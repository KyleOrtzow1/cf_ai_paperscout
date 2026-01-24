/**
 * arXiv API client and Atom XML parser
 *
 * Rate limiting note: arXiv requests should be throttled (~1 request per 3 seconds).
 * MVP does not enforce; callers should batch responsibly. Use the optional `throttleMs`
 * parameter in `fetchArxivPapers` to add delays between requests if needed.
 */

import { XMLParser } from "fast-xml-parser";

// =============================================================================
// Types
// =============================================================================

/**
 * Normalized arXiv ID with canonical (versionless) and versioned forms
 */
export interface NormalizedArxivId {
  /** Canonical ID without version suffix (e.g., "2301.01234" or "cs/9901001") */
  canonical: string;
  /** Version number if present (e.g., 2 from "v2") */
  version?: number;
  /** Full versioned ID if version was present (e.g., "2301.01234v2") */
  versioned?: string;
}

/**
 * Parsed paper data from arXiv API
 */
export interface ArxivPaper {
  /** Canonical arXiv ID without version (primary key for storage) */
  arxivId: string;
  /** Full versioned arXiv ID if version was present */
  arxivIdVersioned?: string;
  /** Version number extracted from the ID */
  version?: number;
  /** Paper title */
  title: string;
  /** List of author names */
  authors: string[];
  /** Publication date (ISO string) */
  published: string;
  /** Last updated date (ISO string) */
  updated?: string;
  /** Paper abstract */
  abstract: string;
  /** Link to arXiv abstract page */
  url: string;
  /** arXiv categories (e.g., ["cs.AI", "cs.LG"]) */
  categories?: string[];
  /** Link to PDF */
  pdfUrl?: string;
}

/**
 * Options for arXiv search queries
 */
export interface ArxivSearchOptions {
  /** Maximum number of results to return (default: 10) */
  maxResults?: number;
  /** Starting index for pagination (default: 0) */
  start?: number;
  /** Sort field */
  sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
  /** Sort order */
  sortOrder?: "ascending" | "descending";
  /** Filter by arXiv categories (e.g., ["cs.AI", "cs.LG"]) */
  categories?: string[];
}

/**
 * Options for fetchArxivPapers
 */
export interface FetchArxivOptions extends ArxivSearchOptions {
  /** Custom fetch implementation for testing */
  fetchImpl?: typeof fetch;
  /** Optional delay in ms between requests (for rate limiting) */
  throttleMs?: number;
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when network request to arXiv fails
 */
export class ArxivNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ArxivNetworkError";
  }
}

/**
 * Error thrown when arXiv returns a non-OK HTTP status
 */
export class ArxivHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string
  ) {
    super(`arXiv API returned ${status}: ${statusText}`);
    this.name = "ArxivHttpError";
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Delay helper for optional rate limiting
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Normalize an arXiv ID or URL to extract canonical and versioned forms.
 *
 * Handles formats like:
 * - "2301.01234v2" → { canonical: "2301.01234", version: 2, versioned: "2301.01234v2" }
 * - "cs/9901001v3" → { canonical: "cs/9901001", version: 3, versioned: "cs/9901001v3" }
 * - "http://arxiv.org/abs/2301.01234v1" → extracts from URL
 * - "2301.01234" → { canonical: "2301.01234" } (no version)
 *
 * @param idOrUrl - arXiv ID or full arXiv URL
 * @returns Normalized ID components
 */
export function normalizeArxivId(idOrUrl: string): NormalizedArxivId {
  // Extract ID from URL if needed (handle both http and https, abs and pdf paths)
  let id = idOrUrl;
  const urlMatch = idOrUrl.match(/arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i);
  if (urlMatch) {
    id = urlMatch[1];
  }

  // Parse the ID to extract version
  // Matches: "2301.01234v2", "cs/9901001v3", "hep-th/9901001v1", etc.
  const versionMatch = id.match(/^(.+?)(?:v(\d+))?$/);

  if (!versionMatch) {
    return { canonical: id };
  }

  const canonical = versionMatch[1];
  const versionStr = versionMatch[2];

  if (versionStr) {
    const version = Number.parseInt(versionStr, 10);
    return {
      canonical,
      version,
      versioned: id,
    };
  }

  return { canonical };
}

/**
 * Build arXiv API query URL.
 *
 * @param query - Search query string
 * @param options - Search options
 * @returns Full arXiv API URL
 */
export function buildArxivQueryUrl(
  query: string,
  options: ArxivSearchOptions = {}
): string {
  const {
    maxResults = 10,
    start = 0,
    sortBy = "relevance",
    sortOrder = "descending",
    categories,
  } = options;

  // Build the search query
  let searchQuery = query;

  // Add category filter if specified
  if (categories && categories.length > 0) {
    const categoryFilter = categories.map((cat) => `cat:${cat}`).join("+OR+");
    searchQuery = `(${encodeURIComponent(query)})+AND+(${categoryFilter})`;
  } else {
    searchQuery = encodeURIComponent(query);
  }

  const params = new URLSearchParams();
  params.set("search_query", `all:${searchQuery}`);
  params.set("start", start.toString());
  params.set("max_results", maxResults.toString());
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);

  return `https://export.arxiv.org/api/query?${params.toString()}`;
}

/**
 * Parse arXiv Atom XML response into structured paper objects.
 *
 * Returns an empty array and logs a warning on malformed XML.
 * Skips individual entries that are missing required fields.
 *
 * @param xml - Raw Atom XML string from arXiv API
 * @returns Array of parsed papers
 */
export function parseArxivAtom(xml: string): ArxivPaper[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Ensure arrays are always arrays even with single element
    isArray: (name) => ["entry", "author", "link", "category"].includes(name),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    console.warn("Failed to parse arXiv XML:", error);
    return [];
  }

  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (!feed) {
    console.warn("arXiv XML missing <feed> element");
    return [];
  }

  const entries = feed.entry as Array<Record<string, unknown>> | undefined;
  if (!entries || entries.length === 0) {
    // No results is valid, not an error
    return [];
  }

  const papers: ArxivPaper[] = [];

  for (const entry of entries) {
    try {
      const paper = parseEntry(entry);
      if (paper) {
        papers.push(paper);
      }
    } catch (error) {
      console.warn("Skipping malformed arXiv entry:", error);
    }
  }

  return papers;
}

/**
 * Parse a single Atom entry into an ArxivPaper.
 * Returns null if required fields are missing.
 */
function parseEntry(entry: Record<string, unknown>): ArxivPaper | null {
  // Extract ID from the <id> element (format: http://arxiv.org/abs/2301.01234v1)
  const idElement = entry.id as string | undefined;
  if (!idElement) {
    console.warn("Entry missing <id> element");
    return null;
  }

  const normalizedId = normalizeArxivId(idElement);

  // Title is required
  const title = entry.title as string | undefined;
  if (!title) {
    console.warn("Entry missing <title> element");
    return null;
  }

  // Clean up title (remove newlines, extra spaces)
  const cleanTitle = title.replace(/\s+/g, " ").trim();

  // Authors array
  const authorElements = entry.author as Array<{ name?: string }> | undefined;
  const authors: string[] = [];
  if (authorElements) {
    for (const author of authorElements) {
      if (author.name) {
        authors.push(author.name);
      }
    }
  }

  // Published date is required
  const published = entry.published as string | undefined;
  if (!published) {
    console.warn("Entry missing <published> element");
    return null;
  }

  // Updated date is optional
  const updated = entry.updated as string | undefined;

  // Abstract (called "summary" in Atom)
  const abstract = entry.summary as string | undefined;
  const cleanAbstract = abstract?.replace(/\s+/g, " ").trim() ?? "";

  // Extract links
  const links = entry.link as
    | Array<{ "@_href"?: string; "@_rel"?: string; "@_type"?: string }>
    | undefined;
  let url = idElement; // Default to ID URL
  let pdfUrl: string | undefined;

  if (links) {
    for (const link of links) {
      if (link["@_rel"] === "alternate" && link["@_type"] === "text/html") {
        url = link["@_href"] ?? url;
      }
      if (link["@_type"] === "application/pdf") {
        pdfUrl = link["@_href"];
      }
    }
  }

  // Extract categories
  const categoryElements = entry.category as
    | Array<{ "@_term"?: string }>
    | undefined;
  const categories: string[] = [];
  if (categoryElements) {
    for (const cat of categoryElements) {
      if (cat["@_term"]) {
        categories.push(cat["@_term"]);
      }
    }
  }

  return {
    arxivId: normalizedId.canonical,
    arxivIdVersioned: normalizedId.versioned,
    version: normalizedId.version,
    title: cleanTitle,
    authors,
    published,
    updated,
    abstract: cleanAbstract,
    url,
    pdfUrl,
    categories: categories.length > 0 ? categories : undefined,
  };
}

/**
 * Fetch papers from arXiv API.
 *
 * Throws ArxivNetworkError on network failures.
 * Throws ArxivHttpError on non-OK HTTP responses.
 * Returns empty array on malformed XML (with console warning).
 *
 * @param query - Search query string
 * @param options - Search and fetch options
 * @returns Array of parsed papers
 */
export async function fetchArxivPapers(
  query: string,
  options: FetchArxivOptions = {}
): Promise<ArxivPaper[]> {
  const { fetchImpl = globalThis.fetch, throttleMs, ...searchOptions } = options;

  // Optional rate limiting delay
  if (throttleMs && throttleMs > 0) {
    await delay(throttleMs);
  }

  const url = buildArxivQueryUrl(query, searchOptions);

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new ArxivNetworkError("Failed to fetch from arXiv API", error);
  }

  if (!response.ok) {
    throw new ArxivHttpError(response.status, response.statusText);
  }

  const xml = await response.text();
  return parseArxivAtom(xml);
}

/**
 * Fetch a single paper by arXiv ID.
 *
 * @param arxivId - arXiv ID (with or without version)
 * @param options - Fetch options
 * @returns The paper if found, null otherwise
 */
export async function fetchArxivPaperById(
  arxivId: string,
  options: Pick<FetchArxivOptions, "fetchImpl" | "throttleMs"> = {}
): Promise<ArxivPaper | null> {
  const { fetchImpl = globalThis.fetch, throttleMs } = options;

  // Optional rate limiting delay
  if (throttleMs && throttleMs > 0) {
    await delay(throttleMs);
  }

  // Normalize the ID to get canonical form
  const normalized = normalizeArxivId(arxivId);
  const url = `https://export.arxiv.org/api/query?id_list=${normalized.canonical}`;

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new ArxivNetworkError("Failed to fetch from arXiv API", error);
  }

  if (!response.ok) {
    throw new ArxivHttpError(response.status, response.statusText);
  }

  const xml = await response.text();
  const papers = parseArxivAtom(xml);

  return papers.length > 0 ? papers[0] : null;
}

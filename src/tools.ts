/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod/v3";

import type { PaperScout } from "./server";
import { getCurrentAgent } from "agents";
import { scheduleSchema } from "agents/schedule";
import {
  type ArxivPaper,
  fetchArxivPapers,
  fetchArxivPaperById,
  normalizeArxivId,
  ArxivNetworkError,
  ArxivHttpError
} from "./lib/arxiv";
import type { LibraryPreviewItem } from "./shared";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

// =============================================================================
// Types
// =============================================================================

/**
 * SQL row type for saved_papers table queries
 */
interface SavedPaperRow {
  arxiv_id: string;
  title: string;
  authors_json: string;
  published: string;
  abstract: string;
  url: string;
  tags_json: string;
  saved_at: number;
}

/**
 * SQL row type for library preview queries
 */
interface SavedPaperPreviewRow {
  arxiv_id: string;
  title: string;
  saved_at: number;
  tags_json: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Prompt version for cache key - bump when prompt changes significantly
 */
const SUMMARY_PROMPT_VERSION = "v1";

/**
 * Generate cache key for paper summaries
 * Composite key allows cache invalidation when prompt version changes
 */
function summaryKey(arxivId: string): string {
  return `${arxivId}:${SUMMARY_PROMPT_VERSION}`;
}

/**
 * Result type for searchArxiv tool - consistent shape for LLM context
 */
export interface SearchArxivResult {
  /** Papers matching the query and filters */
  papers: ArxivPaper[];
  /** Original search query */
  query: string;
  /** Recency filter applied (in days) */
  recencyDays: number;
  /** Number of papers fetched from arXiv before filtering */
  totalFetched: number;
  /** Number of papers after recency filter */
  totalAfterFilter: number;
  /** Error message if the search failed */
  error?: string;
}

/**
 * Result type for summarizePaper tool - consistent shape for LLM context
 */
export interface SummarizePaperResult {
  /** arXiv ID of the summarized paper */
  arxivId: string;
  /** Paper title */
  title?: string;
  /** Generated markdown summary */
  summaryMd: string;
  /** Whether the summary was retrieved from cache */
  cached: boolean;
  /** Error message if summarization failed */
  error?: string;
}

/**
 * Result type for savePaper tool
 */
export interface SavePaperResult {
  arxivId: string;
  title: string;
  tags: string[];
  savedAt: number;
  wasAlreadySaved: boolean;
  error?: string;
  warning?: string;
}

/**
 * Result type for listSavedPapers tool
 */
export interface ListSavedPapersResult {
  papers: Array<{
    arxivId: string;
    title: string;
    authors: string[];
    published: string;
    abstract: string;
    url: string;
    tags: string[];
    savedAt: number;
  }>;
  filterText?: string;
  tagFilter?: string;
  totalCount: number;
  wasTruncated: boolean;
  error?: string;
}

/**
 * Result type for removeSavedPaper tool
 */
export interface RemoveSavedPaperResult {
  arxivId: string;
  title?: string;
  success: boolean;
  error?: string;
  warning?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely parse JSON with fallback value on error
 * Prevents JSON parsing errors from breaking operations
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json || JSON.stringify(fallback));
    return parsed as T;
  } catch (error) {
    console.error("JSON parse error, using fallback:", error);
    return fallback;
  }
}

/**
 * Check if an error is database-related
 * Helps distinguish between expected database errors and unexpected failures
 */
function isDatabaseError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("sql") ||
      msg.includes("database") ||
      msg.includes("sqlite") ||
      msg.includes("constraint")
    );
  }
  return false;
}

/**
 * Create a user-friendly error message for arXiv fetch failures
 * Handles ArxivNetworkError and ArxivHttpError consistently
 */
function getArxivErrorMessage(error: unknown): string {
  if (error instanceof ArxivNetworkError) {
    return "Failed to connect to arXiv. Please try again later.";
  }
  if (error instanceof ArxivHttpError) {
    return `arXiv returned an error (HTTP ${error.status}). Please try again.`;
  }
  // Re-throw unexpected errors
  throw error;
}

/**
 * Factory for creating SavePaperResult error objects
 * Reduces duplication and ensures consistent error structure
 */
function createSavePaperError(
  arxivId: string,
  error: string,
  partial?: Partial<SavePaperResult>
): SavePaperResult {
  return {
    arxivId,
    title: "",
    tags: [],
    savedAt: 0,
    wasAlreadySaved: false,
    ...partial,
    error
  };
}

/**
 * Filter predicate: Check if paper has a specific tag (case-insensitive)
 */
function paperHasTag(row: SavedPaperRow, tag: string): boolean {
  const tags = safeJsonParse<string[]>(row.tags_json, []);
  return tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

/**
 * Filter predicate: Check if paper matches text search (case-insensitive)
 * Searches in title and abstract
 */
function paperMatchesText(row: SavedPaperRow, text: string): boolean {
  const lowerText = text.toLowerCase();
  return (
    row.title.toLowerCase().includes(lowerText) ||
    row.abstract.toLowerCase().includes(lowerText)
  );
}

/**
 * Transform SavedPaperRow to ListSavedPapersResult paper format
 * Handles JSON parsing with safe fallbacks
 */
function rowToListPaper(row: SavedPaperRow) {
  return {
    arxivId: row.arxiv_id,
    title: row.title,
    authors: safeJsonParse<string[]>(row.authors_json, []),
    published: row.published,
    abstract: row.abstract,
    url: row.url,
    tags: safeJsonParse<string[]>(row.tags_json, []),
    savedAt: row.saved_at
  };
}

/**
 * Factory for creating RemoveSavedPaperResult error objects
 * Reduces duplication and ensures consistent error structure
 */
function createRemoveError(
  arxivId: string,
  error: string,
  title?: string
): RemoveSavedPaperResult {
  return {
    arxivId,
    title,
    success: false,
    error
  };
}

// =============================================================================
// Summary Prompt Builder
// =============================================================================

/**
 * Build a prompt for generating a structured paper summary
 */
function buildSummaryPrompt(paper: ArxivPaper): string {
  const authorsStr =
    paper.authors.slice(0, 5).join(", ") +
    (paper.authors.length > 5
      ? ` et al. (${paper.authors.length} authors)`
      : "");
  const publishedDate = new Date(paper.published).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  return `You are a research paper summarizer. Given the following paper metadata and abstract, generate a structured summary.

## Paper Information
**Title:** ${paper.title}
**Authors:** ${authorsStr}
**Published:** ${publishedDate}
**arXiv ID:** ${paper.arxivId}
**Categories:** ${paper.categories?.join(", ") || "Not specified"}

## Abstract
${paper.abstract}

## Instructions
Generate a structured summary with EXACTLY these sections in markdown format:

### TL;DR
(1-2 sentences capturing the core contribution)

### Key Contributions
(3-5 bullet points)

### Limitations & Open Questions
(2-4 bullet points based on what can be inferred from the abstract)

### Who Should Read This
(1-2 sentences describing the target audience)

### Related Keywords
(Comma-separated list of 5-8 relevant terms for discoverability)

---
*⚠️ This summary is based on the paper's abstract and metadata only, not the full text.*

Respond with ONLY the markdown summary, no additional commentary.`;
}

// =============================================================================
// Library Management Helpers
// =============================================================================

/**
 * Helper function to update libraryPreview state with top 10 most recent papers.
 * Called after savePaper and removeSavedPaper operations to keep UI in sync.
 *
 * Errors during preview update are logged but do not fail the calling operation,
 * as the preview is a secondary UI convenience feature.
 */
async function updateLibraryPreview(
  agent: PaperScout
): Promise<{ success: boolean; error?: string }> {
  try {
    const recent = agent.sql<SavedPaperPreviewRow>`
      SELECT arxiv_id, title, saved_at, tags_json
      FROM saved_papers
      ORDER BY saved_at DESC
      LIMIT 10
    `;

    const preview: LibraryPreviewItem[] = recent.map((row) => ({
      arxivId: row.arxiv_id,
      title: row.title,
      savedAt: row.saved_at,
      tags: safeJsonParse<string[]>(row.tags_json, [])
    }));

    // Merge with existing state to preserve preferences
    agent.setState({
      ...agent.state,
      libraryPreview: preview
    });

    return { success: true };
  } catch (error) {
    console.error("Error updating library preview:", error);
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    // Don't throw - preview update failure shouldn't fail the operation
    return {
      success: false,
      error: `Library preview update failed: ${errorMsg}`
    };
  }
}

/**
 * Weather information tool that requires human confirmation
 * When invoked, this will present a confirmation dialog to the user
 */
const getWeatherInformation = tool({
  description: "show the weather in a given city to the user",
  inputSchema: z.object({ city: z.string() })
  // Omitting execute function makes this tool require human confirmation
});

/**
 * Local time tool that executes automatically
 * Since it includes an execute function, it will run without user confirmation
 * This is suitable for low-risk operations that don't need oversight
 */
const getLocalTime = tool({
  description: "get the local time for a specified location",
  inputSchema: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    return "10am";
  }
});

const scheduleTask = tool({
  description: "A tool to schedule a task to be executed at a later time",
  inputSchema: scheduleSchema,
  execute: async ({ when, description }) => {
    // we can now read the agent context from the ALS store
    const { agent } = getCurrentAgent<PaperScout>();

    function throwError(msg: string): string {
      throw new Error(msg);
    }
    if (when.type === "no-schedule") {
      return "Not a valid schedule input";
    }
    const input =
      when.type === "scheduled"
        ? when.date // scheduled
        : when.type === "delayed"
          ? when.delayInSeconds // delayed
          : when.type === "cron"
            ? when.cron // cron
            : throwError("not a valid schedule input");
    try {
      agent!.schedule(input!, "executeTask", description);
    } catch (error) {
      console.error("error scheduling task", error);
      return `Error scheduling task: ${error}`;
    }
    return `Task scheduled for type "${when.type}" : ${input}`;
  }
});

/**
 * Tool to list all scheduled tasks
 * This executes automatically without requiring human confirmation
 */
const getScheduledTasks = tool({
  description: "List all tasks that have been scheduled",
  inputSchema: z.object({}),
  execute: async () => {
    const { agent } = getCurrentAgent<PaperScout>();

    try {
      const tasks = agent!.getSchedules();
      if (!tasks || tasks.length === 0) {
        return "No scheduled tasks found.";
      }
      return tasks;
    } catch (error) {
      console.error("Error listing scheduled tasks", error);
      return `Error listing scheduled tasks: ${error}`;
    }
  }
});

/**
 * Tool to cancel a scheduled task by its ID
 * This executes automatically without requiring human confirmation
 */
const cancelScheduledTask = tool({
  description: "Cancel a scheduled task using its ID",
  inputSchema: z.object({
    taskId: z.string().describe("The ID of the task to cancel")
  }),
  execute: async ({ taskId }) => {
    const { agent } = getCurrentAgent<PaperScout>();
    try {
      await agent!.cancelSchedule(taskId);
      return `Task ${taskId} has been successfully canceled.`;
    } catch (error) {
      console.error("Error canceling scheduled task", error);
      return `Error canceling task ${taskId}: ${error}`;
    }
  }
});

// =============================================================================
// PaperScout Tools
// =============================================================================

/**
 * Search arXiv for papers matching a query.
 * Returns structured results with query context for LLM narration.
 * Filters by recency using the paper's published date.
 */
const searchArxiv = tool({
  description:
    "Search arXiv for academic papers matching a query. Returns papers with titles, authors, abstracts, and links. Use this when the user wants to find or discover research papers on a topic.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Search query for arXiv (e.g., 'transformer attention mechanism', 'reinforcement learning robotics')"
      ),
    maxResults: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum number of results to return (default: from user preferences, typically 5)"
      ),
    recencyDays: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Only return papers published within this many days (default: from user preferences, typically 30)"
      ),
    categories: z
      .preprocess((val) => {
        // Handle LLMs that generate arrays as JSON-like strings
        if (typeof val === "string") {
          const trimmed = val.trim();
          if (!trimmed) return undefined;
          if (trimmed.startsWith("[")) {
            try {
              const parsed = JSON.parse(trimmed);
              return Array.isArray(parsed) ? parsed : undefined;
            } catch {
              try {
                const normalized = trimmed.replace(/'/g, '"');
                const parsed = JSON.parse(normalized);
                return Array.isArray(parsed) ? parsed : undefined;
              } catch {
                return trimmed
                  .slice(1, -1)
                  .split(",")
                  .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
                  .filter(Boolean);
              }
            }
          }
          return trimmed
            .split(",")
            .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean);
        }
        return val;
      }, z.array(z.string()))
      .optional()
      .describe(
        "arXiv categories to filter by (e.g., ['cs.AI', 'cs.LG']). Default: from user preferences"
      )
  }),
  execute: async ({
    query,
    maxResults,
    recencyDays,
    categories
  }): Promise<SearchArxivResult> => {
    const { agent } = getCurrentAgent<PaperScout>();
    const preferences = agent!.state.preferences;

    // Merge inputs with preferences (inputs take precedence)
    const effectiveMaxResults = maxResults ?? preferences.defaultMaxResults;
    const effectiveRecencyDays = recencyDays ?? preferences.recencyDays;
    const effectiveCategories = categories ?? preferences.categories;

    // Fetch papers from arXiv
    let papers: ArxivPaper[];
    try {
      papers = await fetchArxivPapers(query, {
        maxResults: effectiveMaxResults,
        categories: effectiveCategories,
        sortBy: "submittedDate",
        sortOrder: "descending"
      });
    } catch (error) {
      // Return consistent shape with error info
      if (error instanceof ArxivNetworkError) {
        return {
          papers: [],
          query,
          recencyDays: effectiveRecencyDays,
          totalFetched: 0,
          totalAfterFilter: 0,
          error: "Failed to connect to arXiv. Please try again later."
        };
      }
      if (error instanceof ArxivHttpError) {
        return {
          papers: [],
          query,
          recencyDays: effectiveRecencyDays,
          totalFetched: 0,
          totalAfterFilter: 0,
          error: `arXiv returned an error (HTTP ${error.status}). Please try again.`
        };
      }
      throw error; // Re-throw unexpected errors
    }

    const totalFetched = papers.length;

    // Filter by recency using published date
    const cutoffTime = Date.now() - effectiveRecencyDays * 24 * 60 * 60 * 1000;
    const filteredPapers = papers.filter((paper) => {
      const publishedTime = new Date(paper.published).getTime();
      return publishedTime >= cutoffTime;
    });

    return {
      papers: filteredPapers,
      query,
      recencyDays: effectiveRecencyDays,
      totalFetched,
      totalAfterFilter: filteredPapers.length
    };
  }
});

/**
 * Summarize an arXiv paper by ID.
 * Generates a structured markdown summary using Workers AI.
 * Caches summaries in SQL with prompt-versioned keys.
 */
const summarizePaper = tool({
  description:
    "Generate a structured summary of an arXiv paper given its ID. Returns TL;DR, key contributions, limitations, target audience, and keywords. Use this when the user wants to understand what a paper is about.",
  inputSchema: z.object({
    arxivId: z
      .string()
      .describe(
        "arXiv paper ID to summarize (e.g., '2301.01234' or '2301.01234v2')"
      )
  }),
  execute: async ({ arxivId }): Promise<SummarizePaperResult> => {
    const { agent } = getCurrentAgent<PaperScout>();
    const cacheKey = summaryKey(arxivId);

    // Check cache first
    try {
      const cached = agent!.sql<{ summary_md: string }>`
        SELECT summary_md FROM paper_summaries WHERE arxiv_id = ${cacheKey}
      `;
      if (cached.length > 0) {
        return {
          arxivId,
          summaryMd: cached[0].summary_md,
          cached: true
        };
      }
    } catch (error) {
      // Cache miss or error, continue to generate
      console.warn("Cache lookup failed:", error);
    }

    // Fetch paper from arXiv
    let paper: ArxivPaper | null;
    try {
      paper = await fetchArxivPaperById(arxivId);
    } catch (error) {
      if (error instanceof ArxivNetworkError) {
        return {
          arxivId,
          summaryMd: "",
          cached: false,
          error: "Failed to connect to arXiv. Please try again later."
        };
      }
      if (error instanceof ArxivHttpError) {
        return {
          arxivId,
          summaryMd: "",
          cached: false,
          error: `arXiv returned an error (HTTP ${error.status}). Please try again.`
        };
      }
      throw error;
    }

    if (!paper) {
      return {
        arxivId,
        summaryMd: "",
        cached: false,
        error: `Paper with arXiv ID '${arxivId}' not found. Please check the ID and try again.`
      };
    }

    // Generate summary using Workers AI via ai-sdk
    const workersai = createWorkersAI({ binding: agent!.getAIBinding() });
    const model = workersai(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<
        typeof workersai
      >[0]
    );

    let summaryMd: string;
    try {
      const result = await generateText({
        model,
        prompt: buildSummaryPrompt(paper)
      });
      summaryMd = result.text;
    } catch (error) {
      console.error("AI generation failed:", error);
      return {
        arxivId,
        title: paper.title,
        summaryMd: "",
        cached: false,
        error: "Failed to generate summary. Please try again."
      };
    }

    // Cache the result
    try {
      const now = Date.now();
      agent!.sql`
        INSERT OR REPLACE INTO paper_summaries (arxiv_id, summary_md, created_at) 
        VALUES (${cacheKey}, ${summaryMd}, ${now})
      `;
    } catch (error) {
      // Log but don't fail - summary was generated successfully
      console.error("Failed to cache summary:", error);
    }

    return {
      arxivId,
      title: paper.title,
      summaryMd,
      cached: false
    };
  }
});

/**
 * Save an arXiv paper to the user's personal library with optional tags.
 * If the paper is already saved, merges new tags with existing ones.
 * Updates libraryPreview state for UI synchronization.
 */
const savePaper = tool({
  description:
    "Save an arXiv paper to the user's personal library with optional tags. " +
    "Use this when the user wants to bookmark, save, or add a paper to their collection. " +
    "The paper will be fetched from arXiv if not already in the database.",
  inputSchema: z.object({
    arxivId: z
      .string()
      .describe(
        "arXiv paper ID to save (e.g., '2301.01234' or '2301.01234v2')"
      ),
    tags: z
      .preprocess((value) => {
        if (value === undefined || value === null) return undefined;
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (!trimmed) return [];
          if (trimmed.startsWith("[")) {
            try {
              const parsed = JSON.parse(trimmed);
              return Array.isArray(parsed) ? parsed : [String(parsed)];
            } catch {
              // Fall through to comma-separated parsing.
            }
          }
          return trimmed
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
        }
        return value;
      }, z.array(z.string()))
      .optional()
      .describe(
        "Optional tags to categorize the paper (e.g., ['diffusion', 'image-generation'])"
      )
  }),
  execute: async ({ arxivId, tags = [] }): Promise<SavePaperResult> => {
    const { agent } = getCurrentAgent<PaperScout>();

    // Guard: Ensure agent context is available
    if (!agent) {
      return createSavePaperError("", "Agent context not available.");
    }

    // Normalize the arXiv ID to canonical form (without version)
    let normalized: ReturnType<typeof normalizeArxivId>;
    try {
      normalized = normalizeArxivId(arxivId);
    } catch (error) {
      console.error("Error normalizing arXiv ID:", error);
      return createSavePaperError(
        arxivId,
        "Invalid arXiv ID format. Please use format like '2301.01234'."
      );
    }
    const canonicalId = normalized.canonical;

    // Check if already saved
    let existingPaper: SavedPaperPreviewRow[];
    try {
      existingPaper = agent.sql<SavedPaperPreviewRow>`
        SELECT arxiv_id, title, saved_at, tags_json
        FROM saved_papers
        WHERE arxiv_id = ${canonicalId}
      `;
    } catch (error) {
      console.error("Database error checking existing paper:", error);
      // Only catch database errors - re-throw unexpected errors
      if (!isDatabaseError(error)) {
        throw error;
      }
      return createSavePaperError(
        canonicalId,
        "Database error while checking for existing paper."
      );
    }

    const wasAlreadySaved = existingPaper.length > 0;

    // If already saved, update tags (merge with existing)
    if (wasAlreadySaved) {
      const existing = existingPaper[0];
      const existingTags = safeJsonParse<string[]>(existing.tags_json, []);
      const mergedTags = Array.from(new Set([...existingTags, ...tags]));

      try {
        agent.sql`
          UPDATE saved_papers
          SET tags_json = ${JSON.stringify(mergedTags)}
          WHERE arxiv_id = ${canonicalId}
        `;
      } catch (error) {
        console.error("Database error updating tags:", error);
        // Only catch database errors - re-throw unexpected errors
        if (!isDatabaseError(error)) {
          throw error;
        }
        return {
          arxivId: canonicalId,
          title: existing.title,
          tags: existingTags,
          savedAt: existing.saved_at,
          wasAlreadySaved: true,
          error: "Failed to update tags in database."
        };
      }

      // Update libraryPreview state
      const previewResult = await updateLibraryPreview(agent);

      return {
        arxivId: canonicalId,
        title: existing.title,
        tags: mergedTags,
        savedAt: existing.saved_at,
        wasAlreadySaved: true,
        ...(previewResult.success
          ? {}
          : {
              warning:
                "Paper saved but UI preview may be outdated. Please refresh."
            })
      };
    }

    // Fetch paper from arXiv
    let paper: ArxivPaper | null;
    try {
      paper = await fetchArxivPaperById(canonicalId);
    } catch (error) {
      return createSavePaperError(canonicalId, getArxivErrorMessage(error));
    }

    if (!paper) {
      return createSavePaperError(
        canonicalId,
        `Paper with arXiv ID '${canonicalId}' not found. Please check the ID and try again.`
      );
    }

    // Insert into database
    const savedAt = Date.now();
    try {
      agent.sql`
        INSERT INTO saved_papers (
          arxiv_id, title, authors_json, published, updated,
          abstract, url, tags_json, saved_at
        ) VALUES (
          ${canonicalId},
          ${paper.title},
          ${JSON.stringify(paper.authors)},
          ${paper.published},
          ${paper.updated || paper.published},
          ${paper.abstract},
          ${paper.url},
          ${JSON.stringify(tags)},
          ${savedAt}
        )
      `;
    } catch (error) {
      console.error("Database error inserting paper:", error);
      // Check for specific error types
      if (error instanceof Error) {
        if (error.message.includes("UNIQUE")) {
          return createSavePaperError(
            canonicalId,
            "Paper already exists in library (race condition detected).",
            { title: paper.title }
          );
        }
        if (error.message.toLowerCase().includes("quota")) {
          return createSavePaperError(
            canonicalId,
            "Storage quota exceeded. Please remove some papers first.",
            { title: paper.title }
          );
        }
      }
      // Only catch database errors - re-throw unexpected errors
      if (!isDatabaseError(error)) {
        throw error;
      }
      return createSavePaperError(
        canonicalId,
        "Failed to save paper to database.",
        { title: paper.title }
      );
    }

    // Update libraryPreview state (top 10 most recent)
    const previewResult = await updateLibraryPreview(agent);

    return {
      arxivId: canonicalId,
      title: paper.title,
      tags,
      savedAt,
      wasAlreadySaved: false,
      ...(previewResult.success
        ? {}
        : {
            warning:
              "Paper saved but UI preview may be outdated. Please refresh."
          })
    };
  }
});

/**
 * List papers saved in the user's personal library.
 * Supports filtering by text search (titles and abstracts) and tag filtering.
 * Results are always sorted by most recently saved first.
 */
const listSavedPapers = tool({
  description:
    "List papers saved in the user's personal library. " +
    "Supports filtering by text search (searches titles and abstracts) and tag filtering. " +
    "Use this when the user wants to: see/show/view/list their saved papers, review their library, " +
    "find a specific saved paper, check what papers they have saved, or view their collection. " +
    "This tool should be used whenever the user asks about their saved/stored papers.",
  inputSchema: z.object({
    filterText: z
      .string()
      .optional()
      .describe(
        "Optional text to search for in paper titles and abstracts (case-insensitive)"
      ),
    tag: z
      .string()
      .optional()
      .describe(
        "Optional tag to filter by (only papers with this tag will be returned)"
      ),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of results to return (default: 20, max: 100)")
  }),
  execute: async ({
    filterText,
    tag,
    limit = 20
  }): Promise<ListSavedPapersResult> => {
    const { agent } = getCurrentAgent<PaperScout>();

    // Guard: Ensure agent context is available
    if (!agent) {
      return {
        papers: [],
        totalCount: 0,
        wasTruncated: false,
        error: "Agent context not available."
      };
    }

    // Enforce max limit with additional validation
    const effectiveLimit = Math.max(1, Math.min(limit, 100));

    // Fetch all papers from database (filtering done in JavaScript)
    let allPapers: SavedPaperRow[];
    try {
      allPapers = agent.sql<SavedPaperRow>`
        SELECT arxiv_id, title, authors_json, published, abstract, url, tags_json, saved_at
        FROM saved_papers
        ORDER BY saved_at DESC
      `;
    } catch (error) {
      console.error("Database error querying saved papers:", error);
      // Only catch database errors - re-throw unexpected errors
      if (!isDatabaseError(error)) {
        throw error;
      }
      return {
        papers: [],
        totalCount: 0,
        wasTruncated: false,
        error: "Failed to retrieve saved papers from database."
      };
    }

    // Apply filters in JavaScript (SQL template literals are limited)
    // Use declarative filter pipeline for clarity
    const filtered = allPapers
      .filter((row) => !tag || paperHasTag(row, tag))
      .filter((row) => !filterText || paperMatchesText(row, filterText));

    const totalCount = filtered.length;
    const wasTruncated = totalCount > effectiveLimit;

    // Apply limit and transform to result format
    const papers = filtered.slice(0, effectiveLimit).map(rowToListPaper);

    return {
      papers,
      filterText,
      tagFilter: tag,
      totalCount,
      wasTruncated
    };
  }
});

/**
 * Remove a paper from the user's personal library.
 * This action requires user confirmation before execution.
 * Updates libraryPreview state after successful removal.
 */
const removeSavedPaper = tool({
  description:
    "Remove a paper from the user's personal library. " +
    "This action requires user confirmation. " +
    "Use this when the user wants to delete or remove a saved paper from their collection.",
  inputSchema: z.object({
    arxivId: z
      .string()
      .describe("arXiv paper ID to remove (e.g., '2301.01234')")
  })
  // No execute function - requires human confirmation
});

/**
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  getWeatherInformation,
  getLocalTime,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask,
  searchArxiv,
  summarizePaper,
  savePaper,
  listSavedPapers,
  removeSavedPaper
} satisfies ToolSet;

/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Each function here corresponds to a tool above that doesn't have an execute function
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    return `The weather in ${city} is sunny`;
  },

  removeSavedPaper: async ({
    arxivId
  }: {
    arxivId: string;
  }): Promise<RemoveSavedPaperResult> => {
    const { agent } = getCurrentAgent<PaperScout>();

    // Guard: Ensure agent context is available
    if (!agent) {
      return createRemoveError("", "Agent context not available.");
    }

    // Normalize the arXiv ID to canonical form
    let normalized: ReturnType<typeof normalizeArxivId>;
    try {
      normalized = normalizeArxivId(arxivId);
    } catch (error) {
      console.error("Error normalizing arXiv ID:", error);
      return createRemoveError(
        arxivId,
        "Invalid arXiv ID format. Please use format like '2301.01234'."
      );
    }
    const canonicalId = normalized.canonical;

    // Get the paper title before deleting (used in result message and error handling)
    let title: string | undefined;
    let dbErrorDuringLookup = false;
    try {
      const result = agent.sql<{ title: string }>`
        SELECT title FROM saved_papers WHERE arxiv_id = ${canonicalId}
      `;
      title = result.length > 0 ? result[0].title : undefined;
    } catch (error) {
      console.error("Database error fetching paper for removal:", error);
      // Only catch database errors - re-throw unexpected errors
      if (!isDatabaseError(error)) {
        throw error;
      }
      dbErrorDuringLookup = true;
    }

    // Distinguish between database error and paper not found
    if (dbErrorDuringLookup) {
      return createRemoveError(
        canonicalId,
        "Database error while looking up paper. Please try again."
      );
    }

    if (!title) {
      return createRemoveError(
        canonicalId,
        `Paper with arXiv ID '${canonicalId}' not found in library.`
      );
    }

    // Delete from database
    try {
      agent.sql`
        DELETE FROM saved_papers WHERE arxiv_id = ${canonicalId}
      `;
    } catch (error) {
      console.error("Database error deleting paper:", error);
      // Check for specific error types
      if (error instanceof Error && error.message.includes("constraint")) {
        return createRemoveError(
          canonicalId,
          "Cannot remove paper due to database constraint violation.",
          title
        );
      }
      // Only catch database errors - re-throw unexpected errors
      if (!isDatabaseError(error)) {
        throw error;
      }
      return createRemoveError(
        canonicalId,
        "Failed to remove paper from database.",
        title
      );
    }

    // Update libraryPreview state
    const previewResult = await updateLibraryPreview(agent);

    return {
      arxivId: canonicalId,
      title,
      success: true,
      ...(previewResult.success
        ? {}
        : {
            warning:
              "Paper removed but UI preview may be outdated. Please refresh."
          })
    };
  }
};

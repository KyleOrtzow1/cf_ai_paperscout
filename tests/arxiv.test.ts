/**
 * Unit tests for arXiv API client and Atom XML parser
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeArxivId,
  buildArxivQueryUrl,
  parseArxivAtom,
  fetchArxivPapers,
  fetchArxivPaperById,
  ArxivNetworkError,
  ArxivHttpError
} from "../src/lib/arxiv";

// =============================================================================
// Test Fixtures (inline XML)
// =============================================================================

const SINGLE_ENTRY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.01234v2</id>
    <title>A Great Paper About
      Diffusion Models</title>
    <published>2023-01-15T00:00:00Z</published>
    <updated>2023-01-20T00:00:00Z</updated>
    <summary>This paper presents a novel approach
      to diffusion models that improves generation quality.</summary>
    <author>
      <name>Alice Smith</name>
    </author>
    <author>
      <name>Bob Jones</name>
    </author>
    <link href="http://arxiv.org/abs/2301.01234v2" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/2301.01234v2" rel="related" type="application/pdf"/>
    <category term="cs.AI"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

const MULTIPLE_ENTRIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>First Paper</title>
    <published>2023-01-01T00:00:00Z</published>
    <summary>Abstract one.</summary>
    <author><name>Author One</name></author>
    <link href="http://arxiv.org/abs/2301.00001v1" rel="alternate" type="text/html"/>
    <category term="cs.AI"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00002v3</id>
    <title>Second Paper</title>
    <published>2023-01-02T00:00:00Z</published>
    <summary>Abstract two.</summary>
    <author><name>Author Two</name></author>
    <link href="http://arxiv.org/abs/2301.00002v3" rel="alternate" type="text/html"/>
    <category term="cs.LG"/>
  </entry>
</feed>`;

const MISSING_OPTIONAL_FIELDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.99999</id>
    <title>Minimal Paper</title>
    <published>2023-01-01T00:00:00Z</published>
  </entry>
</feed>`;

const EMPTY_RESULTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
</feed>`;

const OLD_FORMAT_ID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/cs/9901001v3</id>
    <title>Old Format Paper</title>
    <published>1999-01-01T00:00:00Z</published>
    <summary>An old paper.</summary>
    <author><name>Old Author</name></author>
    <link href="http://arxiv.org/abs/cs/9901001v3" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

const MALFORMED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>Broken Entry`;

// =============================================================================
// normalizeArxivId Tests
// =============================================================================

describe("normalizeArxivId", () => {
  it("parses new-style ID with version", () => {
    const result = normalizeArxivId("2301.01234v2");
    expect(result).toEqual({
      canonical: "2301.01234",
      version: 2,
      versioned: "2301.01234v2"
    });
  });

  it("parses new-style ID without version", () => {
    const result = normalizeArxivId("2301.01234");
    expect(result).toEqual({
      canonical: "2301.01234"
    });
  });

  it("parses old-style ID with subject prefix and version", () => {
    const result = normalizeArxivId("cs/9901001v3");
    expect(result).toEqual({
      canonical: "cs/9901001",
      version: 3,
      versioned: "cs/9901001v3"
    });
  });

  it("parses old-style ID with hyphenated subject", () => {
    const result = normalizeArxivId("hep-th/9901001v1");
    expect(result).toEqual({
      canonical: "hep-th/9901001",
      version: 1,
      versioned: "hep-th/9901001v1"
    });
  });

  it("extracts ID from http arXiv abs URL", () => {
    const result = normalizeArxivId("http://arxiv.org/abs/2301.01234v2");
    expect(result).toEqual({
      canonical: "2301.01234",
      version: 2,
      versioned: "2301.01234v2"
    });
  });

  it("extracts ID from https arXiv abs URL", () => {
    const result = normalizeArxivId("https://arxiv.org/abs/2301.01234v1");
    expect(result).toEqual({
      canonical: "2301.01234",
      version: 1,
      versioned: "2301.01234v1"
    });
  });

  it("extracts ID from arXiv PDF URL", () => {
    const result = normalizeArxivId("https://arxiv.org/pdf/2301.01234v2.pdf");
    expect(result).toEqual({
      canonical: "2301.01234",
      version: 2,
      versioned: "2301.01234v2"
    });
  });

  it("handles URL without version", () => {
    const result = normalizeArxivId("https://arxiv.org/abs/2301.01234");
    expect(result).toEqual({
      canonical: "2301.01234"
    });
  });
});

// =============================================================================
// buildArxivQueryUrl Tests
// =============================================================================

describe("buildArxivQueryUrl", () => {
  it("builds basic query URL with defaults", () => {
    const url = buildArxivQueryUrl("diffusion models");
    expect(url).toContain("https://export.arxiv.org/api/query");
    // URLSearchParams encodes space as + (or %20), and colon as %3A
    expect(url).toMatch(/search_query=all%3Adiffusion(\+|%20)models/);
    expect(url).toContain("max_results=10");
    expect(url).toContain("start=0");
    expect(url).toContain("sortBy=relevance");
    expect(url).toContain("sortOrder=descending");
  });

  it("respects maxResults option", () => {
    const url = buildArxivQueryUrl("test", { maxResults: 5 });
    expect(url).toContain("max_results=5");
  });

  it("respects start option for pagination", () => {
    const url = buildArxivQueryUrl("test", { start: 20 });
    expect(url).toContain("start=20");
  });

  it("respects sortBy and sortOrder options", () => {
    const url = buildArxivQueryUrl("test", {
      sortBy: "lastUpdatedDate",
      sortOrder: "ascending"
    });
    expect(url).toContain("sortBy=lastUpdatedDate");
    expect(url).toContain("sortOrder=ascending");
  });

  it("adds category filter when categories provided", () => {
    const url = buildArxivQueryUrl("test", { categories: ["cs.AI", "cs.LG"] });
    // URL encoding turns : into %3A, spaces into + or %20
    expect(url).toContain("cat%3Acs.AI");
    expect(url).toContain("cat%3Acs.LG");
    // Check for AND operator (space-separated, URLSearchParams encodes spaces)
    expect(url).toMatch(/AND/);
    // Check for OR operator (space-separated, URLSearchParams encodes spaces)
    expect(url).toMatch(/OR/);
  });
});

// =============================================================================
// parseArxivAtom Tests
// =============================================================================

describe("parseArxivAtom", () => {
  it("parses single entry correctly", () => {
    const papers = parseArxivAtom(SINGLE_ENTRY_XML);

    expect(papers).toHaveLength(1);
    const paper = papers[0];

    expect(paper.arxivId).toBe("2301.01234");
    expect(paper.arxivIdVersioned).toBe("2301.01234v2");
    expect(paper.version).toBe(2);
    expect(paper.title).toBe("A Great Paper About Diffusion Models");
    expect(paper.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(paper.published).toBe("2023-01-15T00:00:00Z");
    expect(paper.updated).toBe("2023-01-20T00:00:00Z");
    expect(paper.abstract).toContain("novel approach");
    expect(paper.url).toBe("http://arxiv.org/abs/2301.01234v2");
    expect(paper.pdfUrl).toBe("http://arxiv.org/pdf/2301.01234v2");
    expect(paper.categories).toEqual(["cs.AI", "cs.LG"]);
  });

  it("parses multiple entries", () => {
    const papers = parseArxivAtom(MULTIPLE_ENTRIES_XML);

    expect(papers).toHaveLength(2);
    expect(papers[0].arxivId).toBe("2301.00001");
    expect(papers[0].title).toBe("First Paper");
    expect(papers[1].arxivId).toBe("2301.00002");
    expect(papers[1].title).toBe("Second Paper");
  });

  it("handles missing optional fields gracefully", () => {
    const papers = parseArxivAtom(MISSING_OPTIONAL_FIELDS_XML);

    expect(papers).toHaveLength(1);
    const paper = papers[0];

    expect(paper.arxivId).toBe("2301.99999");
    expect(paper.version).toBeUndefined();
    expect(paper.arxivIdVersioned).toBeUndefined();
    expect(paper.authors).toEqual([]);
    expect(paper.abstract).toBe("");
    expect(paper.updated).toBeUndefined();
    expect(paper.categories).toBeUndefined();
    expect(paper.pdfUrl).toBeUndefined();
  });

  it("returns empty array for empty results", () => {
    const papers = parseArxivAtom(EMPTY_RESULTS_XML);
    expect(papers).toEqual([]);
  });

  it("handles old-style arXiv IDs correctly", () => {
    const papers = parseArxivAtom(OLD_FORMAT_ID_XML);

    expect(papers).toHaveLength(1);
    expect(papers[0].arxivId).toBe("cs/9901001");
    expect(papers[0].arxivIdVersioned).toBe("cs/9901001v3");
    expect(papers[0].version).toBe(3);
  });

  it("returns empty array and warns on malformed XML", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const papers = parseArxivAtom(MALFORMED_XML);

    expect(papers).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("cleans up whitespace in title and abstract", () => {
    const papers = parseArxivAtom(SINGLE_ENTRY_XML);
    const paper = papers[0];

    // Title should have newlines/extra spaces collapsed
    expect(paper.title).not.toContain("\n");
    expect(paper.title).not.toMatch(/\s{2,}/);

    // Abstract should have newlines/extra spaces collapsed
    expect(paper.abstract).not.toContain("\n");
    expect(paper.abstract).not.toMatch(/\s{2,}/);
  });
});

// =============================================================================
// fetchArxivPapers Tests (with mocked fetch)
// =============================================================================

describe("fetchArxivPapers", () => {
  it("calls the correct URL and parses response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SINGLE_ENTRY_XML)
    });

    const papers = await fetchArxivPapers("diffusion models", {
      fetchImpl: mockFetch,
      maxResults: 5
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain("https://export.arxiv.org/api/query");
    expect(calledUrl).toContain("diffusion");
    expect(calledUrl).toContain("max_results=5");

    expect(papers).toHaveLength(1);
    expect(papers[0].arxivId).toBe("2301.01234");
  });

  it("throws ArxivNetworkError on fetch failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));

    await expect(
      fetchArxivPapers("test", { fetchImpl: mockFetch })
    ).rejects.toThrow(ArxivNetworkError);
  });

  it("throws ArxivHttpError on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error"
    });

    await expect(
      fetchArxivPapers("test", { fetchImpl: mockFetch })
    ).rejects.toThrow(ArxivHttpError);

    try {
      await fetchArxivPapers("test", { fetchImpl: mockFetch });
    } catch (error) {
      expect(error).toBeInstanceOf(ArxivHttpError);
      expect((error as ArxivHttpError).status).toBe(500);
    }
  });

  it("returns empty array on malformed XML response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(MALFORMED_XML)
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const papers = await fetchArxivPapers("test", { fetchImpl: mockFetch });

    expect(papers).toEqual([]);

    warnSpy.mockRestore();
  });
});

// =============================================================================
// fetchArxivPaperById Tests
// =============================================================================

describe("fetchArxivPaperById", () => {
  it("fetches paper by ID and returns single result", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SINGLE_ENTRY_XML)
    });

    const paper = await fetchArxivPaperById("2301.01234v2", {
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain("id_list=2301.01234");

    expect(paper).not.toBeNull();
    expect(paper?.arxivId).toBe("2301.01234");
  });

  it("returns null when paper not found", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(EMPTY_RESULTS_XML)
    });

    const paper = await fetchArxivPaperById("nonexistent", {
      fetchImpl: mockFetch
    });

    expect(paper).toBeNull();
  });
});

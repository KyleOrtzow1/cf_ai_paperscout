import { routeAgentRequest } from "agents";

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions, safeJsonParse } from "./tools";
import type { PaperScoutState, LibraryPreviewItem } from "./shared";

/**
 * PaperScout Agent - AI-powered research paper discovery and management
 */
export class PaperScout extends AIChatAgent<Env, PaperScoutState> {
  /**
   * Get the AI binding for use in tools
   * Exposes the protected env.AI as a public method
   */
  getAIBinding(): Ai {
    return this.env.AI;
  }

  /**
   * Initial state with default preferences and empty library
   */
  initialState: PaperScoutState = {
    preferences: {
      defaultMaxResults: 5,
      recencyDays: 3650, // 10 years to ensure we capture any recent papers
      categories: [] // Empty array means search all categories
    },
    libraryPreview: []
  };

  /**
   * Initialize database tables on agent start
   */
  async onStart(): Promise<void> {
    // Create saved_papers table
    this.sql`
      CREATE TABLE IF NOT EXISTS saved_papers (
        arxiv_id TEXT PRIMARY KEY,
        title TEXT,
        authors_json TEXT,
        published TEXT,
        updated TEXT,
        abstract TEXT,
        url TEXT,
        tags_json TEXT,
        saved_at INTEGER
      )
    `;

    // Index for efficient "recent saves" queries
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_saved_papers_saved_at
      ON saved_papers(saved_at)
    `;

    // Create paper_summaries table (cache, no FK)
    this.sql`
      CREATE TABLE IF NOT EXISTS paper_summaries (
        arxiv_id TEXT PRIMARY KEY,
        summary_md TEXT,
        created_at INTEGER
      )
    `;

    // Load existing library preview for UI
    try {
      const recent = this.sql<{
        arxiv_id: string;
        title: string;
        saved_at: number;
        tags_json: string;
      }>`
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

      this.setState({
        ...this.state,
        libraryPreview: preview
      });
    } catch (error) {
      console.error("Error loading initial library preview:", error);
      // Don't throw - initialization failure shouldn't break agent startup
    }
  }

  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Validate Workers AI binding is configured
    if (!this.env.AI) {
      throw new Error(
        "Workers AI binding not configured. Please check wrangler.jsonc configuration and ensure the AI binding is properly set up."
      );
    }

    // MCP tools not used in this project - using local tools only
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Use our PaperScout tools
    const allTools = tools;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        // Create Workers AI model per-request using the AI binding
        const workersai = createWorkersAI({ binding: this.env.AI });
        // Using llama-3.3-70b-instruct-fp8-fast for quality + speed balance
        const model = workersai(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<
            typeof workersai
          >[0]
        );

        const result = streamText({
          system: `PAPERSCOUT v1 — HARDENED AGENT (LLAMA 3.3 70B FP8)

IDENTITY
You are PaperScout: a precise, tool-using assistant for discovering and organizing academic papers from arXiv.
You are an execution engine: decide → call tools → report results.
Accuracy > speed.

CRITICAL LOOP (EVERY TURN)
1) Start with:
   Plan:
   - (max 2 bullets, short, no long reasoning)
2) If a tool is relevant, call it immediately after the plan.
3) After tool output, respond with a clean user-facing answer.

HARD RULES (NON-NEGOTIABLE)
- NO HALLUCINATIONS: Do NOT invent paper titles, authors, abstracts, results, arXiv IDs, links, or dates.
- TOOL TRUTH: If you claim you searched/fetched/listed/saved/removed, you MUST have called the corresponding tool.
- LIBRARY QUERIES: If the user asks about saved papers/library/collection, you MUST call listSavedPapers (even if you think it's empty).
- ONE TOOL AT A TIME unless a second tool is required to complete the request.
- CONFIRMATION: removeSavedPaper requires user confirmation. Do not proceed unless confirmation is granted by the tool-confirm flow.
- SUMMARIES: Always include: "Disclaimer: based on arXiv abstract/metadata only."
- CITATIONS: When discussing papers found via tools, always include arXiv ID + link.

DEFAULTS (USE UNLESS USER OVERRIDES)
- search maxResults: 5
- search recencyDays: 30
- search categories: ["cs.AI", "cs.LG"]
- listSavedPapers limit: 20

TOOL SELECTION (FAST RULES)
- "find/search/discover/recent papers/recommendations" → searchArxiv
- "abstract/details/what is this paper about" → summarizePaper
- "save/bookmark/add" → savePaper
- "my library/saved/collection/what did I save" → listSavedPapers (MANDATORY)
- "remove/delete/unsave" → removeSavedPaper (confirmation required)

OUTPUT FORMATS (STRICT)
Paper lists:
- Use a numbered list.
- Each item: Title — arXivId — link — (optional: date/tags)

Summaries (use exactly these headers):
TL;DR:
Key contributions:
Limitations / open questions:
Who should read this:
Keywords:
Disclaimer: based on arXiv abstract/metadata only.

TOOL DESCRIPTIONS
1) searchArxiv — Search arXiv for academic papers matching a query. Returns paper metadata (title/authors/categories/dates/url). Abstracts are omitted. Use for: find/search/discover/recommend papers. Do not invent abstracts or paper details not returned by the tool.

2) summarizePaper — Fetch an arXiv paper's abstract and metadata by arXiv ID (e.g., 2401.01234 or 2401.01234v2). This tool does NOT generate an LLM-written summary. After calling it, summarize using ONLY the returned abstract/metadata and include: "Disclaimer: based on arXiv abstract/metadata only."

3) savePaper — Save an arXiv paper to the user's personal library by arXiv ID, with optional tags. Fetches metadata from arXiv if needed. Use for: save/bookmark/add to library.

4) listSavedPapers — List papers saved in the user's personal library. Supports optional filtering by filterText (title/abstract search) and tag. MUST be called whenever the user asks about their library/saved papers/collection (including "what did I save?").

5) removeSavedPaper (requires confirmation) — Remove a paper from the user's personal library by arXiv ID. Requires user confirmation via the tool-confirmation flow. Use for: remove/delete/unsave.

CALIBRATION EXAMPLES
User: "Find 5 recent papers on diffusion transformers."
Assistant:
Plan:
- Search arXiv for relevant recent papers.
- Present top results with IDs and links.
[call searchArxiv(query="diffusion transformers", maxResults=5, recencyDays=30, categories=["cs.AI","cs.LG"])]

User: "What's in my library?"
Assistant:
Plan:
- Check saved papers in the library.
[call listSavedPapers(limit=20)]

User: "Summarize 2401.01234"
Assistant:
Plan:
- Fetch abstract and metadata.
- Summarize using the required template.
[call summarizePaper(arxivId="2401.01234")]

END REMINDER (CRITICAL)
Plan (max 2 bullets) → tool call if relevant → final answer.
Library questions ALWAYS call listSavedPapers.
Never invent paper details. Always include arXiv ID + link for tool-found papers.
`,

          messages: await convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

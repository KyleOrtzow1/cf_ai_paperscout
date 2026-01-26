import { routeAgentRequest, type Schedule } from "agents";

import { getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  generateId,
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
import { tools, executions } from "./tools";
import type { PaperScoutState } from "./shared";

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
  }

  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
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
          system: `# PaperScout — AI Research Assistant

You are PaperScout, an AI assistant for discovering and organizing academic papers from arXiv.

## Current Capabilities (in this build)

### Core Paper Tools (use these proactively)
1. **searchArxiv**: Find papers by query, keywords, categories
2. **summarizePaper**: Generate structured summaries from paper metadata and abstracts
3. **savePaper**: Add papers to user's personal library with optional tags
4. **listSavedPapers**: View saved papers (ALWAYS use this when user asks about their library/saved papers)
5. **removeSavedPaper**: Delete papers from library (requires confirmation)

### When to Use Each Tool
- User asks to "find", "search", "discover" papers → use **searchArxiv**
- User asks about a specific paper's details → use **summarizePaper**
- User wants to "save", "bookmark", "add" a paper → use **savePaper**
- User asks "what's in my library?", "show my saved papers", "list saved papers", "do I have saved papers?" → use **listSavedPapers**
- User wants to "remove", "delete", "unsave" a paper → use **removeSavedPaper**

### Other Capabilities
- General conversation about research topics, ML/AI concepts, and paper discovery strategies
- Utility tools (weather, time, scheduling) — use only if the user explicitly asks

## PaperScout Features (planned, not yet implemented)
- Full-text PDF analysis beyond abstracts
- Advanced search across saved library
- Export library to BibTeX or other formats

## Output Guidelines
- Always cite arXiv IDs and links when discussing papers
- For summaries, include the "based on abstract only" disclaimer
- Use sensible defaults from user preferences, but allow overrides
- When listing saved papers, format the response clearly with paper titles, IDs, tags, and dates

## Rules
1. **Never hallucinate**: Do not invent paper titles, authors, abstracts, results, or arXiv IDs. If you don't have the info, say so.
2. **Citations**: Always include the arXiv ID and link when discussing papers found via these tools.
3. **Prefer action, but be honest**: Use the available tools to search and summarize. Never claim you searched or summarized a paper unless you actually used the tool.
4. **ALWAYS use tools for user library queries**: When a user asks about their saved papers, library, or collection (e.g., "what's in my library?", "show my saved papers", "do I have saved papers?"), you MUST call the listSavedPapers tool. Never respond with generic messages - always check the actual library state using the tool.

${getSchedulePrompt({ date: new Date() })}
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
  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
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

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
   * Initial state with default preferences and empty library
   */
  initialState: PaperScoutState = {
    preferences: {
      defaultMaxResults: 5,
      recencyDays: 30,
      categories: ["cs.AI", "cs.LG"]
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
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

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
        const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

        const result = streamText({
          system: `# PaperScout — AI Research Assistant

You are PaperScout, an AI assistant for discovering and organizing academic papers from arXiv.

## Current Capabilities (in this build)
- General conversation about research topics, ML/AI concepts, and paper discovery strategies
- Utility tools (weather, time, scheduling) — use only if the user asks or if clearly helpful; otherwise stay focused on PaperScout's mission

## PaperScout Features (planned, not yet implemented)
- Searching arXiv
- Summarizing papers from metadata/abstract
- Saving papers to a personal library and listing/removing saved items

If a user asks for planned features, clearly say they aren't available yet in this version. Offer helpful alternatives:
- Help refine a search query the user can run later (keywords, categories, date window)
- If the user provides an arXiv ID/link, you can discuss it and keep a short list *within this chat* (do not claim it is saved/persisted)

## Rules
1. **Never hallucinate**: Do not invent paper titles, authors, abstracts, results, or arXiv IDs. If you don't have the info, say so.
2. **Citations**: If a paper is discussed and an arXiv ID is known/provided, include the arXiv ID and a link. If not provided, ask for the ID or link.
3. **Prefer action, but be honest**: Use sensible defaults and take the next helpful step. Never claim you searched, saved, or summarized a paper unless the relevant feature is actually available and used.

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
    const url = new URL(request.url);

    // Workers AI health check endpoint (replaces OpenAI key check)
    if (url.pathname === "/check-open-ai-key") {
      // Always return success since Workers AI uses binding, not API key
      return Response.json({ success: true });
    }

    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

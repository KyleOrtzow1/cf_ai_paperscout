# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PaperScout is an AI-powered research assistant for discovering and organizing academic papers from arXiv, built on Cloudflare Workers with Durable Objects and Workers AI. This is an MVP implementation demonstrating the Cloudflare Agents SDK with state management, SQLite persistence, and tool-based AI interactions.

## Key Commands

### Development

- `npm start` or `npm run dev` - Start local development server with Vite
- `npm test` - Run Vitest tests
- `npm run check` - Run type checking, linting, and formatting checks
- `npm run format` - Format code with Prettier

### Deployment

- `npm run deploy` - Build and deploy to Cloudflare Workers
- `npx wrangler types env.d.ts` - Generate TypeScript types from Wrangler config

### Testing

- `npm test` - Run all tests
- `npm test -- arxiv.test.ts` - Run specific test file
- `npm test -- --watch` - Run tests in watch mode

Note: Tests use `wrangler.test.jsonc` (without AI binding) to avoid auth requirements in CI.

## Architecture

### Core Components

**PaperScout Agent (Durable Object)**

- Location: `src/server.ts`
- Extends `AIChatAgent<Env, PaperScoutState>` from `@cloudflare/ai-chat`
- Each user gets a persistent agent instance via Durable Objects
- Implements `onStart()` for database initialization and `onChatMessage()` for AI interactions

**State Management**

- **Synced State** (`this.state`): Small UI-friendly data synced to frontend (preferences, library preview)
- **SQL Storage** (`this.sql`): Full paper metadata, summaries, and tags in embedded SQLite
- State shape defined in `src/shared.ts` and synchronized via `this.setState()`

**Routing**

- Worker entry point uses `routeAgentRequest(request, env)` from `agents`
- Maps requests to `/agents/:agent/:name` where `:name` is user ID
- Health check endpoint at `/check-open-ai-key` (legacy name, now checks Workers AI binding)

### Database Schema

Two tables created in `PaperScout.onStart()`:

**saved_papers**

- Primary key: `arxiv_id` (canonical ID without version)
- Stores: title, authors_json, published, updated, abstract, url, tags_json, saved_at
- Indexed on `saved_at` for efficient recent queries

**paper_summaries**

- Primary key: `arxiv_id` (composite key with prompt version: `${arxivId}:${VERSION}`)
- Caches AI-generated summaries to avoid redundant LLM calls
- Invalidated when summary prompt changes

### LLM Integration

**Model**: Llama 3.3 70B Instruct FP8 Fast (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)

- Accessed via Workers AI binding (`env.AI`)
- Uses `ai-sdk` with `workers-ai-provider`
- System prompt emphasizes honesty, citations, and "abstract-only" disclaimers for summaries

**Streaming Pattern**

- `streamText()` from ai-sdk with tool support
- `createUIMessageStream()` for response streaming
- `processToolCalls()` handles human-in-the-loop confirmations
- Max 10 agentic steps via `stopWhen: stepCountIs(10)`

## Tools System

### Tool Definition Pattern

Tools are defined in `src/tools.ts` using `tool()` from ai-sdk:

**Auto-executing tools** (include `execute` function):

- `searchArxiv` - Search arXiv API with filters
- `summarizePaper` - Generate structured paper summary via LLM
- `scheduleTask`, `getScheduledTasks`, `cancelScheduledTask` - Task scheduling
- `getLocalTime` - Example utility tool

**Confirmation-required tools** (omit `execute`, implement in `executions` object):

- `getWeatherInformation` - Example requiring user approval
- Pattern: Tool definition lacks `execute`, handler goes in `executions` export

### Tool Implementation Notes

**searchArxiv**

- Fetches from arXiv Atom API (no auth required)
- Client-side recency filtering by `published` date
- Returns structured `SearchArxivResult` with query context for LLM narration
- Error handling for network and HTTP failures

**summarizePaper**

- Checks SQL cache first using composite key (arxivId + prompt version)
- Fetches paper metadata via `fetchArxivPaperById()`
- Generates summary with specific sections: TL;DR, Key Contributions, Limitations, Target Audience, Keywords
- Includes "based on abstract only" disclaimer
- Caches result in `paper_summaries` table

**Accessing Agent Context**

- Use `getCurrentAgent<PaperScout>()` from `agents` to get agent instance within tool execution
- Access state: `agent!.state.preferences`
- Access SQL: `agent!.sql`
- Access AI binding: `agent!.getAIBinding()`

## arXiv Integration

### Library: `src/lib/arxiv.ts`

**Core Functions**

- `normalizeArxivId()` - Parse IDs/URLs into canonical + versioned forms
- `buildArxivQueryUrl()` - Construct API query with filters
- `parseArxivAtom()` - Parse Atom XML to `ArxivPaper[]` using fast-xml-parser
- `fetchArxivPapers()` - Query arXiv with options
- `fetchArxivPaperById()` - Fetch single paper by ID

**ID Handling**

- Supports new format: `2301.01234v2`
- Supports old format: `cs/9901001v3` or `hep-th/9901001v1`
- Extracts IDs from URLs: `https://arxiv.org/abs/2301.01234v2`
- Canonical form strips version for storage consistency

**Error Types**

- `ArxivNetworkError` - Network/fetch failures
- `ArxivHttpError` - Non-OK HTTP responses from arXiv

**Rate Limiting**

- arXiv requests should be ~1 per 3 seconds (not enforced in MVP)
- Optional `throttleMs` parameter available

**Testing**

- Comprehensive unit tests in `tests/arxiv.test.ts`
- Mocks fetch for offline testing
- Inline XML fixtures for parser validation

## Configuration

### wrangler.jsonc

Key bindings:

- `durable_objects.bindings`: PaperScout class
- `migrations`: MUST include `new_sqlite_classes: ["PaperScout"]` for SQL support
- `ai.binding`: "AI" for Workers AI access
- `observability.enabled`: true for logging

### Environment Setup

1. Copy `.dev.vars.example` to `.dev.vars`
2. No API keys required (Workers AI uses binding)
3. Run `npx wrangler login` for deployment

## Development Workflow

### Adding a New Tool

1. Define tool in `src/tools.ts`:

   ```typescript
   const myTool = tool({
     description: "...",
     inputSchema: z.object({ ... }),
     execute: async ({ param }) => {
       const { agent } = getCurrentAgent<PaperScout>();
       // Access agent!.state, agent!.sql, etc.
       return result;
     }
   });
   ```

2. Add to `tools` export:

   ```typescript
   export const tools = {
     // ... existing tools
     myTool
   } satisfies ToolSet;
   ```

3. If tool requires confirmation, omit `execute` and add to `executions`:
   ```typescript
   export const executions = {
     myTool: async ({ param }) => {
       /* implementation */
     }
   };
   ```

### Modifying System Prompt

System prompt is in `src/server.ts` within `streamText()` call. Key sections:

- Role definition ("You are PaperScout")
- Current capabilities vs. planned features
- Rules (honesty, citations, disclaimers)
- Scheduling instructions via `getSchedulePrompt({ date: new Date() })`

### Changing the LLM Model

Workers AI model is specified in two places:

1. `src/server.ts` - Main chat interactions
2. `src/tools.ts` - `summarizePaper` tool

Change model by updating the parameter to `workersai()`:

```typescript
const model = workersai(
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<typeof workersai>[0]
);
```

Refer to Workers AI documentation for available models.

## Project Structure

```
src/
├── server.ts          # PaperScout agent + Worker entry point
├── tools.ts           # Tool definitions + executions
├── utils.ts           # processToolCalls, cleanupMessages
├── shared.ts          # PaperScoutState type definition
├── app.tsx            # React chat UI
├── styles.css         # Tailwind + custom styles
└── lib/
    ├── arxiv.ts       # arXiv API client
    └── utils.ts       # UI utilities

tests/
├── arxiv.test.ts      # arXiv library tests
└── index.test.ts      # Integration tests
```

## Common Pitfalls

1. **Type Boundaries**: `streamText()` expects specific tool types but base class uses `ToolSet`. Use `as unknown as` cast when passing to `onFinish` callback.

2. **Message Cleanup**: Always call `cleanupMessages()` before passing to `streamText()` to remove incomplete tool calls that cause API errors.

3. **SQL Type Parameters**: Use `this.sql<Type>` with type parameter for type safety, but don't specify array types (returns array automatically).

4. **Agent Context in Tools**: Must use `getCurrentAgent<PaperScout>()` to access agent instance; can't pass as parameter.

5. **Cache Keys**: Summary cache uses composite key (ID + version). Bump `SUMMARY_PROMPT_VERSION` constant when changing prompt to invalidate cache.

6. **Migrations**: The `new_sqlite_classes` array in `wrangler.jsonc` is mandatory for Agent SQL support. Forgetting this causes runtime errors.

## Testing Strategy

- **Unit tests**: arXiv library functions with mocked fetch
- **Integration tests**: Planned for agent workflows (currently minimal)
- **Vitest config**: Uses `@cloudflare/vitest-pool-workers` for Workers-compatible test environment
- **CI/CD**: Test config uses `wrangler.test.jsonc` without AI binding to avoid auth in CI

## Deployment Notes

- `npm run deploy` runs Vite build + Wrangler deploy
- First deploy requires Durable Object migration (automatic via Wrangler)
- Secrets managed via Wrangler (none required for MVP)
- Logs available in Cloudflare dashboard (observability enabled)

## Reference Links

- Cloudflare Agents SDK: https://developers.cloudflare.com/agents/
- Workers AI: https://developers.cloudflare.com/workers-ai/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- arXiv API: https://info.arxiv.org/help/api/

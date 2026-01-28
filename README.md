# PaperScout

An AI-powered research assistant for discovering and organizing academic papers from arXiv, built on Cloudflare Workers with Durable Objects and Workers AI.

## What is PaperScout?

PaperScout is an interactive research assistant that helps you search arXiv for academic papers, read AI-generated summaries, and build a persistent library of papers you're interested in. Every user gets their own isolated agent instance with full SQLite persistence—your library survives page refreshes and browser sessions.

Ask PaperScout to find papers on a topic, and it'll search arXiv and present results. Request a summary of any paper, and it generates one using Llama 3.3 70B. Save interesting papers to your library with custom tags. Query your library later or remove papers you no longer need.

## Features

- 🔍 **arXiv Search** — Query arXiv with date filters and result limits
- 📄 **Paper Summaries** — AI-generated summaries (TL;DR, Key Contributions, Limitations) with abstract-only disclaimers
- 📚 **Persistent Library** — Save papers to your personal library with SQLite backing; data survives page refreshes
- 🏷️ **Tagging** — Organize papers with custom tags
- 💬 **Multi-turn Chat** — Natural language interaction with state persistence
- ⚡ **Streaming Responses** — Real-time response streaming for a snappy UX
- 🛠️ **Tool-based Interactions** — Confirmation prompts for destructive operations (e.g., removing papers)
- 🔐 **User Isolation** — Each user gets their own Durable Object instance with no shared state

## Tech Stack

- **Backend:** Cloudflare Workers + Durable Objects (state + SQL persistence)
- **AI/LLM:** Workers AI (Llama 3.3 70B Instruct FP8 Fast) via ai-sdk
- **Frontend:** React + Tailwind CSS
- **API Integration:** arXiv Atom API (no authentication required)
- **Framework:** Cloudflare Agents SDK

## Prerequisites

- Cloudflare account (free tier supported)
- Node.js 18+ and npm
- Git

**No OpenAI key or other external API credentials needed** — Workers AI is included with Cloudflare Workers.

## Local Development

1. **Clone the repository:**

```bash
git clone https://github.com/yourusername/cf_ai_paperscout
cd cf_ai_paperscout
```

2. **Install dependencies:**

```bash
npm install
```

3. **Start the local dev server:**

```bash
npm start
```

The app will be available at `http://localhost:8787`. Vite will handle hot reloads as you edit files.

**No `.dev.vars` file needed** — Workers AI is configured via the `wrangler.jsonc` binding.

4. **Run tests (optional):**

```bash
npm test
```

Tests use `wrangler.test.jsonc` (without AI binding) for CI compatibility.

## Deployment

1. **Authenticate with Cloudflare (first time only):**

```bash
npx wrangler login
```

2. **Deploy:**

```bash
npm run deploy
```

This runs Vite build + Wrangler deploy. The first deployment will create the Durable Object class automatically.

After deployment, note the Worker URL and update this section with it.

**Deployed URL:** https://cf_ai_paperscout.kyleortzow.workers.dev/

## Sample Prompts

Try these example queries once the app is running:

1. **Search for recent papers:**

   > "Find 5 recent papers about diffusion transformers"

2. **Get a summary:**

   > "Summarize paper #2"

3. **Save with tags:**

   > "Save #3 with tags: diffusion, transformers, vision"

4. **List your library:**

   > "Show my saved papers"

5. **Query your library:**

   > "What have I saved about transformers?"

6. **Remove from library:**

   > "Remove the first paper from my library"

7. **Search and save in one go:**
   > "Find papers about stable diffusion published in the last month and save the top 3"

## Architecture

### Agent per User

Each user gets their own `PaperScout` Durable Object instance, providing isolation and persistent state. The agent maintains:

- **Synced State:** Small UI-friendly data (preferences, library preview) synchronized to the frontend
- **SQL Storage:** Full paper metadata, summaries, and tags in embedded SQLite

### Tool System

PaperScout exposes these AI tools:

| Tool               | Purpose                                             | Auto-execute?            |
| ------------------ | --------------------------------------------------- | ------------------------ |
| `searchArxiv`      | Search arXiv with query, filters, and result limits | ✅ Yes                   |
| `summarizePaper`   | Generate structured summary from abstract           | ✅ Yes                   |
| `savePaper`        | Add paper to library with tags                      | ✅ Yes                   |
| `listSavedPapers`  | Query user's saved paper library                    | ✅ Yes                   |
| `removeSavedPaper` | Remove paper from library                           | ❌ Requires confirmation |

### State Management

**Synced State** (frontend receives):

- User preferences
- Library preview (most recent saved papers for UI sidebar)

**SQL Storage** (backend only):

- Full `saved_papers` table with arxiv_id, title, authors, abstract, url, tags, saved_at
- `paper_summaries` cache table to avoid redundant LLM calls

### LLM Integration

- **Model:** Llama 3.3 70B Instruct FP8 Fast via Cloudflare Workers AI
- **Framework:** ai-sdk with workers-ai-provider
- **System Prompt:** Emphasizes honesty, citations, and "abstract-only" disclaimers for summaries
- **Streaming:** `streamText()` with up to 10 agentic reasoning steps

### arXiv Integration

- **API:** arXiv Atom API (no authentication)
- **Parsing:** Fast XML parser for Atom feed
- **ID Support:** Both new (`2301.01234v2`) and old (`cs/9901001v1`) arXiv ID formats
- **Rate Limiting:** Respects arXiv's ~1 request per 3 seconds guideline (not enforced in MVP)

## Project Structure

```
cf_ai_paperscout/
├── src/
│   ├── server.ts          # PaperScout agent + Worker entry point
│   ├── app.tsx            # React chat UI
│   ├── tools.ts           # Tool definitions and auto-execute implementations
│   ├── utils.ts           # Utility functions (processToolCalls, cleanupMessages)
│   ├── shared.ts          # Shared types (PaperScoutState)
│   ├── styles.css         # Tailwind + custom styles
│   └── lib/
│       ├── arxiv.ts       # arXiv API client (fetch, parse, normalize IDs)
│       ├── storage.ts     # Safe localStorage/sessionStorage fallbacks
│       └── utils.ts       # UI utilities
├── tests/
│   ├── arxiv.test.ts      # Unit tests for arXiv library
│   └── index.test.ts      # Integration tests
├── public/
│   └── index.html         # HTML entry point
├── wrangler.jsonc         # Cloudflare Workers configuration
├── vite.config.ts         # Vite build configuration
└── package.json
```

## Key Files

- **`src/server.ts`:** PaperScout agent class (Durable Object), system prompt, and Worker entry point
- **`src/tools.ts`:** Tool definitions using ai-sdk `tool()` API
- **`src/app.tsx`:** React component for chat UI and library sidebar
- **`src/lib/arxiv.ts`:** arXiv API client with ID normalization and XML parsing

## Testing

Run tests with:

```bash
npm test
```

Run tests in watch mode:

```bash
npm test -- --watch
```

Run a specific test file:

```bash
npm test -- arxiv.test.ts
```

Tests use `wrangler.test.jsonc` without the AI binding for CI compatibility.

## Development Workflow

### Adding a New Tool

1. Define the tool in `src/tools.ts` using `tool()` from ai-sdk:

```typescript
const myTool = tool({
  description: "What this tool does",
  inputSchema: z.object({
    param: z.string().describe("Parameter description")
  }),
  execute: async ({ param }) => {
    // Access agent context if needed:
    // const { agent } = getCurrentAgent<PaperScout>();
    return result;
  }
});
```

2. Add to the `tools` export.

3. If the tool requires user confirmation, omit the `execute` function and add to the `executions` object in `src/tools.ts`.

### Modifying the System Prompt

Edit the system prompt in `src/server.ts` within the `streamText()` call. The prompt defines PaperScout's behavior, capabilities, and response style.

### Changing the LLM Model

Update the model in two places:

1. `src/server.ts` — Main chat interactions
2. `src/tools.ts` — `summarizePaper` tool

Change the parameter to `workersai()`:

```typescript
const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
```

See [Cloudflare Workers AI documentation](https://developers.cloudflare.com/workers-ai/) for available models.

## Error Handling

PaperScout implements comprehensive error handling:

- **Storage Fallbacks:** Gracefully falls back from localStorage → sessionStorage → memory if storage is unavailable (e.g., private browsing)
- **React Error Boundary:** Catches and displays rendering errors with recovery options
- **Message Send Errors:** Failed messages are restored to the input field with an error notification
- **AI Binding Validation:** Checks for Workers AI binding at startup and provides clear error messages if misconfigured

## Troubleshooting

### "Workers AI binding not configured"

**Solution:** Ensure `wrangler.jsonc` has the AI binding:

```jsonc
"ai": {
  "binding": "AI"
}
```

Then redeploy with `npm run deploy`.

### App doesn't work in private browsing

**Solution:** The app now uses safe storage utilities that automatically fall back to sessionStorage or memory. You'll see a warning banner if non-persistent storage is used.

### Tests fail with "Workers AI binding not found"

**Solution:** This is expected in CI. Tests use `wrangler.test.jsonc` which doesn't include the AI binding. This is intentional to keep CI fast and avoid auth requirements.

### Connection state stuck on "Connecting..."

**Solution:** Check the browser console for errors. Verify that:

1. Durable Object is configured in `wrangler.jsonc`
2. Workers AI binding is configured
3. Try refreshing the page

## Environment Variables

No environment variables are required for local development or deployment. Workers AI uses the binding configured in `wrangler.jsonc`.

## Building for Production

```bash
npm run build
```

This runs Vite build. For deployment, use `npm run deploy` which builds and deploys in one step.

## Learn More

- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [ai-sdk Documentation](https://sdk.vercel.ai/)
- [arXiv API Documentation](https://info.arxiv.org/help/api/)

## License

MIT

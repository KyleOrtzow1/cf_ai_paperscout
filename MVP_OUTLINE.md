## 1) MVP outcomes (what “done” looks like)

### Core user stories

1. **Find papers**

* “Find 5 recent papers about *diffusion transformers*”
* Returns a compact ranked list with title, authors, date, arXiv ID, and link.

2. **Summarize a paper**

* “Summarize paper #2”
* Returns a structured output (TL;DR, key contributions, limitations, what to read next, “based on abstract” disclaimer).

3. **Save to library**

* “Save #2 with tags: diffusion, transformers”
* Persists the paper metadata + your tags + (optionally) the summary.

4. **Recall from memory/state**

* “What have I saved about diffusion in the last month?”
* “Show my saved list”
* Results come from the Agent’s built-in SQL storage and synced state. Agents have built-in persisted state and a built-in SQLite API (`this.sql`). ([Cloudflare Docs][1])

### MVP non-goals (avoid scope creep)

* PDF ingestion, embeddings/vector search
* Multi-user auth
* “Read the full paper” deep extraction
* Voice input (we’ll list as a Phase 2 enhancement)

---

## 2) Tech stack (simple, functional, Cloudflare-native)

### Cloudflare platform pieces

* **Cloudflare Workers**: entrypoint HTTP handler + asset hosting + routing to your agent instance. ([Cloudflare Docs][2])
* **Cloudflare Agents SDK** (runs on **Durable Objects**): the stateful “PaperScout” agent per user/session. Agents require Durable Objects bindings + migrations. ([Cloudflare Docs][3])
* **Workers AI**: LLM inference with **Llama 3.3** via binding on `env.AI`. ([Cloudflare Docs][4])
* **(Optional later) Workflows**: for scheduled digests / long-running pipelines (Phase 2).

### LLM + agent dev libraries

* **ai-sdk** (`ai`, `@ai-sdk/react`): streaming + tool calling patterns (matches the Agents starter design).
* **workers-ai-provider**: plugs Workers AI into ai-sdk. ([GitHub][5])
* **agents**: core Agent + React hooks (`useAgent`, `useAgentChat`) and routing helpers. ([Cloudflare Docs][2])
* **zod**: tool input validation (keep tool calls safe + predictable).
* **fast-xml-parser** (or similar): parse arXiv Atom XML into JSON (arXiv results are Atom).

### Frontend

* **React** chat UI from the `cloudflare/agents-starter` template (already wired for agent chat hooks). ([GitHub][6])
* Minimal UI additions:

  * “Library” side panel fed by agent state sync
  * “Save” actions surfaced via chat/tool confirmations

---

## 3) Project scaffold (what you’ll actually generate)

### Repo name and required files (per application requirements)

* Repo name: **`cf_ai_paperscout`**
* Must include:

  * `README.md` with clear run + deploy instructions
  * `PROMPTS.md` with AI prompts you used while coding (keep it honest + chronological)

### Base template to start from

Use the Cloudflare Agents starter template:

```bash
npx create-cloudflare@latest --template cloudflare/agents-starter
npm install
npm start
npm run deploy
```

(These are the standard “ship your first Agent” steps Cloudflare documents.) ([Cloudflare Docs][7])

---

## 4) Architecture (MVP)

### High-level diagram

**Browser (React UI)**
↕ WebSocket + HTTP
**Worker (fetch handler)** → `routeAgentRequest()` → **PaperScout Agent (Durable Object)**
↕
**Workers AI (Llama 3.3)** + **arXiv API**
↕
**Agent built-in SQLite (`this.sql`) + Agent state (`this.setState`)**

### Routing to your agent instance

You’ll use `routeAgentRequest`, which maps requests to `/agents/:agent/:name`, where `:agent` is your Agent class name in kebab-case and `:name` is the instance name (we’ll use a user/session id). ([Cloudflare Docs][2])

### State + persistence

* **Persistent storage:** Agent’s embedded SQLite via `this.sql` (per-agent instance, effectively zero-latency in the agent). ([Cloudflare Docs][1])
* **Synced UI state:** Agent `this.setState` to publish “library preview” and preferences to the UI in real time. ([Cloudflare Docs][1])

---

## 5) Workers + Wrangler config (minimum needed)

### 5.1 Durable Object binding + migrations (required)

Your `wrangler.jsonc` must include:

* `durable_objects.bindings`
* `migrations` with `new_sqlite_classes` (mandatory for Agent state storage) ([Cloudflare Docs][3])

Example shape (adapt names):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf_ai_paperscout",
  "main": "src/server.ts",
  "compatibility_date": "2025-02-23",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "PaperScout", "class_name": "PaperScout" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["PaperScout"] }
  ],
  "observability": { "enabled": true },
  "ai": { "binding": "AI" }
}
```

* The **AI binding** block is the standard way to bind Workers AI so you can call `env.AI`. ([Cloudflare Docs][4])

---

## 6) LLM choice + calling pattern

### Model

Use **Llama 3.3 70B Instruct** on Workers AI:

* **Model ID:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` ([Cloudflare Docs][8])

### Provider approach (keep it simple)

Use **ai-sdk** + **workers-ai-provider** (this matches the starter’s documented “switch to Workers AI” path). ([GitHub][5])

### Prompting strategy (MVP)

You’ll have:

* A **system prompt** that defines:

  * You are PaperScout
  * Always cite arXiv IDs/links when recommending papers
  * Summaries must say **“based on abstract + metadata”**
  * Ask a single follow-up question only when needed (but prefer acting with defaults)

* A **tool policy**:

  * Use tools for: arXiv search, fetch by id, save, list, delete
  * Never hallucinate paper details; if not in metadata/abstract, say so

---

## 7) PaperScout Agent: MVP behavior spec

### 7.1 Agent instance identity

* Frontend generates a stable `userId` (UUID) in `localStorage`.
* Connect with:

  * `agent: "paper-scout"` (kebab-case of `PaperScout`)
  * `name: userId`
    This matches the Agents client convention (`name` defaults to `"default"` if omitted, but we want stable per-user memory). ([Cloudflare Docs][9])

### 7.2 Agent state shape (synced to UI)

Keep the synced state small and UI-friendly:

```ts
type PaperScoutState = {
  preferences: {
    defaultMaxResults: number;   // default 5
    recencyDays: number;         // default 30
    categories: string[];        // default ["cs.AI", "cs.LG"]
  };
  libraryPreview: Array<{
    arxivId: string;
    title: string;
    savedAt: number;
    tags: string[];
  }>;
};
```

### 7.3 Agent SQL schema (persistent)

Use `this.sql` to create tables (run once on startup or lazily on first use). Agents SQL supports normal SQLite DDL like `CREATE TABLE IF NOT EXISTS ...`. ([Cloudflare Docs][9])

**Tables**

1. `saved_papers`

* `arxiv_id TEXT PRIMARY KEY`
* `title TEXT`
* `authors_json TEXT`
* `published TEXT`
* `updated TEXT`
* `abstract TEXT`
* `url TEXT`
* `tags_json TEXT`
* `saved_at INTEGER`

2. `paper_summaries`

* `arxiv_id TEXT PRIMARY KEY`
* `summary_md TEXT`
* `created_at INTEGER`

(Keep it normalized enough that you can update summaries without rewriting paper metadata.)

---

## 8) Tooling spec (the “AI-powered app” core)

You’ll define tools using ai-sdk’s `tool(...)` and zod schemas (same pattern as the starter). ([GitHub][10])

### Tools to implement in MVP

#### Tool: `searchArxiv`

**Input**

* `query: string`
* `maxResults?: number` (default from preferences)
* `recencyDays?: number` (default from preferences)
* `categories?: string[]` (default from preferences)

**Output**

* list of `{ arxivId, title, authors[], published, abstract, url }`

**Implementation notes**

* Call arXiv Atom API (no key required).
* Parse XML → objects.
* Filter by recency client-side (arXiv returns dates).

#### Tool: `summarizePaper`

**Input**

* `arxivId: string`

**Output**

* `summaryMd: string`

**LLM prompt shape**

* Provide title/authors/date + abstract
* Required output sections:

  * TL;DR (1–2 sentences)
  * Key contributions (bullets)
  * Limitations / open questions (bullets)
  * Who should read this
  * Related keywords
  * Disclaimer: “based on abstract/metadata”

#### Tool: `savePaper`

**Input**

* `arxivId: string`
* `tags?: string[]`

**Output**

* `{ ok: true }`

**Behavior**

* Upsert into `saved_papers`
* Update `libraryPreview` state to reflect latest saves (top 20)

#### Tool: `listSavedPapers`

**Input**

* `filterText?: string`
* `tag?: string`
* `limit?: number` (default 20)

**Output**

* list of saved items (light metadata)

#### Tool: `removeSavedPaper` (confirmation recommended)

**Input**

* `arxivId: string`

**Output**

* `{ ok: true }`

**Why confirmation?**
The starter pattern supports “tools requiring user confirmation” (omit `execute` and implement in the `executions` map so the UI can ask the user). ([GitHub][10])

---

## 9) Frontend MVP spec

You are keeping the starter chat UI, but you’ll make 3 practical tweaks:

### 9.1 Remove OpenAI-key gating

The starter includes a “check OpenAI key” flow and a `HasOpenAIKey` component in the UI. You’ll remove/replace this because Workers AI uses an `AI` binding instead (no OpenAI key).
(You’ll keep a small “status check” endpoint if you want, but it should verify the Worker has `env.AI` bound, not `OPENAI_API_KEY`.)

### 9.2 Stable agent instance

In `app.tsx` you’ll pass a stable `name` to `useAgent` so your library persists across refreshes (via the same DO instance). The UI is already built around `useAgent` + `useAgentChat`. ([GitHub][6])

### 9.3 Library side panel (synced state)

Render `state.libraryPreview` on the left:

* Click item → open arXiv link in new tab
* Optional: “Summarize” and “Remove” buttons that send chat commands (or call tools directly)

This demonstrates “memory/state” in a way reviewers can see instantly.

---

## 10) Windows 11 setup assumptions (what you need before coding)

### Required

* **Node.js** (LTS is safest)
* **Git**
* A **Cloudflare account** and Wrangler login (for running Workers AI + deploying)

### Recommended

* VS Code
* A terminal you’re comfortable with (PowerShell is fine)

### Project bootstrap commands (Windows-friendly)

```powershell
# create repo folder (or do this in GitHub first)
npx create-cloudflare@latest --template cloudflare/agents-starter

cd <your-project>
npm install

# login once
npx wrangler login

# run locally
npm start
```

These steps match Cloudflare’s documented “ship your first Agent” flow. ([Cloudflare Docs][7])

---

## 11) MVP deliverables checklist for your README

Your `README.md` should include, at minimum:

* What PaperScout does (2–3 sentences)
* MVP feature list
* Local run steps (`npm install`, `npm start`)
* How to deploy (`npm run deploy`) ([Cloudflare Docs][7])
* How to use in the UI (example prompts)
* What you used for:

  * LLM: Llama 3.3 on Workers AI (model id)
  * State: Agent state + `this.sql`
  * Coordination: Durable Object Agent + tool calling

And `PROMPTS.md` should include:

* The prompts you used to generate/refactor code
* The prompts you used to shape system prompts / tool behavior
* Notes on what you changed manually afterward

---

# Task checklist (in build order)

## A) Repo + Cloudflare project setup

1. Create GitHub repo named **`cf_ai_paperscout`**
2. Generate project with `create-cloudflare` using `cloudflare/agents-starter` ([Cloudflare Docs][7])
3. Commit the vanilla template as “baseline”
4. Update `wrangler.jsonc`:

   * add `PaperScout` durable object binding
   * add migrations with `new_sqlite_classes`
   * add Workers AI binding `"ai": { "binding": "AI" }` ([Cloudflare Docs][3])

## B) Backend: Agent skeleton + persistence

5. Rename/implement the Agent class: `PaperScout extends Agent`
6. Add `initialState` with default preferences + empty libraryPreview
7. Add SQL setup method that creates `saved_papers` + `paper_summaries` tables using `this.sql` ([Cloudflare Docs][9])
8. Wire Worker `fetch` to `routeAgentRequest(request, env)` so `/agents/:agent/:name` works ([Cloudflare Docs][2])

## C) LLM integration (Workers AI)

9. Switch model calls to Workers AI (ai-sdk + workers-ai-provider) ([GitHub][5])
10. Add the PaperScout system prompt + formatting rules (summary template, “abstract-only” disclaimer)

## D) arXiv ingestion

11. Implement arXiv fetch + Atom XML parsing (library + unit test)
12. Implement tool: `searchArxiv` (query → results list)
13. Implement tool: `summarizePaper` (arxivId → structured markdown summary)

## E) Library + memory/state UX

14. Implement tool: `savePaper` (upsert into SQL, update libraryPreview via `this.setState`) ([Cloudflare Docs][1])
15. Implement tool: `listSavedPapers` (SQL query + formatted response)
16. Implement tool: `removeSavedPaper` using confirmation flow (UI tool confirmation pattern) ([GitHub][10])

## F) Frontend polish (minimal but impressive)

17. Remove OpenAI-key checks and related UI gating (since you’re on Workers AI)
18. Add stable `userId` + pass `name: userId` into `useAgent`
19. Add Library side panel driven by synced agent state

## G) Docs + submission readiness

20. Write `README.md` with:

* local run
* deploy
* sample prompts
* architecture notes

21. Write `PROMPTS.md` (copy/paste prompts you used during coding)
22. Add a short demo GIF (optional, but helps a lot)

## H) Deploy

23. `npm run deploy` and add deployed link to README ([Cloudflare Docs][7])
24. Verify the deployed app works end-to-end (search → summarize → save → list)
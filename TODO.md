# PaperScout MVP Task Checklist

## A) Repo + Cloudflare project setup

- [x] 1. Create GitHub repo named `cf_ai_paperscout`
- [x] 2. Generate project with `create-cloudflare` using `cloudflare/agents-starter`
- [x] 3. Commit the vanilla template as "baseline"
- [x] 4. Update `wrangler.jsonc`:
  - [x] Add `PaperScout` durable object binding
  - [x] Add migrations with `new_sqlite_classes`
  - [x] Add Workers AI binding `"ai": { "binding": "AI" }`

## B) Backend: Agent skeleton + persistence

- [x] 5. Rename/implement the Agent class: `PaperScout extends Agent`
- [x] 6. Add `initialState` with default preferences + empty libraryPreview
- [x] 7. Add SQL setup method that creates `saved_papers` + `paper_summaries` tables using `this.sql`
- [x] 8. Wire Worker `fetch` to `routeAgentRequest(request, env)` so `/agents/:agent/:name` works

## C) LLM integration (Workers AI)

- [x] 9. Switch model calls to Workers AI (ai-sdk + workers-ai-provider)
- [x] 10. Add the PaperScout system prompt + formatting rules (summary template, "abstract-only" disclaimer)

## D) arXiv ingestion

- [ ] 11. Implement arXiv fetch + Atom XML parsing (library + unit test)
- [ ] 12. Implement tool: `searchArxiv` (query → results list)
- [ ] 13. Implement tool: `summarizePaper` (arxivId → structured markdown summary)

## E) Library + memory/state UX

- [ ] 14. Implement tool: `savePaper` (upsert into SQL, update libraryPreview via `this.setState`)
- [ ] 15. Implement tool: `listSavedPapers` (SQL query + formatted response)
- [ ] 16. Implement tool: `removeSavedPaper` using confirmation flow (UI tool confirmation pattern)

## F) Frontend polish (minimal but impressive)

- [ ] 17. Remove OpenAI-key checks and related UI gating (since you're on Workers AI)
- [ ] 18. Add stable `userId` + pass `name: userId` into `useAgent`
- [ ] 19. Add Library side panel driven by synced agent state

## G) Docs + submission readiness

- [ ] 20. Write `README.md` with:
  - [ ] Local run instructions
  - [ ] Deploy instructions
  - [ ] Sample prompts
  - [ ] Architecture notes
- [ ] 21. Write `PROMPTS.md` (copy/paste prompts you used during coding)
- [ ] 22. Add a short demo GIF (optional, but helps a lot)

## H) Deploy

- [ ] 23. `npm run deploy` and add deployed link to README
- [ ] 24. Verify the deployed app works end-to-end (search → summarize → save → list)

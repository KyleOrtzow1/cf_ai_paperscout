# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the Cloudflare Worker + UI: `server.ts` (agent + Durable Object), `tools.ts` (tooling), `app.tsx` (React UI), `styles.css`, and helpers in `lib/`.
- `tests/` holds Vitest tests (`*.test.ts`) and a test `tsconfig.json`.
- `public/` is static assets; `patches/` contains `patch-package` fixes.
- Config lives in `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts`, `biome.json`, and `.prettierrc`.

## Build, Test, and Development Commands
- `npm run dev` / `npm start`: run Vite dev server.
- `npm run deploy`: build and deploy via Wrangler.
- `npm test`: run Vitest; add `-- --watch` for watch mode.
- `npm run check`: run Prettier check, Biome lint, and `tsc`.
- `npm run format`: apply Prettier formatting.
- `npx wrangler types env.d.ts`: regenerate Worker env types.

## Coding Style & Naming Conventions
- TypeScript + React; prefer double quotes.
- Indentation uses tabs (see `biome.json`); Prettier disables trailing commas.
- Files follow `kebab-case` for directories and `camelCase` or `PascalCase` for TS/TSX modules.
- Run `npm run check` before PRs to match CI.

## Testing Guidelines
- Framework: Vitest with `@cloudflare/vitest-pool-workers`.
- Tests live in `tests/` and are named `*.test.ts` (e.g., `tests/arxiv.test.ts`).
- CI runs `npm test -- --run` using `wrangler.test.jsonc` (no AI binding).

## Commit & Pull Request Guidelines
- Commit history favors Conventional Commits (`feat:`, `chore:`, `ci:`), though some messages are plain sentences. Prefer the prefix style for new work.
- PRs should include a short summary, testing notes (commands + results), and screenshots if UI changes are involved.
- Ensure CI passes: `npm run check`, `npm test -- --run`, and `npx vite build`.

## Configuration Notes
- Copy `.dev.vars.example` to `.dev.vars` for local development.
- Workers AI binding is configured in `wrangler.jsonc` (`ai.binding = "AI"`).

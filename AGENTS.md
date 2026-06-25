# Sketch

Org-level AI assistant — single deployment, multiple users, each with isolated workspace, memory, and tool auth. Multi-channel support (Slack now, WhatsApp planned).

## Architecture

- Single Node.js process: Hono HTTP server + Slack Bolt + agent runner
- Claude Agent SDK as agent runtime (built-in tools, sessions, compaction, MCP)
- Kysely query builder with SQLite (default), Postgres planned
- Workspace isolation via `canUseTool` path validation + system prompt enforcement
- `permissionMode: "default"` — all tool calls go through `canUseTool` (no `allowedTools` bypass)

## Tech Stack

TypeScript, Node.js 24, pnpm monorepo, Hono, Kysely, Biome, pino, zod, tsdown, tsx

## Node Version Management

- `.node-version` specifies Node 24
- Local dev (macOS): **nvm** — auto-switches via `.node-version`
- EC2 server: **fnm** — auto-switches via `.node-version` (still on Node 22, pending upgrade)
- Claude Code's shell does NOT auto-load nvm/fnm, so it defaults to `/opt/homebrew/bin/node`. Currently this is also Node 24, so no prefix needed. If versions ever diverge again, prefix commands with: `. /Users/rnijhara/.nvm/nvm.sh && nvm use > /dev/null 2>&1 &&`

## Project Structure

```
sketch/
  .env                  → config (repo root, gitignored)
  .env.example          → documented env vars
  data/                 → runtime data (gitignored)
    sketch.db           → SQLite database
    workspaces/{uid}/   → per-user workspace dirs
  .planning/            → internal dev docs (git submodule: sketch-internal-planning)
    STATE.md            → current state + next steps
    STEEL_THREAD.md     → steel thread implementation plan (done)
  packages/
    server/src/
      index.ts          → entry point, wires everything
      config.ts         → zod + dotenv config validation
      logger.ts         → pino logger factory
      http.ts           → Hono app with /health
      queue.ts          → per-channel in-memory message queue
      slack/
        bot.ts            → Slack Bolt adapter (Socket Mode, DMs, mentions, passive thread listener)
        thread-buffer.ts  → in-memory thread message buffer for context between @mentions
        user-cache.ts     → in-memory cache for Slack getUserInfo lookups
      agent/
        runner.ts       → runAgent() — Claude Agent SDK query() with canUseTool
        prompt.ts       → buildSystemContext() + formatBufferedContext() for prompts
        workspace.ts    → ensureWorkspace() creates user dirs
        sessions.ts     → session ID persistence (per-workspace or per-thread)
      db/
        index.ts        → createDatabase() with SQLite + WAL
        schema.ts       → DB type interface (users table)
        migrate.ts      → static migration imports (bundler-safe)
        migrations/     → Kysely migrations
        repositories/   → query functions (users.ts)
    shared/src/         → shared types (placeholder)
```

## Conventions

- RESTful API design: resource-oriented URLs (no verbs in paths), correct HTTP methods (GET for reads, POST for creation, PUT for idempotent upserts, PATCH for partial updates, DELETE for removal). Use nouns for resources (e.g. `POST /api/users/:id/verification` not `POST /api/users/:id/send-verification`).
- Biome for linting and formatting (2-space indent, 120 line width)
- Strict TypeScript (`strict: true`)
- Conventional commits: `feat:`, `fix:`, `chore:`
- Branch names must use work-type prefixes such as `feat/`, `fix/`, or `chore/`; use `feat/` for feature work.
- pino for structured JSON logging — never log message content
- zod + dotenv for config validation (`import "dotenv/config"`, .env at repo root)
- Kysely migrations run at app startup (static imports, not FileMigrationProvider)
- Database code must stay compatible with both SQLite and Postgres. When writing queries, repository methods, migrations, constraints, or database error handling, prefer portable Kysely patterns; if dialect-specific behavior is unavoidable, handle both dialects and add coverage for the difference.
- No inline comments. Use docstrings to explain decisions when the code isn't self-evident.
- Vitest for testing — see **Testing** below for the unit/integration tier split and which suffix new test files get
- Run `pnpm dev` from repo root — tsx watches `packages/server/src/index.ts`
- At the end of every feature, run all quality checks: `pnpm biome check`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- Do not use `npx tsc --noEmit` from the repo root. There is no root `tsconfig.json`, so use `pnpm typecheck` instead.
- Release rule: only create release tags from commits that are already on `main`. Do not tag feature branches. If release prep is done on another branch, merge or cherry-pick it onto `main` first, then create the tag from `main`.
- Deployment rule: only trigger release/deploy workflows from `main` (or tags created from `main`).

## Testing

Vitest, three projects per package by filename suffix. Default to plain unit; the others are forced by the rules below.

- `*.integration.test.{ts,tsx}` — uses PGlite (`createTestPgDb`), a real subprocess, or a real socket/browser. Heavy; excluded from the everyday run.
- `*.isolated.test.{ts,tsx}` — mutates worker-global state that would leak under `isolate: false`: `vi.mock()`, `vi.useFakeTimers()`, its own MSW `setupServer`, or any unrestored global stub. (Local-only `vi.fn`/`vi.spyOn` and shared `server.use()` stay plain.) `test-isolation-guard.test.ts` fails the build if a `vi.mock` file lacks the suffix.
- `*.test.{ts,tsx}` — everything else (default). When unsure, use this; the guard catches a stray `vi.mock`.

**MSW (web):** override per-test via `server.use(...)` (from `@/test/msw`) in `beforeEach`; never make a second `setupServer`. Server runs `onUnhandledRequest: "error"`, so every endpoint a rendered component hits needs a handler in `src/test/msw.ts` or a per-test `server.use`.

**Postgres integration tests:** acquire the DB from the worker-shared `getSharedPgDb()` with per-test `BEGIN`/`ROLLBACK`, not a fresh `createTestPgDb()` per test; reserve a fresh `createTestPgDb()` for schema/DDL/migration tests or ones that open their own `.transaction()`.

**Avoiding flaky tests:** drain streamed response bodies (`await res.text()`) before asserting on side effects (the work may run inside the stream body); prefer `vi.waitFor` over fixed `setTimeout` sleeps; restore timers in `afterEach` (`vi.useRealTimers()`) whenever a test uses fake timers under `isolate:false`; never assert on wall-clock ordering/duration or on unsorted DB/`readdir` order (use `>=`/`<=`, `ORDER BY`, or `.sort()`).

**Commands:** `pnpm test:changed` (per-iteration, affected unit tests) · `pnpm test:unit` (full unit tier, no integration) · `pnpm test` (everything; enforced by the pre-push hook and CI).

## Key Design Decisions

- Platform formatting via system prompt only, no post-processing
- Three-layer prompt: Claude Code preset → user's CLAUDE.md in workspace → platform/org context via `systemPrompt.append`
- Per-user workspace at `data/workspaces/{user_id}/` with session.json; per-channel workspace at `data/workspaces/channel-{id}/` with per-thread sessions at `sessions/{threadTs}.json`
- `canUseTool` validates all tool calls: file tools check path within workspace, Bash checks for absolute paths outside workspace, non-permitted tools denied
- `permissionMode: "default"` with no `allowedTools` — ensures `canUseTool` is always called (`allowedTools` bypasses `canUseTool`)
- In-memory per-channel message queue (sequential processing, one agent run at a time per channel)
- LLM access: Anthropic API, Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex, or custom `ANTHROPIC_BASE_URL`
- Static migration imports instead of FileMigrationProvider (for tsdown bundler compatibility)
- `CURRENT_TIMESTAMP` in migrations for cross-dialect compatibility (SQLite + Postgres)

## Feature Gating (`EXPERIMENTAL_FLAG`)

New features that aren't ready for general availability are gated behind `config.EXPERIMENTAL_FLAG` (env var, defaults to `false`). If the flag is off, the feature must be **completely invisible** — no routes, no tools, no prompt references, no UI. Gate at all 4 layers:

1. **HTTP routes** (`http.ts`): Wrap new API routes in `if (config.EXPERIMENTAL_FLAG) { app.route(...) }`
2. **Agent tools** (`sketch-tools.ts`): Conditionally include tools using the spread pattern:
   ```ts
   ...(deps.experimentalFlag
     ? [tool("MyTool", ...), tool("AnotherTool", ...)]
     : ([] as ReturnType<typeof tool>[])),
   ```
3. **System prompt** (`prompt.ts`): Wrap any instructions referencing experimental tools in `if (params.experimentalFlag) { ... }` so the agent isn't told about tools it can't use
4. **Frontend** (`app-sidebar.tsx`): Hide navigation items using `setupStatus.experimentalFlag`

The flag flows: `config` → `bootstrap.ts` (injected in `trackedRunAgent`) → `RunAgentParams` → both `SketchMcpDeps` (tools) and `buildSystemContext` (prompt).

## Related Repos

- **sketch-platform** (`~/Projects/sketch-platform/`, `canvasxai/sketch-platform`, private): Management plane for the managed offering. Separate pnpm monorepo with `packages/api/` (backend), `packages/web/` (frontend), `packages/infra/` (CDK, planned). Planning docs for both repos live here in `.planning/`.

## Dev Workflow

Internal planning docs live in `.planning/` (git submodule, separate private repo `sketch-internal-planning`):

- **STATE.md** — current project state, what's done, next steps, current version. Updated when releasing a new version/tag.
- **Task files** — one per feature/story (e.g., `STEEL_THREAD.md`, `WHATSAPP_ADAPTER.md`). Implementation plans with phases. Become historical reference once done.
- **TODO.md** — tracked todos and backlog items. Lives in `.planning/TODO.md`.

Completed task files stay in `.planning/` — useful context when revisiting related areas.

**Implementation workflow:**

1. Discuss the change and agree on the approach
2. Implement the plan
3. Commit, done. Update STATE.md only when releasing a new version/tag.

## Reference

Current state: `.planning/STATE.md`

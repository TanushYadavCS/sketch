# Changelog

All notable changes to this project are documented here.

## [0.25.1] -- 2026-05-03

- Runtime: upgrade Claude Agent SDK to the stable `0.2.118` line, picking up the Claude Code `2.1.118` stable runtime for managed agent runs.
- Reliability: refresh the agent runtime after investigating managed-tenant Claude Code subprocess `SIGKILL` failures under the older `2.1.45` runtime.

## [0.25.0] -- 2026-05-03

- Managed onboarding: extend `/api/system/users` so the platform can create WhatsApp onboarding teammates and preserve Slack + WhatsApp identities on the same user row.
- Managed onboarding: add `channel: "whatsapp"` support to `/api/system/onboarding-introductions`, sending direct intro messages without the Slack inbox approval flow.
- Reliability: report unresolved WhatsApp intro recipients as delivery failures instead of silently dropping requested numbers.

## [0.24.0] -- 2026-05-02

- Agent environment: add a user-scoped Environment tab under Integrations for configuring variables available to Sketch agent Bash commands in DMs.
- Runtime: inject saved variables into Claude Agent SDK runs through `options.env`, avoiding shell-profile assumptions and keeping values scoped to the invoking user.
- Security/UI: encrypt values at rest, support secret versus copyable non-secret display, and block reserved runtime/provider keys across backend and frontend validation.

## [0.23.0] -- 2026-04-30

- Connectors: add per-user versus org-wide authorization for integrations, including Fireflies per-user sync support and connector credential visibility controls.
- Files/Search: enforce RBAC across file lists, file details, entity mentions, and connector-backed search so users only see content they are allowed to access.
- Enrichment: fix Fireflies transcript prompt bloat and close a chunk embedding race during enrichment.
- Fix(managed OpenRouter): `PUT /api/system/llm` now creates the singleton settings row before storing `openrouter_bedrock` credentials. Newly provisioned spare tenants can persist the managed OpenRouter virtual key and model id even before onboarding creates identity settings.

## [0.22.0] -- 2026-04-28

- Agent: new `openrouter_bedrock` LLM provider mode. `applyLlmEnvFromSettings` maps DB settings into `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env vars when provider is `openrouter_bedrock`, with validation that `apiKey` + `modelId` are present.
- Managed system API: `PUT /api/system/llm` now accepts the `openrouter_bedrock` variant (`apiKey` + composite `modelId`), so the managed platform can write OpenRouter virtual-key credentials during provisioning/spare setup.
- Shared: centralised `LlmProvider` type and `isLlmProvider` narrowing helper in `@sketch/shared` so onboarding/setup/web all narrow against the same union; replaced a nested ternary in `/api/setup` with the new helper.

## [0.21.0] -- 2026-04-27

- Workflows: implement sketch-mode agent steps. Agent steps with `agentMode: "sketch"` now run inside the full Sketch agent (MCP integrations, inbox messaging, cross-channel `sendDm`) instead of falling back to a light Claude Agent SDK call. Scheduler and bootstrap thread `inboxMessagesRepo` and `sendDm` into the automation runtime, and a shared `resolveWorkspaceKey` keeps workflow sessions aligned with channel/group/user workspaces.
- Docs: expand `AGENTS.md` from a CLAUDE.md pointer into a full project overview mirroring the contributor guide.
- Tests: stabilize Fireflies connector cursor expectations.

## [0.20.1] -- 2026-04-27

- Fix(managed onboarding): let the platform pass the onboarding admin email to `/api/system/onboarding-introductions`, so intro workflows target the current Slack onboarding admin instead of the oldest admin user. Keeps `findFirstAdmin()` only as a compatibility fallback when no email is provided.

## [0.20.0] -- 2026-04-27

- Auth: move admin authentication into the `users` table with `auth_role`, preserving human/team title data in `users.role`; admins can now use password login and magic-link login, and the sidebar shows the user's auth role.
- Migration: add `users.auth_role` and `users.password_hash`, merge legacy settings-table admins into users by normalized email, block duplicate normalized emails, and preserve existing admin auth roles during managed Slack/team sync.
- Managed/system API: update setup, system identity, managed seed, and bulk user sync paths so managed admins are created as users instead of settings-only admins.
- Files and Information Discovery: ship the files/search, connector, RBAC, enrichment, Fireflies, and entity-discovery overhaul; Information Discovery is now always enabled instead of hidden behind `EXPERIMENTAL_FLAG`.
- Cleanup: drop the retired `outreach_messages` table and remove remaining outreach schema/prompt references.

## [0.19.6] -- 2026-04-22

- UI: visual refresh with Inter as the primary sans font, `--brand-accent` theme token (#FEED01), button/dialog polish (shadow-xs, rounded-xl dialogs), and layout rhythm normalization (`max-w-4xl px-10 py-8`, uniform header typography) across channels, team, skills, scheduled-tasks, and connections routes. Empty states restyled with a dashed brand-accent tint and white icon circle.
- UI: unify Team, Integrations, and Usage tab style behind a shared `@sketch/ui/components/tab-button` (uppercase mono label + yellow underline). Team's List/Chart switches to the shared pattern with Chart rendered full-width.
- UI: trim skills surface -- remove Explore tab, category filter pills, and per-card category pills; hide the Details/Permissions tab (always render Details, with markdown-table rendering via remark-gfm and tightened skill-card header).
- UI: hide Workspace from the sidebar and disable its route (route code retained).
- Fix(skill-sync): honor `sync.managedPaths` in the featured-skills manifest so specific files (e.g. `SKILL.md`) on already-installed skills are re-synced on startup while the rest of the local skill directory is preserved. Enables managed updates to featured skills without overwriting user edits.

## [0.19.5] -- 2026-04-22

- Fix(system): invoke `onLlmSettingsUpdated` after `PUT /api/system/llm` writes settings, so the managed platform's onboarding path refreshes the running tenant's `process.env` (CLAUDE_CODE_USE_BEDROCK / AWS_* / ANTHROPIC_MODEL) without a restart. Previously, newly claimed spares had correct DB settings but stale env, causing the Claude Code subprocess to exit with code 1 on the first agent run. The symmetric `/api/setup` path already fired this hook; this change threads it through the managed path.

## [0.19.4] -- 2026-04-21

- Fix(slack): wrap `reactions.add` and `reactions.remove` in try/catch with warn log. A failed acknowledgement reaction (e.g., `missing_scope` on tokens issued without `reactions:write`) no longer kills the message queue work item and blocks the agent reply. Also replaces the silent swallow on `removeReaction` with a visible warn.

## [0.19.3] -- 2026-04-21

- Managed intro workflows: inbox-backed admin approval flow, bulk Slack user sync, `SearchUsers`, `SendMessageToUsers`, and managed onboarding intro bootstrap endpoints
- Cross-channel teammate messaging: shared delivery routing now sends intro/outreach DMs on the recipient's available channel instead of being pinned to the current adapter
- Fix: expose workflow ids and selected recipient ids in prompt inbox context so the agent can reliably advance explicit inbox workflows
- Fix: make bulk Slack user sync atomic and preserve inbox/onboarding state integrity on conflicts
- Fix: harden Slack identity conflict handling to avoid duplicate-user creation and show a user-visible reconnect message instead of silently dropping conflicted Slack messages

## [0.19.2] -- 2026-04-16

- Fix: sync deduped progress state. Renderer now owns dedup/line state and returns `void`; transport exposes `syncLines(lines)` and reconciles Slack/WhatsApp message segments against the full desired state each tick. Closes a drift bug where the renderer's deduped view disagreed with the transport's incremental segment state, producing stale or duplicated progress lines on repeated tool calls.

## [0.19.1] -- 2026-04-16

- Fix: wire teammate tools (`GetTeamDirectory`, `SendMessageToUser`) in shared chats. Slack channel mentions and WhatsApp group runs now receive `inboxMessagesRepo`, `userRepo`, and the platform `sendDm` callback, so the agent can discover and DM teammates from shared contexts (previously only wired for DMs).

## [0.19.0] -- 2026-04-16

- Workflows phase 1: unified automation model where every scheduled task is a workflow (single-step tasks are sugar-expanded; multi-step workflows have trigger + action/agent steps with step content stored separately)
- New `automation_runs` and `automation_step_content` tables (migration 031), with per-run tracking, step outputs, and cascade delete on task removal
- New runtime at `packages/server/src/workflows/` executes all automations through a single code path; agent steps receive integration env, platform formatting, and stderr capture
- API: `/api/scheduled-tasks/:id/step-content`, runs and run-detail endpoints, enriched list response, "Run now" trigger
- Frontend: step summary, run history, run detail, and Run-now action on the automations page
- Resilience: mark interrupted runs as `failed` on startup, auto-pause tasks with invalid cron/step structure
- Member access: members now see and mutate only automations they created; admins retain tenant-wide access across list, pause/resume/delete/run, runs, and the `ManageScheduledTasks` agent tool; N+1 list query replaced with a single grouped run-summary query
- Output style modes: `/outputstyle friendly|concise|technical|verbose` (shorthand `f`/`c`/`t`/`v`), stored per-user in DMs and per-channel in channels/WhatsApp groups, defaulting to friendly
- Runner emits semantic progress events live during a run and delays the final answer until the run ends; new `tool-progress` renderer and Slack/WhatsApp `progress-transport` own accumulate-vs-replace strategy and invisible rollover
- Integration CLIs now run through ephemeral, brokered wrappers with scoped environment and credentials, keyed off `CLAUDE_CONFIG_DIR`
- Fix: flush progress updates on agent errors so users see partial output on failures
- Fix: harden progress message length handling to respect platform caps
- Fix(agent): pin prompt time formatter to `en-US` so the `<time>` tag is stable across host locales
- Fix(web): Vite dev proxy follows the server `PORT` instead of hard-coding `localhost:3000`
- Fix(whatsapp): disable Baileys `fireInitQueries` to avoid bad-request errors on boot and reconnect

## [0.18.0] -- 2026-04-14

- Replace the old outbound/outreach flow with an inbox-based agent messaging model for cross-user delivery and response handling
- Refresh agent execution flow with dedicated tool-progress and final-message callbacks, emoji-based progress feedback, and success reactions in Slack
- Replace the Claude Code preset with a rewritten custom system prompt for better cache efficiency and clearer platform behavior
- Add a lightweight command system with `/new` session reset support across Slack and WhatsApp, including fresh-session confirmations
- Add ephemeral integration credential wrappers and harden skill-sync behavior to preserve local edits and safely scope wrapper environment variables
- Fix WhatsApp startup by disabling Baileys `fireInitQueries` to avoid bad-request failures on boot
- Replace Chart.js with Recharts for usage charts in the web app

## [0.17.4] -- 2026-04-08

- Fix WhatsApp DM replies for LID-based inbound messages by normalizing outbound delivery to the user's phone-number JID
- Normalize composing, text replies, file uploads, error replies, and task-context delivery targets for WhatsApp DMs
- Add regression coverage for inbound `@lid` DMs to ensure replies go back to the canonical phone JID

## [0.17.3] -- 2026-04-07

- Fix WhatsApp reconnect loop caused by stale Baileys sockets scheduling overlapping reconnects
- Ignore stale socket events, enforce single-flight reconnects, and cancel pending reconnects after recovery
- Add regression tests for stale socket close events and duplicate reconnect scheduling

## [0.17.2] -- 2026-04-07

- Add model_id to LLM settings with provider-appropriate defaults (us.anthropic.claude-sonnet-4-6 for Bedrock, claude-sonnet-4-6 for Anthropic)
- Fix: hide managed account link for non-admin users
- 1,224 tests (1,122 server + 102 frontend)

## [0.17.0] -- 2026-04-07

- Configurable CLAUDE_CONFIG_DIR and SKETCH_CONFIG_DIR for EFS persistence in managed Fargate deployments
- System prompt uses actual org directory path instead of hardcoded ~/.claude/
- Security: remove blanket /data/ exception from bash path validation
- Security: fix startsWith prefix collision in file path permission checks
- 1,223 tests (1,121 server + 102 frontend)

## [0.16.0] -- 2026-04-06

- Remove admin/member role distinction: all authenticated users get the same permissions (backend + frontend)
- Migration 028: backfill admin user row in users table, rekey workspaces from email to UUID
- Unify JWT sub to always use UUID, upgrade legacy email-based sessions on next login
- Redesign Connections page as tabbed Integrations page (Applications + MCPs tabs) at /integrations
- Channel-based magic link delivery: send sign-in link via Slack DM, email, and/or WhatsApp (all configured channels)
- Dynamic login page: shows which channels received the magic link
- Self-deletion guard on DELETE /api/users/:id
- Cross-dialect fix for migration UNIQUE constraint check (SQLite + Postgres)
- 1,220 tests (1,118 server + 102 frontend)

## [0.15.0-alpha.1] — 2026-03-31

- Managed onboarding system API: PUT /system/identity (admin account + user row), PUT /system/llm (Anthropic/Bedrock with verification), GET/DELETE /system/whatsapp/pair (SSE pairing), POST /system/onboarding/complete
- Fix managed SSO auth: use JWT `email` claim for user lookup instead of `sub` (UUID)
- Wire system route deps: userRepo and WhatsApp pairing functions passed to systemRoutes
- Extend settings.create() with optional orgName and botName fields
- Anthropic API key verification on LLM credential save
- Usage analytics API and dashboard with team adoption table
- PostHog LLM analytics integration
- Files feature with entity explorer (experimental)
- Agent run timestamp normalization migration
- 1,223 tests (1,121 server + 102 frontend)

## [0.14.0] — 2026-03-24

- Connectors: Google Drive, ClickUp, Notion, and Linear file sync with hybrid semantic search (LLM tagging + vector embeddings) and auto-enrichment pipeline
- Connections UI: integration catalog with OAuth flow, per-tool permissions, MCP server management
- Email channel (SMTP) with magic link verification
- Fix WhatsApp group LID resolution: sender JIDs using LID format now correctly resolve to phone numbers for user identity and integration auth
- WhatsApp phone number in agent context: phone appears in `<sender>` tag (groups) and `## User` section (DMs) alongside email
- One-command self-hosting setup script
- Test performance: mock icon libraries (72% import speedup), template DB cloning, fast scrypt
- 1,096 tests (994 server + 102 frontend)

## [0.13.1] — 2026-03-18

- Fix interval-to-cron conversion crash for intervals >= 60 minutes (e.g., 6-hour intervals produced invalid `*/360` cron expressions that crashed croner on startup)
- Simplify Information Discovery prompt for autonomous outreach
- Improve system prompt for autonomous outreach and org directory access
- 883 tests (781 server + 102 frontend)

## [0.13.0] — 2026-03-15

- Agent outreach: Sketch can discover team members (GetTeamDirectory), send tracked DMs (SendMessageToUser), and collect responses (RespondToOutreach) to complete multi-person tasks
- Event-driven response loop: recipient's agent sees outreach in `<context>` block, responds naturally, response auto-delivers to requester via synthetic message enqueue
- GetOutreachStatus tool for on-demand outreach status checks
- Standardized `<context>` XML protocol for all platform-injected context (outreach, thread buffer, sender attribution), replacing ad-hoc `[Current sender:]` format
- Org chart: Team page with List/Chart tab toggle, CSS tree rendering from `reports_to` relationships
- Agent entities: `type` column (human/agent) on users table, agents as first-class team members with Robot icon and Agent badge
- Role and reports_to fields on users for team hierarchy
- User description field for agent team discovery
- 878 tests (776 server + 102 frontend)

## [0.12.1] — 2026-03-14

- Fix sender attribution in shared contexts: current user's message now prefixed with `[Current sender:]` to prevent the agent from confusing users in channel/group bootstrap history

## [0.12.0] — 2026-03-14

- Workspace file browser: split-pane file manager with Monaco editor, lazy-loaded folder tree, drag-drop upload, inline create/rename, Ctrl+S save
- Personal/Organization scope switcher to browse user workspace or org workspace (`~/.claude/`)
- Backend workspace API: file CRUD, upload, download, search, folder management with path traversal protection
- Modular workspace components: file tree with React context (eliminates 19-prop drilling), extracted editor pane, file icons, and utilities
- 912 tests (810 server + 102 frontend)

## [0.11.0] — 2026-03-13

- Scheduled tasks control plane: dashboard page with role-scoped visibility and pause/resume/delete actions
- Scheduled-task management API with friendly target labels resolved from users, channels, and WhatsApp groups
- WhatsApp group metadata persistence (`whatsapp_groups`) for durable group-name display in scheduled tasks
- Worktree tooling: create/remove/list commands plus submodule/bootstrap fixes for isolated feature development
- 863 tests (784 server + 79 frontend)

## [0.10.0] — 2026-03-13

- Scheduled tasks: DB-backed recurring agent runs via ManageScheduledTasks MCP tool (cron, interval, once)
- Three session modes for scheduled tasks: fresh (ephemeral), persistent (task-scoped), chat (continues conversation)
- One-time future tasks with auto-completion after execution
- Session persistence moved from filesystem to DB (chat_sessions table)
- Postgres-compatible session upsert using empty-string sentinel instead of NULL thread_key
- 839 tests (769 server + 70 frontend)

## [0.9.0] — 2026-03-12

- Skill-provider bridge: `getProviderConfig` tool lets skills fetch org-level API key and user email at runtime
- MCP/skill mode toggle on integration providers (skill-mode providers excluded from MCP injection)
- Featured skills auto-sync from `canvasxai/sketch-skills` repo on server startup
- Auto-publish GitHub Action in canvas-ai for CLI generation and sketch-skills PR creation
- Integration provider system: generic provider abstraction, Canvas as first provider, OAuth flow, MCP injection
- RBAC with magic link auth: admin/member roles, passwordless login for members via email
- User email verification with SMTP transport and tokenized links
- WhatsApp group and Slack email-based user resolution for cross-platform identity
- Theme management: light/dark/system mode with logo and favicon switching
- Server bootstrap refactor: extracted `createServer()` from index.ts for testability
- Slack and WhatsApp adapter modules extracted from index.ts
- 724 tests (654 server + 70 frontend)

## [0.8.0] — 2026-03-09

- Skills management UI: listing, detail view, permissions surfaces, explore/marketplace view
- User email field support in team management
- Sender attribution fix for shared contexts

## [0.7.1] — 2026-03-04

- Fix sender attribution in shared contexts (channels/groups) persisting across SDK session resumes
- Remove dead recentMessages and groupContext.senderName code

## [0.7.0] — 2026-03-02

- WhatsApp group support with mention-only activation
- Persistent typing indicator for message processing feedback
- WhatsApp LID-format JID handling for DM messages
- Team page for managing workspace members
- Self-hosting guide

## [0.6.1] — 2026-03-02

- Fix non-null assertions in team page
- Fix WhatsApp LID-format JID handling

## [0.6.0] — 2026-03-02

- Persistent typing indicator while agent is processing

## [0.5.0] — 2026-02-28

- Cross-session memory via CLAUDE.md — personal, channel, and org layers
- DB-backed admin onboarding wizard for self-hosted setup
- JWT-based persistent admin authentication
- Channels page with Slack connect dialog and WhatsApp QR pairing
- WhatsApp adapter via Baileys with DB-backed auth and pairing
- SSE-based WhatsApp QR pairing with cancel support
- Slack disconnect flow

## [0.4.0] — 2026-02-26

- Streaming assistant messages via onMessage callback
- Control plane steel thread — admin login, app shell, channels page

## [0.3.0] — 2026-02-24

- Per-thread sessions and passive thread message buffering
- Inline buffered file attachments with sender's message

## [0.2.0] — 2026-02-23

- File support — receive, native vision, and send back
- MCP tools support in canUseTool permissions
- Node.js 24 upgrade

## [0.1.0] — 2026-02-19

- Slack channel @mentions with threaded replies
- Vitest unit tests for all server modules
- Skills support in agent runner
- Thread context support and configurable history limits

## [0.0.1] — 2026-02-17

- Initial steel thread — Slack DM to agent to response
- Monorepo scaffold with pnpm, Biome, TypeScript

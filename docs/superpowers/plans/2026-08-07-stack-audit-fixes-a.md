# Stack Audit Fixes A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:verification-before-completion before claiming completion.

**Goal:** Restore the `SLACK_ENTITY_SYNC` kill switch, correct first-boot domain ordering, make migration 160 idempotent with SQLite/PGlite upgrade coverage, and remove the stale classification warning.

**Architecture:** Thread the flag through request viewers, agent dependencies, search/content helpers, and Slack sync options. Keep direct helper callers backward-compatible with an enabled default, while bootstrap injects the configured value. Move domain seeding after managed seed creation and guard migration 160 with schema introspection.

**Tech Stack:** TypeScript, Hono, Kysely, SQLite, PGlite, Vitest, Biome.

## Global Constraints

- Preserve pre-stack access doors when `SLACK_ENTITY_SYNC` is false.
- Add regression coverage in the appropriate unit/integration tiers.
- Run the required quality checks and delete `STACK_AUDIT_FIXES_A.md`; do not commit.

### Task 1: Access and Slack kill switch

- [ ] Thread the flag through HTTP viewers, agent params/deps, search/content/listing helpers, task/brief paths, and Slack sync.
- [ ] Add false-mode regression coverage for predicates, search, reads, listings, emission, and reconciliation.

### Task 2: Bootstrap ordering and wording

- [ ] Run managed seed before organization-domain seeding.
- [ ] Add a fresh-boot internal Slack classification test and update the warning text.

### Task 3: Migration 160

- [ ] Guard the roster-evidence column with `hasColumn`.
- [ ] Add SQLite and PGlite upgrades from schema 158 with existing rows and final schema assertions.

### Task 4: Verification and cleanup

- [ ] Run typecheck, lint/format, changed tests, full tests, and build.
- [ ] Delete the audit file and inspect the final diff without committing.

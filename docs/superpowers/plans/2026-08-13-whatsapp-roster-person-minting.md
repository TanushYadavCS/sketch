# WhatsApp Roster Person Minting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create or link Person entities from participant observations in enabled WhatsApp groups, including phone/LID fallback names that upgrade when a safe human name appears.

**Architecture:** Add a focused roster projection repository that treats phone and LID contact points as identity keys. Invoke it after participant observations are reconciled, then let the existing roster-resolution pass upgrade fallback canonical names or merge later names as aliases.

**Tech Stack:** TypeScript, Kysely, SQLite, PGlite, Vitest

## Global Constraints

- Run only for WhatsApp groups with `index_enabled = 1`.
- Never deduplicate by fallback display name; match by phone/LID contact points.
- Do not change Slack behavior or WhatsApp chunk-only LLM no-mint policy.
- Conflicting phone/LID matches must not auto-merge existing Persons.

---

### Task 1: Project enabled roster identities to Persons

**Files:**
- Create: `packages/server/src/db/repositories/whatsapp-roster-person-projection.ts`
- Modify: `packages/server/src/db/repositories/whatsapp-groups.ts`
- Test: `packages/server/src/db/repositories/whatsapp-group-observations.integration.test.ts`

**Interfaces:**
- Consumes: a Kysely transaction and `{ groupJid, phoneE164, lid, observedAt }`.
- Produces: `projectWhatsAppRosterPerson(db, input): Promise<"created" | "linked" | "disabled" | "ambiguous" | "missing-identity">`.

- [ ] **Step 1: Write failing dual-dialect integration cases**

Extend `observationSuite` to assert that an enabled group creates one external Person, phone-only uses the phone as its name, LID-only uses the LID, a later complete observation converges on the same Person, repeat refreshes remain idempotent, a disabled group creates nothing, and conflicting existing phone/LID Persons are left separate.

- [ ] **Step 2: Run the focused integration test and verify failure**

Run: `pnpm --filter @sketch/server test:integration -- src/db/repositories/whatsapp-group-observations.integration.test.ts`

Expected: the new creation assertions fail because `refreshParticipants` only projects identities onto pre-linked users.

- [ ] **Step 3: Implement identity-first projection**

Create `projectWhatsAppRosterPerson` with this flow:

```ts
export type WhatsAppRosterProjectionInput = {
  groupJid: string;
  phoneE164: string | null;
  lid: string | null;
  observedAt: string;
};

export async function projectWhatsAppRosterPerson(
  db: Transaction<DB>,
  input: WhatsAppRosterProjectionInput,
): Promise<WhatsAppRosterProjectionResult>;
```

The function locks/checks the group, exits when `index_enabled !== 1`, resolves live Person ids from normalized `phone` and `whatsapp_lid` contact points, prefers the linked user Person for an exact user phone/LID, returns `ambiguous` when identity keys point to different Persons, creates an inferred external Person only when no match exists, and upserts available contact points with source `whatsapp_identity`.

Call it after each durable participant insert/update/merge in `refreshParticipants`, including partial phone-only and LID-only observations. Preserve `projectCompleteParticipantIdentity` so complete observations still attach LIDs to known users.

- [ ] **Step 4: Run the focused integration suite**

Run: `pnpm --filter @sketch/server test:integration -- src/db/repositories/whatsapp-group-observations.integration.test.ts`

Expected: all SQLite and Postgres cases pass.

### Task 2: Upgrade fallback names when roster names arrive

**Files:**
- Modify: `packages/server/src/db/repositories/entity-aliases.ts`
- Modify: `packages/server/src/whatsapp/identity-resolution.ts`
- Test: `packages/server/src/whatsapp/identity-resolution.test.ts`

**Interfaces:**
- Produces: `enrichWhatsAppRosterPersonName(db, entityId, candidate, identityValues, now?): Promise<void>`.

- [ ] **Step 1: Write failing name-upgrade tests**

Add tests proving a safe push/group-label name replaces a canonical phone/LID fallback and retains the fallback as an alias, while a Person with a human-readable canonical name keeps it and receives the later name only as an alias.

- [ ] **Step 2: Run the focused unit test and verify failure**

Run: `pnpm --filter @sketch/server test:unit -- src/whatsapp/identity-resolution.test.ts`

Expected: fallback canonical names remain unchanged because current code only merges aliases.

- [ ] **Step 3: Implement guarded canonical-name enrichment**

Add a compare-and-swap helper that identifies fallback canonical names only when they equal the Person's normalized phone or LID identity values. Promote the first safe human candidate, retain the old fallback as an alias, and otherwise delegate to `mergeEntityAliases`. Call it from `enrichResolvedEntityAliases` with the resolved participant phone/LID values.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @sketch/server test:unit -- src/whatsapp/identity-resolution.test.ts`

Run: `pnpm --filter @sketch/server test:integration -- src/db/repositories/whatsapp-group-observations.integration.test.ts`

Expected: all focused tests pass.

### Task 3: Verify locally and update the PR

**Files:**
- Modify only files from Tasks 1–2 and this plan.

**Interfaces:**
- Produces: tested branch commits pushed to `feat/whatsapp-llm-chunking-engine`.

- [ ] **Step 1: Run quality checks**

Run: `pnpm biome check packages/server/src/db/repositories/whatsapp-roster-person-projection.ts packages/server/src/db/repositories/whatsapp-groups.ts packages/server/src/db/repositories/whatsapp-group-observations.integration.test.ts packages/server/src/db/repositories/entity-aliases.ts packages/server/src/whatsapp/identity-resolution.ts packages/server/src/whatsapp/identity-resolution.test.ts`

Run: `pnpm typecheck`

Run: `pnpm test:changed`

Expected: all commands pass.

- [ ] **Step 2: Test against the two enabled local WhatsApp groups**

Restart the local stack, trigger one normal WhatsApp sync, and verify participant contact points project to Persons for `Internal OW` and `Capmobfinance <> Sketch`, no disabled group creates Persons, repeat sync does not increase the Person count, and safe names replace only phone/LID fallback canonicals.

- [ ] **Step 3: Commit and push**

Stage only the feature files and plan, create a conventional `feat:` commit, push `feat/whatsapp-llm-chunking-engine`, and confirm the existing PR contains the new commits.

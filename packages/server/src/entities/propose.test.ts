import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeName } from "../connectors/name-normalize";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { type Entity, type EntityLookup, proposeEntity } from "./propose";

async function fetchPersonEntities(db: Kysely<DB>): Promise<Entity[]> {
  return db.selectFrom("entities").selectAll().where("source_type", "=", "person").execute();
}

function makeLookup(getList: () => Entity[]): EntityLookup {
  return {
    getByNormalizedName: (n) => {
      // Mirror sync.ts's ambiguity-preserving index: bucket entities by
      // normalized name. Built lazily on every call so tests that mutate
      // the underlying list (via getList) see fresh state.
      const list = getList();
      const out: Entity[] = [];
      for (const e of list) {
        if (normalizeName(e.name) === n) out.push(e);
      }
      return out;
    },
    getByAlias: (n) => {
      const list = getList();
      const out: Entity[] = [];
      for (const e of list) {
        const aliases: string[] = e.aliases ? JSON.parse(e.aliases) : [];
        if (aliases.some((a) => normalizeName(a) === n)) out.push(e);
      }
      return out;
    },
    listByType: (t) => getList().filter((e) => e.source_type === t),
  };
}

function readEmail(e: Entity): string | null {
  if (!e.metadata) return null;
  try {
    const m = JSON.parse(e.metadata);
    return typeof m.email === "string" ? m.email : null;
  } catch {
    return null;
  }
}

async function insertTestFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "config-test",
      provider_file_id: `p-${id}`,
      file_name: `${id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

describe("proposeEntity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    // Single connector_config for all tests that need to reference indexed_files.
    await db
      .insertInto("connector_configs")
      .values({
        id: "config-test",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", apiKey: "test" }),
        created_by: "user-1",
        scope_config: JSON.stringify({}),
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("1. links to existing entity when email matches", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Bob Chen",
      email: "bob@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => []),
      readEmail,
    };
    // Refresh lookup so it reads the just-inserted entity.
    deps.lookup = makeLookup(() => []);
    const existing = await fetchPersonEntities(db);
    deps.lookup = makeLookup(() => existing);

    const result = await proposeEntity(deps, {
      name: "Bob C",
      email: "bob@acme.com",
      entityType: "person",
      subtype: "external",
      source: "test",
      sourceId: "test:1",
      evidence: [{ indexedFileId: "file-1" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(existing[0].id);

    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("2. email-present-but-not-linked auto-creates and skips fuzzy ranking", async () => {
    // Pre-seed an existing Simran Suri with a different email so the ranker
    // would otherwise queue. The email-present short-circuit must take over.
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@old.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      email: "neeli@acme.com",
      entityType: "person",
      subtype: "external",
      source: "test",
      sourceId: "test:2",
      evidence: [{ indexedFileId: "file-2" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("created");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
    const persons = await fetchPersonEntities(db);
    expect(persons.map((p) => p.name).sort()).toEqual(["Simran Suri", "Simran Suri Neeli"]);
  });

  it("3. auto-creates when no fuzzy collision", async () => {
    const entityRepo = createEntityRepository(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => []),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Aryaman Soni",
      entityType: "person",
      subtype: "external",
      source: "test",
      sourceId: "test:3",
      evidence: [{ indexedFileId: "file-3" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("created");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("4. token-superset → queue with single candidate + evidence", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    // Need a real indexed_files row because evidence has an FK to it.
    await insertTestFile(db, "file-4");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:1",
      evidence: [{ indexedFileId: "file-4" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") throw new Error("unreachable");

    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].candidate_entity_id).toBe(before[0].id);
    expect(queue[0].candidate_score).toBe(0.9);
    expect(queue[0].candidate_reason).toBe("token-superset");
    expect(queue[0].triggered_by_user_id).toBe("user-1");
    expect(queue[0].occurrence_count).toBe(1);

    const evidence = await db.selectFrom("entity_review_evidence").selectAll().execute();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].indexed_file_id).toBe("file-4");

    // Crucial: no person entity was created for the queued proposal.
    const persons = await fetchPersonEntities(db);
    expect(persons.map((p) => p.name)).toEqual(["Simran Suri"]);
  });

  it("5. ambiguous token-superset → queue with NULL candidate", async () => {
    // This test only passes if the ranker preserves multi-match — a plain
    // Map lookup would collapse to one of the two and falsely single-match.
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });
    await entityRepo.upsertPersonEntity({
      name: "Simran Kumar",
      subtype: "external",
      source: "seed",
      sourceId: "seed:2",
    });

    await insertTestFile(db, "file-5");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:2",
      evidence: [{ indexedFileId: "file-5" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].candidate_entity_id).toBeNull();
    // Reason still set so reviewer knows what kind of collision triggered it.
    expect(queue[0].candidate_reason).toBe("token-superset");
  });

  it("6. rejection filter dropping the only candidate falls through to auto-create", async () => {
    const entityRepo = createEntityRepository(db);
    const existing = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: "rej-1",
        entity_id: existing.id,
        rejected_name: "Simran Suri Neeli",
        normalized_rejected_name: "simran suri neeli",
        rejected_by: "user-1",
        rejected_at: new Date().toISOString(),
      })
      .execute();

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:3",
      evidence: [{ indexedFileId: "file-doesnt-exist" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("created");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("7. rejection in multi-candidate collapses to single → queues that one", async () => {
    const entityRepo = createEntityRepository(db);
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });
    await entityRepo.upsertPersonEntity({
      name: "Simran Kumar",
      subtype: "external",
      source: "seed",
      sourceId: "seed:2",
    });

    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: "rej-2",
        entity_id: e1.id,
        rejected_name: "Simran",
        normalized_rejected_name: "simran",
        rejected_by: "user-1",
        rejected_at: new Date().toISOString(),
      })
      .execute();

    await insertTestFile(db, "file-7");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:7",
      evidence: [{ indexedFileId: "file-7" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    // After rejection filter only Simran Kumar survives → candidate = Kumar.
    const kumar = before.find((b) => b.name === "Simran Kumar");
    expect(queue[0].candidate_entity_id).toBe(kumar?.id);
  });

  it("8. mid-review row only bumps occurrence_count + last_seen_at", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    await insertTestFile(db, "file-8");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:8",
      evidence: [{ indexedFileId: "file-8" }],
      triggeredByUserId: "user-1",
    });

    // Mark the row as mid-review (within the freeze window).
    const reviewStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db
      .updateTable("entity_review_queue")
      .set({ review_started_at: reviewStart, review_started_by: "user-1" })
      .where("normalized_name", "=", "simran suri neeli")
      .execute();

    const snapshot = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", "simran suri neeli")
      .executeTakeFirstOrThrow();

    // Propose again with a candidate that would normally rewrite the fields.
    // The mid-review row should preserve its snapshot.
    await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:8b",
      evidence: [{ indexedFileId: "file-8" }],
      triggeredByUserId: "user-2",
    });

    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", "simran suri neeli")
      .executeTakeFirstOrThrow();

    expect(after.candidate_entity_id).toBe(snapshot.candidate_entity_id);
    expect(after.candidate_generated_at).toBe(snapshot.candidate_generated_at);
    expect(after.triggered_by_user_id).toBe("user-1");
    expect(after.occurrence_count).toBe(snapshot.occurrence_count + 1);
  });

  it("9. resolved row → no-op (skipEvidence honored, no new evidence written)", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:1",
    });

    await insertTestFile(db, "file-9");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:9",
      evidence: [{ indexedFileId: "file-9" }],
      triggeredByUserId: "user-1",
    });

    // Flip the row to 'confirmed' to simulate ECR-02 resolve.
    await db
      .updateTable("entity_review_queue")
      .set({ status: "confirmed", resolved_at: new Date().toISOString(), resolved_by: "user-1" })
      .where("normalized_name", "=", "simran suri neeli")
      .execute();

    const evidenceBefore = await db.selectFrom("entity_review_evidence").selectAll().execute();
    const queueBefore = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", "simran suri neeli")
      .executeTakeFirstOrThrow();

    // Late-arriving propose for the same name. Should be a complete no-op.
    await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:9b",
      evidence: [{ indexedFileId: "file-9" }],
      triggeredByUserId: "user-1",
    });

    const evidenceAfter = await db.selectFrom("entity_review_evidence").selectAll().execute();
    const queueAfter = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", "simran suri neeli")
      .executeTakeFirstOrThrow();

    expect(evidenceAfter).toHaveLength(evidenceBefore.length);
    expect(queueAfter.status).toBe("confirmed");
    expect(queueAfter.occurrence_count).toBe(queueBefore.occurrence_count);
    expect(queueAfter.last_seen_at).toBe(queueBefore.last_seen_at);
  });

  it("10. exact-name match links even when a fuzzy candidate also exists (Saurabh Kumar regression)", async () => {
    // Reproduces the production bug: two distinct entities exist with
    // different emails — "Saurabh Kumar" and "Saurabh Kumar Singh". A
    // name-only attendee "Saurabh Kumar" must link to the matching entity,
    // not get queued against Singh just because Singh is a fuzzy superset.
    const entityRepo = createEntityRepository(db);
    const sk = await entityRepo.upsertPersonEntity({
      name: "Saurabh Kumar",
      email: "saurabh@canvasx.ai",
      subtype: "external",
      source: "seed",
      sourceId: "seed:sk",
    });
    await entityRepo.upsertPersonEntity({
      name: "Saurabh Kumar Singh",
      email: "saurabhkumar.singh@habuild.in",
      subtype: "external",
      source: "seed",
      sourceId: "seed:sks",
    });

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Saurabh Kumar",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:meeting-1",
      evidence: [{ indexedFileId: "file-does-not-need-to-exist" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(sk.id);

    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
    const evidence = await db.selectFrom("entity_review_evidence").selectAll().execute();
    expect(evidence).toHaveLength(0);

    // No new person entity was created — count is unchanged.
    const after = await fetchPersonEntities(db);
    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());
  });

  it("11. exact-name match is case-insensitive", async () => {
    const entityRepo = createEntityRepository(db);
    const bob = await entityRepo.upsertPersonEntity({
      name: "Bob Chen",
      subtype: "external",
      source: "seed",
      sourceId: "seed:bob",
    });

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "bob  chen", // double space + lowercase — normalizeName collapses both
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:meeting-2",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(bob.id);

    // The canonical name stays "Bob Chen" — exact-name fast-path passes the
    // matched entity's name (not the proposed casing) to upsertPersonEntity.
    const refreshed = await db.selectFrom("entities").selectAll().where("id", "=", bob.id).executeTakeFirstOrThrow();
    expect(refreshed.name).toBe("Bob Chen");
  });

  it("12. ambiguous exact-name (two entities share the same canonical name) queues exact ambiguity", async () => {
    // upsertPersonEntity dedups by name, so we have to insert directly.
    // This shouldn't happen in healthy data but the fast-path must not
    // silently pick one of two same-name entities — that would be the
    // Saurabh Bothra–class bug.
    const entityRepo = createEntityRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "dup-1",
          name: "Bob Chen",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({}),
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "dup-2",
          name: "Bob Chen",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({}),
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    await insertTestFile(db, "file-12");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Bob Chen",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:meeting-3",
      evidence: [{ indexedFileId: "file-12" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].candidate_entity_id).toBeNull();
    expect(queue[0].candidate_score).toBeNull();
    expect(queue[0].candidate_reason).toBe("exact-ambiguous");
  });

  it("13. alias-match links — post-Confirm proposal hits the alias half of the fast-path", async () => {
    // Models the post-Confirm scenario: existing entity 'Simran Suri'
    // already carries 'Simran Suri Neeli' in its aliases JSON (the state
    // left behind after a reviewer Confirmed a merge proposal). A future
    // propose for 'Simran Suri Neeli' with no email must auto-link to
    // that entity, not fall through to the fuzzy ranker.
    const entityRepo = createEntityRepository(db);
    const ss = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:simran",
    });
    await entityRepo.appendAlias(ss.id, "Simran Suri Neeli");

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran Suri Neeli",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:alias-1",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(ss.id);

    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("14. alias-match dedup — same entity returned by name+alias counts as one (no ambiguity misfire)", async () => {
    // Edge case: an entity whose canonical name AND one of its aliases
    // both normalize to the proposed input. Both `getByNormalizedName`
    // and `getByAlias` return the same entity; the Map-by-id dedup in
    // step 3 must keep the count at 1 so we link rather than ambiguously
    // fall through. Guards against a future refactor that switches to a
    // length-only check on the concatenated arrays.
    const entityRepo = createEntityRepository(db);
    const ss = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:dup",
    });
    // Append an alias that normalizes to the same form as the canonical
    // name. appendAlias dedups case-insensitively, so we have to write
    // a slightly differently-cased copy.
    await db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(["SIMRAN SURI "]), updated_at: new Date().toISOString() })
      .where("id", "=", ss.id)
      .execute();

    const before = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Simran Suri",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:dup-1",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(ss.id);
  });

  it("15. company fuzzy collision queues without calling person upsert", async () => {
    const entityRepo = createEntityRepository(db);
    const existing = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await insertTestFile(db, "file-15");

    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => entities),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Canvas",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "company:canvas",
      evidence: [{ indexedFileId: "file-15" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    const queue = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(queue.entity_type).toBe("company");
    expect(queue.candidate_entity_id).toBe(existing.id);
    expect(queue.candidate_reason).toBe("token-superset");
    const companies = await db.selectFrom("entities").selectAll().where("source_type", "=", "company").execute();
    expect(companies.map((c) => c.name)).toEqual(["Canvas Labs"]);
  });

  it("16. product version normalization links Claude 3 and Claude-3 but keeps Claude 3.5 separate", async () => {
    const entityRepo = createEntityRepository(db);
    const claude3 = await entityRepo.upsertEntity({
      name: "Claude 3",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
    });
    const before = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => before),
      readEmail,
    };

    const linked = await proposeEntity(deps, {
      name: "Claude-3",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:claude-3",
      evidence: [],
      triggeredByUserId: "user-1",
    });
    expect(linked.kind).toBe("linked");
    if (linked.kind !== "linked") throw new Error("unreachable");
    expect(linked.entity.id).toBe(claude3.id);

    const fresh = await db.selectFrom("entities").selectAll().execute();
    const created = await proposeEntity(
      { ...deps, lookup: makeLookup(() => fresh) },
      {
        name: "Claude 3.5",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:claude-3-5",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );
    expect(created.kind).toBe("created");
    const products = await db.selectFrom("entities").selectAll().where("source_type", "=", "product").execute();
    expect(products.map((p) => p.name).sort()).toEqual(["Claude 3", "Claude 3.5"]);
  });

  it("17. precomputed LLM candidates queue after exact-name fast-path is checked", async () => {
    const entityRepo = createEntityRepository(db);
    const exact = await entityRepo.upsertPersonEntity({
      name: "Sarah Chen",
      subtype: "external",
      source: "seed",
      sourceId: "seed:sarah",
    });
    const fuzzy = await entityRepo.upsertPersonEntity({
      name: "Sarah C",
      subtype: "external",
      source: "seed",
      sourceId: "seed:sarah-c",
    });
    const entities = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => entities),
      readEmail,
    };

    const linked = await proposeEntity(deps, {
      name: "Sarah Chen",
      entityType: "person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "llm:sarah",
      evidence: [],
      triggeredByUserId: "user-1",
      precomputedCandidates: [{ entity: fuzzy, score: 12 }],
    });

    expect(linked.kind).toBe("linked");
    if (linked.kind !== "linked") throw new Error("unreachable");
    expect(linked.entity.id).toBe(exact.id);

    await insertTestFile(db, "file-17");
    const queued = await proposeEntity(deps, {
      name: "Sarah Cheng",
      entityType: "person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "llm:sarah-cheng",
      evidence: [{ indexedFileId: "file-17" }],
      triggeredByUserId: "user-1",
      precomputedCandidates: [{ entity: fuzzy, score: 12 }],
    });

    expect(queued.kind).toBe("queued");
    const queue = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("normalized_name", "=", "sarah cheng")
      .executeTakeFirstOrThrow();
    expect(queue.candidate_entity_id).toBe(fuzzy.id);
    expect(queue.candidate_reason).toBe("llm-ambiguous");
  });

  it("18. evidenceDomain links a token-overlapping company before fuzzy queueing", async () => {
    const entityRepo = createEntityRepository(db);
    const domainsRepo = createEntityDomainsRepository(db);
    const canvas = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await entityRepo.upsertEntity({
      name: "Canvas Industries",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await domainsRepo.upsertDomain({
      entityId: canvas.id,
      domain: "canvas.example",
      kind: "corporate",
      source: "manual",
    });
    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: {
        ...makeLookup(() => entities),
        getCompanyIdsByDomain: (domain: string) => (domain === "canvas.example" ? [canvas.id] : []),
      },
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Canvas",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "company:canvas-domain",
      evidence: [],
      triggeredByUserId: "user-1",
      evidenceDomain: "canvas.example",
    });

    expect(result.kind).toBe("linked");
    if (result.kind === "linked") expect(result.entity.id).toBe(canvas.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("19. evidenceDomain disambiguates two confirmed companies via deterministic tie-break instead of queueing", async () => {
    const entityRepo = createEntityRepository(db);
    const first = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    const second = await entityRepo.upsertEntity({
      name: "Canvas Studios",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await db.updateTable("entities").set({ hotness: 10 }).where("id", "=", first.id).execute();
    await db.updateTable("entities").set({ hotness: 1 }).where("id", "=", second.id).execute();
    await insertTestFile(db, "file-19");
    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: {
        ...makeLookup(() => entities),
        getCompanyIdsByDomain: (domain: string) => (domain === "canvas.example" ? [first.id, second.id] : []),
      },
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Canvas",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "company:canvas-ambiguous-domain",
      evidence: [{ indexedFileId: "file-19" }],
      triggeredByUserId: "user-1",
      evidenceDomain: "canvas.example",
    });

    expect(result.kind).toBe("linked");
    if (result.kind === "linked") expect(result.entity.id).toBe(first.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("20. exact-name collision across confirmed companies picks the evidenceDomain-mapped winner (OW dedup)", async () => {
    // Production shape: three OW entities accumulated across syncs
    // ("Oliver Wyman", "OW", "Oliverwyman" — normalize to overlapping
    // keys). When extraction emits `engaged_with` against the normalized
    // form with evidenceDomain "oliverwyman.com", we must NOT queue —
    // we land the edge on the domain-mapped canonical so the graph
    // stays connected. Cleanup of the dupes is a separate problem.
    const entityRepo = createEntityRepository(db);
    const domainsRepo = createEntityDomainsRepository(db);
    const canonical = await entityRepo.upsertEntity({
      name: "Oliverwyman",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    const ghost = await entityRepo.upsertEntity({
      name: "Oliver Wyman",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await domainsRepo.upsertDomain({
      entityId: canonical.id,
      domain: "oliverwyman.com",
      kind: "corporate",
      source: "manual",
    });
    // Force both entities into the SAME normalized-name bucket so the
    // exact-name fast-path collides them. normalizeName collapses
    // whitespace, so "Oliver Wyman" and "Oliverwyman" already collide
    // there; we additionally alias the ghost with the canonical form to
    // exercise the alias-half of the bucket too.
    await db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(["Oliverwyman"]) })
      .where("id", "=", ghost.id)
      .execute();

    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: {
        ...makeLookup(() => entities),
        getCompanyIdsByDomain: (domain: string) => (domain === "oliverwyman.com" ? [canonical.id] : []),
      },
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Oliverwyman",
      entityType: "company",
      subtype: "external",
      source: "llm_relation",
      sourceId: "rel:vedant->oliverwyman",
      evidence: [],
      triggeredByUserId: "user-1",
      evidenceDomain: "oliverwyman.com",
    });

    expect(result.kind).toBe("linked");
    if (result.kind === "linked") expect(result.entity.id).toBe(canonical.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("21. exact-name collision with no evidenceDomain falls back to higher hotness", async () => {
    // No domain signal available (e.g. extraction from a meeting that
    // doesn't carry an explicit evidenceDomain, or proposing a non-company
    // type). Tie-break by hotness — the more-mentioned entity wins. Still
    // no queue: the cost of queueing is silent edge loss, the cost of a
    // wrong link is a recoverable mis-attribution.
    const entityRepo = createEntityRepository(db);
    const hot = await entityRepo.upsertEntity({
      name: "Aviation Edge",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
    });
    const cold = await entityRepo.upsertEntity({
      name: "Aviation Edge",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
    });
    await db.updateTable("entities").set({ hotness: 17 }).where("id", "=", hot.id).execute();
    await db.updateTable("entities").set({ hotness: 0 }).where("id", "=", cold.id).execute();

    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => entities),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Aviation Edge",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:aviation-edge",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind === "linked") expect(result.entity.id).toBe(hot.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../connectors/embeddings/types";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { createTestDb, spyOnExecutedSql } from "../test-utils";
import { buildLookupIndex, buildMaterializeDeps, createEntityLookupFromIndex } from "./materialize-deps";
import type { IndexEntityRow } from "./materialize-types";
import { normalizeEntityMatchName, normalizeName } from "./name-keys";
import { type Entity, type EntityLookup, type ProposeEntityType, proposeEntity } from "./propose";

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
        if (normalizeEntityMatchName(e.source_type, e.name) === n) out.push(e);
      }
      return out;
    },
    getByAlias: (n) => {
      const list = getList();
      const out: Entity[] = [];
      for (const e of list) {
        const aliases: string[] = e.aliases ? JSON.parse(e.aliases) : [];
        if (aliases.some((a) => normalizeEntityMatchName(e.source_type, a) === n)) out.push(e);
      }
      return out;
    },
    listByType: (t) => getList().filter((e) => e.source_type === t),
  };
}

function readEmail(e: IndexEntityRow): string | null {
  if (!e.metadata) return null;
  try {
    const m = JSON.parse(e.metadata);
    return typeof m.email === "string" ? m.email : null;
  } catch {
    return null;
  }
}

function makeEmbeddingProvider(): EmbeddingProvider & { embedTexts: ReturnType<typeof vi.fn> } {
  return {
    name: "test",
    dimensions: 2,
    supportsImages: false,
    embedTexts: vi.fn(async () => [[1, 0]]),
  };
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

  it("links through a hand-added contact point when metadata has no email", async () => {
    const entityRepo = createEntityRepository(db);
    const entity = await entityRepo.createPersonEntity({
      name: "Manual Identity",
      subtype: "external",
      source: "manual",
      sourceId: "manual:identity",
    });
    await entityRepo.upsertContactPoint({
      entityId: entity.id,
      kind: "email",
      value: "shared@example.com",
      source: "manual",
      makePrimary: true,
    });
    const existing = await fetchPersonEntities(db);

    const result = await proposeEntity(
      {
        entityRepo,
        reviewRepo: createEntityReviewRepo(db),
        lookup: makeLookup(() => existing),
        readEmail,
      },
      {
        name: "Different Incoming Name",
        email: "shared@example.com",
        entityType: "person",
        subtype: "external",
        source: "test",
        sourceId: "test:manual-contact",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result).toMatchObject({ kind: "linked", entity: { id: entity.id } });
  });

  it("promotes an email-matched existing person for an internal seed", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Roster Match",
      email: "roster@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:roster-match",
    });
    const existing = await fetchPersonEntities(db);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => existing),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Roster Match",
      email: "roster@example.com",
      entityType: "person",
      subtype: "internal",
      source: "notion",
      sourceId: "user:roster-match",
      evidence: [],
      triggeredByUserId: "user-1",
      provenanceTier: "structural",
    });

    expect(result.kind).toBe("linked");
    await expect(
      db.selectFrom("entities").select("subtype").where("id", "=", existing[0].id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ subtype: "internal" });
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

  it("batches rejection filtering once per proposal while preserving name-dedup and fuzzy outcomes", async () => {
    const entityRepo = createEntityRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    const product = await entityRepo.upsertEntity({
      name: "GPT 4 Pro",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "human_confirmed",
    });
    await reviewRepo.addRejection({ entityId: product.id, rejectedName: "GPT4", rejectedBy: "user-1" });
    const entities = await db.selectFrom("entities").selectAll().execute();
    const productLookup: EntityLookup = {
      ...makeLookup(() => entities),
      findNameDedupCandidates: () => [{ entity: product, score: 1, reason: "strict-normalized" }],
    };
    const spy = spyOnExecutedSql(db);

    const created = await proposeEntity(
      {
        entityRepo,
        reviewRepo,
        lookup: productLookup,
        readEmail,
      },
      {
        name: "GPT4",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:gpt4-batched",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(created.kind).toBe("created");
    expect(spy.sqls.filter((sql) => sql.includes('from "entity_alias_rejections"'))).toHaveLength(1);

    spy.sqls.length = 0;
    const simranSuri = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      subtype: "external",
      source: "seed",
      sourceId: "seed:batched-suri",
    });
    const simranKumar = await entityRepo.upsertPersonEntity({
      name: "Simran Kumar",
      subtype: "external",
      source: "seed",
      sourceId: "seed:batched-kumar",
    });
    await reviewRepo.addRejection({ entityId: simranSuri.id, rejectedName: "Simran", rejectedBy: "user-1" });
    await insertTestFile(db, "file-batched-rejection");
    const people = await fetchPersonEntities(db);

    const queued = await proposeEntity(
      {
        entityRepo,
        reviewRepo,
        lookup: makeLookup(() => people),
        readEmail,
      },
      {
        name: "Simran",
        entityType: "person",
        subtype: "external",
        source: "fireflies",
        sourceId: "fireflies:batched-rejection",
        evidence: [{ indexedFileId: "file-batched-rejection" }],
        triggeredByUserId: "user-1",
      },
    );

    expect(queued.kind).toBe("queued");
    const queue = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source_id", "=", "fireflies:batched-rejection")
      .executeTakeFirstOrThrow();
    expect(queue.candidate_entity_id).toBe(simranKumar.id);
    expect(spy.sqls.filter((sql) => sql.includes('from "entity_alias_rejections"'))).toHaveLength(1);
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

  it("16. declared product version normalization links Claude 3 and Claude-3 but keeps Claude 3.5 separate", async () => {
    const entityRepo = createEntityRepository(db);
    const claude3 = await entityRepo.upsertEntity({
      name: "Claude 3",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "declared",
    });
    const materializeDeps = await buildMaterializeDeps(db);
    const deps = {
      entityRepo: materializeDeps.entityRepo,
      reviewRepo: materializeDeps.reviewRepo,
      lookup: materializeDeps.lookup,
      readEmail: materializeDeps.readEmail,
      onEntityResolved: materializeDeps.onEntityResolved,
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

  it("suppresses a key-divergent product candidate rejected through the real writer", async () => {
    const entityRepo = createEntityRepository(db);
    const existing = await entityRepo.upsertEntity({
      name: "GPT 4 Pro",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "human_confirmed",
    });
    const reviewRepo = createEntityReviewRepo(db);
    await reviewRepo.addRejection({ entityId: existing.id, rejectedName: "GPT4", rejectedBy: "user-1" });
    const materializeDeps = await buildMaterializeDeps(db, {
      birthGateTypes: new Set<ProposeEntityType>(["product"]),
      birthGateLiveTypes: new Set<ProposeEntityType>(["product"]),
    });

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        birthGateTypes: materializeDeps.birthGateTypes,
        birthGateLiveTypes: materializeDeps.birthGateLiveTypes,
      },
      {
        name: "GPT4",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:gpt4",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") throw new Error("unreachable");
    expect(result.candidateEntityId).toBeNull();
    const queue = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(queue.candidate_entity_id).toBeNull();
    expect(queue.candidate_reason).toBe("birth-gated");
  });

  it("17. inferred product source-ref and exact-name matches are not eligible match targets", async () => {
    const entityRepo = createEntityRepository(db);
    const legacy = await entityRepo.upsertEntity({
      name: "Claude Legacy",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "inferred",
    });
    await entityRepo.upsertSourceRef({
      entityId: legacy.id,
      source: "llm_extraction",
      sourceId: "product:claude-legacy",
    });
    const materializeDeps = await buildMaterializeDeps(db);
    expect(
      materializeDeps.index.byNormalizedName.get(normalizeName("Claude Legacy"))?.map((e) => e.id) ?? [],
    ).not.toContain(legacy.id);
    expect(materializeDeps.index.bySourceRef.has("llm_extraction:product:claude-legacy")).toBe(false);

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "Claude Legacy",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:claude-legacy",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("unreachable");
    expect(result.entity.id).not.toBe(legacy.id);
    const products = await db.selectFrom("entities").selectAll().where("source_type", "=", "product").execute();
    expect(products.map((product) => product.id).sort()).toEqual([legacy.id, result.entity.id].sort());
  });

  it("18. precomputed LLM candidates queue after exact-name fast-path is checked", async () => {
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

  it("19. evidenceDomain links a token-overlapping company before fuzzy queueing", async () => {
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
      provenanceTier: "human_confirmed",
    });
    const cold = await entityRepo.upsertEntity({
      name: "Aviation Edge",
      sourceType: "product",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "human_confirmed",
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

  it("22. company exact-name collision with strong hotness disparity links without evidenceDomain", async () => {
    const entityRepo = createEntityRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "acme-hot",
          name: "Acme",
          source_type: "company",
          subtype: "external",
          metadata: null,
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 100,
          created_at: now,
          updated_at: now,
          ai_brief: null,
        },
        {
          id: "acme-cold",
          name: "Acme",
          source_type: "company",
          subtype: "external",
          metadata: null,
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 1,
          created_at: now,
          updated_at: now,
          ai_brief: null,
        },
      ])
      .execute();

    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => entities),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Acme",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "company:acme-strong",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("linked");
    if (result.kind === "linked") expect(result.entity.id).toBe("acme-hot");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("23. company exact-name collision with similar hotness queues without evidenceDomain", async () => {
    const entityRepo = createEntityRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "acme-first",
          name: "Acme",
          source_type: "company",
          subtype: "external",
          metadata: null,
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 5,
          created_at: now,
          updated_at: now,
          ai_brief: null,
        },
        {
          id: "acme-second",
          name: "Acme",
          source_type: "company",
          subtype: "external",
          metadata: null,
          aliases: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 4,
          created_at: now,
          updated_at: now,
          ai_brief: null,
        },
      ])
      .execute();
    await insertTestFile(db, "file-23");

    const entities = await db.selectFrom("entities").selectAll().execute();
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => entities),
      readEmail,
    };

    const result = await proposeEntity(deps, {
      name: "Acme",
      entityType: "company",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "company:acme-similar",
      evidence: [{ indexedFileId: "file-23" }],
      triggeredByUserId: "user-1",
    });

    expect(result.kind).toBe("queued");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].candidate_reason).toBe("exact-ambiguous");
  });

  it("24. source-ref fast-path links renamed non-person entity and aliases incoming name", async () => {
    const entityRepo = createEntityRepository(db);
    const project = await entityRepo.upsertEntity({
      name: "Project Atlas",
      sourceType: "project",
      subtype: "external",
      status: "confirmed",
    });
    await entityRepo.upsertSourceRef({ entityId: project.id, source: "linear", sourceId: "lin-123" });
    await entityRepo.updateEntity(project.id, { name: "Atlas (TAQA)" });

    const entities = await db.selectFrom("entities").selectAll().execute();
    const result = await proposeEntity(
      {
        entityRepo,
        reviewRepo: createEntityReviewRepo(db),
        lookup: makeLookup(() => entities),
        readEmail,
      },
      {
        name: "Project Atlas",
        entityType: "project",
        subtype: "external",
        source: "linear",
        sourceId: "lin-123",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(project.id);
    expect(result.entity.name).toBe("Atlas (TAQA)");
    const refreshed = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    expect(refreshed.name).toBe("Atlas (TAQA)");
    expect(refreshed.aliases ? JSON.parse(refreshed.aliases) : []).toContain("Project Atlas");
  });

  it("25. person source-ref links before email identity", async () => {
    const entityRepo = createEntityRepository(db);
    const bob = await entityRepo.upsertPersonEntity({
      name: "Bob Chen",
      email: "bob@acme.com",
      subtype: "external",
      source: "crm",
      sourceId: "contact-1",
    });
    const alice = await entityRepo.upsertPersonEntity({
      name: "Alice Ng",
      email: "alice@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "alice-1",
    });

    const people = await fetchPersonEntities(db);
    const result = await proposeEntity(
      {
        entityRepo,
        reviewRepo: createEntityReviewRepo(db),
        lookup: makeLookup(() => people),
        readEmail,
      },
      {
        name: "Alice Ng",
        email: "alice@acme.com",
        entityType: "person",
        subtype: "external",
        source: "crm",
        sourceId: "contact-1",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(bob.id);
    expect(result.entity.id).not.toBe(alice.id);
  });

  it("26. same-batch source-ref link refreshes materialization index and avoids double-create", async () => {
    const entityRepo = createEntityRepository(db);
    const project = await entityRepo.upsertEntity({
      name: "Atlas (TAQA)",
      sourceType: "project",
      subtype: "external",
      status: "confirmed",
    });
    const materializeDeps = await buildMaterializeDeps(db);
    await entityRepo.upsertSourceRef({ entityId: project.id, source: "linear", sourceId: "lin-456" });

    expect(materializeDeps.index.bySourceRef.has("linear:lin-456")).toBe(false);
    const first = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "Project Atlas",
        entityType: "project",
        subtype: "external",
        source: "linear",
        sourceId: "lin-456",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(first.kind).toBe("linked");
    expect(materializeDeps.index.bySourceRef.get("linear:lin-456")?.id).toBe(project.id);
    expect(materializeDeps.index.byNormalizedAlias.get(normalizeName("Project Atlas"))?.map((e) => e.id)).toContain(
      project.id,
    );

    const second = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "Project Atlas",
        entityType: "project",
        subtype: "external",
        source: "linear",
        sourceId: "lin-456",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );
    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();

    expect(second.kind).toBe("linked");
    expect(projects).toHaveLength(1);
  });

  it("27. strict name dedup links and appends the incoming spelling as an alias", async () => {
    const entityRepo = createEntityRepository(db);
    const redseer = await entityRepo.upsertEntity({
      name: "Redseer Consulting",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    const materializeDeps = await buildMaterializeDeps(db);

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "RedseerConsulting",
        entityType: "company",
        subtype: "external",
        source: "llm",
        sourceId: "mention-redseer",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(redseer.id);
    expect(JSON.parse(result.entity.aliases ?? "[]")).toContain("RedseerConsulting");
    expect(materializeDeps.index.byNormalizedAlias.get(normalizeName("RedseerConsulting"))?.map((e) => e.id)).toContain(
      redseer.id,
    );
  });

  it("28. compact person strict-name collisions queue instead of auto-linking", async () => {
    const entityRepo = createEntityRepository(db);
    const ann = await entityRepo.upsertEntity({
      name: "Ann A",
      sourceType: "person",
      subtype: "external",
      status: "confirmed",
    });
    const materializeDeps = await buildMaterializeDeps(db);

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "Anna",
        entityType: "person",
        subtype: "external",
        source: "llm",
        sourceId: "mention-anna",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") throw new Error("unreachable");
    expect(result.candidateEntityId).toBe(ann.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(queue.candidate_entity_id).toBe(ann.id);
    expect(queue.candidate_reason).toBe("strict-normalized");
  });

  it("29. materialized lookup queues token-set reorder matches", async () => {
    const entityRepo = createEntityRepository(db);
    const ohoud = await entityRepo.upsertEntity({
      name: "Ohoud Zitan",
      sourceType: "person",
      subtype: "external",
      status: "confirmed",
    });
    const materializeDeps = await buildMaterializeDeps(db);

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
        onEntityResolved: materializeDeps.onEntityResolved,
      },
      {
        name: "Zitan, Ohoud",
        entityType: "person",
        subtype: "external",
        source: "llm",
        sourceId: "mention-zitan-ohoud",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") throw new Error("unreachable");
    expect(result.candidateEntityId).toBe(ohoud.id);
    const queue = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(queue.candidate_entity_id).toBe(ohoud.id);
    expect(queue.candidate_reason).toBe("token-set");
  });

  it("30. suppresses a product proposal matching an existing company entity", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntity({
      name: "STR Global",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    const materializeDeps = await buildMaterializeDeps(db);

    const result = await proposeEntity(
      {
        entityRepo: materializeDeps.entityRepo,
        reviewRepo: materializeDeps.reviewRepo,
        domainsRepo: materializeDeps.domainsRepo,
        lookup: materializeDeps.lookup,
        readEmail: materializeDeps.readEmail,
      },
      {
        name: "STR Global",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:str-global",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result).toEqual({ kind: "suppressed", reason: "third_party_vendor_collision" });
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("keeps product collision parity from index buckets with scoped fallback", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntity({
      name: "Inferred Vendor",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
      provenanceTier: "inferred",
    });
    await entityRepo.upsertEntity({
      name: "Alias Owner",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
      aliases: ["Alias Product"],
    });
    await db
      .insertInto("entity_domains")
      .values({
        id: "domain-nullcorp",
        entity_id: null,
        domain: "nullcorp.com",
        kind: "corporate",
        is_primary: 0,
        confidence: 1,
        source: "test",
      })
      .execute();
    const materializeDeps = await buildMaterializeDeps(db);
    const deps = {
      entityRepo: materializeDeps.entityRepo,
      reviewRepo: materializeDeps.reviewRepo,
      domainsRepo: materializeDeps.domainsRepo,
      lookup: materializeDeps.lookup,
      readEmail: materializeDeps.readEmail,
    };
    const spy = spyOnExecutedSql(db);

    const companyCollision = await proposeEntity(deps, {
      name: "Inferred Vendor",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:inferred-vendor",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(companyCollision).toEqual({ kind: "suppressed", reason: "third_party_vendor_collision" });
    expect(
      spy.sqls.filter((sql) => sql.startsWith('select * from "entities"') && sql.includes('"source_type"')),
    ).toHaveLength(0);

    const aliasOnly = await proposeEntity(deps, {
      name: "Alias Product",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:alias-product",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(aliasOnly.kind).toBe("created");

    const domainCollision = await proposeEntity(deps, {
      name: "Nullcorp",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:nullcorp",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(domainCollision).toEqual({ kind: "suppressed", reason: "third_party_vendor_collision" });

    await entityRepo.upsertEntity({
      name: "Scoped Tool",
      sourceType: "tool",
      subtype: "external",
      status: "confirmed",
    });
    const scopedIndex = await buildLookupIndex(db, { types: ["company"] });
    const scopedLookup = createEntityLookupFromIndex({
      db,
      index: scopedIndex,
      normalizationBackfillComplete: false,
    });
    const scopedFallback = await proposeEntity(
      {
        entityRepo,
        reviewRepo: createEntityReviewRepo(db),
        domainsRepo: createEntityDomainsRepository(db),
        lookup: scopedLookup,
        readEmail,
      },
      {
        name: "Scoped Tool",
        entityType: "product",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "product:scoped-tool",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(scopedFallback).toEqual({ kind: "suppressed", reason: "third_party_vendor_collision" });
  });

  it("31. suppresses trailing API product names without suppressing the base product name", async () => {
    const materializeDeps = await buildMaterializeDeps(db);
    const deps = {
      entityRepo: materializeDeps.entityRepo,
      reviewRepo: materializeDeps.reviewRepo,
      domainsRepo: materializeDeps.domainsRepo,
      lookup: materializeDeps.lookup,
      readEmail: materializeDeps.readEmail,
    };

    const apiResult = await proposeEntity(deps, {
      name: "Aviation Edge API",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:aviation-edge-api",
      evidence: [],
      triggeredByUserId: "user-1",
    });
    const baseResult = await proposeEntity(deps, {
      name: "Aviation Edge",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:aviation-edge",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(apiResult).toEqual({ kind: "suppressed", reason: "third_party_vendor_collision" });
    expect(baseResult.kind).toBe("created");
  });

  it("32. embedding fallback queues unresolved person proposals including skipFuzzy", async () => {
    const entityRepo = createEntityRepository(db);
    const husnu = await entityRepo.upsertEntity({
      name: "Husnu Ozyegin",
      sourceType: "person",
      subtype: "external",
      status: "confirmed",
    });
    const oliver = await entityRepo.upsertEntity({
      name: "Oliver Wyman",
      sourceType: "person",
      subtype: "external",
      status: "confirmed",
    });
    const entities = await db.selectFrom("entities").selectAll().execute();
    const retrieveEmbeddingCandidates = vi.fn(async (_entityType: string, name: string) => {
      if (name === "HO") return [{ entity: husnu, score: 0.91, reason: "embedding" as const }];
      if (name === "OW") return [{ entity: oliver, score: 0.92, reason: "embedding" as const }];
      return [];
    });
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: {
        ...makeLookup(() => entities),
        retrieveEmbeddingCandidates,
      },
      readEmail,
    };

    const normal = await proposeEntity(deps, {
      name: "HO",
      entityType: "person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "person:ho",
      evidence: [],
      triggeredByUserId: "user-1",
    });
    const skipFuzzy = await proposeEntity(deps, {
      name: "OW",
      entityType: "person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "person:ow",
      evidence: [],
      triggeredByUserId: "user-1",
      skipFuzzy: true,
    });

    expect(normal.kind).toBe("queued");
    expect(skipFuzzy.kind).toBe("queued");
    if (normal.kind !== "queued" || skipFuzzy.kind !== "queued") throw new Error("unreachable");
    expect(normal.candidateEntityId).toBe(husnu.id);
    expect(skipFuzzy.candidateEntityId).toBe(oliver.id);
    expect(retrieveEmbeddingCandidates).toHaveBeenCalledTimes(2);
    expect(retrieveEmbeddingCandidates.mock.calls.map((call) => call[0])).toEqual(["person", "person"]);

    const queue = await db.selectFrom("entity_review_queue").selectAll().orderBy("proposed_name", "asc").execute();
    expect(queue.map((row) => [row.proposed_name, row.candidate_entity_id, row.candidate_reason])).toEqual([
      ["HO", husnu.id, "embedding"],
      ["OW", oliver.id, "embedding"],
    ]);
    const persons = await fetchPersonEntities(db);
    expect(persons.map((person) => person.name).sort()).toEqual(["Husnu Ozyegin", "Oliver Wyman"]);
  });

  it("33. deterministic email and project paths do not call embedding fallback", async () => {
    const entityRepo = createEntityRepository(db);
    const bob = await entityRepo.upsertPersonEntity({
      name: "Bob Chen",
      email: "bob@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:bob",
    });
    const entities = await db.selectFrom("entities").selectAll().execute();
    const retrieveEmbeddingCandidates = vi.fn(async () => []);
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: {
        ...makeLookup(() => entities),
        retrieveEmbeddingCandidates,
      },
      readEmail,
    };

    const linked = await proposeEntity(deps, {
      name: "Robert Chen",
      email: "bob@acme.com",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:bob",
      evidence: [],
      triggeredByUserId: "user-1",
    });
    const project = await proposeEntity(deps, {
      name: "Project Phoenix",
      entityType: "project",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "project:phoenix",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(linked.kind).toBe("linked");
    if (linked.kind !== "linked") throw new Error("unreachable");
    expect(linked.entity.id).toBe(bob.id);
    expect(project.kind).toBe("created");
    expect(retrieveEmbeddingCandidates).not.toHaveBeenCalled();
  });

  it("34. project and product live birth gates queue unknown content terms", async () => {
    const entityRepo = createEntityRepository(db);
    await insertTestFile(db, "file-34a");
    await insertTestFile(db, "file-34b");
    const deps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => []),
      readEmail,
      birthGateTypes: new Set<ProposeEntityType>(["project", "product", "team"]),
      birthGateLiveTypes: new Set<ProposeEntityType>(["project", "product"]),
      birthGateDryRun: true,
    };

    const project = await proposeEntity(deps, {
      name: "Atlas Migration",
      entityType: "project",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "project:atlas-migration",
      evidence: [{ indexedFileId: "file-34a" }],
      triggeredByUserId: "user-1",
    });
    const product = await proposeEntity(deps, {
      name: "Canvas Copilot",
      entityType: "product",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "product:canvas-copilot",
      evidence: [{ indexedFileId: "file-34b" }],
      triggeredByUserId: "user-1",
    });

    expect(project.kind).toBe("queued");
    expect(product.kind).toBe("queued");
    const rows = await db.selectFrom("entity_review_queue").selectAll().orderBy("proposed_name", "asc").execute();
    expect(rows.map((row) => [row.entity_type, row.proposed_name, row.candidate_reason, row.source])).toEqual([
      ["project", "Atlas Migration", "birth-gated", "llm_extraction"],
      ["product", "Canvas Copilot", "birth-gated", "llm_extraction"],
    ]);
    expect(
      await db.selectFrom("entities").selectAll().where("source_type", "in", ["project", "product"]).execute(),
    ).toEqual([]);
  });

  it("35. drops content-extracted team births without changing structural team births", async () => {
    const entityRepo = createEntityRepository(db);
    const info = vi.fn();
    const contentDeps = {
      entityRepo,
      reviewRepo: createEntityReviewRepo(db),
      lookup: makeLookup(() => []),
      readEmail,
      logger: { info } as unknown as Parameters<typeof proposeEntity>[0]["logger"],
      birthGateTypes: new Set<ProposeEntityType>(["project", "product", "team"]),
      birthGateLiveTypes: new Set<ProposeEntityType>(["project", "product"]),
      birthGateDryRun: true,
    };

    const dropped = await proposeEntity(contentDeps, {
      name: "Atlas Team",
      entityType: "team",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "team:atlas",
      evidence: [],
      triggeredByUserId: "user-1",
    });

    expect(dropped).toEqual({ kind: "suppressed", reason: "content_team_birth_dropped" });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "content_team_birth_dropped", type: "team", name: "Atlas Team" }),
      "content_team_birth_dropped",
    );
    expect(await db.selectFrom("entity_review_queue").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entities").selectAll().where("source_type", "=", "team").execute()).toHaveLength(0);

    const structural = await proposeEntity(
      { ...contentDeps, logger: undefined, lookup: makeLookup(() => []) },
      {
        name: "Declared Team",
        entityType: "team",
        subtype: "external",
        source: "connector_seed",
        sourceId: "team:declared",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(structural.kind).toBe("created");
    expect(await db.selectFrom("entities").selectAll().where("source_type", "=", "team").execute()).toHaveLength(1);
  });

  it("36. materialize deps leave embedding lookup off without provider and enable it with a provider", async () => {
    const provider = makeEmbeddingProvider();
    const withoutProvider = await buildMaterializeDeps(db, {});
    const withProvider = await buildMaterializeDeps(db, { embeddingProvider: provider });

    expect(withoutProvider.lookup.retrieveEmbeddingCandidates).toBeUndefined();
    expect(withProvider.lookup.retrieveEmbeddingCandidates).toEqual(expect.any(Function));

    const result = await proposeEntity(
      {
        entityRepo: withoutProvider.entityRepo,
        reviewRepo: withoutProvider.reviewRepo,
        lookup: withoutProvider.lookup,
        readEmail: withoutProvider.readEmail,
        onEntityResolved: withoutProvider.onEntityResolved,
      },
      {
        name: "No Provider Person",
        entityType: "person",
        subtype: "external",
        source: "llm_extraction",
        sourceId: "person:no-provider",
        evidence: [],
        triggeredByUserId: "user-1",
      },
    );

    expect(result.kind).toBe("created");
    expect(provider.embedTexts).not.toHaveBeenCalled();
  });
});

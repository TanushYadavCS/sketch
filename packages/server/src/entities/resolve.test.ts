/**
 * Tests for confirmReview / rejectReview.
 *
 * Covers the master plan's Confirm + Reject happy-paths, the
 * compare-and-swap and existence checks, the stale-merge escalation,
 * the auto-resolution short-circuit, the Reject re-resolve path
 * (single / zero / multi match), and the self-alias contract that
 * keeps a Reject-created entity from re-queuing on the next propose.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import type { IndexEntityRow } from "./materialize-types";
import { normalizeName } from "./name-keys";
import { type Entity, type EntityLookup, proposeEntity } from "./propose";
import { ResolveError, confirmReview, dismissReview, rejectReview } from "./resolve";

const USER_ID = "user-1";

function readEmail(e: IndexEntityRow): string | null {
  if (!e.metadata) return null;
  try {
    const m = JSON.parse(e.metadata);
    return typeof m.email === "string" ? m.email : null;
  } catch {
    return null;
  }
}

function makeLookup(getList: () => Entity[]): EntityLookup {
  return {
    getByNormalizedName: (n) => getList().filter((e) => normalizeName(e.name) === n),
    getByAlias: (n) =>
      getList().filter((e) => {
        const aliases: string[] = e.aliases ? JSON.parse(e.aliases) : [];
        return aliases.some((a) => normalizeName(a) === n);
      }),
    listByType: (t) => getList().filter((e) => e.source_type === t),
  };
}

async function seedConnectorConfig(db: Kysely<DB>, id = "config-test", createdBy = USER_ID) {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: createdBy,
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string, opts: { configId?: string; source?: string } = {}) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: opts.configId ?? "config-test",
      provider_file_id: `p-${id}`,
      file_name: `${id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: opts.source ?? "fireflies",
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

async function queuePendingRow(
  db: Kysely<DB>,
  opts: {
    proposedName: string;
    candidateEntityId: string | null;
    fileIds: string[];
    source?: string;
    triggeredByUserId?: string;
    entityType?: "person" | "company";
  },
) {
  const entityRepo = createEntityRepository(db);
  const reviewRepo = createEntityReviewRepo(db);
  const persons = await db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "=", opts.entityType ?? "person")
    .execute();
  const result = await proposeEntity(
    {
      entityRepo,
      reviewRepo,
      lookup: makeLookup(() => persons),
      readEmail,
    },
    {
      name: opts.proposedName,
      entityType: opts.entityType ?? "person",
      subtype: "external",
      source: opts.source ?? "fireflies",
      sourceId: `fireflies:${opts.proposedName}`,
      evidence: opts.fileIds.map((f) => ({ indexedFileId: f })),
      triggeredByUserId: opts.triggeredByUserId ?? USER_ID,
    },
  );
  if (result.kind !== "queued") throw new Error(`expected queued, got ${result.kind}`);
  return result.reviewId;
}

async function upsertLlmFact(db: Kysely<DB>, fileId: string, name: string, type: string) {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: fileId,
    connectorConfigId: "config-test",
    createdByUserId: USER_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:llm-extraction-v2:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion: "llm-extraction-v2",
      model: "gemini",
      mention: name,
      type,
      variations: [],
    },
  });
}

async function upsertLlmRelationFact(
  db: Kysely<DB>,
  input: {
    fileId: string;
    relationType: "works_at" | "leads" | "contributes_to" | "builds" | "part_of" | "partner_of";
    source: { name: string; type: string; variations?: string[] };
    target: { name: string; type: string; variations?: string[] };
  },
) {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: "config-test",
    createdByUserId: USER_ID,
    contentHash: `hash-${input.fileId}`,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: input.relationType,
    subjectName: input.source.name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${input.fileId}:hash-${input.fileId}:llm-extraction-v2:${input.relationType}:${input.source.name}:${input.target.name}`,
    raw: {
      contentHash: `hash-${input.fileId}`,
      promptVersion: "llm-extraction-v2",
      model: "gemini",
      relationType: input.relationType,
      confidence: 0.91,
      sourceConfidence: 0.9,
      targetConfidence: 0.9,
      source: {
        name: input.source.name,
        type: input.source.type,
        variations: input.source.variations ?? [],
      },
      target: {
        name: input.target.name,
        type: input.target.type,
        variations: input.target.variations ?? [],
      },
    },
  });
}

describe("confirmReview", () => {
  let db: Kysely<DB>;
  let entityRepo: ReturnType<typeof createEntityRepository>;
  let reviewRepo: ReturnType<typeof createEntityReviewRepo>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: USER_ID, name: "User One", email: "user-1@example.com" }).execute();
    entityRepo = createEntityRepository(db);
    reviewRepo = createEntityReviewRepo(db);
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("happy path: appends alias, materializes ACL + mentions, marks confirmed", async () => {
    const target = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    await seedIndexedFile(db, "file-2");
    await seedIndexedFile(db, "file-3");

    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: target.id,
      fileIds: ["file-1", "file-2", "file-3"],
    });

    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing candidate_generated_at");

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    expect(result.targetEntityId).toBe(target.id);
    expect(result.shortCircuited).toBe(false);

    const refreshedTarget = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    const aliases: string[] = refreshedTarget.aliases ? JSON.parse(refreshedTarget.aliases) : [];
    expect(aliases).toContain("Simran Suri Neeli");

    const access = await db
      .selectFrom("file_access")
      .selectAll()
      .where("principal_type", "=", "email")
      .where("principal_value", "=", "simran@acme.com")
      .execute();
    expect(access.map((a) => a.indexed_file_id).sort()).toEqual(["file-1", "file-2", "file-3"]);

    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", target.id).execute();
    expect(mentions.map((m) => m.indexed_file_id).sort()).toEqual(["file-1", "file-2", "file-3"]);
    expect(mentions.map((m) => ({ confidence: m.confidence, source: m.source, relation: m.relation }))).toEqual([
      { confidence: "EXTRACTED", source: "fireflies", relation: "attended" },
      { confidence: "EXTRACTED", source: "fireflies", relation: "attended" },
      { confidence: "EXTRACTED", source: "fireflies", relation: "attended" },
    ]);

    const finalRow = await reviewRepo.getById(reviewId);
    expect(finalRow?.status).toBe("confirmed");
    expect(finalRow?.resolved_entity_id).toBe(target.id);
    expect(finalRow?.resolved_by).toBe(USER_ID);
  });

  it("creates and source-binds a seed project on confirm", async () => {
    await seedIndexedFile(db, "file-seed", { source: "clickup" });
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Launch Plan",
        normalized_name: "launch plan",
        entity_type: "project",
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
        seed_source: "clickup",
        seed_source_id: "S1",
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: reviewId,
        indexed_file_id: "file-seed",
        source: "clickup",
        note: JSON.stringify({ path: "Workspace / Space" }),
        seen_at: now,
      })
      .execute();

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: now });

    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", result.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(entity).toMatchObject({ name: "Launch Plan", source_type: "project", status: "confirmed" });

    const sourceRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "clickup")
      .where("source_id", "=", "S1")
      .executeTakeFirstOrThrow();
    expect(sourceRef.entity_id).toBe(entity.id);

    expect(result.row.status).toBe("confirmed");
    expect(result.row.resolved_entity_id).toBe(entity.id);
    expect(result.shortCircuited).toBe(false);
    expect(result.mergedStaleEntityId).toBeNull();
  });

  it("source-binds a seed row when confirming into an existing target", async () => {
    const target = await entityRepo.upsertEntity({
      name: "Existing Launch",
      sourceType: "project",
      status: "confirmed",
    });
    const now = new Date().toISOString();
    const reviewId = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Launch Plan",
        normalized_name: "launch plan",
        entity_type: "project",
        candidate_entity_id: target.id,
        candidate_score: 0.9,
        candidate_reason: "seed match",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
        seed_source: "clickup",
        seed_source_id: "S1",
      })
      .execute();

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: now });

    expect(result.targetEntityId).toBe(target.id);
    await expect(
      db
        .selectFrom("entity_source_refs")
        .select(["entity_id", "source", "source_id"])
        .where("source", "=", "clickup")
        .where("source_id", "=", "S1")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: target.id, source: "clickup", source_id: "S1" });
  });

  it("rematerializes held LLM non-person facts after confirm", async () => {
    const target = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await seedIndexedFile(db, "file-llm-1", { source: "google_drive" });
    await seedIndexedFile(db, "file-llm-2", { source: "google_drive" });
    await upsertLlmFact(db, "file-llm-1", "Canvas", "company");
    await upsertLlmFact(db, "file-llm-2", "Canvas", "company");

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row.candidate_entity_id).toBe(target.id);
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");

    await confirmReview({ db, userId: USER_ID }, row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", target.id).execute();
    expect(mentions.map((m) => m.indexed_file_id).sort()).toEqual(["file-llm-1", "file-llm-2"]);
    expect(mentions.every((m) => m.source === "llm_extraction")).toBe(true);
    const facts = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).execute();
    expect(facts.every((f) => f.materialized_at !== null)).toBe(true);
  });

  it("revives deferred relation facts after confirming a queued endpoint", async () => {
    const target = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await seedIndexedFile(db, "file-relation", { source: "google_drive" });
    await upsertLlmRelationFact(db, {
      fileId: "file-relation",
      relationType: "works_at",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Canvas", type: "company" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row.candidate_entity_id).toBe(target.id);
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);

    await confirmReview({ db, userId: USER_ID, logger: createTestLogger() }, row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    const relationship = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["source.name as source_name", "target.name as target_name", "entity_relationships.relationship_type"])
      .executeTakeFirstOrThrow();
    expect(relationship).toEqual({
      source_name: "Sarah Chen",
      target_name: "Canvas Labs",
      relationship_type: "works_at",
    });
    const fact = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).executeTakeFirstOrThrow();
    expect(fact.materialized_at).not.toBeNull();
  });

  it("409 on candidate_generated_at drift", async () => {
    const target = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: target.id,
      fileIds: ["file-1"],
    });

    await expect(
      confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: "1999-01-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ResolveError);

    // No mutations.
    const row = await reviewRepo.getById(reviewId);
    expect(row?.status).toBe("pending");
  });

  it("merges a stale entity into target through the ledgered merge core", async () => {
    const target = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    const stale = await entityRepo.upsertPersonEntity({
      // Same proposed name, no email — exactly the stale-merge predicate.
      name: "Simran Suri Neeli",
      subtype: "external",
      source: "seed",
      sourceId: "seed:stale",
    });
    await seedIndexedFile(db, "file-1");
    await seedIndexedFile(db, "file-stale");

    // Pre-existing mention on the stale entity for file-stale.
    await db
      .insertInto("entity_mentions")
      .values({
        id: randomUUID(),
        entity_id: stale.id,
        indexed_file_id: "file-stale",
        chunk_index: null,
        context_snippet: null,
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    // Pre-existing mention on target for file-stale (forces ON CONFLICT path).
    await db
      .insertInto("entity_mentions")
      .values({
        id: randomUUID(),
        entity_id: target.id,
        indexed_file_id: "file-stale",
        chunk_index: null,
        context_snippet: null,
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    await entityRepo.upsertContactPoint({
      entityId: target.id,
      kind: "email",
      value: "simran@acme.com",
      displayValue: "simran@acme.com",
      source: "gmail",
      connectorConfigId: "config-test",
      lastContactedAt: "2026-01-01T00:00:00.000Z",
      makePrimary: true,
    });
    await entityRepo.upsertContactPoint({
      entityId: stale.id,
      kind: "email",
      value: "SIMRAN@ACME.COM",
      displayValue: "SIMRAN@ACME.COM",
      source: "manual",
      connectorConfigId: "config-test",
      verifiedAt: "2026-01-04T00:00:00.000Z",
      lastContactedAt: "2026-01-03T00:00:00.000Z",
      makePrimary: true,
    });
    await entityRepo.upsertContactPoint({
      entityId: target.id,
      kind: "linkedin",
      value: "simran-old",
      source: "manual",
      connectorConfigId: "config-test",
      lastContactedAt: "2026-01-01T00:00:00.000Z",
      makePrimary: true,
    });
    await entityRepo.upsertContactPoint({
      entityId: stale.id,
      kind: "linkedin",
      value: "simran-new",
      source: "manual",
      connectorConfigId: "config-test",
      lastContactedAt: "2026-01-05T00:00:00.000Z",
      makePrimary: true,
    });

    // Queue with the stale entity NOT as the candidate — the resolver
    // discovers it via the name+no-email predicate at step 5. proposeEntity
    // would have routed this through token-superset to land Simran Suri as
    // the candidate.
    const target2 = await db.selectFrom("entities").selectAll().where("id", "=", target.id).executeTakeFirstOrThrow();
    void target2;
    await seedIndexedFile(db, "file-q");
    // The propose path won't queue against the existing stale entity
    // because the alias fast-path links to it. So queue manually.
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Simran Suri Neeli",
        normalized_name: "simran suri neeli",
        entity_type: "person",
        candidate_entity_id: target.id,
        candidate_score: 0.9,
        candidate_reason: "token-superset",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: reviewId,
        indexed_file_id: "file-q",
        source: "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: now });

    expect(result.mergedStaleEntityId).toBe(stale.id);

    const merges = await db.selectFrom("entity_merges").selectAll().execute();
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ survivor_entity_id: target.id, merged_entity_id: stale.id });

    // Stale entity is tombstoned, not hard-deleted.
    const staleAfter = await db.selectFrom("entities").selectAll().where("id", "=", stale.id).executeTakeFirst();
    expect(staleAfter).toMatchObject({ merged_into_entity_id: target.id });
    expect(staleAfter?.deleted_at).toBeTruthy();

    // Target gained the stale's file-stale mention (ON CONFLICT kept the pre-existing one).
    const targetMentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", target.id)
      .execute();
    const fileIds = targetMentions.map((m) => m.indexed_file_id);
    expect(fileIds).toContain("file-stale");
    expect(fileIds).toContain("file-q");

    const contactPoints = await entityRepo.getContactPointsForEntity(target.id);
    expect(contactPoints.filter((point) => point.kind === "email")).toHaveLength(1);
    expect(contactPoints.find((point) => point.kind === "email")).toMatchObject({
      value: "simran@acme.com",
      source: "gmail",
      verified_at: null,
      last_contacted_at: "2026-01-01T00:00:00.000Z",
      is_primary: 1,
    });
    expect(
      contactPoints
        .filter((point) => point.kind === "linkedin")
        .map((point) => ({ value: point.value, isPrimary: point.is_primary })),
    ).toEqual([
      { value: "simran-old", isPrimary: 1 },
      { value: "simran-new", isPrimary: 0 },
    ]);
  });

  it("aborts with MULTIPLE_STALE_CANDIDATES when two stale entities match", async () => {
    const target = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    // Insert two stale entities sharing the proposed name, distinct from
    // target, no email.
    const stale1 = randomUUID();
    const stale2 = randomUUID();
    const t = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: stale1,
          name: "Simran Suri Neeli",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: JSON.stringify({}),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: t,
          updated_at: t,
        },
        {
          id: stale2,
          name: "Simran Suri Neeli",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: JSON.stringify({}),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: t,
          updated_at: t,
        },
      ])
      .execute();

    await seedIndexedFile(db, "file-1");
    const reviewId = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Simran Suri Neeli",
        normalized_name: "simran suri neeli",
        entity_type: "person",
        candidate_entity_id: target.id,
        candidate_score: 0.9,
        candidate_reason: "token-superset",
        candidate_generated_at: t,
        first_seen_at: t,
        last_seen_at: t,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: reviewId,
        indexed_file_id: "file-1",
        source: "fireflies",
        note: null,
        seen_at: t,
      })
      .execute();

    await expect(confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: t })).rejects.toMatchObject({
      code: "MULTIPLE_STALE_CANDIDATES",
    });

    // Row stays pending; transaction rolled back.
    const row = await reviewRepo.getById(reviewId);
    expect(row?.status).toBe("pending");
  });

  it("pick-different writes a rejection against the original candidate", async () => {
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    const e2 = await entityRepo.upsertPersonEntity({
      name: "Simran S",
      email: "simran-s@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss2",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: e1.id,
      fileIds: ["file-1"],
    });

    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");
    const result = await confirmReview({ db, userId: USER_ID }, reviewId, {
      mergeIntoEntityId: e2.id,
      candidateGeneratedAt: row.candidate_generated_at,
    });

    expect(result.targetEntityId).toBe(e2.id);

    // E1 carries the rejection so future proposals of the same name skip it.
    const rejections = await db
      .selectFrom("entity_alias_rejections")
      .selectAll()
      .where("entity_id", "=", e1.id)
      .execute();
    expect(rejections.map((r) => r.normalized_rejected_name)).toContain("simran suri neeli");
  });

  it("422 when mergeIntoEntityId source_type does not match queue entity_type", async () => {
    const personTarget = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    // A company we're going to try to merge a person row into.
    const company = await entityRepo.upsertEntity({
      name: "Sketch Inc",
      sourceType: "company",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: personTarget.id,
      fileIds: ["file-1"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    await expect(
      confirmReview({ db, userId: USER_ID }, reviewId, {
        mergeIntoEntityId: company.id,
        candidateGeneratedAt: row.candidate_generated_at,
      }),
    ).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
  });

  it("idempotent replay on already-confirmed row", async () => {
    const target = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: target.id,
      fileIds: ["file-1"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    await confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: row.candidate_generated_at });
    // Replay.
    const second = await confirmReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at,
    });
    expect(second.row.status).toBe("confirmed");
    // Aliases / mentions counts unchanged on second call.
    const aliasesCount = await db
      .selectFrom("entities")
      .select(["aliases"])
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    const aliases: string[] = aliasesCount.aliases ? JSON.parse(aliasesCount.aliases) : [];
    expect(aliases.filter((a) => normalizeName(a) === "simran suri neeli")).toHaveLength(1);
  });

  it("terminal update does not overwrite a row resolved by another request", async () => {
    const confirmedTarget = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: confirmedTarget.id,
      fileIds: ["file-1"],
    });
    const rejectedTarget = await entityRepo.upsertPersonEntity({
      name: "Simran Suri Neeli",
      email: "neeli@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:neeli",
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    const firstWon = await reviewRepo.markResolved(
      reviewId,
      "confirmed",
      confirmedTarget.id,
      "resolver-1",
      row.candidate_generated_at,
    );
    const secondWon = await reviewRepo.markResolved(
      reviewId,
      "rejected",
      rejectedTarget.id,
      "resolver-2",
      row.candidate_generated_at,
    );

    expect(firstWon).toBe(true);
    expect(secondWon).toBe(false);

    const finalRow = await reviewRepo.getById(reviewId);
    expect(finalRow?.status).toBe("confirmed");
    expect(finalRow?.resolved_entity_id).toBe(confirmedTarget.id);
    expect(finalRow?.resolved_by).toBe("resolver-1");
  });
});

describe("rejectReview", () => {
  let db: Kysely<DB>;
  let entityRepo: ReturnType<typeof createEntityRepository>;
  let reviewRepo: ReturnType<typeof createEntityReviewRepo>;

  beforeEach(async () => {
    db = await createTestDb();
    entityRepo = createEntityRepository(db);
    reviewRepo = createEntityReviewRepo(db);
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates new entity, writes sticky rejection against candidate, self-aliases", async () => {
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    await seedIndexedFile(db, "file-2");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: e1.id,
      fileIds: ["file-1", "file-2"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    const result = await rejectReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    expect(result.reResolvedToExisting).toBe(false);
    expect(result.createdEntityId).toBeTruthy();
    expect(result.targetEntityId).toBe(result.createdEntityId);

    // New entity has the proposed name and self-alias.
    if (!result.createdEntityId) throw new Error("createdEntityId expected");
    const newEntity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", result.createdEntityId)
      .executeTakeFirstOrThrow();
    expect(newEntity.name).toBe("Simran Suri Neeli");
    const aliases: string[] = newEntity.aliases ? JSON.parse(newEntity.aliases) : [];
    expect(aliases).toContain("Simran Suri Neeli");

    // Mentions exist for both evidence files.
    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", newEntity.id).execute();
    expect(mentions.map((m) => m.indexed_file_id).sort()).toEqual(["file-1", "file-2"]);
    expect(mentions.map((m) => ({ confidence: m.confidence, source: m.source, relation: m.relation }))).toEqual([
      { confidence: "INFERRED", source: "fireflies", relation: "attended" },
      { confidence: "INFERRED", source: "fireflies", relation: "attended" },
    ]);

    // Sticky rejection on the suggested candidate.
    const rejections = await db
      .selectFrom("entity_alias_rejections")
      .selectAll()
      .where("entity_id", "=", e1.id)
      .execute();
    expect(rejections.map((r) => r.normalized_rejected_name)).toContain("simran suri neeli");
  });

  it("re-resolve: single matching entity → link instead of create", async () => {
    // Models the race: queue row landed against e1 ('Simran Suri') when
    // the proposed identity was still unknown. Before the reviewer hits
    // Reject, another sync seeds the real entity e2 ('Simran Suri Neeli')
    // with its own email. Reject's step 2 re-resolves and discovers e2.
    // The queue row is materialized manually so the propose-time exact-
    // match fast-path doesn't intercept (it'd link to e2 instead of
    // queuing — which is the correct propose-time behaviour once e2
    // exists, but here we're simulating that e2 was seeded AFTER the
    // queue row was created).
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Simran Suri Neeli",
        normalized_name: "simran suri neeli",
        entity_type: "person",
        candidate_entity_id: e1.id,
        candidate_score: 0.9,
        candidate_reason: "token-superset",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: reviewId,
        indexed_file_id: "file-1",
        source: "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();

    // Now seed e2 (between propose-time and Reject-time).
    const e2 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri Neeli",
      email: "neeli@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:neeli",
    });

    const result = await rejectReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: now });

    expect(result.reResolvedToExisting).toBe(true);
    expect(result.createdEntityId).toBeNull();
    expect(result.targetEntityId).toBe(e2.id);

    // No new person entity beyond e1, e2.
    const persons = await db.selectFrom("entities").selectAll().where("source_type", "=", "person").execute();
    expect(persons.map((p) => p.id).sort()).toEqual([e1.id, e2.id].sort());

    // Sticky rejection still written against e1.
    const rejections = await db
      .selectFrom("entity_alias_rejections")
      .selectAll()
      .where("entity_id", "=", e1.id)
      .execute();
    expect(rejections).toHaveLength(1);
  });

  it("re-resolve: multi-match → 409, no mutations", async () => {
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    // Two distinct entities matching the proposed name (distinct from e1).
    const t = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: randomUUID(),
          name: "Simran Suri Neeli",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: JSON.stringify({ email: "a@x" }),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: t,
          updated_at: t,
        },
        {
          id: randomUUID(),
          name: "Simran Suri Neeli",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: JSON.stringify({ email: "b@x" }),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: t,
          updated_at: t,
        },
      ])
      .execute();

    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: e1.id,
      fileIds: ["file-1"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    await expect(
      rejectReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: row.candidate_generated_at }),
    ).rejects.toMatchObject({ code: "MULTIPLE_RE_RESOLVE_MATCHES" });

    const after = await reviewRepo.getById(reviewId);
    expect(after?.status).toBe("pending");
  });

  it("self-alias contract: next propose for same name auto-links to the Reject-created entity", async () => {
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: e1.id,
      fileIds: ["file-1"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    const reject = await rejectReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    // Now propose the same name again — should link, not queue.
    const persons = await db.selectFrom("entities").selectAll().where("source_type", "=", "person").execute();
    const result = await proposeEntity(
      {
        entityRepo,
        reviewRepo,
        lookup: makeLookup(() => persons),
        readEmail,
      },
      {
        name: "Simran Suri Neeli",
        entityType: "person",
        subtype: "external",
        source: "fireflies",
        sourceId: "fireflies:after",
        evidence: [],
        triggeredByUserId: USER_ID,
      },
    );
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.entity.id).toBe(reject.targetEntityId);
  });

  it("rejects against BOTH candidate and explicit rejectAgainstEntityId when distinct", async () => {
    const e1 = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss",
    });
    const e2 = await entityRepo.upsertPersonEntity({
      name: "Simran S",
      email: "simran-s@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:ss2",
    });
    await seedIndexedFile(db, "file-1");
    const reviewId = await queuePendingRow(db, {
      proposedName: "Simran Suri Neeli",
      candidateEntityId: e1.id,
      fileIds: ["file-1"],
    });
    const row = await reviewRepo.getById(reviewId);
    if (!row?.candidate_generated_at) throw new Error("missing");

    await rejectReview({ db, userId: USER_ID }, reviewId, {
      rejectAgainstEntityId: e2.id,
      candidateGeneratedAt: row.candidate_generated_at,
    });

    const e1Rejections = await db
      .selectFrom("entity_alias_rejections")
      .selectAll()
      .where("entity_id", "=", e1.id)
      .execute();
    const e2Rejections = await db
      .selectFrom("entity_alias_rejections")
      .selectAll()
      .where("entity_id", "=", e2.id)
      .execute();
    expect(e1Rejections).toHaveLength(1);
    expect(e2Rejections).toHaveLength(1);
  });
});

describe("dismissReview", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedBirthRow(): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id,
        proposed_name: "Canvasx",
        normalized_name: normalizeName("Canvasx"),
        entity_type: "team",
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: "birth-gated",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
        source: "clickup",
        source_id: "clickup:team:canvasx",
      })
      .execute();
    return id;
  }

  async function countEntities(): Promise<number> {
    const row = await db
      .selectFrom("entities")
      .select((eb) => eb.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    return Number(row.c);
  }

  it("marks the row dismissed and creates no entity", async () => {
    const reviewId = await seedBirthRow();
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();

    const result = await dismissReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at as string,
    });

    expect(result.idempotent).toBe(false);
    expect(result.row.status).toBe("dismissed");
    expect(result.row.resolved_entity_id).toBeNull();
    expect(result.row.resolved_by).toBe(USER_ID);
    expect(await countEntities()).toBe(0);
  });

  it("rejects confirm on an already-dismissed row and creates no entity", async () => {
    const reviewId = await seedBirthRow();
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    await dismissReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at as string,
    });

    await expect(
      confirmReview({ db, userId: USER_ID }, reviewId, { candidateGeneratedAt: row.candidate_generated_at as string }),
    ).rejects.toMatchObject({ code: "CANDIDATE_DRIFT" });
    expect(await countEntities()).toBe(0);
  });

  it("rejects mergeInto (confirm-with-merge) on an already-dismissed row, linking nothing", async () => {
    const reviewId = await seedBirthRow();
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    const existing = await createEntityRepository(db).createEntity({
      name: "Canvas X Team",
      sourceType: "team",
      status: "confirmed",
      provenanceTier: "structural",
    });
    await dismissReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at as string,
    });

    await expect(
      confirmReview({ db, userId: USER_ID }, reviewId, {
        candidateGeneratedAt: row.candidate_generated_at as string,
        mergeIntoEntityId: existing.id,
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_DRIFT" });
    // Only the pre-existing entity remains; no link/merge created.
    expect(await countEntities()).toBe(1);
    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", existing.id).execute();
    expect(mentions).toHaveLength(0);
  });
});

describe("confirmReview — birth rename (nameOverride)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedBirthRow(): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id,
        proposed_name: "canvasx",
        normalized_name: normalizeName("canvasx"),
        entity_type: "team",
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: "birth-gated",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: USER_ID,
        source: "clickup",
        source_id: "clickup:team:canvasx",
      })
      .execute();
    return id;
  }

  it("creates the entity under the override name and keeps the original as an alias", async () => {
    const reviewId = await seedBirthRow();
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at as string,
      nameOverride: "CanvasX",
    });

    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", result.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("CanvasX");
    const aliases: string[] = JSON.parse(entity.aliases || "[]");
    expect(aliases).toContain("canvasx");
  });

  it("falls back to proposed_name when nameOverride is blank", async () => {
    const reviewId = await seedBirthRow();
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();

    const result = await confirmReview({ db, userId: USER_ID }, reviewId, {
      candidateGeneratedAt: row.candidate_generated_at as string,
      nameOverride: "   ",
    });

    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", result.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("canvasx");
  });
});

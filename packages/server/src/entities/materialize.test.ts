import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { buildMaterializeDeps, materializeFromFact, materializeUnmaterializedFacts } from "./materialize";

const ADMIN_ID = "admin-1";
const CONNECTOR_ID = "cfg";

async function seedFiles(db: Kysely<DB>, count: number): Promise<string[]> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: ADMIN_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .execute();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `file-${i + 1}`;
    ids.push(id);
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: CONNECTOR_ID,
        provider_file_id: id,
        file_name: id,
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content_hash: `hash-${i + 1}`,
        is_archived: 0,
        synced_at: now,
      })
      .execute();
  }
  return ids;
}

async function upsertLlmFact(
  db: Kysely<DB>,
  fileId: string,
  name: string,
  type: string,
  promptVersion = "llm-extraction-v2",
) {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ADMIN_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:${promptVersion}:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion,
      model: "gemini",
      mention: name,
      type,
      variations: [],
    },
  });
}

describe("materializeFromFact — llm_extracted threshold + type fidelity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("defers a single-file company mention below threshold", async () => {
    await seedFiles(db, 1);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db, { llmPromotionThreshold: 2 });
    const result = await materializeFromFact(deps, fact);
    expect(result.kind).toBe("deferred_below_threshold");
    const entities = await db.selectFrom("entities").selectAll().execute();
    expect(entities).toHaveLength(0);
  });

  it("promotes once threshold reached, with correct source_type", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    await upsertLlmFact(db, "file-2", "Acme", "company");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect(summary.entitiesCreated).toBe(1);
    const entity = await db.selectFrom("entities").selectAll().executeTakeFirstOrThrow();
    expect(entity.source_type).toBe("company");
    expect(entity.name).toBe("Acme");
    const mentions = await db.selectFrom("entity_mentions").selectAll().execute();
    expect(mentions).toHaveLength(2);
    expect(mentions.every((m) => m.confidence === "INFERRED")).toBe(true);
    expect(mentions.every((m) => m.source === "llm_extraction")).toBe(true);
  });

  it("routes person mentions through the person path, keeping fuzzy review semantics", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Jane Doe", "person");
    await upsertLlmFact(db, "file-2", "Jane Doe", "person");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const entity = await db.selectFrom("entities").selectAll().executeTakeFirstOrThrow();
    expect(entity.source_type).toBe("person");
  });

  it("creates non-person entities without queuing reviews", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Apollo", "project");
    await upsertLlmFact(db, "file-2", "Apollo", "project");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    const entity = await db.selectFrom("entities").selectAll().executeTakeFirstOrThrow();
    expect(entity.source_type).toBe("project");
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
  });

  it("skips facts with missing/invalid type and leaves them unmaterialized", async () => {
    await seedFiles(db, 1);
    // Use 'foo' as an invalid type — passes raw validation but fails normalizeMentionType.
    await upsertLlmFact(db, "file-1", "Whatever", "foo");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });
    expect(summary.entitiesCreated).toBe(0);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
  });

  it("respects configurable threshold (=1 promotes immediately, =3 keeps deferred)", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    await upsertLlmFact(db, "file-2", "Acme", "company");

    let summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 3 });
    expect(summary.entitiesCreated).toBe(0);
    expect(summary.deferredBelowThreshold).toBeGreaterThan(0);

    summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });
    expect(summary.entitiesCreated).toBe(1);
  });

  it("counts active facts only — tombstoned facts don't count toward threshold", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    await upsertLlmFact(db, "file-2", "Acme", "company");
    await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: new Date().toISOString() })
      .where("indexed_file_id", "=", "file-1")
      .execute();
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect(summary.entitiesCreated).toBe(0);
  });

  it("counts distinct files — two facts in the same file don't promote", async () => {
    await seedFiles(db, 1);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    // Second fact w/ different variation makes a different fact_key.
    const repo = createIndexedFileFactRepository(db);
    await repo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      contentHash: "hash-file-1",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Acme",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash-file-1:llm-extraction-v2:Acme:dup",
      raw: {
        contentHash: "hash-file-1",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        mention: "Acme",
        type: "company",
        variations: ["AcmeCorp"],
      },
    });
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });
    expect(summary.entitiesCreated).toBe(0);
  });

  it("dedupes non-person LLM entities case-insensitively", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    await upsertLlmFact(db, "file-2", "acme", "company");
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });
    const entities = await db.selectFrom("entities").selectAll().where("source_type", "=", "company").execute();
    expect(entities).toHaveLength(1);
  });

  it("holds non-person LLM collisions in review without materializing mentions", async () => {
    await seedFiles(db, 2);
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await upsertLlmFact(db, "file-1", "Canvas", "company");
    await upsertLlmFact(db, "file-2", "Canvas", "company");

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    expect(summary.entitiesCreated).toBe(0);
    expect(summary.queued).toBe(2);
    expect(summary.materialized).toBe(0);
    expect(summary.deferred).toBe(2);
    const queue = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(queue.entity_type).toBe("company");
    expect(queue.proposed_name).toBe("Canvas");
    expect(queue.candidate_reason).toBe("token-superset");
    const mentions = await db.selectFrom("entity_mentions").selectAll().execute();
    expect(mentions).toHaveLength(0);
    const facts = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).execute();
    expect(facts.every((f) => f.materialized_at === null)).toBe(true);
  });
});

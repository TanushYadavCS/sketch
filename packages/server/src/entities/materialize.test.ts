import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  buildMaterializeDeps,
  cleanupEmptyRelationships,
  cleanupRelationshipEvidenceForFacts,
  materializeFromFact,
  materializeUnmaterializedFacts,
} from "./materialize";

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

async function upsertLlmRelationFact(
  db: Kysely<DB>,
  input: {
    fileId: string;
    relationType: "works_at" | "leads" | "contributes_to" | "builds" | "part_of" | "partner_of";
    source: { name: string; type: string; variations?: string[] };
    target: { name: string; type: string; variations?: string[] };
    confidence?: number;
    sourceConfidence?: number;
    targetConfidence?: number;
  },
) {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ADMIN_ID,
    contentHash: `hash-${input.fileId}`,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: input.relationType,
    subjectName: input.source.name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${input.fileId}:hash-${input.fileId}:llm-extraction-v2:${input.relationType}:${input.source.name}:${input.target.name}`,
    contextSnippet: `${input.source.name} ${input.relationType} ${input.target.name}`,
    raw: {
      contentHash: `hash-${input.fileId}`,
      promptVersion: "llm-extraction-v2",
      model: "gemini",
      relationType: input.relationType,
      confidence: input.confidence ?? 0.91,
      sourceConfidence: input.sourceConfidence ?? 0.9,
      targetConfidence: input.targetConfidence ?? 0.9,
      context: `${input.source.name} ${input.relationType} ${input.target.name}`,
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

  it("queues ambiguous existing LLM person mentions for review and leaves the fact pending", async () => {
    await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertPersonEntity({
      name: "Sam Smith",
      email: "sam.smith@example.com",
      subtype: "external",
      source: "google_drive",
      sourceId: "person:sam-smith",
    });
    await entityRepo.upsertPersonEntity({
      name: "Sam Patel",
      email: "sam.patel@example.com",
      subtype: "external",
      source: "google_drive",
      sourceId: "person:sam-patel",
    });
    await upsertLlmFact(db, "file-1", "Sam", "person");

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.queued).toBe(1);
    expect(summary.materialized).toBe(0);
    expect(summary.deferred).toBe(1);
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(review.proposed_name).toBe("Sam");
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
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
    await upsertLlmFact(db, "file-1", "Whatever", "foo");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });
    expect(summary.entitiesCreated).toBe(0);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
  });

  it("skips stale feature facts and leaves them unmaterialized", async () => {
    await seedFiles(db, 1);
    await upsertLlmFact(db, "file-1", "Aviation Edge scraper", "feature");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });
    expect(summary.entitiesCreated).toBe(0);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
    const entities = await db.selectFrom("entities").selectAll().execute();
    expect(entities).toHaveLength(0);
  });

  it("stops before materializing when cancellation is requested", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Acme", "company");
    await upsertLlmFact(db, "file-2", "Acme", "company");

    await expect(
      materializeUnmaterializedFacts(db, createTestLogger(), {
        llmPromotionThreshold: 1,
        shouldCancel: () => true,
      }),
    ).rejects.toThrow("Re-enrich stopped");

    const facts = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).execute();
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => fact.materialized_at === null)).toBe(true);
    expect(await db.selectFrom("entities").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entity_mentions").selectAll().execute()).toHaveLength(0);
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

describe("materializeFromFact — llm_relation typed edges", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("materializes relation endpoints immediately and writes extracted relationship evidence", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "leads",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    expect(summary.entitiesCreated).toBe(2);
    expect(summary.materialized).toBe(1);
    expect(summary.relationshipsWritten).toBe(1);
    const relationship = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select([
        "entity_relationships.relationship_type",
        "entity_relationships.confidence",
        "entity_relationships.confidence_score",
        "source.name as source_name",
        "target.name as target_name",
      ])
      .executeTakeFirstOrThrow();
    expect(relationship).toMatchObject({
      relationship_type: "leads",
      confidence: "EXTRACTED",
      confidence_score: 0.91,
      source_name: "Sarah Chen",
      target_name: "Project Atlas",
    });
    const evidence = await db.selectFrom("entity_relationship_evidence").selectAll().execute();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].indexed_file_id).toBe("file-1");
  });

  it("writes partner_of symmetrically and idempotently", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "partner_of",
      source: { name: "Acme", type: "company" },
      target: { name: "Globex", type: "company" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });
    await db.updateTable("indexed_file_facts").set({ materialized_at: null }).execute();
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["source.name as source_name", "target.name as target_name", "entity_relationships.relationship_type"])
      .orderBy("source.name")
      .execute();
    expect(relationships).toEqual([
      { source_name: "Acme", target_name: "Globex", relationship_type: "partner_of" },
      { source_name: "Globex", target_name: "Acme", relationship_type: "partner_of" },
    ]);
  });

  it("keeps domain and LLM evidence as separate rows for the same relationship and file", async () => {
    await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    const domainsRepo = createEntityDomainsRepository(db);
    const person = await entityRepo.upsertPersonEntity({
      name: "Sarah Chen",
      email: "sarah@canvas.example",
      subtype: "external",
      source: "google_drive",
      sourceId: "person:sarah",
    });
    const company = await entityRepo.upsertEntity({
      name: "Canvas Labs",
      sourceType: "company",
      status: "confirmed",
    });
    const relationshipId = await domainsRepo.upsertWorksAt({
      personEntityId: person.id,
      companyEntityId: company.id,
      confidence: "INFERRED",
      confidenceScore: 0.9,
      source: "email_domain",
    });
    await domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: "file-1",
      note: "email_domain:canvas.example",
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "works_at",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Canvas Labs", type: "company" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    const evidence = await db
      .selectFrom("entity_relationship_evidence")
      .select(["indexed_file_id", "source_fact_id", "evidence_key", "note"])
      .where("relationship_id", "=", relationshipId)
      .orderBy("source_fact_id")
      .execute();
    expect(evidence).toHaveLength(2);
    expect(evidence.map((row) => row.indexed_file_id)).toEqual(["file-1", "file-1"]);
    expect(evidence.some((row) => row.source_fact_id === null && row.evidence_key.startsWith("note:"))).toBe(true);
    expect(evidence.some((row) => row.source_fact_id !== null && row.evidence_key.startsWith("fact:"))).toBe(true);
  });

  it("skips relations whose endpoint mentions are below the confidence floor", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "leads",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project" },
      sourceConfidence: 0.7,
      targetConfidence: 0.92,
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.entitiesCreated).toBe(0);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entity_relationship_evidence").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entity_mentions").selectAll().execute()).toHaveLength(0);
  });

  it("removes relationships that lose their last source-fact evidence row", async () => {
    await seedFiles(db, 2);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "leads",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project" },
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-2",
      relationType: "leads",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project" },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    const facts = await db.selectFrom("indexed_file_facts").selectAll().orderBy("indexed_file_id").execute();
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("entity_relationship_evidence").selectAll().execute()).toHaveLength(2);

    await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: new Date().toISOString(), materialized_at: null })
      .where("id", "=", facts[0].id)
      .execute();
    await cleanupRelationshipEvidenceForFacts(db, [facts[0].id]);
    await cleanupEmptyRelationships(db);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("entity_relationship_evidence").selectAll().execute()).toHaveLength(1);

    await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: new Date().toISOString(), materialized_at: null })
      .where("id", "=", facts[1].id)
      .execute();
    await cleanupRelationshipEvidenceForFacts(db, [facts[1].id]);
    await cleanupEmptyRelationships(db);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entity_relationship_evidence").selectAll().execute()).toHaveLength(0);
  });

  it("skips invalid relation directions without creating edges", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "builds",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.entitiesCreated).toBe(0);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);
  });
});

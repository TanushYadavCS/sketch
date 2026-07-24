import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntitySuppressionRepository } from "../db/repositories/entity-suppressions";
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
import { normalizeEntityMatchName } from "./materialize-deps";

const ADMIN_ID = "admin-1";
const CONNECTOR_ID = "cfg";
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";

async function countEntitiesBySourceType(db: Kysely<DB>, sourceType: string): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", sourceType)
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countReviewQueueRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_review_queue")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

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

async function seedChatSliceFile(db: Kysely<DB>, id: string, source: string, fileType: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: id,
      file_type: fileType,
      content_category: "document",
      source,
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: new Date().toISOString(),
    })
    .execute();
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
    relationType: "works_at" | "leads" | "contributes_to" | "builds" | "part_of" | "engagement_for" | "partner_of";
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

  it("A0 documents current LLM mention path creating product and project entities with no review rows until A1 flips it", async () => {
    await seedFiles(db, 2);
    await upsertLlmFact(db, "file-1", "Sketch", "product");
    await upsertLlmFact(db, "file-2", "Apollo", "project");

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(await countEntitiesBySourceType(db, "product")).toBe(1);
    expect(await countEntitiesBySourceType(db, "project")).toBe(1);
    expect(await countReviewQueueRows(db)).toBe(0);
  });

  it("promotes legacy project container source refs before queueing review", async () => {
    const [fileId] = await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    const legacy = await entityRepo.upsertEntityFromTool({
      name: "Old Atlas",
      sourceType: "linear_project",
      source: "linear",
      sourceId: "project:atlas",
    });
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      contentHash: "hash-1",
      source: "linear",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Project Atlas",
      subjectSource: "linear",
      subjectSourceId: "project:atlas",
      raw: { sourceType: "linear_project" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.queued).toBe(0);
    expect(summary.materialized).toBe(1);
    const entity = await db.selectFrom("entities").selectAll().where("id", "=", legacy.id).executeTakeFirstOrThrow();
    expect(entity).toMatchObject({ name: "Project Atlas", source_type: "project" });
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("queues a never-seen project relation endpoint instead of birthing it", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "part_of",
      source: { name: "Zephyr", type: "project" },
      target: { name: "Atlas", type: "project" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(0);
    const queue = await db.selectFrom("entity_review_queue").selectAll().where("entity_type", "=", "project").execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].proposed_name).toBe("Zephyr");
    const rels = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(rels).toHaveLength(0);
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.materialized_at).toBeNull();
  });

  it("A0 documents current relation endpoint path queueing project endpoints but creating company and product endpoints until A1 flips it", async () => {
    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "part_of",
      source: { name: "Zephyr", type: "project" },
      target: { name: "Atlas", type: "project" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(await countEntitiesBySourceType(db, "project")).toBe(0);
    expect(await countReviewQueueRows(db)).toBe(1);

    await db.destroy();
    db = await createTestDb();

    await seedFiles(db, 1);
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "builds",
      source: { name: "Acme", type: "company" },
      target: { name: "Sketch", type: "product" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(await countEntitiesBySourceType(db, "company")).toBe(1);
    expect(await countEntitiesBySourceType(db, "product")).toBe(1);
    expect(await countReviewQueueRows(db)).toBe(0);
  });

  it("links an existing project relation endpoint and writes the relation", async () => {
    await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntityFromTool({
      name: "Atlas",
      sourceType: "project",
      source: "google_drive",
      sourceId: "project:atlas",
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "leads",
      source: { name: "Dana Lee", type: "person" },
      target: { name: "Atlas", type: "project" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(1);
    const queue = await db.selectFrom("entity_review_queue").selectAll().where("entity_type", "=", "project").execute();
    expect(queue).toHaveLength(0);
    const rels = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "leads")
      .execute();
    expect(rels).toHaveLength(1);
  });

  it("dedupes repeated new-project relation endpoints into one review row", async () => {
    await seedFiles(db, 2);
    for (const fileId of ["file-1", "file-2"]) {
      await upsertLlmRelationFact(db, {
        fileId,
        relationType: "part_of",
        source: { name: "Zephyr", type: "project" },
        target: { name: "Atlas", type: "project" },
      });
    }

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    const queue = await db.selectFrom("entity_review_queue").selectAll().where("entity_type", "=", "project").execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].occurrence_count).toBeGreaterThanOrEqual(2);
    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(0);
  });

  it("suppresses re-creation of a deleted project name across mention and relation paths", async () => {
    await seedFiles(db, 3);
    await createEntitySuppressionRepository(db).suppress({
      normalizedName: normalizeEntityMatchName("project", "Zephyr"),
      entityType: "project",
      createdBy: ADMIN_ID,
    });
    await upsertLlmFact(db, "file-1", "Zephyr", "project");
    await upsertLlmFact(db, "file-2", "Zephyr", "project");
    await upsertLlmRelationFact(db, {
      fileId: "file-3",
      relationType: "part_of",
      source: { name: "Zephyr", type: "project" },
      target: { name: "Atlas", type: "project" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(0);
    const queue = await db.selectFrom("entity_review_queue").selectAll().where("entity_type", "=", "project").execute();
    expect(queue).toHaveLength(0);
  });

  it("suppresses non-project relation endpoints before creating relation entities", async () => {
    await seedFiles(db, 1);
    await createEntitySuppressionRepository(db).suppress({
      normalizedName: normalizeEntityMatchName("person", "Dana Lee"),
      entityType: "person",
      createdBy: ADMIN_ID,
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "works_at",
      source: { name: "Dana Lee", type: "person" },
      target: { name: "Acme", type: "company" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    const entities = await db.selectFrom("entities").selectAll().execute();
    expect(entities).toHaveLength(0);
    const rels = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(rels).toHaveLength(0);
  });

  it("suppresses a builds product endpoint when a corporate domain matches the product name", async () => {
    await seedFiles(db, 1);
    await db
      .insertInto("entity_domains")
      .values({
        id: "domain-ratevendor",
        entity_id: null,
        domain: "ratevendor.test",
        kind: "corporate",
        is_primary: 1,
        confidence: 1,
        source: "manual",
      })
      .execute();
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "builds",
      source: { name: "Acme Hospitality", type: "company" },
      target: { name: "Rate Vendor", type: "product" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.relationshipsWritten).toBe(0);
    expect(await countEntitiesBySourceType(db, "company")).toBe(1);
    expect(await countEntitiesBySourceType(db, "product")).toBe(0);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);
  });

  it("materializes contact point facts onto the referenced person", async () => {
    const [fileId] = await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    const person = await entityRepo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@example.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "person:simran",
    });
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      contentHash: "hash-1",
      source: "fireflies",
      factType: "contact_point",
      relation: "contactable",
      subjectName: "Simran Suri",
      subjectEmail: "simran@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "person:simran",
      raw: {
        providerFileId: "meeting-1",
        contactPoint: {
          subjectName: "Simran Suri",
          subjectEmail: "simran@example.com",
          subjectSource: "fireflies",
          subjectSourceId: "person:simran",
          kind: "email",
          value: "SIMRAN@example.com",
          displayValue: "SIMRAN@example.com",
          source: "fireflies",
          lastContactedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.materialized).toBe(1);
    const rows = await entityRepo.getContactPointsForEntity(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "email",
      value: "simran@example.com",
      display_value: "SIMRAN@example.com",
      source: "fireflies",
      connector_config_id: CONNECTOR_ID,
      created_by_user_id: ADMIN_ID,
      last_contacted_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("materializes contact point facts after same-batch person facts", async () => {
    const [fileId] = await seedFiles(db, 1);
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      contentHash: "hash-1",
      source: "fireflies",
      factType: "contact_point",
      relation: "contactable",
      subjectName: "Nisha Rao",
      subjectEmail: "nisha@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "person:nisha",
      raw: {
        providerFileId: "meeting-1",
        contactPoint: {
          subjectName: "Nisha Rao",
          subjectEmail: "nisha@example.com",
          subjectSource: "fireflies",
          subjectSourceId: "person:nisha",
          kind: "linkedin",
          value: "https://www.linkedin.com/in/Nisha-Rao/",
          source: "fireflies",
        },
      },
    });
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      contentHash: "hash-1",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Nisha Rao",
      subjectEmail: "nisha@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "person:nisha",
      raw: {
        providerFileId: "meeting-1",
        attendee: {
          name: "Nisha Rao",
          email: "nisha@example.com",
        },
      },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.materialized).toBe(2);
    const entityRepo = createEntityRepository(db);
    const [person] = await entityRepo.getPersonEntitiesByEmail("nisha@example.com");
    expect(person).toMatchObject({ source_type: "person", name: "Nisha Rao" });
    const rows = await entityRepo.getContactPointsForEntity(person.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "linkedin",
        value: "nisha-rao",
        source: "fireflies",
      }),
    ]);
    const facts = await db.selectFrom("indexed_file_facts").select(["materialized_at"]).execute();
    expect(facts.every((fact) => fact.materialized_at !== null)).toBe(true);
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

  it("logs conflicting Zoho CRM Account domain claims without reassigning the domain", async () => {
    await seedFiles(db, 1);
    const entityRepo = createEntityRepository(db);
    const domainsRepo = createEntityDomainsRepository(db);
    const globex = await entityRepo.upsertEntity({ name: "Globex", sourceType: "company" });
    await domainsRepo.upsertDomain({
      entityId: globex.id,
      domain: "globex.test",
      kind: "corporate",
      source: "manual",
      confidence: 1,
      isPrimary: true,
    });

    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: ADMIN_ID,
      source: "zoho_crm",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Acme Corp",
      subjectSource: "zoho_crm",
      subjectSourceId: "Accounts:a1",
      raw: {
        sourceType: "company",
        metadata: { crmAccountDomains: ["globex.test"] },
      },
    });
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as ReturnType<typeof createTestLogger>;

    await materializeUnmaterializedFacts(db, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityName: "Acme Corp",
        domain: "globex.test",
        result: "skipped_manual_conflict",
      }),
      "Skipped conflicting Zoho CRM Account domain claim",
    );
    const domain = await db
      .selectFrom("entity_domains")
      .select(["domain", "entity_id", "source"])
      .where("domain", "=", "globex.test")
      .executeTakeFirstOrThrow();
    expect(domain).toEqual({ domain: "globex.test", entity_id: globex.id, source: "manual" });
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

  it("never mints relation endpoints from a chat conversation slice", async () => {
    await seedFiles(db, 1);
    await seedChatSliceFile(db, "slice-slack", "slack", "slack_conversation_slice");
    await upsertLlmRelationFact(db, {
      fileId: "slice-slack",
      relationType: "leads",
      source: { name: "K Saurabh", type: "person" },
      target: { name: "Acme Corp", type: "company" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.entitiesCreated).toBe(0);
    expect(summary.relationshipsWritten).toBe(0);
    const entities = await db.selectFrom("entities").select("name").execute();
    expect(entities).toEqual([]);
  });

  it("never mints relation endpoints from a WhatsApp conversation slice", async () => {
    await seedFiles(db, 1);
    await seedChatSliceFile(db, "slice-wa", "whatsapp", "whatsapp_conversation_slice");
    await upsertLlmRelationFact(db, {
      fileId: "slice-wa",
      relationType: "works_at",
      source: { name: "Priya Rao", type: "person" },
      target: { name: "Globex", type: "company" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.entitiesCreated).toBe(0);
    expect(summary.relationshipsWritten).toBe(0);
  });

  it("links chat-slice relations to existing entities and writes the relationship without minting", async () => {
    await seedFiles(db, 1);
    await seedChatSliceFile(db, "slice-slack", "slack", "slack_conversation_slice");
    const repo = createEntityRepository(db);
    await repo.upsertEntityFromTool({
      name: "Acme Corp",
      sourceType: "company",
      source: "crm",
      sourceId: "company:acme",
    });
    await repo.upsertEntityFromTool({
      name: "Globex",
      sourceType: "company",
      source: "crm",
      sourceId: "company:globex",
    });
    await upsertLlmRelationFact(db, {
      fileId: "slice-slack",
      relationType: "partner_of",
      source: { name: "Acme Corp", type: "company" },
      target: { name: "Globex", type: "company" },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 1 });

    expect(summary.entitiesCreated).toBe(0);
    expect(summary.relationshipsWritten).toBe(2);
    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["source.name as source_name", "target.name as target_name"])
      .orderBy("source.name")
      .execute();
    expect(relationships).toEqual([
      { source_name: "Acme Corp", target_name: "Globex" },
      { source_name: "Globex", target_name: "Acme Corp" },
    ]);
  });

  it("materializes relation endpoints immediately and writes extracted relationship evidence", async () => {
    await seedFiles(db, 1);
    await createEntityRepository(db).upsertEntityFromTool({
      name: "Project Atlas",
      sourceType: "project",
      source: "google_drive",
      sourceId: "project:atlas",
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "leads",
      source: { name: "Sarah Chen", type: "person" },
      target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
    });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    expect(summary.entitiesCreated).toBe(1);
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

  it("materializes project part_of product relations", async () => {
    await seedFiles(db, 1);
    await createEntityRepository(db).upsertEntity({
      name: "Files Project",
      sourceType: "project",
      status: "confirmed",
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "part_of",
      source: { name: "Files Project", type: "project" },
      target: { name: "Sketch", type: "product" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.relationship_type", "source.name as source_name", "target.name as target_name"])
      .execute();
    expect(relationships).toEqual([
      {
        relationship_type: "part_of",
        source_name: "Files Project",
        target_name: "Sketch",
      },
    ]);
  });

  it("materializes project engagement_for company relations", async () => {
    await seedFiles(db, 1);
    await createEntityRepository(db).upsertEntity({
      name: "Project Atlas",
      sourceType: "project",
      status: "confirmed",
    });
    await upsertLlmRelationFact(db, {
      fileId: "file-1",
      relationType: "engagement_for",
      source: { name: "Project Atlas", type: "project" },
      target: { name: "Oliver Wyman", type: "company" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 99 });

    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.relationship_type", "source.name as source_name", "target.name as target_name"])
      .execute();
    expect(relationships).toEqual([
      {
        relationship_type: "engagement_for",
        source_name: "Project Atlas",
        target_name: "Oliver Wyman",
      },
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
    await entityRepo.upsertSourceRef({
      entityId: person.id,
      source: "llm_relation",
      sourceId: "file-1:hash-file-1:source:Sarah Chen",
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
    const entityRepo = createEntityRepository(db);
    const person = await entityRepo.upsertPersonEntity({
      name: "Sarah Chen",
      subtype: "external",
      source: "google_drive",
      sourceId: "person:sarah",
    });
    await entityRepo.upsertSourceRef({
      entityId: person.id,
      source: "llm_relation",
      sourceId: "file-1:hash-file-1:source:Sarah Chen",
    });
    await entityRepo.upsertSourceRef({
      entityId: person.id,
      source: "llm_relation",
      sourceId: "file-2:hash-file-2:source:Sarah Chen",
    });
    await entityRepo.upsertEntityFromTool({
      name: "Project Atlas",
      sourceType: "project",
      source: "google_drive",
      sourceId: "project:atlas",
    });
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

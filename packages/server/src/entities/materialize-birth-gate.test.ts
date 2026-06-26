import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import type { ProposeEntityType } from "./propose";

const USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";
const A1_BIRTH_GATE_TYPES: Set<ProposeEntityType> = new Set(["project", "product", "team"]);
const PRODUCT_LIVE_TYPES: Set<ProposeEntityType> = new Set(["product"]);

async function seedConnector(db: Kysely<DB>, source = "google_drive"): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "User One",
      email: "user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: source,
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, source = "google_drive"): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.md`,
      file_type: "doc",
      content_category: "document",
      source,
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function upsertLlmMention(db: Kysely<DB>, fileId: string, name: string, type: string): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:llm-extraction-v8:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion: "llm-extraction-v8",
      model: "gemini",
      mention: name,
      type,
      variations: [],
    },
  });
}

async function upsertLlmRelation(
  db: Kysely<DB>,
  input: {
    fileId: string;
    relationType: "builds";
    source: { name: string; type: string };
    target: { name: string; type: string };
  },
): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${input.fileId}`,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: input.relationType,
    subjectName: input.source.name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${input.fileId}:hash-${input.fileId}:llm-extraction-v8:${input.relationType}:${input.source.name}:${input.target.name}`,
    contextSnippet: `${input.source.name} ${input.relationType} ${input.target.name}`,
    raw: {
      contentHash: `hash-${input.fileId}`,
      promptVersion: "llm-extraction-v8",
      model: "gemini",
      relationType: input.relationType,
      confidence: 0.92,
      sourceConfidence: 0.9,
      targetConfidence: 0.9,
      context: `${input.source.name} ${input.relationType} ${input.target.name}`,
      source: { ...input.source, variations: [] },
      target: { ...input.target, variations: [] },
    },
  });
}

async function countEntitiesByType(db: Kysely<DB>, sourceType: string): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", sourceType)
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countQueueRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_review_queue")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("A1 birth gate", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("queues unmatched product mentions live while the global birth gate stays dry-run", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateLiveTypes: PRODUCT_LIVE_TYPES,
      birthGateDryRun: true,
    });

    expect(await countEntitiesByType(db, "product")).toBe(0);
    expect(await countQueueRows(db)).toBe(1);
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row.candidate_reason).toBe("birth-gated");
    expect(row.entity_type).toBe("product");
    expect(row.source).toBe("llm_extraction");
    expect(row.source_id).toBe("file-1:hash-file-1:llm-extraction-v8:Canvas Copilot");
    expect(row.status).toBe("pending");
  });

  it("links declared product mentions without writing a review row", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    const entityRepo = createEntityRepository(db);
    const declared = await entityRepo.upsertEntity({
      name: "Canvas Copilot",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "declared",
    });
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateLiveTypes: PRODUCT_LIVE_TYPES,
      birthGateDryRun: true,
    });

    expect(await countEntitiesByType(db, "product")).toBe(1);
    expect(await countQueueRows(db)).toBe(0);
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", declared.id).execute(),
    ).resolves.toHaveLength(1);
  });

  it("keeps project births dry-run while unmatched relation product endpoints are queued", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    await upsertLlmMention(db, "file-1", "Atlas Migration", "project");
    await upsertLlmRelation(db, {
      fileId: "file-1",
      relationType: "builds",
      source: { name: "Acme", type: "company" },
      target: { name: "Canvas Copilot", type: "product" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateLiveTypes: PRODUCT_LIVE_TYPES,
      birthGateDryRun: true,
    });

    expect(await countEntitiesByType(db, "project")).toBe(1);
    expect(await countEntitiesByType(db, "company")).toBe(1);
    expect(await countEntitiesByType(db, "product")).toBe(0);
    expect(await countQueueRows(db)).toBe(1);
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      entity_type: "product",
      proposed_name: "Canvas Copilot",
      candidate_reason: "birth-gated",
      status: "pending",
    });
  });

  it("auto-creates product mentions with the gate off (EXPERIMENTAL_FLAG invisible)", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: new Set(),
      birthGateLiveTypes: new Set(),
      birthGateDryRun: true,
    });

    expect(await countEntitiesByType(db, "product")).toBe(1);
    expect(await countQueueRows(db)).toBe(0);
  });
});

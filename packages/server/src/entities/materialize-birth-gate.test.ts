import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import type { ProposeEntityType } from "./propose";
import { confirmReview } from "./resolve";

const USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";
const A1_BIRTH_GATE_TYPES: Set<ProposeEntityType> = new Set(["project", "product", "team"]);

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

async function upsertStructuralSeed(
  db: Kysely<DB>,
  input: { fileId: string; sourceType: string; name: string; sourceId: string; source?: string; aliases?: string[] },
): Promise<void> {
  const source = input.source ?? "linear";
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source,
    factType: "structural_seed",
    relation: "seeded",
    subjectName: input.name,
    subjectSource: source,
    subjectSourceId: input.sourceId,
    raw: {
      name: input.name,
      sourceType: input.sourceType,
      source: source,
      sourceId: input.sourceId,
      aliases: input.aliases,
      providerFileId: input.sourceId,
      sourcePath: `${source}/${input.sourceId}`,
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

  it("queues a conversational product birth gate and confirmReview creates the entity", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateDryRun: false,
    });

    expect(await countEntitiesByType(db, "product")).toBe(0);
    expect(await countQueueRows(db)).toBe(1);
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row.candidate_reason).toBe("birth-gated");
    expect(row.source).toBe("llm_extraction");
    expect(row.source_id).toBe("file-1:hash-file-1:llm-extraction-v8:Canvas Copilot");
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");

    const result = await confirmReview({ db, userId: USER_ID }, row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    expect(result.targetEntityId).toBeTruthy();
    expect(await countEntitiesByType(db, "product")).toBe(1);
  });

  it("drops conversational team mentions and queues Linear team structural seeds", async () => {
    await seedConnector(db, "linear");
    await seedFile(db, "file-1", "linear");
    await seedFile(db, "file-2", "linear");
    await upsertLlmMention(db, "file-1", "Platform Team", "team");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateDryRun: false,
    });

    expect(await countEntitiesByType(db, "team")).toBe(0);
    expect(await countQueueRows(db)).toBe(0);

    await upsertStructuralSeed(db, {
      fileId: "file-2",
      sourceType: "team",
      name: "Sketch Platform",
      sourceId: "team-1",
      source: "linear",
      aliases: ["Platform"],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateDryRun: false,
    });

    expect(await countEntitiesByType(db, "team")).toBe(0);
    expect(await countQueueRows(db)).toBe(1);
    const row = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      entity_type: "team",
      seed_source: "linear",
      seed_source_id: "team-1",
      seed_aliases: '["Platform"]',
    });
    if (!row.candidate_generated_at) throw new Error("missing candidate_generated_at");

    const result = await confirmReview({ db, userId: USER_ID }, row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });
    const team = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", result.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(team.name).toBe("Sketch Platform");
    expect(JSON.parse(team.aliases ?? "[]")).toEqual(expect.arrayContaining(["Platform"]));
  });

  it("links exact product matches under the gate and flag-off product mentions still auto-create", async () => {
    await seedConnector(db);
    await seedFile(db, "file-1");
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntity({
      name: "Canvas Copilot",
      sourceType: "product",
      status: "confirmed",
    });
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateDryRun: false,
    });

    expect(await countEntitiesByType(db, "product")).toBe(1);
    expect(await countQueueRows(db)).toBe(0);

    await db.destroy();
    db = await createTestDb();
    await seedConnector(db);
    await seedFile(db, "file-1");
    await upsertLlmMention(db, "file-1", "Canvas Copilot", "product");

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: new Set(),
      birthGateDryRun: false,
    });

    expect(await countEntitiesByType(db, "product")).toBe(1);
    expect(await countQueueRows(db)).toBe(0);
  });
});

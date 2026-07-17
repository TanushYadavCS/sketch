import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";

const OWNER_ID = "whatsapp-policy-owner";
const CONNECTOR_ID = "whatsapp-policy-connector";

async function seedCorpus(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: OWNER_ID, name: "Owner", email: "owner@example.com", auth_role: "admin" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "whatsapp",
      auth_type: "system",
      credentials: "{}",
      created_by: OWNER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, source: string, fileType: string): Promise<void> {
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
      synced_at: "2026-07-17T12:00:00.000Z",
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, fileId: string, name: string, type: string): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: OWNER_ID,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:${name}`,
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

describe("WhatsApp-only LLM evidence no-mint policy", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedCorpus(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not mint recurring unknown person, company, or tool entities from WhatsApp slices", async () => {
    for (const fileId of ["wa-1", "wa-2"]) {
      await seedFile(db, fileId, "whatsapp", "whatsapp_conversation_slice");
      await seedMention(db, fileId, "Unknown Recurring Person", "person");
      await seedMention(db, fileId, "Unknown Recurring Company", "company");
      await seedMention(db, fileId, "Unknown Recurring Tool", "tool");
    }

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    const entities = await db
      .selectFrom("entities")
      .select(["name", "source_type"])
      .where("name", "like", "Unknown Recurring%")
      .execute();
    expect(entities).toEqual([]);
    await expect(db.selectFrom("entity_review_queue").select("id").execute()).resolves.toEqual([]);
  });

  it("keeps existing mixed-evidence minting behavior", async () => {
    await seedFile(db, "wa-mixed", "whatsapp", "whatsapp_conversation_slice");
    await seedFile(db, "drive-mixed", "google_drive", "document");
    await seedMention(db, "wa-mixed", "Mixed Evidence Company", "company");
    await seedMention(db, "drive-mixed", "Mixed Evidence Company", "company");

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    await expect(
      db
        .selectFrom("entities")
        .select(["name", "source_type"])
        .where("name", "=", "Mixed Evidence Company")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ name: "Mixed Evidence Company", source_type: "company" });
  });

  it("corroborates an existing entity from WhatsApp-only evidence", async () => {
    await seedFile(db, "wa-existing-1", "whatsapp", "whatsapp_conversation_slice");
    await seedFile(db, "wa-existing-2", "whatsapp", "whatsapp_conversation_slice");
    const existing = await createEntityRepository(db).upsertEntity({
      name: "Existing Company",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    await seedMention(db, "wa-existing-1", "Existing Company", "company");
    await seedMention(db, "wa-existing-2", "Existing Company", "company");

    await materializeUnmaterializedFacts(db, createTestLogger(), { llmPromotionThreshold: 2 });

    const entities = await db.selectFrom("entities").select("id").where("name", "=", "Existing Company").execute();
    expect(entities).toEqual([{ id: existing.id }]);
    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["entity_id", "indexed_file_id"])
      .where("entity_id", "=", existing.id)
      .orderBy("indexed_file_id", "asc")
      .execute();
    expect(mentions).toEqual([
      { entity_id: existing.id, indexed_file_id: "wa-existing-1" },
      { entity_id: existing.id, indexed_file_id: "wa-existing-2" },
    ]);
  });
});

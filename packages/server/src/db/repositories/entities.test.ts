import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";

async function seedConnectorConfig(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "config-test",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: "user-1",
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "config-test",
      provider_file_id: `provider-${id}`,
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

describe("createEntityRepository createMention", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
    await seedConnectorConfig(db);
    await seedIndexedFile(db, "file-1");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("is idempotent for the same entity, file, and relation", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Beetu",
      email: "beetu@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:beetu",
    });

    const input = {
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED" as const,
      source: "fireflies_attendee",
      relation: "attended" as const,
    };

    await repo.createMention(input);
    await repo.createMention(input);

    const rows = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", entity.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indexed_file_id: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
  });

  it("allows distinct relations for the same entity and file", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Beetu",
      email: "beetu@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:beetu",
    });

    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "assignee",
      relation: "assigned",
    });

    const rows = await db
      .selectFrom("entity_mentions")
      .select(["relation"])
      .where("entity_id", "=", entity.id)
      .orderBy("relation")
      .execute();
    expect(rows.map((r) => r.relation)).toEqual(["assigned", "attended"]);
  });

  it("deleteMentionsForFile preserves EXTRACTED mentions and clears the rest", async () => {
    const db = await createTestDb();
    await seedConnectorConfig(db);
    await seedIndexedFile(db, "file-1");
    const repo = createEntityRepository(db);
    const entity = await repo.upsertPersonEntity({
      name: "Saurabh",
      email: "saurabh@canvasx.ai",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:saurabh",
    });
    // EXTRACTED — from a durable fact. Must survive.
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    // INFERRED — content-derived. Should be wiped on re-enrichment.
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    await repo.deleteMentionsForFile("file-1");

    const remaining = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "relation"])
      .where("indexed_file_id", "=", "file-1")
      .execute();
    expect(remaining).toEqual([{ confidence: "EXTRACTED", relation: "attended" }]);

    await db.destroy();
  });
});

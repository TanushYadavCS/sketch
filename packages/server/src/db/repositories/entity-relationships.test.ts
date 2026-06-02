import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRelationshipsRepository } from "./entity-relationships";

describe("entity relationships repository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedRelations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("orders relationships before applying the per-side cap", async () => {
    const repo = createEntityRelationshipsRepository(db);

    const result = await repo.listRelationsForEntity("e-root", { limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.outgoing.map((row) => row.id)).toEqual(["rel-ambiguous", "rel-many"]);
  });
});

async function seedRelations(db: Kysely<DB>) {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({ id: "owner", name: "Owner", email: "owner@example.com", created_at: now })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-1",
        connector_config_id: "cfg",
        provider_file_id: "provider-1",
        file_name: "File 1",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content_hash: "hash-1",
        is_archived: 0,
        synced_at: now,
      },
      {
        id: "file-2",
        connector_config_id: "cfg",
        provider_file_id: "provider-2",
        file_name: "File 2",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content_hash: "hash-2",
        is_archived: 0,
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "e-root",
        name: "Root",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "e-low",
        name: "Zulu",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "e-many",
        name: "Many Evidence",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "e-ambiguous",
        name: "Ambiguous",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_relationships")
    .values([
      {
        id: "rel-low",
        source_entity_id: "e-root",
        target_entity_id: "e-low",
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.1,
        source: "llm_relation",
      },
      {
        id: "rel-many",
        source_entity_id: "e-root",
        target_entity_id: "e-many",
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.8,
        source: "llm_relation",
      },
      {
        id: "rel-ambiguous",
        source_entity_id: "e-root",
        target_entity_id: "e-ambiguous",
        relationship_type: "works_at",
        confidence: "AMBIGUOUS",
        confidence_score: 0.2,
        source: "llm_relation",
      },
    ])
    .execute();
  await db
    .insertInto("entity_relationship_evidence")
    .values([
      { id: "ev-1", relationship_id: "rel-many", indexed_file_id: "file-1", note: "one", evidence_key: "ev-1" },
      { id: "ev-2", relationship_id: "rel-many", indexed_file_id: "file-2", note: "two", evidence_key: "ev-2" },
    ])
    .execute();
}

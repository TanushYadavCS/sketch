import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";

describe("createEntityRepository deleteEntitiesForFiles postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "pg-config-test",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
        created_by: "user-1",
        scope_config: JSON.stringify({}),
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "pg-file-1",
        connector_config_id: "pg-config-test",
        provider_file_id: "provider-pg-file-1",
        file_name: "pg-file-1.md",
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
  }, 30000);

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("deletes relation endpoint entities whose only support is deleted file evidence", async () => {
    const repo = createEntityRepository(db);
    const source = await repo.upsertPersonEntity({
      name: "PG Source Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "pg-relation:source",
    });
    const target = await repo.upsertPersonEntity({
      name: "PG Target Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "pg-relation:target",
    });
    await db
      .insertInto("entity_relationships")
      .values({
        id: "pg-rel-1",
        source_entity_id: source.id,
        target_entity_id: target.id,
        relationship_type: "knows",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_relation",
      })
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "pg-rel-ev-1",
        relationship_id: "pg-rel-1",
        indexed_file_id: "pg-file-1",
        note: null,
        source_fact_id: null,
      })
      .execute();

    await expect(repo.deleteEntitiesForFiles(["pg-file-1"])).resolves.toBe(2);
    await expect(repo.getEntity(target.id)).resolves.toBeUndefined();
  });

  it("finds batched people by metadata email fallback in postgres", async () => {
    const repo = createEntityRepository(db);
    const metadataOnly = await repo.upsertPersonEntity({
      name: "PG Metadata Person",
      email: "pg-metadata@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "pg-seed:metadata",
    });

    const matches = await repo.getPersonEntitiesByEmails(["PG-METADATA@example.com"]);

    expect(matches.get("pg-metadata@example.com")).toMatchObject([{ id: metadataOnly.id }]);
  });

  it("searches names and aliases case-insensitively in postgres", async () => {
    const repo = createEntityRepository(db);
    const entity = await repo.upsertEntity({
      name: "Oxane Partners",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
      aliases: ["OxanePartners"],
    });

    const nameMatches = await repo.searchEntities("oxane");
    expect(nameMatches.map((match) => match.id)).toContain(entity.id);

    const aliasMatches = await repo.searchEntities("oXaNeP");
    expect(aliasMatches.map((match) => match.id)).toContain(entity.id);
  });
});

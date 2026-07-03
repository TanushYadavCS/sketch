import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";

async function columnInfo(db: Kysely<DB>, tableName: string, columnName: string) {
  const result = await sql<{ column_name: string; data_type: string; udt_name: string }>`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `.execute(db);
  return result.rows;
}

async function indexNames(db: Kysely<DB>, tableName: string): Promise<string[]> {
  const result = await sql<{ indexname: string }>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = ${tableName}
  `.execute(db);
  return result.rows.map((row) => row.indexname);
}

describe("128-trunk-name-embeddings migration", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates entity_name_embeddings with a text primary key and vector embedding", async () => {
    expect(await columnInfo(db, "entity_name_embeddings", "entity_id")).toEqual([
      expect.objectContaining({ column_name: "entity_id", data_type: "text" }),
    ]);
    expect(await columnInfo(db, "entity_name_embeddings", "embedding")).toEqual([
      expect.objectContaining({ column_name: "embedding", data_type: "USER-DEFINED", udt_name: "vector" }),
    ]);
    expect(await indexNames(db, "entity_name_embeddings")).toContain("idx_entity_name_embeddings_hnsw");
  });

  it("creates entity_review_queue_embeddings with a text primary key and vector embedding", async () => {
    expect(await columnInfo(db, "entity_review_queue_embeddings", "review_id")).toEqual([
      expect.objectContaining({ column_name: "review_id", data_type: "text" }),
    ]);
    expect(await columnInfo(db, "entity_review_queue_embeddings", "embedding")).toEqual([
      expect.objectContaining({ column_name: "embedding", data_type: "USER-DEFINED", udt_name: "vector" }),
    ]);
    expect(await indexNames(db, "entity_review_queue_embeddings")).toContain("idx_review_queue_embeddings_hnsw");
  });
});

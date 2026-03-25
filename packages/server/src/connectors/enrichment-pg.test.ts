/**
 * Tests for embedding table operations on Postgres (PGlite + pgvector).
 *
 * Verifies that chunk_embeddings and file_embeddings behave as standard SQL
 * tables on Postgres — in contrast to SQLite where they are vec0 virtual tables.
 * Also validates clearEnrichmentData() does not throw on Postgres.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { clearEnrichmentData } from "./enrichment";

/**
 * Build a sparse vector string of `dims` dimensions.
 * `values` maps zero-based dimension indices to non-zero floats.
 */
function makeVector(dims: number, values: Record<number, number> = {}): string {
  const arr = new Array(dims).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    arr[Number(idx)] = val;
  }
  return `[${arr.join(",")}]`;
}

async function seedFile(db: Kysely<DB>, fileId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "conn-pg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "conn-pg",
      provider_file_id: fileId,
      file_name: "test.txt",
      file_type: "text",
      content_category: "document",
      source: "google_drive",
      source_path: "My Drive",
      provider_url: null,
      content: "test content",
      summary: null,
      context_note: null,
      tags: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

describe("chunk_embeddings on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("inserts a row into chunk_embeddings with a vector(3072) embedding", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const chunkId = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({ id: chunkId, indexed_file_id: fileId, chunk_index: 0, content: "hello world", token_count: 2 })
      .execute();

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 0: 0.5, 1: 0.3 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId}, ${vec}::vector)`.execute(db);

    const rows = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ${chunkId}
    `.execute(db);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].chunk_id).toBe(chunkId);
  });

  it("deletes a row from chunk_embeddings", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const chunkId = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({ id: chunkId, indexed_file_id: fileId, chunk_index: 0, content: "hello", token_count: 1 })
      .execute();

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId}, ${vec}::vector)`.execute(db);

    await sql`DELETE FROM chunk_embeddings WHERE chunk_id = ${chunkId}`.execute(db);

    const rows = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ${chunkId}
    `.execute(db);

    expect(rows.rows).toHaveLength(0);
  });
});

describe("file_embeddings on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("inserts a row into file_embeddings with a vector(3072) embedding", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 5: 0.8 });
    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding) VALUES (${fileId}, ${vec}::vector)`.execute(db);

    const rows = await sql<{ indexed_file_id: string }>`
      SELECT indexed_file_id FROM file_embeddings WHERE indexed_file_id = ${fileId}
    `.execute(db);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].indexed_file_id).toBe(fileId);
  });

  it("upserts file_embeddings with ON CONFLICT DO UPDATE", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const vec1 = makeVector(EMBEDDING_DIMENSIONS, { 0: 0.1 });
    const vec2 = makeVector(EMBEDDING_DIMENSIONS, { 0: 0.9 });

    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding) VALUES (${fileId}, ${vec1}::vector)`.execute(db);
    // ON CONFLICT upsert — Postgres syntax (not INSERT OR REPLACE)
    await sql`
      INSERT INTO file_embeddings (indexed_file_id, embedding)
      VALUES (${fileId}, ${vec2}::vector)
      ON CONFLICT (indexed_file_id) DO UPDATE SET embedding = EXCLUDED.embedding
    `.execute(db);

    const rows = await sql<{ indexed_file_id: string }>`
      SELECT indexed_file_id FROM file_embeddings WHERE indexed_file_id = ${fileId}
    `.execute(db);

    // Upsert must not create a duplicate row
    expect(rows.rows).toHaveLength(1);
  });

  it("deletes a row from file_embeddings", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 2: 0.7 });
    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding) VALUES (${fileId}, ${vec}::vector)`.execute(db);

    await sql`DELETE FROM file_embeddings WHERE indexed_file_id = ${fileId}`.execute(db);

    const rows = await sql<{ indexed_file_id: string }>`
      SELECT indexed_file_id FROM file_embeddings WHERE indexed_file_id = ${fileId}
    `.execute(db);

    expect(rows.rows).toHaveLength(0);
  });
});

describe("clearEnrichmentData on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not throw on Postgres (no 'no such table' error for embedding tables)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    // On Postgres, chunk_embeddings and file_embeddings are real tables.
    // clearEnrichmentData must not fail with "no such table".
    await expect(clearEnrichmentData(db, fileId)).resolves.toBeUndefined();
  });

  it("clears document_chunks on Postgres", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const chunkIds = [randomUUID(), randomUUID()];
    await db
      .insertInto("document_chunks")
      .values(
        chunkIds.map((id, i) => ({
          id,
          indexed_file_id: fileId,
          chunk_index: i,
          content: `chunk ${i}`,
          token_count: 5,
        })),
      )
      .execute();

    await clearEnrichmentData(db, fileId);

    const remaining = await db
      .selectFrom("document_chunks")
      .where("indexed_file_id", "=", fileId)
      .select(sql<number>`count(*)`.as("n"))
      .executeTakeFirstOrThrow();

    expect(Number(remaining.n)).toBe(0);
  });

  it("clears chunk_embeddings when chunks exist on Postgres", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const chunkId = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({ id: chunkId, indexed_file_id: fileId, chunk_index: 0, content: "hello", token_count: 1 })
      .execute();

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 0: 0.5 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId}, ${vec}::vector)`.execute(db);

    await clearEnrichmentData(db, fileId);

    const rows = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ${chunkId}
    `.execute(db);

    expect(rows.rows).toHaveLength(0);
  });

  it("clears file_embeddings on Postgres", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const vec = makeVector(EMBEDDING_DIMENSIONS, { 1: 0.4 });
    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding) VALUES (${fileId}, ${vec}::vector)`.execute(db);

    await clearEnrichmentData(db, fileId);

    const rows = await sql<{ indexed_file_id: string }>`
      SELECT indexed_file_id FROM file_embeddings WHERE indexed_file_id = ${fileId}
    `.execute(db);

    expect(rows.rows).toHaveLength(0);
  });

  it("re-enrichment cycle: delete old embeddings then insert new ones", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    // First enrichment pass
    const chunkId1 = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({ id: chunkId1, indexed_file_id: fileId, chunk_index: 0, content: "original content", token_count: 5 })
      .execute();

    const vec1 = makeVector(EMBEDDING_DIMENSIONS, { 0: 0.5 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId1}, ${vec1}::vector)`.execute(db);

    // Simulate re-enrichment: clear, then insert new chunks + embeddings
    await clearEnrichmentData(db, fileId);

    const chunkId2 = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({ id: chunkId2, indexed_file_id: fileId, chunk_index: 0, content: "updated content", token_count: 5 })
      .execute();

    const vec2 = makeVector(EMBEDDING_DIMENSIONS, { 1: 0.8 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId2}, ${vec2}::vector)`.execute(db);

    // Old chunk embedding must be gone, new one present
    const oldRows = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ${chunkId1}
    `.execute(db);
    expect(oldRows.rows).toHaveLength(0);

    const newRows = await sql<{ chunk_id: string }>`
      SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ${chunkId2}
    `.execute(db);
    expect(newRows.rows).toHaveLength(1);
  });
});

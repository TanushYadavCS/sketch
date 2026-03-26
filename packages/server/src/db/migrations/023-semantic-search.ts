/**
 * Semantic search infrastructure.
 *
 * - document_chunks: text segments for granular embedding + retrieval
 * - document_timeframes: temporal references extracted from documents
 *
 * Note: sqlite-vec virtual tables (chunk_embeddings, file_embeddings) are created
 * outside of Kysely migrations since they require the sqlite-vec extension to be
 * loaded first. See db/index.ts for vec table initialization.
 */
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1. document_chunks ─────────────────────────────────────
  await db.schema
    .createTable("document_chunks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("chunk_index", "integer", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("token_count", "integer")
    .execute();

  await sql`CREATE UNIQUE INDEX idx_chunks_file_index ON document_chunks(indexed_file_id, chunk_index)`.execute(db);
  await sql`CREATE INDEX idx_chunks_file ON document_chunks(indexed_file_id)`.execute(db);

  // ── 2. document_timeframes ─────────────────────────────────
  await db.schema
    .createTable("document_timeframes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("start_date", "text", (col) => col.notNull())
    .addColumn("end_date", "text")
    .addColumn("context", "text")
    .execute();

  await sql`CREATE INDEX idx_timeframes_file ON document_timeframes(indexed_file_id)`.execute(db);
  await sql`CREATE INDEX idx_timeframes_dates ON document_timeframes(start_date, end_date)`.execute(db);

  const isPostgres = isPg(db);

  if (isPostgres) {
    await sql`CREATE TABLE chunk_embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES document_chunks(id) ON DELETE CASCADE,
      embedding vector(3072) NOT NULL
    )`.execute(db);

    await sql`CREATE INDEX idx_chunk_embeddings_hnsw ON chunk_embeddings
      USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)`.execute(db);

    await sql`CREATE TABLE file_embeddings (
      indexed_file_id TEXT PRIMARY KEY REFERENCES indexed_files(id) ON DELETE CASCADE,
      embedding vector(3072) NOT NULL
    )`.execute(db);

    await sql`CREATE INDEX idx_file_embeddings_hnsw ON file_embeddings
      USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("document_timeframes").execute();
  await db.schema.dropTable("document_chunks").execute();
}

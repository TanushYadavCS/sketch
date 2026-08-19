import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";
import { EMBEDDING_DIMENSIONS } from "../index";

/**
 * Embeddings of a file's own fields — its name and its summary — alongside the existing
 * content-chunk embeddings.
 *
 * Vector search previously covered content only, so a file could be semantically
 * unreachable by the two things a person is most likely to describe it by: what it is
 * called and what it is about.
 *
 * A separate table rather than reusing either existing one. `document_chunks` carries a
 * `chunk_index` and feeds a best-chunk-per-file dedup, and a file name is not a chunk of
 * anything. `file_embeddings` holds image embeddings written by a different provider path;
 * mixing modalities under one index is what made that table's name misleading in the first
 * place.
 *
 * SQLite gets no table here — sqlite-vec virtual tables are created at startup outside the
 * migration runner, and the Postgres deployment is the one this targets.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;
  const dims = EMBEDDING_DIMENSIONS;

  await sql`CREATE TABLE file_field_embeddings (
    indexed_file_id TEXT NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    embedding vector(${sql.lit(dims)}) NOT NULL,
    source_text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (indexed_file_id, field)
  )`.execute(db);

  await sql`CREATE INDEX idx_file_field_embeddings_hnsw ON file_field_embeddings
    USING hnsw ((embedding::halfvec(${sql.lit(dims)})) halfvec_cosine_ops)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;
  await sql`DROP TABLE IF EXISTS file_field_embeddings`.execute(db);
}

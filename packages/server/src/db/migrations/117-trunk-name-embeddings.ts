import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  await sql`CREATE TABLE entity_name_embeddings (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    embedding vector(3072) NOT NULL
  )`.execute(db);

  await sql`CREATE INDEX idx_entity_name_embeddings_hnsw ON entity_name_embeddings
    USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)`.execute(db);

  await sql`CREATE TABLE entity_review_queue_embeddings (
    review_id TEXT PRIMARY KEY REFERENCES entity_review_queue(id) ON DELETE CASCADE,
    embedding vector(3072) NOT NULL
  )`.execute(db);

  await sql`CREATE INDEX idx_review_queue_embeddings_hnsw ON entity_review_queue_embeddings
    USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  await sql`DROP TABLE IF EXISTS entity_review_queue_embeddings`.execute(db);
  await sql`DROP TABLE IF EXISTS entity_name_embeddings`.execute(db);
}

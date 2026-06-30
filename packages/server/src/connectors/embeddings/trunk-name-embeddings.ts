import { type Kysely, sql } from "kysely";
import pino from "pino";
import { isPg } from "../../db/dialect";
import * as dbIndex from "../../db/index";
import type { DB } from "../../db/schema";
import type { EmbeddingProvider } from "./types";

export type NameDedupEntityType = "project" | "product";
export type NameEmbeddingKind = "entity" | "review";

export interface ReconcileMissingNameEmbeddingsOptions {
  types?: NameDedupEntityType[];
}

type MissingNameRow = {
  id: string;
  name: string;
  type: string;
};

const NAME_EMBEDDING_BATCH_SIZE = 64;
const NAME_EMBEDDING_TYPES: NameDedupEntityType[] = ["project", "product"];
const logger = pino({ level: process.env.NODE_ENV === "test" ? "silent" : "warn" });

function storageAvailable(db: Kysely<DB>): boolean {
  return isPg(db) || dbIndex.isSqliteVecAvailable();
}

function requestedTypes(types: NameDedupEntityType[] | undefined): NameDedupEntityType[] {
  const requested = types ?? NAME_EMBEDDING_TYPES;
  return NAME_EMBEDDING_TYPES.filter((type) => requested.includes(type));
}

async function missingEntityRows(db: Kysely<DB>, types: NameDedupEntityType[]): Promise<MissingNameRow[]> {
  if (types.length === 0) return [];
  return db
    .selectFrom("entities")
    .select(["id", "name", "source_type as type"])
    .where("source_type", "in", types)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .where(
      sql<boolean>`NOT EXISTS (
        SELECT 1 FROM entity_name_embeddings
        WHERE entity_name_embeddings.entity_id = entities.id
      )`,
    )
    .orderBy("id", "asc")
    .execute();
}

async function missingReviewRows(db: Kysely<DB>, types: NameDedupEntityType[]): Promise<MissingNameRow[]> {
  if (types.length === 0) return [];
  return db
    .selectFrom("entity_review_queue")
    .select(["id", "proposed_name as name", "entity_type as type"])
    .where("entity_type", "in", types)
    .where("status", "=", "pending")
    .where(
      sql<boolean>`NOT EXISTS (
        SELECT 1 FROM entity_review_queue_embeddings
        WHERE entity_review_queue_embeddings.review_id = entity_review_queue.id
      )`,
    )
    .orderBy("id", "asc")
    .execute();
}

async function insertNameEmbedding(
  db: Kysely<DB>,
  kind: NameEmbeddingKind,
  id: string,
  embedding: number[],
): Promise<void> {
  const vector = JSON.stringify(embedding);
  if (isPg(db)) {
    if (kind === "entity") {
      await sql`INSERT INTO entity_name_embeddings (entity_id, embedding)
        VALUES (${id}, ${vector}::vector)
        ON CONFLICT (entity_id) DO NOTHING`.execute(db);
      return;
    }

    await sql`INSERT INTO entity_review_queue_embeddings (review_id, embedding)
      VALUES (${id}, ${vector}::vector)
      ON CONFLICT (review_id) DO NOTHING`.execute(db);
    return;
  }

  if (kind === "entity") {
    await sql`INSERT OR IGNORE INTO entity_name_embeddings (entity_id, embedding)
      VALUES (${id}, ${vector})`.execute(db);
    return;
  }

  await sql`INSERT OR IGNORE INTO entity_review_queue_embeddings (review_id, embedding)
    VALUES (${id}, ${vector})`.execute(db);
}

async function embedMissingRows(
  db: Kysely<DB>,
  provider: EmbeddingProvider,
  kind: NameEmbeddingKind,
  rows: MissingNameRow[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += NAME_EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(start, start + NAME_EMBEDDING_BATCH_SIZE);
    const embeddings = await provider.embedTexts(batch.map((row) => row.name));
    for (let index = 0; index < batch.length; index++) {
      const embedding = embeddings[index];
      if (!embedding) continue;
      await insertNameEmbedding(db, kind, batch[index].id, embedding);
    }
  }
}

export async function reconcileMissingNameEmbeddings(
  db: Kysely<DB>,
  provider: EmbeddingProvider | null | undefined,
  opts: ReconcileMissingNameEmbeddingsOptions = {},
): Promise<void> {
  if (!provider || !storageAvailable(db)) return;

  try {
    const types = requestedTypes(opts.types);
    const [entities, reviews] = await Promise.all([missingEntityRows(db, types), missingReviewRows(db, types)]);
    await embedMissingRows(db, provider, "entity", entities);
    await embedMissingRows(db, provider, "review", reviews);
  } catch (err) {
    logger.warn({ err, stage: "reconcileMissingNameEmbeddings" }, "name embedding reconcile failed open");
  }
}

export async function deleteNameEmbedding(db: Kysely<DB>, kind: NameEmbeddingKind, id: string): Promise<void> {
  if (!storageAvailable(db)) return;

  try {
    if (kind === "entity") {
      await db.deleteFrom("entity_name_embeddings").where("entity_id", "=", id).execute();
      return;
    }

    await db.deleteFrom("entity_review_queue_embeddings").where("review_id", "=", id).execute();
  } catch (err) {
    logger.warn({ err, kind }, "name embedding delete failed open");
  }
}

import { type Kysely, sql } from "kysely";
import pino from "pino";
import { isPg } from "../../db/dialect";
import * as dbIndex from "../../db/index";
import { EMBEDDING_DIMENSIONS } from "../../db/index";
import type { DB } from "../../db/schema";
import type { KnownEntityForPrompt } from "../file-scope-context";
import type { EmbeddingProvider } from "./types";

export type NameDedupEntityType = "project" | "product";
export type NameEmbeddingKind = "entity" | "review";
export type NameDedupQuery = { name: string; type: NameDedupEntityType };

export interface ReconcileMissingNameEmbeddingsOptions {
  types?: NameDedupEntityType[];
}

export interface RetrieveNameDedupCandidatesOptions {
  topK?: number;
  minCosine?: number;
}

type MissingNameRow = {
  id: string;
  name: string;
  type: string;
};

type RetrievedNameRow = {
  entityId: string | null;
  reviewId: string | null;
  name: string;
  type: string;
  similarity: number;
};

const NAME_EMBEDDING_BATCH_SIZE = 64;
const NAME_EMBEDDING_TYPES: NameDedupEntityType[] = ["project", "product"];
export const NAME_DEDUP_COSINE_THRESHOLD = 0.62;
export const NAME_DEDUP_TOP_K = 10;
export const NAME_DEDUP_OVERFETCH = 4;
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

function candidateKey(row: RetrievedNameRow): string {
  return `${row.type}:${row.name.toLowerCase()}`;
}

function toKnownEntity(row: RetrievedNameRow): KnownEntityForPrompt {
  const entity: KnownEntityForPrompt = { name: row.name, type: row.type };
  if (row.entityId) entity.entityId = row.entityId;
  if (row.reviewId) entity.reviewId = row.reviewId;
  return entity;
}

async function retrieveEntityRows(
  db: Kysely<DB>,
  query: NameDedupQuery,
  embeddingJson: string,
  vecLimit: number,
): Promise<RetrievedNameRow[]> {
  if (isPg(db)) {
    const dims = EMBEDDING_DIMENSIONS;
    const result = await sql<RetrievedNameRow>`
      SELECT
        e.id as "entityId",
        NULL::text as "reviewId",
        e.name,
        e.source_type as type,
        (1 - ranked.distance) as similarity
      FROM (
        SELECT
          entity_id,
          (embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
        FROM entity_name_embeddings
        ORDER BY embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
        LIMIT ${vecLimit}
      ) ranked
      INNER JOIN entities e ON e.id = ranked.entity_id
      WHERE e.source_type = ${query.type}
        AND e.deleted_at IS NULL
        AND e.merged_into_entity_id IS NULL
      ORDER BY ranked.distance ASC
    `.execute(db);
    return result.rows;
  }

  const result = await sql<RetrievedNameRow>`
    SELECT
      e.id as entityId,
      NULL as reviewId,
      e.name,
      e.source_type as type,
      (1 - ranked.distance) as similarity
    FROM (
      SELECT entity_id, distance
      FROM entity_name_embeddings
      WHERE embedding MATCH ${embeddingJson}
        AND k = ${vecLimit}
      ORDER BY distance ASC
    ) ranked
    INNER JOIN entities e ON e.id = ranked.entity_id
    WHERE e.source_type = ${query.type}
      AND e.deleted_at IS NULL
      AND e.merged_into_entity_id IS NULL
    ORDER BY ranked.distance ASC
  `.execute(db);
  return result.rows;
}

async function retrieveReviewRows(
  db: Kysely<DB>,
  query: NameDedupQuery,
  embeddingJson: string,
  vecLimit: number,
): Promise<RetrievedNameRow[]> {
  if (isPg(db)) {
    const dims = EMBEDDING_DIMENSIONS;
    const result = await sql<RetrievedNameRow>`
      SELECT
        NULL::text as "entityId",
        q.id as "reviewId",
        q.proposed_name as name,
        q.entity_type as type,
        (1 - ranked.distance) as similarity
      FROM (
        SELECT
          review_id,
          (embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
        FROM entity_review_queue_embeddings
        ORDER BY embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
        LIMIT ${vecLimit}
      ) ranked
      INNER JOIN entity_review_queue q ON q.id = ranked.review_id
      WHERE q.entity_type = ${query.type}
        AND q.status = 'pending'
      ORDER BY ranked.distance ASC
    `.execute(db);
    return result.rows;
  }

  const result = await sql<RetrievedNameRow>`
    SELECT
      NULL as entityId,
      q.id as reviewId,
      q.proposed_name as name,
      q.entity_type as type,
      (1 - ranked.distance) as similarity
    FROM (
      SELECT review_id, distance
      FROM entity_review_queue_embeddings
      WHERE embedding MATCH ${embeddingJson}
        AND k = ${vecLimit}
      ORDER BY distance ASC
    ) ranked
    INNER JOIN entity_review_queue q ON q.id = ranked.review_id
    WHERE q.entity_type = ${query.type}
      AND q.status = 'pending'
    ORDER BY ranked.distance ASC
  `.execute(db);
  return result.rows;
}

export async function retrieveNameDedupCandidates(
  db: Kysely<DB>,
  provider: EmbeddingProvider | null | undefined,
  queries: NameDedupQuery[],
  opts: RetrieveNameDedupCandidatesOptions = {},
): Promise<KnownEntityForPrompt[]> {
  if (!provider || !storageAvailable(db) || queries.length === 0) return [];

  try {
    const topK = opts.topK ?? NAME_DEDUP_TOP_K;
    const minCosine = opts.minCosine ?? NAME_DEDUP_COSINE_THRESHOLD;
    const vecLimit = Math.max(1, topK * NAME_DEDUP_OVERFETCH);
    const embeddings = await provider.embedTexts(queries.map((query) => query.name));
    const bestByKey = new Map<string, RetrievedNameRow>();

    for (let index = 0; index < queries.length; index++) {
      const embedding = embeddings[index];
      if (!embedding) continue;
      const embeddingJson = JSON.stringify(embedding);
      const rows = [
        ...(await retrieveEntityRows(db, queries[index], embeddingJson, vecLimit)),
        ...(await retrieveReviewRows(db, queries[index], embeddingJson, vecLimit)),
      ]
        .filter((row) => row.similarity >= minCosine)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, topK);

      for (const row of rows) {
        const key = candidateKey(row);
        const existing = bestByKey.get(key);
        if (!existing || row.similarity > existing.similarity) {
          bestByKey.set(key, row);
        }
      }
    }

    return Array.from(bestByKey.values())
      .sort((left, right) => right.similarity - left.similarity)
      .map(toKnownEntity);
  } catch (err) {
    logger.warn({ err, stage: "retrieveNameDedupCandidates" }, "name dedup retrieval failed open");
    return [];
  }
}

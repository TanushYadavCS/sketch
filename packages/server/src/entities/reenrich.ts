import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { createEmbeddingProvider } from "../connectors/embeddings";
import { type EnrichmentDeps, type EnrichmentResult, MAX_FILES_PER_RUN, runEnrichment } from "../connectors/enrichment";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import type { MaterializeProgress } from "./materialize";
import { cleanupEmptyRelationships, cleanupRelationshipEvidenceForFacts } from "./materialize";
import { type RecreateSummary, recreateEntityGraph } from "./recreate";
import { beginRecreateLock, endRecreateLock } from "./recreate-state";

export const AI_EXTRACTION_FACT_TYPES = ["llm_extracted", "llm_relation"] as const satisfies IndexedFileFactType[];
const MENTION_SOURCES_TO_CLEAR = ["llm_extraction", "deterministic_substring"] as const;
const WIPE_BATCH_SIZE = 250;

export type ReenrichScope = { all: true } | { fileIds: string[] } | { sources: string[] };

export interface ResolvedReenrichScope {
  fileIds: string[];
  missingFileIds: string[];
}

export interface ReenrichDryRunSummary {
  files: number;
  missingFileIds: string[];
  factsByType: Record<(typeof AI_EXTRACTION_FACT_TYPES)[number], number>;
  chunks: number;
  timeframes: number;
  fileEmbeddings: number;
  chunkEmbeddings: number;
  mentions: number;
}

export interface ReenrichWipeSummary extends ReenrichDryRunSummary {
  relationshipEvidenceDeleted: number;
  relationshipsDeleted: number;
  factsTombstoned: number;
}

export interface ReenrichSummary {
  scope: ResolvedReenrichScope;
  wipe: ReenrichWipeSummary;
  enrichment: EnrichmentResult;
  recreate?: RecreateSummary;
}

export interface ReenrichDeps {
  db: Kysely<DB>;
  logger: Logger;
  triggeredByUserId: string;
  runAfter?: boolean;
  fileIds: string[];
  missingFileIds?: string[];
  llmPromotionThreshold?: number;
  coMentionContributesToThreshold?: number;
  /**
   * Set when the caller already promoted a pending recreate lock (two-step
   * rebuild flow). Skips the internal beginRecreateLock/endRecreateLock so
   * we don't double-acquire; the caller's `finally` is responsible for
   * releasing the lock.
   */
  lockAlreadyHeld?: boolean;
  materializeFactTypes?: IndexedFileFactType[];
  onPhase?: (phase: "wiping" | "enriching" | "rebuilding") => void;
  /**
   * Fires during enrich and rebuild phases (per-file during enrichment,
   * per-fact during materialize). The wipe phase reports a single
   * 0-of-1 → 1-of-1 transition since its batches are coarse.
   */
  onProgress?: (progress: MaterializeProgress) => void;
  runEnrichmentImpl?: (deps: EnrichmentDeps) => Promise<EnrichmentResult>;
  recreateEntityGraphImpl?: typeof recreateEntityGraph;
}

type DbOrTrx = Kysely<DB> | Transaction<DB>;

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table") || message.includes("does not exist");
}

function uniqueNonEmpty(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)));
}

export async function resolveReenrichFileIds(db: Kysely<DB>, scope: ReenrichScope): Promise<ResolvedReenrichScope> {
  if ("all" in scope && scope.all) {
    const rows = await db.selectFrom("indexed_files").select("id").where("is_archived", "=", 0).orderBy("id").execute();
    return { fileIds: rows.map((row) => row.id), missingFileIds: [] };
  }

  if ("fileIds" in scope) {
    const requested = uniqueNonEmpty(scope.fileIds);
    if (requested.length === 0) return { fileIds: [], missingFileIds: [] };
    const rows = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("id", "in", requested)
      .where("is_archived", "=", 0)
      .execute();
    const found = new Set(rows.map((row) => row.id));
    return {
      fileIds: requested.filter((id) => found.has(id)),
      missingFileIds: requested.filter((id) => !found.has(id)),
    };
  }

  if ("sources" in scope) {
    const sources = uniqueNonEmpty(scope.sources);
    if (sources.length === 0) return { fileIds: [], missingFileIds: [] };
    const rows = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("source", "in", sources)
      .where("is_archived", "=", 0)
      .orderBy("id")
      .execute();
    return { fileIds: rows.map((row) => row.id), missingFileIds: [] };
  }

  return { fileIds: [], missingFileIds: [] };
}

async function countSql(db: Kysely<DB>, query: ReturnType<typeof sql>): Promise<number> {
  try {
    const result = await query.execute(db);
    const row = result.rows[0] as { count?: string | number | bigint } | undefined;
    return Number(row?.count ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

export async function computeReenrichDryRun(
  db: Kysely<DB>,
  fileIds: string[],
  missingFileIds: string[] = [],
): Promise<ReenrichDryRunSummary> {
  const factsByType = {
    llm_extracted: 0,
    llm_relation: 0,
  };
  if (fileIds.length === 0) {
    return {
      files: 0,
      missingFileIds,
      factsByType,
      chunks: 0,
      timeframes: 0,
      fileEmbeddings: 0,
      chunkEmbeddings: 0,
      mentions: 0,
    };
  }

  const factRows = await db
    .selectFrom("indexed_file_facts")
    .select(["fact_type", db.fn.countAll<number>().as("count")])
    .where("indexed_file_id", "in", fileIds)
    .where("fact_type", "in", AI_EXTRACTION_FACT_TYPES)
    .where("deleted_at", "is", null)
    .groupBy("fact_type")
    .execute();
  for (const row of factRows) {
    if (row.fact_type === "llm_extracted" || row.fact_type === "llm_relation") {
      factsByType[row.fact_type] = Number(row.count ?? 0);
    }
  }

  const chunks = Number(
    (
      await db
        .selectFrom("document_chunks")
        .select(db.fn.countAll<number>().as("count"))
        .where("indexed_file_id", "in", fileIds)
        .executeTakeFirst()
    )?.count ?? 0,
  );
  const timeframes = Number(
    (
      await db
        .selectFrom("document_timeframes")
        .select(db.fn.countAll<number>().as("count"))
        .where("indexed_file_id", "in", fileIds)
        .executeTakeFirst()
    )?.count ?? 0,
  );
  const mentions = Number(
    (
      await db
        .selectFrom("entity_mentions")
        .select(db.fn.countAll<number>().as("count"))
        .where("indexed_file_id", "in", fileIds)
        .where("source", "in", MENTION_SOURCES_TO_CLEAR)
        .executeTakeFirst()
    )?.count ?? 0,
  );
  const fileEmbeddings = await countSql(
    db,
    sql<{
      count: number | string | bigint;
    }>`SELECT COUNT(*) AS count FROM file_embeddings WHERE indexed_file_id IN (${sql.join(fileIds)})`,
  );
  const chunkEmbeddings = await countSql(
    db,
    sql<{
      count: number | string | bigint;
    }>`SELECT COUNT(*) AS count FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE indexed_file_id IN (${sql.join(
      fileIds,
    )}))`,
  );

  return {
    files: fileIds.length,
    missingFileIds,
    factsByType,
    chunks,
    timeframes,
    fileEmbeddings,
    chunkEmbeddings,
    mentions,
  };
}

async function deleteFileEmbeddings(db: DbOrTrx, fileIds: string[]): Promise<void> {
  try {
    await sql`DELETE FROM file_embeddings WHERE indexed_file_id IN (${sql.join(fileIds)})`.execute(db);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
}

async function deleteChunkEmbeddings(db: DbOrTrx, fileIds: string[]): Promise<void> {
  try {
    await sql`
      DELETE FROM chunk_embeddings
      WHERE chunk_id IN (
        SELECT id FROM document_chunks WHERE indexed_file_id IN (${sql.join(fileIds)})
      )
    `.execute(db);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }
}

function emptyWipeSummary(fileIds: string[], missingFileIds: string[]): ReenrichWipeSummary {
  return {
    files: fileIds.length,
    missingFileIds,
    factsByType: { llm_extracted: 0, llm_relation: 0 },
    chunks: 0,
    timeframes: 0,
    fileEmbeddings: 0,
    chunkEmbeddings: 0,
    mentions: 0,
    relationshipEvidenceDeleted: 0,
    relationshipsDeleted: 0,
    factsTombstoned: 0,
  };
}

export async function wipeLlmEnrichmentForFiles(
  db: Kysely<DB>,
  logger: Logger,
  fileIds: string[],
  missingFileIds: string[] = [],
): Promise<ReenrichWipeSummary> {
  const summary = emptyWipeSummary(fileIds, missingFileIds);
  if (fileIds.length === 0) return summary;

  for (let i = 0; i < fileIds.length; i += WIPE_BATCH_SIZE) {
    const batch = fileIds.slice(i, i + WIPE_BATCH_SIZE);
    await db.transaction().execute(async (trx) => {
      const before = await computeReenrichDryRun(trx as unknown as Kysely<DB>, batch);
      summary.chunks += before.chunks;
      summary.timeframes += before.timeframes;
      summary.fileEmbeddings += before.fileEmbeddings;
      summary.chunkEmbeddings += before.chunkEmbeddings;
      summary.mentions += before.mentions;
      summary.factsByType.llm_extracted += before.factsByType.llm_extracted;
      summary.factsByType.llm_relation += before.factsByType.llm_relation;

      const facts = await trx
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("indexed_file_id", "in", batch)
        .where("fact_type", "in", AI_EXTRACTION_FACT_TYPES)
        .where("deleted_at", "is", null)
        .execute();
      const factIds = facts.map((fact) => fact.id);

      if (factIds.length > 0) {
        summary.relationshipEvidenceDeleted += await cleanupRelationshipEvidenceForFacts(
          trx as unknown as Kysely<DB>,
          factIds,
        );
        summary.relationshipsDeleted += await cleanupEmptyRelationships(trx as unknown as Kysely<DB>);
      }

      await deleteChunkEmbeddings(trx, batch);
      await trx.deleteFrom("document_chunks").where("indexed_file_id", "in", batch).execute();
      await trx.deleteFrom("document_timeframes").where("indexed_file_id", "in", batch).execute();
      await deleteFileEmbeddings(trx, batch);
      await trx
        .deleteFrom("entity_mentions")
        .where("indexed_file_id", "in", batch)
        .where("source", "in", MENTION_SOURCES_TO_CLEAR)
        .execute();

      if (factIds.length > 0) {
        const now = new Date().toISOString();
        const tombstone = await trx
          .updateTable("indexed_file_facts")
          .set({ deleted_at: now, materialized_at: null, updated_at: now })
          .where("id", "in", factIds)
          .executeTakeFirst();
        summary.factsTombstoned += Number(tombstone.numUpdatedRows ?? 0);
      }

      await trx
        .updateTable("indexed_files")
        .set({ embedding_status: "pending", summary_status: "pending", summary: null })
        .where("id", "in", batch)
        .execute();
    });
  }

  logger.warn({ fileCount: fileIds.length, factsTombstoned: summary.factsTombstoned }, "LLM enrichment wiped");
  return summary;
}

/**
 * Tombstone all active llm_extracted / llm_relation facts graph-wide and
 * clean up dependent relation evidence + emptied relationships. Used by the
 * step-1 reset path when the operator opted into wiping LLM-extracted facts.
 *
 * Narrower than `wipeLlmEnrichmentForFiles`: does not delete document_chunks,
 * file/chunk embeddings, summaries, or document_timeframes. Step 1 is an
 * entity-and-fact checkpoint, not a file-reprocessing job — the file-level
 * artifacts only get wiped if step 2 chooses re-extract, which runs
 * `wipeLlmEnrichmentForFiles` as usual before LLM extraction.
 */
export async function tombstoneActiveLlmFacts(
  db: Kysely<DB>,
  logger: Logger,
): Promise<{ factsTombstoned: number; relationshipEvidenceDeleted: number; relationshipsDeleted: number }> {
  const result = { factsTombstoned: 0, relationshipEvidenceDeleted: 0, relationshipsDeleted: 0 };
  const factRows = await db
    .selectFrom("indexed_file_facts")
    .select("id")
    .where("fact_type", "in", AI_EXTRACTION_FACT_TYPES)
    .where("deleted_at", "is", null)
    .execute();
  if (factRows.length === 0) return result;
  const factIds = factRows.map((r) => r.id);

  result.relationshipEvidenceDeleted = await cleanupRelationshipEvidenceForFacts(db, factIds);
  result.relationshipsDeleted = await cleanupEmptyRelationships(db);

  const now = new Date().toISOString();
  for (let i = 0; i < factIds.length; i += WIPE_BATCH_SIZE) {
    const batch = factIds.slice(i, i + WIPE_BATCH_SIZE);
    const tomb = await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: now, materialized_at: null, updated_at: now })
      .where("id", "in", batch)
      .executeTakeFirst();
    result.factsTombstoned += Number(tomb.numUpdatedRows ?? 0);
  }

  logger.warn(
    {
      factsTombstoned: result.factsTombstoned,
      relationshipEvidenceDeleted: result.relationshipEvidenceDeleted,
      relationshipsDeleted: result.relationshipsDeleted,
    },
    "LLM facts tombstoned (step-1 wipe)",
  );
  return result;
}

export async function runEnrichmentForFileBatches(
  deps: Omit<EnrichmentDeps, "fileIds"> & { runEnrichmentImpl?: (deps: EnrichmentDeps) => Promise<EnrichmentResult> },
  fileIds: string[],
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] };
  const run = deps.runEnrichmentImpl ?? runEnrichment;
  const totalFiles = fileIds.length;
  let baseCompleted = 0;
  for (let i = 0; i < fileIds.length; i += MAX_FILES_PER_RUN) {
    const batch = fileIds.slice(i, i + MAX_FILES_PER_RUN);
    const start = baseCompleted;
    const batchResult = await run({
      ...deps,
      fileIds: batch,
      onProgress: deps.onProgress
        ? ({ completed }) => deps.onProgress?.({ phase: "enrich", completed: start + completed, total: totalFiles })
        : undefined,
    });
    result.filesProcessed += batchResult.filesProcessed;
    result.filesSkipped += batchResult.filesSkipped;
    result.filesFailed += batchResult.filesFailed;
    result.errors.push(...batchResult.errors);
    baseCompleted += batch.length;
  }
  return result;
}

export async function runReenrichJob(deps: ReenrichDeps): Promise<ReenrichSummary> {
  if (!deps.lockAlreadyHeld) beginRecreateLock();
  try {
    deps.onPhase?.("wiping");
    deps.onProgress?.({ phase: "wipe", completed: 0, total: 1 });
    const settings = await deps.db
      .selectFrom("settings")
      .select("gemini_api_key")
      .where("id", "=", "default")
      .executeTakeFirst();
    const embeddingProvider = settings?.gemini_api_key
      ? createEmbeddingProvider({ provider: "gemini", apiKey: settings.gemini_api_key })
      : null;
    const wipe = await wipeLlmEnrichmentForFiles(deps.db, deps.logger, deps.fileIds, deps.missingFileIds ?? []);
    deps.onProgress?.({ phase: "wipe", completed: 1, total: 1 });
    deps.onPhase?.("enriching");
    const enrichment = await runEnrichmentForFileBatches(
      {
        db: deps.db,
        logger: deps.logger.child({ phase: "enrichment" }),
        embeddingProvider,
        geminiApiKey: settings?.gemini_api_key,
        runEnrichmentImpl: deps.runEnrichmentImpl,
        onProgress: deps.onProgress,
      },
      deps.fileIds,
    );
    const summary: ReenrichSummary = {
      scope: { fileIds: deps.fileIds, missingFileIds: deps.missingFileIds ?? [] },
      wipe,
      enrichment,
    };
    if (deps.runAfter !== false) {
      deps.onPhase?.("rebuilding");
      const recreate = await (deps.recreateEntityGraphImpl ?? recreateEntityGraph)({
        db: deps.db,
        logger: deps.logger.child({ phase: "rebuild" }),
        triggeredByUserId: deps.triggeredByUserId,
        skipReset: true,
        lockAlreadyHeld: true,
        llmPromotionThreshold: deps.llmPromotionThreshold,
        coMentionContributesToThreshold: deps.coMentionContributesToThreshold,
        materializeFactTypes: deps.materializeFactTypes ?? [...AI_EXTRACTION_FACT_TYPES],
        onProgress: deps.onProgress,
      });
      summary.recreate = recreate;
    }
    return summary;
  } finally {
    if (!deps.lockAlreadyHeld) endRecreateLock();
  }
}

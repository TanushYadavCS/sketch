/**
 * Post-sync enrichment pipeline.
 *
 * Runs after sync completes. For each file with embedding_status = 'pending':
 * 1. Chunk text content
 * 2. Extract timeframes (deterministic regex-based)
 * 3. Extract AI-grounded summaries and entity facts when available
 * 4. Generate embeddings (text chunks or images)
 * 5. Store everything in DB
 *
 * Images are downloaded temporarily from Google Drive, embedded, then discarded.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import { parseOrgContext } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { PRODUCT_MATCH_TARGET_PROVENANCE_TIERS } from "../entities/provenance";
import { yieldToEventLoop } from "../lib/event-loop";
import { heapStats, heapUsedMb } from "../lib/heap";
import { chunkText } from "./chunking";
import { type DocumentFactContext, emitDocumentDerivedFacts, sortDocumentParentRefs } from "./document-facts";
import { ensureEmailThreadSummary, rebuildEmailThreadSummary } from "./email/thread-summary";
import type { EmbeddingProvider } from "./embeddings/types";
import { applyEngagementFloor } from "./engagement-floor";
import type { StageReport, StageReporter } from "./enrichment-stage-report";
import { type KnownEntityForPrompt, buildFileScopedKnownEntities } from "./file-scope-context";
import { type GeminiGenerator, createGeminiGenerator } from "./gemini-generate";
import { buildParticipantBlock } from "./participant-block";
import { smartEnrichFile } from "./smart-enrichment";
import { extractDatesFromText } from "./tagging";

/** Max files to enrich for explicit/manual runs. */
export const MAX_FILES_PER_RUN = 5000;
export const SCHEDULED_ENRICHMENT_MAX_FILES_PER_RUN = 50;
export const SCHEDULED_ENRICHMENT_TIME_BUDGET_MS = 5 * 60 * 1000;

const PROJECT_BASELINE_LIMIT = 200;
const ENRICHMENT_BACKOFF_MS = [
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;

let activeEnrichmentRuns = 0;
export function isEnrichmentActive(): boolean {
  return activeEnrichmentRuns > 0;
}

class StaleEnrichmentError extends Error {
  constructor(readonly fileId: string) {
    super(`Stale enrichment result for file ${fileId}`);
    this.name = "StaleEnrichmentError";
  }
}

type FileContentVersion = {
  contentHash: string | null;
  contentCategory: string;
  content: string | null;
  sourceUpdatedAt: string | null;
};

type ContentVersionGuardable<T> = {
  where(column: "content_category", op: "=", value: string): T;
  where(column: "content_hash", op: "=", value: string): T;
  where(column: "content_hash", op: "is", value: null): T;
  where(column: "content", op: "=", value: string): T;
  where(column: "content", op: "is", value: null): T;
  where(column: "source_updated_at", op: "=", value: string): T;
  where(column: "source_updated_at", op: "is", value: null): T;
};

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function parseDescription(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.description === "string" ? parsed.description : undefined;
  } catch {
    return undefined;
  }
}

function nextRetryAt(attempts: number): string {
  const index = Math.min(Math.max(attempts, 1) - 1, ENRICHMENT_BACKOFF_MS.length - 1);
  return new Date(Date.now() + ENRICHMENT_BACKOFF_MS[index]).toISOString();
}

function noRowsUpdated(result: { numUpdatedRows?: bigint | number }): boolean {
  const count = result.numUpdatedRows ?? 0;
  return typeof count === "bigint" ? count === BigInt(0) : count === 0;
}

function assertFreshUpdate(result: { numUpdatedRows?: bigint | number }, fileId: string): void {
  if (noRowsUpdated(result)) throw new StaleEnrichmentError(fileId);
}

function minWordsForSmartEnrichment(fileType: string | null, threadContext: string | null): number {
  if (fileType === "email_message") return threadContext ? 1 : 10;
  if (fileType === "calendar_event") return 10;
  if (fileType === "whatsapp_conversation_slice") return 1;
  if (fileType === "slack_conversation_slice") return 1;
  return 100;
}

function contentVersionOf(file: {
  content_hash: string | null;
  content_category: string;
  content: string | null;
  source_updated_at: string | null;
}): FileContentVersion {
  return {
    contentHash: file.content_hash,
    contentCategory: file.content_category,
    content: file.content,
    sourceUpdatedAt: file.source_updated_at,
  };
}

function contentVersionMatches(row: FileContentVersion | undefined, version: FileContentVersion): boolean {
  if (!row) return false;
  if (row.contentCategory !== version.contentCategory) return false;
  if (row.contentHash !== version.contentHash) return false;
  if (version.contentHash !== null) return true;
  if (row.content !== version.content) return false;
  return version.content !== null || row.sourceUpdatedAt === version.sourceUpdatedAt;
}

/**
 * Fetch a single file's `content` column by id.
 *
 * The pending-files batch query deliberately omits `content` so that a run
 * spanning thousands of files (paced by multi-hour LLM calls) never pins every
 * document body in heap at once. Each file's body is instead read just-in-time
 * here, kept resident only while that one file is being enriched, then released.
 */
async function fetchFileContent(db: Kysely<DB>, fileId: string): Promise<string | null> {
  const row = await db.selectFrom("indexed_files").select("content").where("id", "=", fileId).executeTakeFirst();
  return row?.content ?? null;
}

async function ensureFileFresh(db: Kysely<DB>, fileId: string, version: FileContentVersion): Promise<void> {
  const row = await db
    .selectFrom("indexed_files")
    .select([
      "content_hash as contentHash",
      "content_category as contentCategory",
      "content",
      "source_updated_at as sourceUpdatedAt",
    ])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (!contentVersionMatches(row, version)) throw new StaleEnrichmentError(fileId);
}

function applyContentVersionWhere<T extends ContentVersionGuardable<T>>(query: T, version: FileContentVersion): T {
  let guarded = query.where("content_category", "=", version.contentCategory);
  if (version.contentHash === null) {
    guarded = guarded.where("content_hash", "is", null);
    if (version.content !== null) return guarded.where("content", "=", version.content);
    guarded = guarded.where("content", "is", null);
    return version.sourceUpdatedAt === null
      ? guarded.where("source_updated_at", "is", null)
      : guarded.where("source_updated_at", "=", version.sourceUpdatedAt);
  }
  return guarded.where("content_hash", "=", version.contentHash);
}

async function withFreshFileWriteLock<T>(
  db: Kysely<DB>,
  fileId: string,
  version: FileContentVersion,
  write: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const lockQuery = trx
      .updateTable("indexed_files")
      .set({ embedding_status: sql<string>`embedding_status` })
      .where("id", "=", fileId);
    const lockResult = await applyContentVersionWhere(lockQuery, version).executeTakeFirst();
    assertFreshUpdate(lockResult, fileId);
    return write(trx);
  });
}

async function markSummaryFailure(
  db: Kysely<DB>,
  fileId: string,
  currentAttempts: number,
  version?: FileContentVersion,
): Promise<void> {
  const attempts = currentAttempts + 1;
  let query = db
    .updateTable("indexed_files")
    .set({ summary_status: "failed", summary_attempts: attempts, summary_next_retry_at: nextRetryAt(attempts) })
    .where("id", "=", fileId);
  if (version) query = applyContentVersionWhere(query, version);
  await query.execute();
}

async function resetSummaryRetry(db: Kysely<DB>, fileId: string, version?: FileContentVersion): Promise<void> {
  let query = db
    .updateTable("indexed_files")
    .set({ summary_attempts: 0, summary_next_retry_at: null })
    .where("id", "=", fileId);
  if (version) query = applyContentVersionWhere(query, version);
  const result = await query.executeTakeFirst();
  if (version) assertFreshUpdate(result, fileId);
}

type StoredDocumentFactFile = {
  id: string;
  source: string;
  content: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  content_category: string;
  file_type: string | null;
  content_hash: string | null;
  connector_config_id: string;
};

async function emitAndMaterializeDocumentFactsFromStoredFile(
  file: StoredDocumentFactFile,
  deps: EnrichmentDeps,
  generator: GeminiGenerator | null,
): Promise<void> {
  const context = await buildStoredDocumentFactContext(deps.db, file);
  const result = await emitDocumentDerivedFacts(deps.db, context, {
    contentChanged: true,
    generator: generator ?? undefined,
    dumpDir: deps.debugDumpDir,
    logger: deps.logger,
  });
  if (result.changed) {
    await materializeUnmaterializedFacts(deps.db, deps.logger, {
      embeddingProvider: deps.embeddingProvider,
      factTypes: ["llm_task"],
    });
  }
}

async function buildStoredDocumentFactContext(
  db: Kysely<DB>,
  file: StoredDocumentFactFile,
): Promise<DocumentFactContext> {
  const owner = await db
    .selectFrom("connector_configs")
    .select("created_by")
    .where("id", "=", file.connector_config_id)
    .executeTakeFirst();
  const participants = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "subject_email"])
    .where("indexed_file_id", "=", file.id)
    .where("fact_type", "in", PERSON_PARTICIPANT_FACT_TYPES)
    .where("deleted_at", "is", null)
    .execute();
  const parentRows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_source", "subject_source_id"])
    .where("indexed_file_id", "=", file.id)
    .where("fact_type", "=", "parent_entity")
    .where("deleted_at", "is", null)
    .execute();

  const seenParticipants = new Set<string>();
  const attendees = participants
    .flatMap((participant) => {
      const name = participant.subject_name?.trim() || undefined;
      const email = participant.subject_email?.trim() || undefined;
      if (!name && !email) return [];
      const key = `${name?.toLowerCase() ?? ""}|${email?.toLowerCase() ?? ""}`;
      if (seenParticipants.has(key)) return [];
      seenParticipants.add(key);
      return [{ name, email }];
    })
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || (a.email ?? "").localeCompare(b.email ?? ""));

  return {
    indexedFileId: file.id,
    source: file.source,
    content: file.content ?? "",
    sourceDate: file.source_created_at ?? file.source_updated_at,
    contentCategory: file.content_category,
    fileType: file.file_type,
    contentHash: file.content_hash,
    connectorConfigId: file.connector_config_id,
    createdByUserId: owner?.created_by ?? null,
    lastSeenSyncRunId: null,
    attendees,
    parentRefs: sortDocumentParentRefs(
      parentRows.flatMap((row) =>
        row.subject_source && row.subject_source_id
          ? [{ source: row.subject_source, sourceId: row.subject_source_id }]
          : [],
      ),
    ),
  };
}

async function markEmbeddingFailure(
  db: Kysely<DB>,
  fileId: string,
  currentAttempts: number,
  version?: FileContentVersion,
): Promise<void> {
  const attempts = currentAttempts + 1;
  let query = db
    .updateTable("indexed_files")
    .set({ embedding_status: "failed", embedding_attempts: attempts, embedding_next_retry_at: nextRetryAt(attempts) })
    .where("id", "=", fileId);
  if (version) query = applyContentVersionWhere(query, version);
  await query.execute();
}

export async function loadBaselineKnownEntities(db: Kysely<DB>): Promise<KnownEntityForPrompt[]> {
  const baseEntities = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "aliases", "metadata", "hotness"])
    .where("source_type", "in", ["product", "team"])
    .where("status", "=", "confirmed")
    .where((eb) =>
      eb.or([
        eb("source_type", "!=", "product"),
        eb("provenance_tier", "in", [...PRODUCT_MATCH_TARGET_PROVENANCE_TIERS]),
      ]),
    )
    .where(whereLiveEntity())
    .execute();
  const projectEntities = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "aliases", "metadata", "hotness"])
    .where("source_type", "=", "project")
    .where("status", "=", "confirmed")
    .where(whereLiveEntity())
    .orderBy("hotness", "desc")
    .orderBy("name", "asc")
    .limit(PROJECT_BASELINE_LIMIT)
    .execute();
  const entities = [...baseEntities, ...projectEntities];
  return entities.map((entity) => ({
    id: entity.id,
    entityId: entity.id,
    name: entity.name,
    type: entity.source_type,
    aliases: parseStringArray(entity.aliases),
    description: parseDescription(entity.metadata),
    hotness: Number(entity.hotness ?? 0),
  }));
}

export interface EnrichmentDeps {
  db: Kysely<DB>;
  logger: Logger;
  embeddingProvider: EmbeddingProvider | null;
  generator?: GeminiGenerator | null;
  /** Gemini API key for AI-powered enrichment when a generator is not supplied. */
  geminiApiKey?: string | null;
  geminiMaxRpm?: number;
  geminiMaxRetries?: number;
  /** Download image from Google Drive by provider file ID. Returns buffer + mime type. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  /** If set, only enrich these specific file IDs (ignoring pending status). */
  fileIds?: string[];
  /** Org context for enrichment prompts. Populated at start of enrichment run. */
  orgContext?: { orgName?: string; description?: string; industry?: string; disambiguationGuidance?: string } | null;
  /**
   * Org-wide baseline of confirmed entities used as a
   * fallback when a file has no resolvable anchors. The per-file scoped list
   * is built on top of this by `buildFileScopedKnownEntities`.
   */
  knownEntities?: KnownEntityForPrompt[];
  /**
   * Fires once at the start of the run and once after each file is processed
   * (success, skip, or failure), with `completed` and `total` reflecting the
   * pending-file batch. Used by reset/reenrich jobs to surface live progress.
   */
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
  shouldCancel?: () => boolean;
  /**
   * When set, every LLM call inside this enrichment run writes a dump file
   * (prompt + raw response + token usage) under this directory. Set only by
   * the per-file "Enrich File" debug endpoint; never set in bulk runs.
   */
  debugDumpDir?: string;
  stageReport?: StageReporter;
  /**
   * Re-runs the LLM stages on a file that already has a summary. Set only by the
   * dev trace route, where the caller named one file and expects work to happen.
   */
  forceSmartEnrichment?: boolean;
  maxFilesPerRun?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

export interface EnrichmentResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  errors: Array<{ fileId: string; error: string }>;
  stoppedReason?: "time_budget" | "file_limit" | "cancelled";
}

/**
 * Run enrichment for pending files, or specific files if fileIds is set.
 */
export async function runEnrichment(deps: EnrichmentDeps): Promise<EnrichmentResult> {
  activeEnrichmentRuns++;
  const startHeapMb = heapUsedMb();
  try {
    return await runEnrichmentInner(deps);
  } finally {
    activeEnrichmentRuns--;
    deps.logger.info(heapStats(startHeapMb), "Enrichment run finished");
  }
}

async function runEnrichmentInner(deps: EnrichmentDeps): Promise<EnrichmentResult> {
  const { db, logger } = deps;
  const nowMs = deps.now ?? Date.now;
  const startedAtMs = nowMs();
  const maxFilesPerRun = deps.maxFilesPerRun ?? MAX_FILES_PER_RUN;
  const timeBudgetMs = deps.timeBudgetMs;
  const result: EnrichmentResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    errors: [],
  };

  // Load org context for enrichment prompt
  try {
    const settings = await db
      .selectFrom("settings")
      .select(["org_name", "org_context"])
      .where("id", "=", "default")
      .executeTakeFirst();
    if (settings?.org_context) {
      const parsed = parseOrgContext(settings.org_context);
      deps.orgContext = {
        orgName: settings.org_name ?? undefined,
        description: parsed?.description,
        industry: parsed?.industry,
        disambiguationGuidance: parsed?.disambiguationGuidance,
      };
    }
  } catch {
    // org_context column may not exist yet — ignore
  }

  try {
    deps.knownEntities = await loadBaselineKnownEntities(db);
  } catch {
    // entities table may not exist yet — ignore
  }

  let generatorForRun: GeminiGenerator | null = deps.generator ?? null;
  const getGenerator = () => {
    if (generatorForRun) return generatorForRun;
    if (!deps.geminiApiKey) return null;
    generatorForRun ??= createGeminiGenerator(deps.geminiApiKey, {
      maxRpm: deps.geminiMaxRpm,
      maxRetries: deps.geminiMaxRetries,
    });
    return generatorForRun;
  };
  const hasGenerator = () => !!deps.generator || !!deps.geminiApiKey;
  const touchedEmailThreads = new Map<string, { connectorConfigId: string; threadId: string }>();

  // Find files needing enrichment
  let query = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "file_type",
      "content_category",
      "content_hash",
      "source",
      "source_path",
      "mime_type",
      "provider_file_id",
      "thread_id",
      "connector_config_id",
      "source_created_at",
      "source_updated_at",
      "embedding_status",
      "summary_status",
      "embedding_attempts",
      "embedding_next_retry_at",
      "summary_attempts",
      "summary_next_retry_at",
      "synced_at",
    ])
    .where("is_archived", "=", 0);

  if (deps.fileIds && deps.fileIds.length > 0) {
    query = query.where("id", "in", deps.fileIds);
  } else {
    const now = new Date().toISOString();
    query = query.where((eb) =>
      eb.or([
        eb("embedding_status", "=", "pending"),
        eb.and([
          eb("embedding_status", "=", "failed"),
          eb.or([eb("embedding_next_retry_at", "is", null), eb("embedding_next_retry_at", "<=", now)]),
        ]),
        eb.and([eb("embedding_status", "=", "done"), eb("summary_status", "=", "pending")]),
        eb.and([
          eb("embedding_status", "=", "done"),
          eb("summary_status", "=", "failed"),
          eb.or([eb("summary_next_retry_at", "is", null), eb("summary_next_retry_at", "<=", now)]),
        ]),
      ]),
    );
  }

  const pendingFiles = await query
    .orderBy("source_created_at", "asc")
    .orderBy("id", "asc")
    .limit(maxFilesPerRun)
    .execute();

  if (pendingFiles.length === 0) {
    logger.debug("No files pending enrichment");
    return result;
  }

  logger.info({ count: pendingFiles.length }, "Starting enrichment run");
  deps.onProgress?.({ phase: "enrich", completed: 0, total: pendingFiles.length });

  for (let idx = 0; idx < pendingFiles.length; idx++) {
    if (deps.shouldCancel?.()) {
      result.stoppedReason = "cancelled";
      throw new Error("Re-enrich stopped");
    }
    if (timeBudgetMs !== undefined && nowMs() - startedAtMs >= timeBudgetMs) {
      result.stoppedReason = "time_budget";
      logger.info(
        {
          processed: result.filesProcessed,
          skipped: result.filesSkipped,
          failed: result.filesFailed,
          budgetMs: timeBudgetMs,
        },
        "Enrichment run stopped at time budget",
      );
      break;
    }
    const fileMeta = pendingFiles[idx];
    const file = { ...fileMeta, content: await fetchFileContent(db, fileMeta.id) };
    const fileVersion = contentVersionOf(file);
    const fileStart = Date.now();
    try {
      const isImage = file.mime_type?.startsWith("image/") || file.file_type === "image";
      const isStructured = file.content_category === "structured";
      const isEmailMessage = file.file_type === "email_message";
      const threadContext =
        isEmailMessage && file.thread_id
          ? await (async () => {
              const generator = getGenerator();
              return generator
                ? ensureEmailThreadSummary(db, generator, file.connector_config_id, file.thread_id)
                : Promise.resolve(null);
            })()
          : null;

      // Summary-only pass: file already has embeddings, just needs AI summary
      const needsSummaryOnly =
        file.embedding_status === "done" && file.summary_status !== "done" && file.summary_status !== "skipped";

      if (needsSummaryOnly) {
        if (file.content && !isImage && !isStructured && hasGenerator()) {
          const wordCount = file.content.split(/\s+/).filter(Boolean).length;
          const minWordsForSummary = minWordsForSmartEnrichment(file.file_type, threadContext);
          if (wordCount >= minWordsForSummary) {
            try {
              const generator = getGenerator();
              if (!generator) throw new Error("Enrichment generator unavailable");
              const knownEntities = await buildFileScopedKnownEntities(
                { db, logger },
                file.id,
                deps.knownEntities ?? [],
                file.content,
              );
              const participantBlock = await buildParticipantBlock(
                { db, logger },
                { fileId: file.id, fileContent: file.content },
              );
              await smartEnrichFile(
                {
                  db,
                  logger,
                  generator,
                  embeddingProvider: deps.embeddingProvider,
                  orgContext: deps.orgContext,
                  knownEntities,
                  participantBlock,
                  debugDumpDir: deps.debugDumpDir,
                  stageReport: deps.stageReport,
                  ensureFresh: () => ensureFileFresh(db, file.id, fileVersion),
                },
                {
                  id: file.id,
                  fileName: file.file_name,
                  content: file.content,
                  threadContext,
                  contentCategory: file.content_category,
                  fileType: file.file_type,
                  source: file.source_path?.split("/")[0] ?? "unknown",
                  sourcePath: file.source_path,
                  contentHash: file.content_hash,
                  connectorConfigId: file.connector_config_id,
                  sourceCreatedAt: file.source_created_at,
                  sourceUpdatedAt: file.source_updated_at,
                },
              );
              await ensureFileFresh(db, file.id, fileVersion);
              const floor = await applyEngagementFloor(
                { db, logger },
                {
                  fileId: file.id,
                  fileContent: file.content,
                  connectorConfigId: file.connector_config_id,
                  contentHash: file.content_hash,
                },
              );
              deps.stageReport?.({
                stage: "engagementFloor",
                label: "Engagement floor",
                kind: "code",
                status: "done",
                summary: { ...floor },
              });
              await ensureFileFresh(db, file.id, fileVersion);
              if (floor.emitted > 0) {
                await materializeUnmaterializedFacts(db, logger, {
                  embeddingProvider: deps.embeddingProvider,
                  factTypes: ["llm_relation"],
                  stageReport: deps.stageReport,
                });
              }
              await resetSummaryRetry(db, file.id, fileVersion);
            } catch (err) {
              if (err instanceof StaleEnrichmentError) throw err;
              reportPostSmartSkipped(deps.stageReport, err);
              logger.warn(
                {
                  err,
                  fileId: file.id,
                  fileName: file.file_name,
                  sourcePath: file.source_path,
                  mimeType: file.mime_type,
                  contentCategory: file.content_category,
                  contentChars: file.content?.length ?? 0,
                  wordCount,
                },
                "Summary-only enrichment failed",
              );
              await markSummaryFailure(db, file.id, Number(file.summary_attempts ?? 0), fileVersion);
              result.filesFailed++;
              continue;
            }
          } else {
            const skippedQuery = db
              .updateTable("indexed_files")
              .set({ summary_status: "skipped", summary_attempts: 0, summary_next_retry_at: null })
              .where("id", "=", file.id);
            const skippedResult = await applyContentVersionWhere(skippedQuery, fileVersion).executeTakeFirst();
            assertFreshUpdate(skippedResult, file.id);
          }
        } else {
          const skippedQuery = db
            .updateTable("indexed_files")
            .set({ summary_status: "skipped", summary_attempts: 0, summary_next_retry_at: null })
            .where("id", "=", file.id);
          const skippedResult = await applyContentVersionWhere(skippedQuery, fileVersion).executeTakeFirst();
          assertFreshUpdate(skippedResult, file.id);
        }
        await emitAndMaterializeDocumentFactsFromStoredFile(file, deps, getGenerator());
        result.filesProcessed++;
        if (isEmailMessage && file.thread_id) {
          touchedEmailThreads.set(`${file.connector_config_id}:${file.thread_id}`, {
            connectorConfigId: file.connector_config_id,
            threadId: file.thread_id,
          });
        }
        const elapsed = ((Date.now() - fileStart) / 1000).toFixed(1);
        logger.info(
          { fileName: file.file_name, progress: `${idx + 1}/${pendingFiles.length}`, elapsed: `${elapsed}s` },
          "Summary-only enrichment done",
        );
        continue;
      }

      // Full enrichment: optimistic lock, chunk, embed, summarize.
      // Scheduled runs only claim pending/failed — never `processing`, since
      // that would let two concurrent runs (e.g. scheduled + manual trigger)
      // both "claim" the same file and race on chunk_embeddings inserts.
      // Stuck `processing` rows are recovered by `recoverStaleEnrichments`.
      // Explicit fileIds reruns can claim any status (manual override).
      const claimableStatuses = deps.fileIds ? ["pending", "failed", "processing", "done"] : ["pending", "failed"];
      const claimResult = await db
        .updateTable("indexed_files")
        .set({ embedding_status: "processing" })
        .where("id", "=", file.id)
        .where("embedding_status", "in", claimableStatuses)
        .where("synced_at", "=", file.synced_at)
        .executeTakeFirst();
      if (claimResult.numUpdatedRows === BigInt(0)) {
        result.filesSkipped++;
        continue;
      }

      if (isImage) {
        await enrichImage(file, deps);
      } else if (file.content) {
        await enrichTextDocument(file as typeof file & { content: string }, isStructured, deps, threadContext);
      } else {
        const skippedQuery = db
          .updateTable("indexed_files")
          .set({ embedding_status: "skipped" })
          .where("id", "=", file.id);
        const skippedResult = await applyContentVersionWhere(skippedQuery, fileVersion).executeTakeFirst();
        assertFreshUpdate(skippedResult, file.id);
        result.filesSkipped++;
        continue;
      }

      const doneQuery = db
        .updateTable("indexed_files")
        .set({ embedding_status: "done", embedding_attempts: 0, embedding_next_retry_at: null })
        .where("id", "=", file.id);
      const doneResult = await applyContentVersionWhere(doneQuery, fileVersion).executeTakeFirst();
      assertFreshUpdate(doneResult, file.id);

      result.filesProcessed++;
      if (isEmailMessage && file.thread_id) {
        touchedEmailThreads.set(`${file.connector_config_id}:${file.thread_id}`, {
          connectorConfigId: file.connector_config_id,
          threadId: file.thread_id,
        });
      }

      const elapsed = ((Date.now() - fileStart) / 1000).toFixed(1);
      logger.info(
        {
          fileName: file.file_name,
          progress: `${idx + 1}/${pendingFiles.length}`,
          elapsed: `${elapsed}s`,
        },
        "Enriched file",
      );
    } catch (err) {
      if (err instanceof StaleEnrichmentError) {
        logger.info({ fileId: file.id, fileName: file.file_name }, "Skipped stale enrichment result");
        result.filesSkipped++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, fileId: file.id, fileName: file.file_name }, "Enrichment failed for file");
      result.errors.push({ fileId: file.id, error: message });
      result.filesFailed++;

      await markEmbeddingFailure(db, file.id, Number(file.embedding_attempts ?? 0), fileVersion);
    } finally {
      deps.onProgress?.({ phase: "enrich", completed: idx + 1, total: pendingFiles.length });
      await yieldToEventLoop();
    }
  }

  if (!result.stoppedReason && pendingFiles.length >= maxFilesPerRun) {
    result.stoppedReason = "file_limit";
  }

  logger.info(
    {
      processed: result.filesProcessed,
      skipped: result.filesSkipped,
      failed: result.filesFailed,
      stoppedReason: result.stoppedReason,
    },
    "Enrichment run complete",
  );

  const generator = getGenerator();
  if (generator && touchedEmailThreads.size > 0) {
    for (const thread of touchedEmailThreads.values()) {
      try {
        await rebuildEmailThreadSummary(db, generator, thread.connectorConfigId, thread.threadId);
      } catch (err) {
        logger.warn(
          { err, threadId: thread.threadId, connectorId: thread.connectorConfigId },
          "Email thread summary rebuild failed",
        );
      }
    }
  }

  return result;
}

/**
 * Enrich a text document: chunk, extract timeframes, link entities, embed.
 */
async function enrichTextDocument(
  file: {
    id: string;
    file_name: string;
    content: string;
    content_category: string;
    content_hash: string | null;
    connector_config_id: string;
    source_path: string | null;
    source: string;
    source_created_at: string | null;
    source_updated_at: string | null;
    synced_at: string;
    file_type: string | null;
    summary_status: string;
    summary_attempts: number;
  },
  isStructured: boolean,
  deps: EnrichmentDeps,
  threadContext: string | null = null,
): Promise<void> {
  const { db, logger, embeddingProvider } = deps;
  const fileVersion = contentVersionOf(file);

  // For structured data (CSV/sheets), only extract timeframes — no chunking, summary, or embedding
  if (isStructured) {
    const timeframes = extractDatesFromText(file.content);
    await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
      await clearFileTimeframes(trx, file.id);
      await storeTimeframes(trx, file.id, timeframes);
    });

    logger.debug({ fileId: file.id, fileName: file.file_name }, "Structured file enriched (no chunking/embedding)");
    return;
  }

  const chunks = chunkText(file.content);
  const timeframes = extractDatesFromText(file.content);

  await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
    await clearFileChunks(trx, file.id);
    if (chunks.length > 0) {
      await trx
        .insertInto("document_chunks")
        .values(
          chunks.map((chunk) => ({
            id: randomUUID(),
            indexed_file_id: file.id,
            chunk_index: chunk.index,
            content: chunk.content,
            token_count: chunk.tokenCount,
          })),
        )
        .execute();
    }
    await clearFileTimeframes(trx, file.id);
    await storeTimeframes(trx, file.id, timeframes);
  });

  // 4. Summary and entity extraction — AI-powered when Gemini is available
  // Skip LLM calls for tiny content; mail and calendar items use a lower threshold because the payload is often short.
  const wordCount = file.content.split(/\s+/).filter(Boolean).length;
  let usedSmartEnrichment = false;
  let smartEnrichmentFailed = false;
  /**
   * A file that already has a summary normally skips every LLM stage, which is
   * right for a sync but useless for a deliberate per-file re-run: the caller
   * asked for this file by id and gets silence. `forceSmartEnrichment` is set
   * only by the dev trace route.
   */
  const summaryAlreadyResolved =
    !deps.forceSmartEnrichment && (file.summary_status === "done" || file.summary_status === "skipped");
  const minWordsForSummary = minWordsForSmartEnrichment(file.file_type, threadContext);
  const generator =
    deps.generator ??
    (deps.geminiApiKey
      ? createGeminiGenerator(deps.geminiApiKey, {
          maxRpm: deps.geminiMaxRpm,
          maxRetries: deps.geminiMaxRetries,
        })
      : null);

  if (!summaryAlreadyResolved && generator && wordCount >= minWordsForSummary) {
    try {
      const knownEntities = await buildFileScopedKnownEntities(
        { db, logger },
        file.id,
        deps.knownEntities ?? [],
        file.content,
      );
      const participantBlock = await buildParticipantBlock(
        { db, logger },
        { fileId: file.id, fileContent: file.content },
      );
      await smartEnrichFile(
        {
          db,
          logger,
          generator,
          embeddingProvider,
          orgContext: deps.orgContext,
          knownEntities,
          participantBlock,
          debugDumpDir: deps.debugDumpDir,
          stageReport: deps.stageReport,
          ensureFresh: () => ensureFileFresh(db, file.id, fileVersion),
        },
        {
          id: file.id,
          fileName: file.file_name,
          content: file.content,
          threadContext,
          contentCategory: file.content_category,
          fileType: file.file_type,
          source: file.source_path?.split("/")[0] ?? "unknown",
          sourcePath: file.source_path,
          contentHash: file.content_hash,
          connectorConfigId: file.connector_config_id,
          sourceCreatedAt: file.source_created_at,
          sourceUpdatedAt: file.source_updated_at,
        },
      );
      await ensureFileFresh(db, file.id, fileVersion);
      const floor = await applyEngagementFloor(
        { db, logger },
        {
          fileId: file.id,
          fileContent: file.content,
          connectorConfigId: file.connector_config_id,
          contentHash: file.content_hash,
        },
      );
      deps.stageReport?.({
        stage: "engagementFloor",
        label: "Engagement floor",
        kind: "code",
        status: "done",
        summary: { ...floor },
      });
      await ensureFileFresh(db, file.id, fileVersion);
      if (floor.emitted > 0) {
        await materializeUnmaterializedFacts(db, logger, {
          embeddingProvider,
          factTypes: ["llm_relation"],
          stageReport: deps.stageReport,
        });
      }
      await resetSummaryRetry(db, file.id, fileVersion);
      usedSmartEnrichment = true;
    } catch (err) {
      if (err instanceof StaleEnrichmentError) throw err;
      reportPostSmartSkipped(deps.stageReport, err);
      smartEnrichmentFailed = true;
      logger.warn({ err, fileId: file.id }, "Smart enrichment failed");
    }
  }

  if (!usedSmartEnrichment && !smartEnrichmentFailed) {
    reportSmartEnrichmentSkipped(deps.stageReport, {
      summaryAlreadyResolved,
      hasGenerator: Boolean(generator),
      wordCount,
      minWordsForSummary,
    });
  }

  if (!summaryAlreadyResolved && !usedSmartEnrichment) {
    const summaryQuery = db
      .updateTable("indexed_files")
      .set(
        smartEnrichmentFailed
          ? {
              summary_status: "failed",
              summary_attempts: Number(file.summary_attempts ?? 0) + 1,
              summary_next_retry_at: nextRetryAt(Number(file.summary_attempts ?? 0) + 1),
            }
          : { summary_status: "skipped", summary_attempts: 0, summary_next_retry_at: null },
      )
      .where("id", "=", file.id);
    const summaryResult = await applyContentVersionWhere(summaryQuery, fileVersion).executeTakeFirst();
    assertFreshUpdate(summaryResult, file.id);
  }

  await emitAndMaterializeDocumentFactsFromStoredFile(file, deps, generator);
  await ensureFileFresh(db, file.id, fileVersion);

  // 5. Embed chunks (best-effort — entity linking still succeeds if embedding fails)
  if (embeddingProvider && chunks.length > 0) {
    const texts = chunks.map((c) => c.content);
    let embeddings: number[][];
    try {
      embeddings = await embeddingProvider.embedTexts(texts);
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Embedding provider failed");
      throw err;
    }

    try {
      const embedded = await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
        const storedChunks = await trx
          .selectFrom("document_chunks")
          .select(["id", "chunk_index"])
          .where("indexed_file_id", "=", file.id)
          .orderBy("chunk_index", "asc")
          .execute();

        const isPostgres = isPg(trx);

        const pairs = storedChunks
          .map((chunk, i) => ({ chunk, embedding: embeddings[i] }))
          .filter((p): p is { chunk: (typeof storedChunks)[number]; embedding: number[] } => !!p.embedding);

        await Promise.all(
          pairs.map(({ chunk, embedding }) =>
            isPostgres
              ? sql`INSERT INTO chunk_embeddings (chunk_id, embedding)
                    VALUES (${chunk.id}, ${JSON.stringify(embedding)}::vector)
                    ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(trx)
              : sql`INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding)
                    VALUES (${chunk.id}, ${JSON.stringify(embedding)})`.execute(trx),
          ),
        );
        return pairs.length;
      });
      logger.info({ fileId: file.id, chunks: embedded }, "Embeddings created");
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Embedding storage failed, entity linking still saved");
    }
  }
}

/**
 * Says why no LLM stage ran. Without this a re-run of an already-summarised file
 * reports "done" with eight untouched stages and no reason anywhere, which reads
 * as a broken page rather than as a pipeline that decided to do nothing.
 */
function reportSmartEnrichmentSkipped(
  stageReport: StageReporter | undefined,
  facts: { summaryAlreadyResolved: boolean; hasGenerator: boolean; wordCount: number; minWordsForSummary: number },
): void {
  if (!stageReport) return;
  const reason = facts.summaryAlreadyResolved
    ? "The file already has a summary, so every LLM stage was skipped. Re-run with force to redo them."
    : !facts.hasGenerator
      ? "No enrichment model is configured, so no LLM stage could run."
      : `The file has ${facts.wordCount} words and this file type needs at least ${facts.minWordsForSummary} before any LLM stage runs.`;

  for (const stage of SMART_ENRICHMENT_STAGES) {
    stageReport({ ...stage, status: "skipped", error: reason });
  }
}

const SMART_ENRICHMENT_STAGES = [
  { stage: "extractEntities", label: "Extract entities", kind: "model" },
  { stage: "dedupAdjudicate", label: "Adjudicate known matches", kind: "model" },
  { stage: "reconcileFacts", label: "Reconcile facts", kind: "code" },
  { stage: "matchEntities", label: "Match entities", kind: "code" },
  { stage: "generateSummary", label: "Summary", kind: "model" },
  { stage: "extractEntityFacts", label: "Entity facts", kind: "model" },
  { stage: "engagementFloor", label: "Engagement floor", kind: "code" },
  { stage: "materialize", label: "Materialise", kind: "code" },
] as const satisfies ReadonlyArray<Pick<StageReport, "stage" | "label" | "kind">>;

function reportPostSmartSkipped(stageReport: StageReporter | undefined, err: unknown): void {
  stageReport?.({
    stage: "engagementFloor",
    label: "Engagement floor",
    kind: "code",
    status: "skipped",
    error: err instanceof Error ? err.message : String(err),
  });
  stageReport?.({
    stage: "materialize",
    label: "Materialise",
    kind: "code",
    status: "skipped",
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Enrich an image file: download temporarily, embed, discard.
 */
async function enrichImage(
  file: {
    id: string;
    file_name: string;
    content: string | null;
    content_category: string;
    content_hash: string | null;
    mime_type: string | null;
    provider_file_id: string;
    connector_config_id: string;
    source_path: string | null;
    source_updated_at: string | null;
    synced_at: string;
  },
  deps: EnrichmentDeps,
): Promise<void> {
  const { db, embeddingProvider, downloadImage } = deps;
  const fileVersion = contentVersionOf(file);

  if (!embeddingProvider?.supportsImages || !embeddingProvider.embedImage) {
    const skippedQuery = db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id);
    const skippedResult = await applyContentVersionWhere(skippedQuery, fileVersion).executeTakeFirst();
    assertFreshUpdate(skippedResult, file.id);
    return;
  }

  if (!downloadImage) {
    const skippedQuery = db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id);
    const skippedResult = await applyContentVersionWhere(skippedQuery, fileVersion).executeTakeFirst();
    assertFreshUpdate(skippedResult, file.id);
    return;
  }

  await ensureFileFresh(db, file.id, fileVersion);
  const { buffer, mimeType } = await downloadImage(file.provider_file_id, file.connector_config_id);

  const embedding = await embeddingProvider.embedImage(buffer, mimeType);

  await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
    const isPostgres = isPg(trx);
    if (isPostgres) {
      await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
        VALUES (${file.id}, ${JSON.stringify(embedding)}::vector)
        ON CONFLICT (indexed_file_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(trx);
    } else {
      await sql`INSERT OR REPLACE INTO file_embeddings (indexed_file_id, embedding) VALUES (${file.id}, ${JSON.stringify(embedding)})`.execute(
        trx,
      );
    }
  });

  // buffer is garbage collected — nothing stored on disk
}

async function storeTimeframes(
  db: Kysely<DB>,
  fileId: string,
  timeframes: Array<{ startDate: string; endDate?: string; context?: string }>,
): Promise<void> {
  if (timeframes.length > 0) {
    await db
      .insertInto("document_timeframes")
      .values(
        timeframes.map((tf) => ({
          id: randomUUID(),
          indexed_file_id: fileId,
          start_date: tf.startDate,
          end_date: tf.endDate ?? null,
          context: tf.context ?? null,
        })),
      )
      .execute();
  }
}

async function clearFileChunks(db: Kysely<DB>, fileId: string): Promise<void> {
  try {
    await sql`
      DELETE FROM chunk_embeddings
      WHERE chunk_id IN (
        SELECT id FROM document_chunks WHERE indexed_file_id = ${fileId}
      )
    `.execute(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const isNoSuchTable = msg.includes("no such table: chunk_embeddings") || msg.includes("does not exist");
    if (!isNoSuchTable) throw err;
  }

  await db.deleteFrom("document_chunks").where("indexed_file_id", "=", fileId).execute();
}

async function clearFileTimeframes(db: Kysely<DB>, fileId: string): Promise<void> {
  await db.deleteFrom("document_timeframes").where("indexed_file_id", "=", fileId).execute();
}

/**
 * Clear all enrichment data for a file (used when re-enriching on content change).
 */
export async function clearEnrichmentData(db: Kysely<DB>, fileId: string): Promise<void> {
  await clearFileChunks(db, fileId);
  await clearFileTimeframes(db, fileId);
  const entityRepo = createEntityRepository(db);
  await entityRepo.deleteMentionsForFile(fileId);
  // file_embeddings is a vec0 virtual table (sqlite-vec). Gracefully skip if unavailable.
  try {
    await sql`DELETE FROM file_embeddings WHERE indexed_file_id = ${fileId}`.execute(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const isNoSuchTable = msg.includes("no such table: file_embeddings") || msg.includes("does not exist");
    if (!isNoSuchTable) throw err;
  }
}

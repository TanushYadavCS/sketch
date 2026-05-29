/**
 * Post-sync enrichment pipeline.
 *
 * Runs after sync completes. For each file with embedding_status = 'pending':
 * 1. Chunk text content
 * 2. Extract timeframes (deterministic regex-based)
 * 3. Link entities deterministically (substring match entity names against content)
 * 4. Generate embeddings (text chunks or images)
 * 5. Store everything in DB
 *
 * No LLM calls — all extraction is deterministic.
 * Images are downloaded temporarily from Google Drive, embedded, then discarded.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { yieldToEventLoop } from "../lib/event-loop";
import type { Chunk } from "./chunking";
import { chunkText } from "./chunking";
import type { EmbeddingProvider } from "./embeddings/types";
import { applyEngagementFloor } from "./engagement-floor";
import { type KnownEntityForPrompt, buildFileScopedKnownEntities } from "./file-scope-context";
import { createGeminiGenerator } from "./gemini-generate";
import type { GeminiGenerator } from "./gemini-generate";
import { buildParticipantBlock } from "./participant-block";
import { smartEnrichFile } from "./smart-enrichment";
import { extractDatesFromText } from "./tagging";

/** Max files to enrich per run. Set high — enrichment is now deterministic (no LLM costs). */
export const MAX_FILES_PER_RUN = 5000;

/** Minimum entity name length for substring matching (avoids false positives). */
const MIN_ENTITY_NAME_LENGTH = 3;

const DETERMINISTIC_LINK_BATCH_SIZE = 500;

let enrichmentActive = false;
export function isEnrichmentActive(): boolean {
  return enrichmentActive;
}

type DeterministicEntity = {
  id: string;
  name: string;
  aliases: string | null;
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

export async function loadBaselineKnownEntities(db: Kysely<DB>): Promise<KnownEntityForPrompt[]> {
  const entities = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "aliases", "metadata", "hotness"])
    .where("source_type", "in", ["product", "team"])
    .where("status", "=", "confirmed")
    .execute();
  return entities.map((entity) => ({
    id: entity.id,
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
  /** Gemini API key for AI-powered enrichment (summaries, entity extraction). */
  geminiApiKey?: string | null;
  /** Download image from Google Drive by provider file ID. Returns buffer + mime type. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  /** If set, only enrich these specific file IDs (ignoring pending status). */
  fileIds?: string[];
  /** Org context for enrichment prompts. Populated at start of enrichment run. */
  orgContext?: { orgName?: string; description?: string; industry?: string } | null;
  /**
   * Org-wide baseline of confirmed entities (products + teams) used as a
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
  /**
   * When set, every LLM call inside this enrichment run writes a dump file
   * (prompt + raw response + token usage) under this directory. Set only by
   * the per-file "Enrich File" debug endpoint; never set in bulk runs.
   */
  debugDumpDir?: string;
}

export interface EnrichmentResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  errors: Array<{ fileId: string; error: string }>;
}

/**
 * Run enrichment for pending files, or specific files if fileIds is set.
 */
export async function runEnrichment(deps: EnrichmentDeps): Promise<EnrichmentResult> {
  enrichmentActive = true;
  try {
    return await runEnrichmentInner(deps);
  } finally {
    enrichmentActive = false;
  }
}

async function runEnrichmentInner(deps: EnrichmentDeps): Promise<EnrichmentResult> {
  const { db, logger } = deps;
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
      const parsed = JSON.parse(settings.org_context) as Record<string, string>;
      deps.orgContext = {
        orgName: settings.org_name ?? undefined,
        description: parsed.description,
        industry: parsed.industry,
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

  // Find files needing enrichment
  let query = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "file_type",
      "content_category",
      "content",
      "content_hash",
      "source",
      "source_path",
      "mime_type",
      "provider_file_id",
      "connector_config_id",
      "source_created_at",
      "source_updated_at",
      "embedding_status",
      "summary_status",
    ])
    .where("is_archived", "=", 0);

  if (deps.fileIds && deps.fileIds.length > 0) {
    query = query.where("id", "in", deps.fileIds);
  } else {
    query = query.where((eb) =>
      eb.or([
        eb("embedding_status", "in", ["pending", "failed"]),
        eb.and([eb("embedding_status", "=", "done"), eb("summary_status", "in", ["pending", "failed"])]),
      ]),
    );
  }

  const pendingFiles = await query
    .orderBy("source_created_at", "asc")
    .orderBy("id", "asc")
    .limit(MAX_FILES_PER_RUN)
    .execute();

  if (pendingFiles.length === 0) {
    logger.debug("No files pending enrichment");
    return result;
  }

  logger.info({ count: pendingFiles.length }, "Starting enrichment run");
  deps.onProgress?.({ phase: "enrich", completed: 0, total: pendingFiles.length });

  for (let idx = 0; idx < pendingFiles.length; idx++) {
    const file = pendingFiles[idx];
    const fileStart = Date.now();
    try {
      const isImage = file.mime_type?.startsWith("image/") || file.file_type === "image";
      const isStructured = file.content_category === "structured";

      // Summary-only pass: file already has embeddings, just needs AI summary
      const needsSummaryOnly =
        file.embedding_status === "done" && file.summary_status !== "done" && file.summary_status !== "skipped";

      if (needsSummaryOnly) {
        if (file.content && !isImage && !isStructured && deps.geminiApiKey) {
          const wordCount = file.content.split(/\s+/).length;
          if (wordCount >= 100) {
            try {
              const generator = createGeminiGenerator(deps.geminiApiKey);
              const knownEntities = await buildFileScopedKnownEntities(
                { db, logger },
                file.id,
                deps.knownEntities ?? [],
                file.content,
              );
              const participantBlock = await buildParticipantBlock(
                { db },
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
                },
                {
                  id: file.id,
                  fileName: file.file_name,
                  content: file.content,
                  contentCategory: file.content_category,
                  source: file.source_path?.split("/")[0] ?? "unknown",
                  sourcePath: file.source_path,
                  contentHash: file.content_hash,
                  connectorConfigId: file.connector_config_id,
                  sourceCreatedAt: file.source_created_at,
                  sourceUpdatedAt: file.source_updated_at,
                },
              );
              const floor = await applyEngagementFloor(
                { db, logger },
                {
                  fileId: file.id,
                  fileContent: file.content,
                  connectorConfigId: file.connector_config_id,
                  contentHash: file.content_hash,
                },
              );
              if (floor.emitted > 0) {
                await materializeUnmaterializedFacts(db, logger);
              }
            } catch (err) {
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
              await db
                .updateTable("indexed_files")
                .set({ summary_status: "failed" })
                .where("id", "=", file.id)
                .execute();
              result.filesFailed++;
              continue;
            }
          } else {
            await db
              .updateTable("indexed_files")
              .set({ summary_status: "skipped" })
              .where("id", "=", file.id)
              .execute();
          }
        } else {
          await db.updateTable("indexed_files").set({ summary_status: "skipped" }).where("id", "=", file.id).execute();
        }
        result.filesProcessed++;
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
        .executeTakeFirst();
      if (claimResult.numUpdatedRows === BigInt(0)) {
        result.filesSkipped++;
        continue;
      }

      if (isImage) {
        await enrichImage(file, deps);
      } else if (file.content) {
        await enrichTextDocument(file as typeof file & { content: string }, isStructured, deps);
      } else {
        // No content and not an image — skip
        await db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id).execute();
        result.filesSkipped++;
        continue;
      }

      // Mark as done
      await db.updateTable("indexed_files").set({ embedding_status: "done" }).where("id", "=", file.id).execute();

      result.filesProcessed++;

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
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, fileId: file.id, fileName: file.file_name }, "Enrichment failed for file");
      result.errors.push({ fileId: file.id, error: message });
      result.filesFailed++;

      await db.updateTable("indexed_files").set({ embedding_status: "failed" }).where("id", "=", file.id).execute();
    } finally {
      deps.onProgress?.({ phase: "enrich", completed: idx + 1, total: pendingFiles.length });
      await yieldToEventLoop();
    }
  }

  logger.info(
    {
      processed: result.filesProcessed,
      skipped: result.filesSkipped,
      failed: result.filesFailed,
    },
    "Enrichment run complete",
  );

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
    source_created_at: string | null;
    source_updated_at: string | null;
  },
  isStructured: boolean,
  deps: EnrichmentDeps,
): Promise<void> {
  const { db, logger, embeddingProvider } = deps;

  // For structured data (CSV/sheets), only extract timeframes + link entities — no chunking, no embedding
  if (isStructured) {
    const timeframes = extractDatesFromText(file.content);
    await clearFileTimeframes(db, file.id);
    await storeTimeframes(db, file.id, timeframes);

    // Deterministic entity linking on structured content
    await linkEntitiesDeterministic(db, file.id, file.content, []);

    logger.debug({ fileId: file.id, fileName: file.file_name }, "Structured file enriched (no chunking/embedding)");
    return;
  }

  // 1. Chunk the content
  const chunks = chunkText(file.content);

  // 2. Store chunks (batch insert)
  await clearFileChunks(db, file.id);
  if (chunks.length > 0) {
    await db
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

  // 3. Deterministic timeframes
  const timeframes = extractDatesFromText(file.content);
  await clearFileTimeframes(db, file.id);
  await storeTimeframes(db, file.id, timeframes);

  // 4. Entity linking — AI-powered when Gemini available, deterministic fallback
  // Skip LLM calls for tiny documents (<100 words) — not enough content to extract meaningful entities/summaries
  const wordCount = file.content.split(/\s+/).length;
  let usedSmartEnrichment = false;
  let smartEnrichmentFailed = false;
  if (deps.geminiApiKey && wordCount >= 100) {
    try {
      const generator = createGeminiGenerator(deps.geminiApiKey);
      const knownEntities = await buildFileScopedKnownEntities(
        { db, logger },
        file.id,
        deps.knownEntities ?? [],
        file.content,
      );
      const participantBlock = await buildParticipantBlock({ db }, { fileId: file.id, fileContent: file.content });
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
        },
        {
          id: file.id,
          fileName: file.file_name,
          content: file.content,
          contentCategory: file.content_category,
          source: file.source_path?.split("/")[0] ?? "unknown",
          sourcePath: file.source_path,
          contentHash: file.content_hash,
          connectorConfigId: file.connector_config_id,
          sourceCreatedAt: file.source_created_at,
          sourceUpdatedAt: file.source_updated_at,
        },
      );
      const floor = await applyEngagementFloor(
        { db, logger },
        {
          fileId: file.id,
          fileContent: file.content,
          connectorConfigId: file.connector_config_id,
          contentHash: file.content_hash,
        },
      );
      if (floor.emitted > 0) {
        await materializeUnmaterializedFacts(db, logger);
      }
      usedSmartEnrichment = true;
    } catch (err) {
      smartEnrichmentFailed = true;
      logger.warn({ err, fileId: file.id }, "Smart enrichment failed, falling back to deterministic");
    }
  }

  if (!usedSmartEnrichment) {
    await linkEntitiesDeterministic(db, file.id, file.content, chunks);
    // 'failed' = retryable (Gemini error), 'skipped' = intentional (no key or content too short)
    await db
      .updateTable("indexed_files")
      .set({ summary_status: smartEnrichmentFailed ? "failed" : "skipped" })
      .where("id", "=", file.id)
      .execute();
  }

  // 5. Embed chunks (best-effort — entity linking still succeeds if embedding fails)
  if (embeddingProvider && chunks.length > 0) {
    try {
      const texts = chunks.map((c) => c.content);
      const embeddings = await embeddingProvider.embedTexts(texts);

      const storedChunks = await db
        .selectFrom("document_chunks")
        .select(["id", "chunk_index"])
        .where("indexed_file_id", "=", file.id)
        .orderBy("chunk_index", "asc")
        .execute();

      const isPostgres = isPg(db);

      const pairs = storedChunks
        .map((chunk, i) => ({ chunk, embedding: embeddings[i] }))
        .filter((p): p is { chunk: (typeof storedChunks)[number]; embedding: number[] } => !!p.embedding);

      await Promise.all(
        pairs.map(({ chunk, embedding }) =>
          isPostgres
            ? sql`INSERT INTO chunk_embeddings (chunk_id, embedding)
                  VALUES (${chunk.id}, ${JSON.stringify(embedding)}::vector)
                  ON CONFLICT (chunk_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(db)
            : sql`INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding)
                  VALUES (${chunk.id}, ${JSON.stringify(embedding)})`.execute(db),
        ),
      );
      logger.info({ fileId: file.id, chunks: pairs.length }, "Embeddings created");
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Embedding failed, entity linking still saved");
    }
  }
}

/**
 * Enrich an image file: download temporarily, embed, discard.
 */
async function enrichImage(
  file: {
    id: string;
    file_name: string;
    mime_type: string | null;
    provider_file_id: string;
    connector_config_id: string;
    source_path: string | null;
  },
  deps: EnrichmentDeps,
): Promise<void> {
  const { db, embeddingProvider, downloadImage } = deps;

  if (!embeddingProvider?.supportsImages || !embeddingProvider.embedImage) {
    await db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id).execute();
    return;
  }

  if (!downloadImage) {
    await db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id).execute();
    return;
  }

  // Download image temporarily
  const { buffer, mimeType } = await downloadImage(file.provider_file_id, file.connector_config_id);

  // Embed
  const embedding = await embeddingProvider.embedImage(buffer, mimeType);

  // Store embedding
  const isPostgres = isPg(db);
  if (isPostgres) {
    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
      VALUES (${file.id}, ${JSON.stringify(embedding)}::vector)
      ON CONFLICT (indexed_file_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(db);
  } else {
    await sql`INSERT OR REPLACE INTO file_embeddings (indexed_file_id, embedding) VALUES (${file.id}, ${JSON.stringify(embedding)})`.execute(
      db,
    );
  }

  // buffer is garbage collected — nothing stored on disk
}

/**
 * Deterministic entity linking: substring-match entity names/aliases
 * against document content, create mentions for matches.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary substring match. Plain `String.includes` falsely matches
 * short names inside longer words — "Anshu" inside "Himanshu", "Tim" inside
 * "estimated", "Don" inside "donate". `\b` ensures the candidate sits at
 * an ASCII word boundary. JS `\b` is ASCII-only; names with non-ASCII
 * letters (accents, Devanagari, etc.) would need `\p{L}` boundaries — out
 * of scope for this fix, which targets the dominant false-positive class.
 */
export function matchesAsWord(content: string, name: string): boolean {
  if (!name || !content) return false;
  return new RegExp(`\\b${escapeRegex(name)}\\b`).test(content);
}

export async function linkEntitiesByDeterministicMatch(db: Kysely<DB>, logger: Logger): Promise<EnrichmentResult> {
  const result: EnrichmentResult = { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] };
  const allEntities = await createEntityRepository(db).getEntitiesByStatus("confirmed");
  let lastFileId: string | null = null;

  while (true) {
    let query = db
      .selectFrom("indexed_files")
      .select(["id", "content"])
      .where("is_archived", "=", 0)
      .where("content", "is not", null)
      .orderBy("id", "asc")
      .limit(DETERMINISTIC_LINK_BATCH_SIZE);
    if (lastFileId) {
      query = query.where("id", ">", lastFileId);
    }
    const files = await query.execute();
    if (files.length === 0) break;
    lastFileId = files[files.length - 1].id;

    const fileIds = files.map((file) => file.id);
    const chunkRows = await db
      .selectFrom("document_chunks")
      .select(["indexed_file_id", "chunk_index", "content", "token_count"])
      .where("indexed_file_id", "in", fileIds)
      .orderBy("indexed_file_id", "asc")
      .orderBy("chunk_index", "asc")
      .execute();
    const chunksByFile = new Map<string, Chunk[]>();
    for (const chunk of chunkRows) {
      const chunks = chunksByFile.get(chunk.indexed_file_id) ?? [];
      chunks.push({
        index: chunk.chunk_index,
        content: chunk.content,
        tokenCount: chunk.token_count ?? 0,
      });
      chunksByFile.set(chunk.indexed_file_id, chunks);
    }

    for (const file of files) {
      try {
        await linkEntitiesDeterministic(db, file.id, file.content ?? "", chunksByFile.get(file.id) ?? [], allEntities);
        result.filesProcessed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, fileId: file.id }, "Deterministic entity linking failed");
        result.errors.push({ fileId: file.id, error: message });
        result.filesFailed++;
      }
    }
  }

  return result;
}

async function linkEntitiesDeterministic(
  db: Kysely<DB>,
  fileId: string,
  content: string,
  chunks: Chunk[],
  allEntities?: DeterministicEntity[],
): Promise<void> {
  const entityRepo = createEntityRepository(db);

  await db
    .deleteFrom("entity_mentions")
    .where("indexed_file_id", "=", fileId)
    .where("source", "=", "deterministic_substring")
    .where("confidence", "!=", "EXTRACTED")
    .execute();

  await deleteStaleLegacyDeterministicMentions(db, fileId);

  const entities = allEntities ?? (await entityRepo.getEntitiesByStatus("confirmed"));
  const contentLower = content.toLowerCase();

  for (const entity of entities) {
    const names: string[] = [entity.name];
    try {
      const aliases = JSON.parse(entity.aliases || "[]") as string[];
      names.push(...aliases);
    } catch {
      /* skip bad JSON */
    }

    // Check if any name/alias appears in content (skip very short names).
    // Word-boundary match avoids "anshu" inside "himanshu" false positives.
    const matchedName = names.find((name) => {
      const nameLower = name.toLowerCase();
      if (nameLower.length < MIN_ENTITY_NAME_LENGTH) return false;
      return matchesAsWord(contentLower, nameLower);
    });

    if (matchedName) {
      // Find the best chunk for context snippet
      const nameLower = matchedName.toLowerCase();
      const chunkIndex = chunks.findIndex((c) => matchesAsWord(c.content.toLowerCase(), nameLower));

      await entityRepo.createMention({
        entityId: entity.id,
        indexedFileId: fileId,
        chunkIndex: chunkIndex >= 0 ? chunkIndex : null,
        contextSnippet: chunkIndex >= 0 ? chunks[chunkIndex].content.slice(0, 300) : null,
        confidence: "INFERRED",
        source: "deterministic_substring",
        relation: "mentioned",
      });
      await entityRepo.updateHotness(entity.id);
      await yieldToEventLoop();
    }
  }
}

function normalizeDeterministicName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function entityNames(entity: { name: string; aliases: string | null }): string[] {
  const names = [entity.name];
  try {
    const aliases = JSON.parse(entity.aliases || "[]") as string[];
    names.push(...aliases.filter((alias) => typeof alias === "string"));
  } catch {}
  return names;
}

async function deleteStaleLegacyDeterministicMentions(db: Kysely<DB>, fileId: string): Promise<void> {
  const activeFactRows = await db
    .selectFrom("indexed_file_facts")
    .select("subject_name")
    .where("indexed_file_id", "=", fileId)
    .where("source", "=", "llm_extraction")
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  const activeLlmNames = new Set(
    activeFactRows
      .map((row) => row.subject_name)
      .filter((name): name is string => Boolean(name))
      .map(normalizeDeterministicName),
  );

  const legacyMentions = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entity_mentions.id as id", "entities.name as name", "entities.aliases as aliases"])
    .where("entity_mentions.indexed_file_id", "=", fileId)
    .where("entity_mentions.source", "=", "llm_extraction")
    .where("entity_mentions.confidence", "!=", "EXTRACTED")
    .execute();
  const staleIds = legacyMentions
    .filter((mention) => entityNames(mention).every((name) => !activeLlmNames.has(normalizeDeterministicName(name))))
    .map((mention) => mention.id);

  if (staleIds.length === 0) return;
  await db.deleteFrom("entity_mentions").where("id", "in", staleIds).execute();
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

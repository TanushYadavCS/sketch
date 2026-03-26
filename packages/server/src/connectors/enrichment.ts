/**
 * Post-sync enrichment pipeline.
 *
 * Runs after sync completes. For each file with embedding_status = 'pending':
 * 1. Chunk text content
 * 2. Extract tags + timeframes (deterministic for structured, LLM for unstructured)
 * 3. Generate embeddings (text chunks or images)
 * 4. Store everything in DB
 *
 * Images are downloaded temporarily from Google Drive, embedded, then discarded.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import type { DB } from "../db/schema";
import { chunkText } from "./chunking";
import type { EmbeddingProvider } from "./embeddings/types";
import type { LlmCallResult } from "./llm";
import {
  type FileContext,
  type TaggingResult,
  buildRollupPrompt,
  buildTaggingPrompt,
  parseTaggingResponse,
  tagShortContent,
  tagStructuredContent,
} from "./tagging";

/** Max estimated tokens per LLM tagging batch. Our token estimator (1 token ≈ 4 chars) undercounts ~4x, so 12k estimated ≈ ~48k actual, safely under 200k limit. */
const TAG_BATCH_TOKEN_LIMIT = 12_000;

/** Max files to enrich per run (prevent runaway costs). */
const MAX_FILES_PER_RUN = 50;

/** Token threshold for single vs. batched LLM tagging. */
const SINGLE_CALL_TOKEN_LIMIT = 4000;

interface EnrichmentDeps {
  db: Kysely<DB>;
  logger: Logger;
  embeddingProvider: EmbeddingProvider | null;
  /** Call the LLM for tagging. Returns text + token usage. */
  llmCall: (prompt: string) => Promise<LlmCallResult>;
  /** Download image from Google Drive by provider file ID. Returns buffer + mime type. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  /** Org context for the tagging prompt — helps the LLM understand documents in context. */
  orgContext?: string;
  /** If set, only enrich these specific file IDs (ignoring pending status). */
  fileIds?: string[];
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
  const { db, logger } = deps;
  const result: EnrichmentResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    errors: [],
  };

  // Find files needing enrichment
  let query = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "file_type",
      "content_category",
      "content",
      "source",
      "source_path",
      "mime_type",
      "provider_file_id",
      "connector_config_id",
      "source_created_at",
      "source_updated_at",
    ])
    .where("is_archived", "=", 0);

  if (deps.fileIds && deps.fileIds.length > 0) {
    query = query.where("id", "in", deps.fileIds);
  } else {
    query = query.where("embedding_status", "in", ["pending", "failed", "processing"]);
  }

  const pendingFiles = await query.limit(MAX_FILES_PER_RUN).execute();

  if (pendingFiles.length === 0) {
    logger.debug("No files pending enrichment");
    return result;
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  logger.info({ count: pendingFiles.length }, "Starting enrichment run");

  for (let idx = 0; idx < pendingFiles.length; idx++) {
    const file = pendingFiles[idx];
    const fileStart = Date.now();
    try {
      // Optimistic lock: only claim the file if it's still in a claimable state.
      // Concurrent enrichment runs racing on the same file will each attempt this UPDATE;
      // only the first one to execute it will see numUpdatedRows > 0.
      const claimResult = await db
        .updateTable("indexed_files")
        .set({ embedding_status: "processing" })
        .where("id", "=", file.id)
        .where("embedding_status", "in", ["pending", "failed", "processing"])
        .executeTakeFirst();
      if (claimResult.numUpdatedRows === BigInt(0)) {
        result.filesSkipped++;
        continue;
      }

      const isImage = file.mime_type?.startsWith("image/") || file.file_type === "image";
      const isStructured = file.content_category === "structured";

      // Track tokens for this file via a wrapper
      let fileInputTokens = 0;
      let fileOutputTokens = 0;
      const trackedDeps: EnrichmentDeps = {
        ...deps,
        llmCall: async (prompt: string) => {
          const r = await deps.llmCall(prompt);
          fileInputTokens += r.inputTokens;
          fileOutputTokens += r.outputTokens;
          return r;
        },
      };

      if (isImage) {
        await enrichImage(file, trackedDeps);
      } else if (file.content) {
        await enrichTextDocument(file as typeof file & { content: string }, isStructured, trackedDeps);
      } else {
        // No content and not an image — skip
        await db.updateTable("indexed_files").set({ embedding_status: "skipped" }).where("id", "=", file.id).execute();
        result.filesSkipped++;
        continue;
      }

      // Mark as done
      await db.updateTable("indexed_files").set({ embedding_status: "done" }).where("id", "=", file.id).execute();

      totalInputTokens += fileInputTokens;
      totalOutputTokens += fileOutputTokens;
      result.filesProcessed++;

      const elapsed = ((Date.now() - fileStart) / 1000).toFixed(1);
      logger.info(
        {
          fileName: file.file_name,
          progress: `${idx + 1}/${pendingFiles.length}`,
          elapsed: `${elapsed}s`,
          tokens:
            fileInputTokens + fileOutputTokens > 0 ? { input: fileInputTokens, output: fileOutputTokens } : undefined,
        },
        "Enriched file",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, fileId: file.id, fileName: file.file_name }, "Enrichment failed for file");
      result.errors.push({ fileId: file.id, error: message });
      result.filesFailed++;

      await db.updateTable("indexed_files").set({ embedding_status: "failed" }).where("id", "=", file.id).execute();
    }
  }

  logger.info(
    {
      processed: result.filesProcessed,
      skipped: result.filesSkipped,
      failed: result.filesFailed,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    },
    "Enrichment run complete",
  );

  return result;
}

/**
 * Enrich a text document: chunk, tag, embed.
 */
async function enrichTextDocument(
  file: {
    id: string;
    file_name: string;
    content: string;
    content_category: string;
    source_path: string | null;
    source_created_at: string | null;
    source_updated_at: string | null;
  },
  isStructured: boolean,
  deps: EnrichmentDeps,
): Promise<void> {
  const { db, logger, embeddingProvider, llmCall } = deps;

  // For structured data (CSV/sheets), only use the head for tagging — no chunking, no embedding
  if (isStructured) {
    const taggingResult = tagStructuredContent(file.content, file.file_name, file.source_path);

    await db
      .updateTable("indexed_files")
      .set({
        tags: JSON.stringify(taggingResult.tags),
        summary: taggingResult.summary || null,
      })
      .where("id", "=", file.id)
      .execute();

    await clearFileTimeframes(db, file.id);
    for (const tf of taggingResult.timeframes) {
      await db
        .insertInto("document_timeframes")
        .values({
          id: randomUUID(),
          indexed_file_id: file.id,
          start_date: tf.startDate,
          end_date: tf.endDate ?? null,
          context: tf.context ?? null,
        })
        .execute();
    }

    logger.debug(
      { fileId: file.id, fileName: file.file_name, tags: taggingResult.tags.length },
      "Structured file tagged (no chunking/embedding)",
    );
    return;
  }

  // 1. Chunk the content
  const chunks = chunkText(file.content);

  // 1b. Gather extra context for tagging
  const sharedWith = await db
    .selectFrom("file_access")
    .select("email")
    .where("indexed_file_id", "=", file.id)
    .execute();

  // Sibling files in the same folder
  let siblingNames: string[] = [];
  if (file.source_path) {
    const siblings = await db
      .selectFrom("indexed_files")
      .select("file_name")
      .where("source_path", "=", file.source_path)
      .where("id", "!=", file.id)
      .where("is_archived", "=", 0)
      .limit(15)
      .execute();
    siblingNames = siblings.map((s) => s.file_name);
  }

  const fileContext: FileContext = {
    sourcePath: file.source_path,
    createdAt: file.source_created_at,
    modifiedAt: file.source_updated_at,
    wordCount: file.content.split(/\s+/).length,
    sharedWith: sharedWith.map((s) => s.email),
    siblingFileNames: siblingNames,
  };

  // 2. Store chunks (batch insert — one statement instead of N)
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

  // 3. Extract tags + timeframes
  let taggingResult: TaggingResult;

  const wordCount = file.content.split(/\s+/).length;

  if (wordCount < 100) {
    // Short content — deterministic tagging, no LLM needed
    taggingResult = tagShortContent(file.content, file.file_name, file.source_path);
  } else {
    // LLM-based tagging
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

    if (totalTokens <= SINGLE_CALL_TOKEN_LIMIT) {
      // Small doc — single LLM call
      const prompt = buildTaggingPrompt(chunks, file.file_name, deps.orgContext, fileContext);
      const response = await llmCall(prompt);
      taggingResult = parseTaggingResponse(response.text) ?? { tags: [], summary: "", timeframes: [] };
    } else {
      // Large doc — batch then rollup
      taggingResult = await batchTagDocument(chunks, file.file_name, llmCall, logger, deps.orgContext, fileContext);
    }
  }

  // 4. Update indexed_files with tags + summary
  await db
    .updateTable("indexed_files")
    .set({
      tags: JSON.stringify(taggingResult.tags),
      summary: taggingResult.summary || null,
    })
    .where("id", "=", file.id)
    .execute();

  // 5. Store timeframes (batch insert)
  await clearFileTimeframes(db, file.id);
  if (taggingResult.timeframes.length > 0) {
    await db
      .insertInto("document_timeframes")
      .values(
        taggingResult.timeframes.map((tf) => ({
          id: randomUUID(),
          indexed_file_id: file.id,
          start_date: tf.startDate,
          end_date: tf.endDate ?? null,
          context: tf.context ?? null,
        })),
      )
      .execute();
  }

  // 6. Embed chunks (best-effort — tagging still succeeds if embedding fails)
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

      // Batch embedding inserts — chunk_embeddings is a vec0 virtual table that
      // only supports single-row INSERT, so we must still insert one at a time.
      // We use Promise.all to overlap the async overhead rather than a for-await loop.
      await Promise.all(
        storedChunks
          .filter((_, i) => !!embeddings[i])
          .map((chunk, i) =>
            isPostgres
              ? sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunk.id}, ${JSON.stringify(embeddings[i])}::vector)`.execute(
                  db,
                )
              : sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunk.id}, ${JSON.stringify(embeddings[i])})`.execute(
                  db,
                ),
          ),
      );
      logger.info({ fileId: file.id, chunks: storedChunks.length }, "Embeddings created");
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Embedding failed, tagging still saved");
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
    // No multimodal embedding available — skip image
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

  // Derive basic tags from file name and path (no LLM needed for images)
  const tags = deriveImageTags(file.file_name, file.source_path);
  await db
    .updateTable("indexed_files")
    .set({ tags: JSON.stringify(tags) })
    .where("id", "=", file.id)
    .execute();

  // buffer is garbage collected — nothing stored on disk
}

/**
 * Batch tagging for large documents.
 * Processes chunks in groups, then rolls up into document-level metadata.
 */
async function batchTagDocument(
  chunks: ReturnType<typeof chunkText>,
  fileName: string,
  llmCall: (prompt: string) => Promise<LlmCallResult>,
  logger: Logger,
  orgContext?: string,
  fileContext?: FileContext,
): Promise<TaggingResult> {
  const batchResults: Array<{ tags: string[]; summary: string; temporal_references: unknown[] }> = [];

  // Group chunks into batches by token count
  const batches: (typeof chunks)[] = [];
  let currentBatch: typeof chunks = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    // Safety: skip oversized chunks that would exceed the API limit on their own
    if (chunk.tokenCount > TAG_BATCH_TOKEN_LIMIT) {
      // Flush current batch first
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      // Truncate the chunk content to fit within the limit
      const maxChars = TAG_BATCH_TOKEN_LIMIT * 4;
      const truncated = { ...chunk, content: chunk.content.slice(0, maxChars), tokenCount: TAG_BATCH_TOKEN_LIMIT };
      batches.push([truncated]);
      continue;
    }
    if (currentBatch.length > 0 && currentTokens + chunk.tokenCount > TAG_BATCH_TOKEN_LIMIT) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(chunk);
    currentTokens += chunk.tokenCount;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const prompt = buildTaggingPrompt(batch, fileName, orgContext, fileContext);

    try {
      const response = await llmCall(prompt);
      const parsed = parseTaggingResponse(response.text);
      if (parsed) {
        batchResults.push({
          tags: parsed.tags,
          summary: parsed.summary,
          temporal_references: parsed.timeframes.map((tf) => ({
            start_date: tf.startDate,
            end_date: tf.endDate,
            context: tf.context,
          })),
        });
      }
    } catch (err) {
      logger.warn({ err, batchIndex: i }, "Tagging batch failed, continuing with remaining batches");
    }
  }

  if (batchResults.length === 0) {
    return { tags: [], summary: "", timeframes: [] };
  }

  if (batchResults.length === 1) {
    return parseTaggingResponse(JSON.stringify(batchResults[0])) ?? { tags: [], summary: "", timeframes: [] };
  }

  // Rollup: merge all batch results
  const rollupPrompt = buildRollupPrompt(batchResults, fileName);
  const rollupResponse = await llmCall(rollupPrompt);
  return parseTaggingResponse(rollupResponse.text) ?? { tags: [], summary: "", timeframes: [] };
}

/**
 * Derive tags from an image filename and path. No LLM call.
 */
function deriveImageTags(fileName: string, _sourcePath: string | null): string[] {
  const tags = new Set<string>(["image"]);

  // Extract meaningful words from filename
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, "");
  const words = nameWithoutExt.split(/[-_\s]+/).filter((w) => w.length > 1);
  for (const word of words) {
    tags.add(word.toLowerCase());
  }

  return [...tags].slice(0, 15);
}

async function clearFileChunks(db: Kysely<DB>, fileId: string): Promise<void> {
  // Delete all embeddings for the file's chunks in a single statement.
  // The subquery approach avoids a separate SELECT + N per-chunk DELETEs.
  // chunk_embeddings is a vec0 virtual table that only exists when sqlite-vec
  // is loaded. Catch and ignore "no such table" so this works in test DBs too.
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
  // file_embeddings is a vec0 virtual table (sqlite-vec). Gracefully skip if unavailable.
  try {
    await sql`DELETE FROM file_embeddings WHERE indexed_file_id = ${fileId}`.execute(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const isNoSuchTable = msg.includes("no such table: file_embeddings") || msg.includes("does not exist");
    if (!isNoSuchTable) throw err;
  }
}

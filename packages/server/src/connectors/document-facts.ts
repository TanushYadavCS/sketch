import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createIndexedFileFactRepository, upsertLlmTaskFact } from "../db/repositories/indexed-file-facts";
import { retireLlmTasksForTombstonedFacts } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import type { GeminiGenerator } from "./gemini-generate";
import { LLM_TASK_PROMPT_VERSION, extractLlmTaskCandidates } from "./llm-task-extraction";
import { normalizeName } from "./name-normalize";
import type { LlmTaskCandidate } from "./types";

export interface DocumentFactParticipant {
  name?: string;
  email?: string;
}

export interface DocumentFactParentRef {
  source: string;
  sourceId: string;
}

export interface DocumentFactContext {
  indexedFileId: string;
  source: string;
  content: string;
  sourceDate?: string | null;
  contentCategory: string;
  fileType?: string | null;
  contentHash: string | null;
  connectorConfigId: string | null;
  createdByUserId: string | null;
  lastSeenSyncRunId: string | null;
  attendees: DocumentFactParticipant[];
  parentRefs: DocumentFactParentRef[];
}

export interface EmitDocumentDerivedFactsOptions {
  experimentalFlag?: boolean;
  contentChanged?: boolean;
  generator?: GeminiGenerator;
  dumpDir?: string;
  logger?: Logger;
}

export interface EmitDocumentDerivedFactsResult {
  emittedFactKeys: Set<string>;
  tombstonedFactIds: string[];
  changed: boolean;
}

/**
 * File types that the structural pipeline already mints a `structural_task` from
 * (Linear issues, ClickUp tasks/subtasks — keyed off the sync `item.task` flag).
 * Such records ARE tasks, so deriving tasks from their body double-sources them.
 * Zoho's `crm_task` is deliberately absent: it sets no `task` flag, mints no
 * structural task, and so is not double-sourced. A null/unknown file type falls
 * through to normal extraction.
 */
export const STRUCTURAL_TASK_FILE_TYPES = new Set(["issue", "task", "subtask"]);

export function sortDocumentParentRefs(parentRefs: DocumentFactParentRef[]): DocumentFactParentRef[] {
  return [...parentRefs].sort((a, b) => a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId));
}

export async function emitDocumentDerivedFacts(
  db: Kysely<DB>,
  ctx: DocumentFactContext,
  { experimentalFlag = false, contentChanged = false, generator, dumpDir, logger }: EmitDocumentDerivedFactsOptions,
): Promise<EmitDocumentDerivedFactsResult> {
  const emittedFactKeys = new Set<string>();
  const factRepo = createIndexedFileFactRepository(db);

  if (!(experimentalFlag && ctx.contentCategory === "document" && ctx.content)) {
    return { emittedFactKeys, tombstonedFactIds: [], changed: false };
  }

  if (ctx.fileType && STRUCTURAL_TASK_FILE_TYPES.has(ctx.fileType.toLowerCase())) {
    const reconcile = await factRepo.reconcileStaleFacts(
      { kind: "file", indexedFileId: ctx.indexedFileId, source: ctx.source, factType: "llm_task" },
      new Set(),
    );
    await retireLlmTasksForTombstonedFacts(db, reconcile.tombstonedFactIds);
    return {
      emittedFactKeys,
      tombstonedFactIds: reconcile.tombstonedFactIds,
      changed: reconcile.tombstonedFactIds.length > 0,
    };
  }

  if (!contentChanged) {
    const touched = await touchExistingLlmTaskFacts(factRepo, ctx);
    return { emittedFactKeys, tombstonedFactIds: [], changed: touched > 0 };
  }

  if (!generator) {
    const touched = await touchExistingLlmTaskFacts(factRepo, ctx);
    return { emittedFactKeys, tombstonedFactIds: [], changed: touched > 0 };
  }

  const parentRefs = sortDocumentParentRefs(ctx.parentRefs);
  const parentRef = parentRefs[0];
  const connectorConfigId = ctx.connectorConfigId ?? "";
  const priorTitles = await loadPriorLlmTaskTitles(db, ctx.indexedFileId, logger);
  let candidates: LlmTaskCandidate[];
  try {
    candidates = await extractLlmTaskCandidates({
      content: ctx.content,
      sourceDate: ctx.sourceDate ?? undefined,
      attendees: ctx.attendees,
      parentRefs,
      priorTitles,
      generator,
      promptVersion: LLM_TASK_PROMPT_VERSION,
      dumpDir,
    });
  } catch (err) {
    logger?.warn({ err, indexedFileId: ctx.indexedFileId }, "llm_task extraction failed");
    const touched = await touchExistingLlmTaskFacts(factRepo, ctx);
    return { emittedFactKeys, tombstonedFactIds: [], changed: touched > 0 };
  }

  for (const candidate of candidates) {
    const result = await upsertLlmTaskFact(db, {
      experimentalFlag,
      indexedFileId: ctx.indexedFileId,
      connectorConfigId,
      createdByUserId: ctx.createdByUserId,
      lastSeenSyncRunId: ctx.lastSeenSyncRunId,
      contentHash: ctx.contentHash,
      source: ctx.source,
      candidate,
      corroborationKey: buildLlmTaskCorroborationKey(candidate.title, parentRef),
      parentRef,
      evidence: { fileIds: [ctx.indexedFileId], entityIds: [] },
      promptVersion: LLM_TASK_PROMPT_VERSION,
    });
    if (result.factKey) emittedFactKeys.add(result.factKey);
  }

  const reconcile = await factRepo.reconcileStaleFacts(
    { kind: "file", indexedFileId: ctx.indexedFileId, source: ctx.source, factType: "llm_task" },
    emittedFactKeys,
  );
  await retireLlmTasksForTombstonedFacts(db, reconcile.tombstonedFactIds);
  return {
    emittedFactKeys,
    tombstonedFactIds: reconcile.tombstonedFactIds,
    changed: emittedFactKeys.size > 0 || reconcile.tombstonedFactIds.length > 0,
  };
}

async function touchExistingLlmTaskFacts(
  factRepo: ReturnType<typeof createIndexedFileFactRepository>,
  ctx: DocumentFactContext,
): Promise<number> {
  if (!ctx.lastSeenSyncRunId) return 0;
  return factRepo.touchActiveFactsForFile({
    indexedFileId: ctx.indexedFileId,
    source: ctx.source,
    factType: "llm_task",
    lastSeenSyncRunId: ctx.lastSeenSyncRunId,
    contentHash: ctx.contentHash,
  });
}

async function loadPriorLlmTaskTitles(db: Kysely<DB>, indexedFileId: string, logger: Logger | undefined) {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select("raw")
    .where("fact_type", "=", "llm_task")
    .where("indexed_file_id", "=", indexedFileId)
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "asc")
    .execute();
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const row of rows) {
    const title = readRawTitle(row.raw);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  const capped = titles.slice(0, 50);
  if (titles.length > capped.length) {
    logger?.info(
      { indexedFileId, priorTitleCount: titles.length, passedPriorTitleCount: capped.length },
      "llm_task prior titles truncated",
    );
  }
  return capped;
}

function readRawTitle(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null;
  } catch {
    return null;
  }
}

function buildLlmTaskCorroborationKey(title: string, parentRef: DocumentFactParentRef | undefined): string {
  return [normalizeName(title), parentRef ? `${parentRef.source}:${parentRef.sourceId}` : "global"].join("|");
}

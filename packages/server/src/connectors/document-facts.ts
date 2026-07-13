import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { retireLlmTasksForTombstonedFacts } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import type { GeminiGenerator } from "./gemini-generate";

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
  { contentChanged = false }: EmitDocumentDerivedFactsOptions,
): Promise<EmitDocumentDerivedFactsResult> {
  const emittedFactKeys = new Set<string>();
  const factRepo = createIndexedFileFactRepository(db);

  if (!(contentChanged && ctx.content)) {
    return { emittedFactKeys, tombstonedFactIds: [], changed: false };
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

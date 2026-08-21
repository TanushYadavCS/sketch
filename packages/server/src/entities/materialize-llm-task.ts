import { createTaskActivityRepository } from "../db/repositories/task-activity";
import { type TaskStatus, updateTaskStatusFromEvidence, upsertLlmTask } from "../db/repositories/tasks";
import { TEST_ACCOUNT_ENTITY_ID } from "../db/repositories/tasks";
import { readJsonObject } from "./materialize-json";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { normalizeName } from "./name-keys";

export async function materializeLlmTask(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  const raw = readLlmTask(readJsonObject(fact.raw));
  if (!raw) return { kind: "skipped", reason: "invalid_llm_task" };
  const indexedFileId = fact.indexed_file_id;
  if (!indexedFileId) return { kind: "skipped", reason: "invalid_llm_task" };

  const ownerUserId = deps.resolveOwner(fact);
  if (!ownerUserId) return { kind: "skipped", reason: "llm_task_no_owner" };

  if (raw.updateOf) {
    const updated = await materializeTaskUpdate(deps, raw.updateOf, raw, indexedFileId);
    if (updated) return { kind: "task_materialized", taskId: raw.updateOf, created: false, updated: true };
  }

  const parent = resolveParent(deps, raw);
  const collatedTaskId = await findCollationTaskId(deps, raw.title, parent?.id ?? null, ownerUserId);
  if (collatedTaskId) {
    await upsertTaskEvidence(deps, collatedTaskId, evidenceForFact(raw, [fact.id]));
    await appendTaskEvidenceActivity(deps, collatedTaskId, indexedFileId, raw.sourceExcerpt);
    return { kind: "task_materialized", taskId: collatedTaskId, created: false, updated: true };
  }

  const mechanicalTaskId = await findMechanicalDedupTaskId(deps, raw.title, parent?.id ?? null, ownerUserId);
  if (mechanicalTaskId) {
    await materializeTaskUpdate(deps, mechanicalTaskId, raw, indexedFileId);
    return { kind: "task_materialized", taskId: mechanicalTaskId, created: false, updated: true };
  }

  const corroborationCount = await countCorroboratingFiles(deps, raw.corroborationKey, ownerUserId);
  if (raw.hasOwnerVerbObject || corroborationCount >= deps.llmTaskCorroborationThreshold) {
    const corroborating = await loadCorroboratingFacts(deps, raw.corroborationKey, ownerUserId);
    const assignee = await resolveAssignee(deps, raw.owner);
    const result = await upsertLlmTask(deps.db, {
      candidate: {
        title: raw.title,
        dueAt: raw.dueDate ?? null,
        assigneeEntityId: assignee.entityId,
        assigneeName: assignee.name,
      },
      ownerUserId,
      parentEntityId: parent?.id ?? null,
      parentKey: parentKey(raw, parent),
      evidence: evidenceForFacts(corroborating),
    });
    return { kind: "task_materialized", ...result };
  }

  return { kind: "skipped", reason: "llm_task_ungated" };
}

function resolveParent(deps: MaterializeDeps, raw: LlmTaskInput): IndexEntityRow | null {
  if (raw.parentRef) {
    const byRef = deps.index.bySourceRef.get(`${raw.parentRef.source}:${raw.parentRef.sourceId}`);
    if (isAllowedParent(byRef)) return byRef;
  }
  if (raw.parentEntityId) {
    const byId = findEntityById(deps, raw.parentEntityId);
    if (isAllowedParent(byId)) return byId;
  }
  for (const entityId of raw.evidence.entityIds) {
    const byId = findEntityById(deps, entityId);
    if (isAllowedParent(byId)) return byId;
  }
  return null;
}

async function resolveAssignee(
  deps: MaterializeDeps,
  owner: LlmTaskInput["owner"],
): Promise<{ entityId: string | null; name: string | null }> {
  if (!owner) return { entityId: null, name: null };
  const name = owner.name ?? null;
  if (owner.email) {
    const matches = await deps.entityRepo.getPersonEntitiesByEmail(owner.email);
    if (matches.length === 1) return { entityId: matches[0].id, name };
  }
  if (owner.name) {
    const matches = (deps.index.byNormalizedName.get(normalizeName(owner.name)) ?? []).filter(
      (entity) => entity.source_type === "person",
    );
    if (matches.length === 1) return { entityId: matches[0].id, name };
  }
  return { entityId: null, name };
}

function findEntityById(deps: MaterializeDeps, entityId: string): IndexEntityRow | undefined {
  return deps.index.entitiesByType.get("project")?.find((entity) => entity.id === entityId);
}

function isAllowedParent(entity: IndexEntityRow | undefined): entity is IndexEntityRow {
  return Boolean(entity && entity.id !== TEST_ACCOUNT_ENTITY_ID && entity.source_type === "project");
}

async function findCollationTaskId(
  deps: MaterializeDeps,
  title: string,
  parentEntityId: string | null,
  ownerUserId: string,
): Promise<string | null> {
  let query = deps.db
    .selectFrom("tasks")
    .select(["id", "provenance", "created_by_user_id"])
    .where("valid_to", "is", null)
    .where("normalized_title", "=", normalizeName(title));
  query =
    parentEntityId === null
      ? query.where("parent_entity_id", "is", null)
      : query.where("parent_entity_id", "=", parentEntityId);
  const rows = await query.execute();
  const structural = rows.find((row) => row.provenance === "structural");
  if (structural) return structural.id;
  const local = rows.find(
    (row) => (row.provenance === "brief" || row.provenance === "llm") && row.created_by_user_id === ownerUserId,
  );
  return local?.id ?? null;
}

/**
 * Parentless conversation evidence may not know the tracker parent. Structural
 * tasks are authoritative about that shape, so a higher token-overlap bar is
 * used before linking across the parent scope.
 */
async function findMechanicalDedupTaskId(
  deps: MaterializeDeps,
  title: string,
  parentEntityId: string | null,
  ownerUserId: string,
): Promise<string | null> {
  const candidateTokens = titleTokens(title);
  if (candidateTokens.length < 2) return null;
  const rows = await deps.db
    .selectFrom("tasks")
    .select(["id", "title", "parent_entity_id", "provenance", "created_by_user_id"])
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .where((eb) =>
      eb.or([
        eb("provenance", "=", "structural"),
        eb.and([eb("provenance", "in", ["llm", "brief"]), eb("created_by_user_id", "=", ownerUserId)]),
      ]),
    )
    .execute();
  const structural = rows.filter((row) => row.provenance === "structural");
  const local = rows.filter((row) => row.provenance === "llm" || row.provenance === "brief");
  for (const task of [...structural, ...local]) {
    const taskTokens = titleTokens(task.title);
    const shared = sharedTokenCount(candidateTokens, taskTokens);
    if (shared < 2) continue;
    const overlap = shared / Math.max(candidateTokens.length, taskTokens.length);
    if ((task.parent_entity_id ?? null) === parentEntityId && overlap >= 0.8) return task.id;
    if (
      task.provenance === "structural" &&
      parentEntityId === null &&
      task.parent_entity_id !== null &&
      overlap >= 0.9
    ) {
      return task.id;
    }
  }
  return null;
}

async function materializeTaskUpdate(
  deps: MaterializeDeps,
  taskId: string,
  raw: LlmTaskInput,
  indexedFileId: string,
): Promise<boolean> {
  const task = await deps.db
    .selectFrom("tasks")
    .select(["id", "status", "status_authority"])
    .where("id", "=", taskId)
    .where("valid_to", "is", null)
    .executeTakeFirst();
  if (!task) return false;
  await upsertTaskEvidence(deps, task.id, { fileIds: [indexedFileId], entityIds: [], factIds: [] });
  const status = taskStatusFromHint(raw.statusHint);
  if (status && task.status_authority === "local" && task.status !== status) {
    const result = await updateTaskStatusFromEvidence(deps.db, {
      taskId: task.id,
      status,
      indexedFileId,
      excerpt: raw.sourceExcerpt,
    });
    if (result?.changed) return true;
  }
  await appendTaskEvidenceActivity(deps, task.id, indexedFileId, raw.sourceExcerpt);
  return true;
}

async function appendTaskEvidenceActivity(
  deps: MaterializeDeps,
  taskId: string,
  indexedFileId: string,
  excerpt?: string,
): Promise<void> {
  await createTaskActivityRepository(deps.db).append({
    taskId,
    eventKind: "evidence_added",
    actorType: "system",
    surface: "sync",
    evidence: { fileIds: [indexedFileId], excerpt },
    identityParts: [taskId, indexedFileId, "evidence_added"],
    occurredAt: new Date().toISOString(),
  });
}

function taskStatusFromHint(value: LlmTaskInput["statusHint"]): TaskStatus | null {
  if (value === "done" || value === "in_progress") return value;
  return null;
}

function titleTokens(title: string): string[] {
  return normalizeName(title)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function sharedTokenCount(left: string[], right: string[]): number {
  const rightTokens = new Set(right);
  let count = 0;
  for (const token of new Set(left)) {
    if (rightTokens.has(token)) count += 1;
  }
  return count;
}

async function countCorroboratingFiles(
  deps: MaterializeDeps,
  corroborationKey: string,
  ownerUserId: string,
): Promise<number> {
  const facts = await loadCorroboratingFacts(deps, corroborationKey, ownerUserId);
  if (facts.length === 0) return 0;
  const row = await deps.db
    .selectFrom("indexed_file_facts")
    .select((eb) => eb.fn.count<number>("indexed_file_id").distinct().as("count"))
    .where(
      "id",
      "in",
      facts.map((entry) => entry.fact.id),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function loadCorroboratingFacts(
  deps: MaterializeDeps,
  corroborationKey: string,
  ownerUserId: string,
): Promise<Array<{ fact: IndexedFileFactRow; raw: LlmTaskInput }>> {
  const rows = await deps.db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("fact_type", "=", "llm_task")
    .where("created_by_user_id", "=", ownerUserId)
    .where("deleted_at", "is", null)
    .execute();
  const out: Array<{ fact: IndexedFileFactRow; raw: LlmTaskInput }> = [];
  for (const row of rows) {
    const raw = readLlmTask(readJsonObject(row.raw));
    if (raw?.corroborationKey === corroborationKey) out.push({ fact: row, raw });
  }
  return out;
}

function evidenceForFact(
  raw: LlmTaskInput,
  factIds: string[],
): { fileIds: string[]; entityIds: string[]; factIds: string[] } {
  return {
    fileIds: [...new Set(raw.evidence.fileIds)],
    entityIds: [...new Set(raw.evidence.entityIds.filter((id) => id !== TEST_ACCOUNT_ENTITY_ID))],
    factIds: [...new Set(factIds)],
  };
}

function evidenceForFacts(entries: Array<{ fact: IndexedFileFactRow; raw: LlmTaskInput }>): {
  fileIds: string[];
  entityIds: string[];
  factIds: string[];
} {
  return {
    fileIds: [...new Set(entries.flatMap((entry) => entry.raw.evidence.fileIds))],
    entityIds: [
      ...new Set(
        entries.flatMap((entry) => entry.raw.evidence.entityIds).filter((id) => id !== TEST_ACCOUNT_ENTITY_ID),
      ),
    ],
    factIds: [...new Set(entries.map((entry) => entry.fact.id))],
  };
}

async function upsertTaskEvidence(
  deps: MaterializeDeps,
  taskId: string,
  evidence: { fileIds: string[]; entityIds: string[]; factIds: string[] },
): Promise<void> {
  const edges = [
    ...evidence.fileIds.map((refId) => ({ kind: "file", refId })),
    ...evidence.entityIds.map((refId) => ({ kind: "entity", refId })),
    ...evidence.factIds.map((refId) => ({ kind: "fact", refId })),
  ];
  for (const edge of edges) {
    await deps.db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: edge.kind, ref_id: edge.refId })
      .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
      .execute();
  }
}

function parentKey(raw: LlmTaskInput, parent: IndexEntityRow | null): string {
  if (parent) return parent.id;
  if (raw.parentRef) return `${raw.parentRef.source}:${raw.parentRef.sourceId}`;
  if (raw.parentEntityId) return raw.parentEntityId;
  return "global";
}

interface LlmTaskInput {
  candidateId: string;
  title: string;
  owner?: { name?: string; email?: string };
  dueDate?: string;
  hasOwnerVerbObject: boolean;
  updateOf?: string;
  statusHint?: "done" | "in_progress" | "blocked";
  corroborationKey: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  sourceExcerpt?: string;
  promptVersion: string;
}

function readLlmTask(raw: Record<string, unknown>): LlmTaskInput | null {
  if (
    typeof raw.candidateId !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.hasOwnerVerbObject !== "boolean" ||
    typeof raw.corroborationKey !== "string" ||
    typeof raw.promptVersion !== "string" ||
    !isEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    candidateId: raw.candidateId,
    title: raw.title,
    owner: readOwner(raw.owner),
    dueDate: readDueDate(raw.dueDate),
    hasOwnerVerbObject: raw.hasOwnerVerbObject,
    updateOf: readOptionalString(raw.updateOf),
    statusHint: readStatusHint(raw.statusHint),
    corroborationKey: raw.corroborationKey,
    parentRef: readParentRef(raw.parentRef),
    parentEntityId: readOptionalString(raw.parentEntityId),
    evidence: raw.evidence,
    sourceExcerpt: readOptionalString(raw.sourceExcerpt),
    promptVersion: raw.promptVersion,
  };
}

function readParentRef(value: unknown): { source: string; sourceId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.sourceId !== "string") return undefined;
  return { source: record.source, sourceId: record.sourceId };
}

function readOwner(value: unknown): { name?: string; email?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = readOptionalString(record.name);
  const email = readOptionalString(record.email);
  return name || email ? { name, email } : undefined;
}

function isEvidence(value: unknown): value is { fileIds: string[]; entityIds: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.fileIds) &&
    record.fileIds.every((id) => typeof id === "string") &&
    Array.isArray(record.entityIds) &&
    record.entityIds.every((id) => typeof id === "string")
  );
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDueDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function readStatusHint(value: unknown): "done" | "in_progress" | "blocked" | undefined {
  return value === "done" || value === "in_progress" || value === "blocked" ? value : undefined;
}

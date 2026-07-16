import { normalizeName } from "../connectors/name-normalize";
import { upsertLlmTask } from "../db/repositories/tasks";
import { TEST_ACCOUNT_ENTITY_ID } from "../db/repositories/tasks";
import { readJsonObject } from "./materialize-json";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

export async function materializeLlmTask(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  const raw = readLlmTask(readJsonObject(fact.raw));
  if (!raw) return { kind: "skipped", reason: "invalid_llm_task" };

  const ownerUserId = deps.resolveOwner(fact);
  if (!ownerUserId) return { kind: "skipped", reason: "llm_task_no_owner" };

  const parent = resolveParent(deps, raw);
  const collatedTaskId = await findCollationTaskId(deps, raw.title, parent?.id ?? null, ownerUserId);
  if (collatedTaskId) {
    await upsertTaskEvidence(deps, collatedTaskId, evidenceForFact(raw, [fact.id]));
    return { kind: "task_materialized", taskId: collatedTaskId, created: false };
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

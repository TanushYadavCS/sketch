import { createSubEntityRepository } from "../db/repositories/sub-entities";
import { TEST_ACCOUNT_ENTITY_ID } from "../db/repositories/tasks";
import { readJsonObject } from "./materialize-json";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import type { ProposeEntityType } from "./propose";

export async function materializeCommitment(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const commitment = readCommitment(raw);
  if (!commitment) return { kind: "skipped", reason: "invalid_commitment" };

  const parent = resolveParent(deps, commitment, ["project", "person"]);
  const repo = createSubEntityRepository(deps.db);
  const result = await repo.upsertSubEntity({
    parentEntityId: parent?.id ?? null,
    kind: "commitment",
    displayName: commitment.title,
    status: commitment.status,
    provenance: fact.source === "llm" ? "corroborated_llm" : "structural",
    dueAt: commitment.dueAt ?? null,
    ownerUserId: deps.resolveOwner(fact),
    sourceFactId: fact.id,
  });
  await repo.upsertSubEntityEvidence(result.subEntityId, "fact", fact.id);
  for (const fileId of commitment.evidence.fileIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "file", fileId);
  }
  for (const entityId of commitment.evidence.entityIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "entity", entityId);
  }
  return { kind: "commitment_materialized" };
}

export interface SubEntityParentInput {
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  evidence: { entityIds: string[] };
}

export function resolveParent(
  deps: MaterializeDeps,
  input: SubEntityParentInput,
  allowedTypes: readonly string[],
): IndexEntityRow | null {
  if (input.parentRef) {
    const byRef = deps.index.bySourceRef.get(`${input.parentRef.source}:${input.parentRef.sourceId}`);
    if (isAllowedParent(byRef, allowedTypes)) return byRef;
  }
  if (input.parentEntityId) {
    const byId = findEntityById(deps, input.parentEntityId, allowedTypes);
    if (isAllowedParent(byId, allowedTypes)) return byId;
  }
  for (const entityId of input.evidence.entityIds) {
    const byId = findEntityById(deps, entityId, allowedTypes);
    if (isAllowedParent(byId, allowedTypes)) return byId;
  }
  return null;
}

export function findEntityById(
  deps: MaterializeDeps,
  entityId: string,
  allowedTypes: readonly string[],
): IndexEntityRow | undefined {
  for (const type of allowedTypes) {
    const found = deps.index.entitiesByType.get(type as ProposeEntityType)?.find((entity) => entity.id === entityId);
    if (found) return found;
  }
  return undefined;
}

export function isAllowedParent(
  entity: IndexEntityRow | undefined,
  allowedTypes: readonly string[],
): entity is IndexEntityRow {
  return Boolean(entity && entity.id !== TEST_ACCOUNT_ENTITY_ID && allowedTypes.includes(entity.source_type));
}

interface CommitmentInput extends SubEntityParentInput {
  commitmentId: string;
  title: string;
  status: "open" | "done" | "dropped";
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
}

function readCommitment(raw: Record<string, unknown>): CommitmentInput | null {
  if (
    typeof raw.commitmentId !== "string" ||
    typeof raw.title !== "string" ||
    (raw.status !== "open" && raw.status !== "done" && raw.status !== "dropped") ||
    !isEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    commitmentId: raw.commitmentId,
    parentRef: readParentRef(raw.parentRef),
    parentEntityId: readOptionalString(raw.parentEntityId),
    title: raw.title,
    status: raw.status,
    dueAt: readOptionalString(raw.dueAt),
    evidence: { fileIds: raw.evidence.fileIds, entityIds: raw.evidence.entityIds },
  };
}

function readParentRef(value: unknown): { source: string; sourceId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.sourceId !== "string") return undefined;
  return { source: record.source, sourceId: record.sourceId };
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

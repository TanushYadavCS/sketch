import { createSubEntityRepository } from "../db/repositories/sub-entities";
import { type SubEntityParentInput, resolveParent } from "./materialize-commitment";
import { resolveEffectiveAt } from "./materialize-effective-time";
import { readJsonObject } from "./materialize-json";
import type { IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { valueSignatureForParts } from "./sub-entity-signatures";

export async function materializeMilestone(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const milestone = readMilestone(raw);
  if (!milestone) return { kind: "skipped", reason: "invalid_milestone" };

  const parent = resolveParent(deps, milestone, ["project"]);
  if (!parent) return { kind: "skipped", reason: "missing_milestone_parent" };
  const effectiveAt = await resolveEffectiveAt(deps, fact, milestone.observedAt);
  if (!effectiveAt) return { kind: "skipped", reason: "missing_milestone_effective_time" };

  const repo = createSubEntityRepository(deps.db);
  const result = await repo.supersedeSubEntity({
    parentEntityId: parent.id,
    kind: "milestone",
    dedupName: milestone.milestoneName,
    displayName: milestone.milestoneName,
    status: milestone.status,
    dueAt: milestone.dueAt,
    valueSignature: valueSignatureForParts([milestone.status, milestone.dueAt]),
    provenance: fact.source === "llm" ? "corroborated_llm" : "structural",
    sourceFactId: fact.id,
    effectiveAt,
  });
  await repo.upsertSubEntityEvidence(result.subEntityId, "fact", fact.id);
  for (const fileId of milestone.evidence.fileIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "file", fileId);
  }
  for (const entityId of milestone.evidence.entityIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "entity", entityId);
  }
  return { kind: "milestone_materialized" };
}

interface MilestoneInput extends SubEntityParentInput {
  milestoneId: string;
  milestoneName: string;
  status: "planned" | "hit" | "missed";
  dueAt: string;
  observedAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
}

function readMilestone(raw: Record<string, unknown>): MilestoneInput | null {
  if (
    typeof raw.milestoneId !== "string" ||
    typeof raw.milestoneName !== "string" ||
    (raw.status !== "planned" && raw.status !== "hit" && raw.status !== "missed") ||
    typeof raw.dueAt !== "string" ||
    !isEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    milestoneId: raw.milestoneId,
    milestoneName: raw.milestoneName,
    parentRef: readParentRef(raw.parentRef),
    parentEntityId: readOptionalString(raw.parentEntityId),
    status: raw.status,
    dueAt: raw.dueAt,
    observedAt: readOptionalString(raw.observedAt),
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

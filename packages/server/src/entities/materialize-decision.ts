import { createSubEntityRepository } from "../db/repositories/sub-entities";
import { resolveParent } from "./materialize-commitment";
import { readJsonObject } from "./materialize-json";
import type { IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

export async function materializeDecision(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!deps.experimentalFlag) return { kind: "skipped", reason: "experimental_off" };
  const raw = readJsonObject(fact.raw);
  const decision = readDecision(raw);
  if (!decision) return { kind: "skipped", reason: "invalid_decision" };

  const parent = resolveParent(deps, decision);
  if (!parent) return { kind: "skipped", reason: "missing_decision_parent" };
  const effectiveAt = await resolveEffectiveAt(deps, fact, decision);
  if (!effectiveAt) return { kind: "skipped", reason: "missing_decision_effective_time" };

  const repo = createSubEntityRepository(deps.db);
  const result = await repo.supersedeSubEntity({
    parentEntityId: parent.id,
    kind: "decision",
    dedupName: decision.topic,
    displayName: decision.statement,
    provenance: fact.source === "llm" ? "corroborated_llm" : "structural",
    metadata: {
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      rationale: decision.rationale,
    },
    sourceFactId: fact.id,
    effectiveAt,
  });
  await repo.upsertSubEntityEvidence(result.subEntityId, "fact", fact.id);
  for (const fileId of decision.evidence.fileIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "file", fileId);
  }
  for (const entityId of decision.evidence.entityIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "entity", entityId);
  }
  return { kind: "decision_materialized" };
}

async function resolveEffectiveAt(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  decision: DecisionInput,
): Promise<string | null> {
  const sourceTimes = fact.indexed_file_id ? await deps.getIndexedFileSourceTime(fact.indexed_file_id) : null;
  const value =
    decision.decidedAt ?? sourceTimes?.source_updated_at ?? sourceTimes?.source_created_at ?? sourceTimes?.synced_at;
  if (!value) return null;
  return new Date(value).toISOString();
}

interface DecisionInput {
  decisionId: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  topic: string;
  statement: string;
  decidedBy?: string;
  decidedAt?: string;
  rationale?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
}

function readDecision(raw: Record<string, unknown>): DecisionInput | null {
  if (
    typeof raw.decisionId !== "string" ||
    typeof raw.topic !== "string" ||
    typeof raw.statement !== "string" ||
    !isEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    decisionId: raw.decisionId,
    parentRef: readParentRef(raw.parentRef),
    parentEntityId: readOptionalString(raw.parentEntityId),
    topic: raw.topic,
    statement: raw.statement,
    decidedBy: readOptionalString(raw.decidedBy),
    decidedAt: readOptionalString(raw.decidedAt),
    rationale: readOptionalString(raw.rationale),
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

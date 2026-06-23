import { createSubEntityRepository } from "../db/repositories/sub-entities";
import { type SubEntityParentInput, resolveParent } from "./materialize-commitment";
import { readJsonObject } from "./materialize-json";
import type { IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

export async function materializeFeature(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!deps.experimentalFlag) return { kind: "skipped", reason: "experimental_off" };
  const raw = readJsonObject(fact.raw);
  const feature = readFeature(raw);
  if (!feature) return { kind: "skipped", reason: "invalid_feature" };

  const parent = resolveParent(deps, feature, ["product"]);
  if (!parent) return { kind: "skipped", reason: "missing_feature_parent" };

  const repo = createSubEntityRepository(deps.db);
  const result = await repo.upsertSubEntity({
    parentEntityId: parent.id,
    kind: "feature",
    dedupName: feature.featureName,
    displayName: feature.featureName,
    status: feature.status,
    provenance: fact.source === "llm" ? "corroborated_llm" : "structural",
    dueAt: feature.dueAt ?? null,
    ownerUserId: deps.resolveOwner(fact),
    sourceFactId: fact.id,
  });
  await repo.upsertSubEntityEvidence(result.subEntityId, "fact", fact.id);
  for (const fileId of feature.evidence.fileIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "file", fileId);
  }
  for (const entityId of feature.evidence.entityIds) {
    await repo.upsertSubEntityEvidence(result.subEntityId, "entity", entityId);
  }
  return { kind: "feature_materialized" };
}

interface FeatureInput extends SubEntityParentInput {
  featureId: string;
  featureName: string;
  status: "proposed" | "building" | "shipped" | "deprecated";
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
}

function readFeature(raw: Record<string, unknown>): FeatureInput | null {
  if (
    typeof raw.featureId !== "string" ||
    typeof raw.featureName !== "string" ||
    (raw.status !== "proposed" &&
      raw.status !== "building" &&
      raw.status !== "shipped" &&
      raw.status !== "deprecated") ||
    !isEvidence(raw.evidence)
  ) {
    return null;
  }
  return {
    featureId: raw.featureId,
    featureName: raw.featureName,
    parentRef: readParentProductRef(raw.parentProductRef),
    parentEntityId: readOptionalString(raw.parentEntityId),
    status: raw.status,
    dueAt: readOptionalString(raw.dueAt),
    evidence: { fileIds: raw.evidence.fileIds, entityIds: raw.evidence.entityIds },
  };
}

function readParentProductRef(value: unknown): { source: string; sourceId: string } | undefined {
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

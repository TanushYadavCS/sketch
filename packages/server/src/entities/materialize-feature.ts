import { normalizeName } from "../connectors/name-normalize";
import { type SubEntityRow, createSubEntityRepository } from "../db/repositories/sub-entities";
import { type SubEntityParentInput, resolveParent } from "./materialize-commitment";
import { readJsonObject } from "./materialize-json";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

export async function materializeFeature(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!deps.experimentalFlag) return { kind: "skipped", reason: "experimental_off" };
  const raw = readJsonObject(fact.raw);
  const feature = readFeature(raw);
  if (!feature) return { kind: "skipped", reason: "invalid_feature" };

  if (isLlmFeatureSource(fact.source)) {
    if (!feature.corroborationKey) return { kind: "skipped", reason: "invalid_feature" };
    const result = await reconcileFeatureSubEntity(deps, feature.corroborationKey);
    return result.materialized
      ? { kind: "feature_materialized" }
      : { kind: "deferred_below_threshold", reason: "feature_ungated" };
  }

  const parent = resolveParent(deps, feature, ["product"]);
  if (!parent) return { kind: "skipped", reason: "missing_feature_parent" };

  const repo = createSubEntityRepository(deps.db);
  const result = await repo.upsertSubEntity({
    parentEntityId: parent.id,
    kind: "feature",
    dedupName: feature.featureName,
    displayName: feature.featureName,
    status: feature.status,
    provenance: featureProvenance(fact.source),
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

export async function reconcileFeatureSubEntity(
  deps: MaterializeDeps,
  corroborationKey: string,
): Promise<{ support: number; materialized: boolean; subEntityId?: string }> {
  if (!deps.experimentalFlag) return { support: 0, materialized: false };
  const entries = await loadCorroboratingFeatureFacts(deps, corroborationKey);
  const support = distinctIndexedFileCount(entries);
  if (support >= deps.llmPromotionThreshold) {
    const supported = resolveSupportedFeature(deps, entries);
    if (!supported) {
      await closeCurrentFeatureSubEntity(deps, corroborationKey, null);
      return { support, materialized: false };
    }
    const repo = createSubEntityRepository(deps.db);
    const result = await repo.upsertSubEntity({
      parentEntityId: supported.parent.id,
      kind: "feature",
      dedupName: supported.feature.featureName,
      displayName: supported.feature.featureName,
      status: supported.feature.status,
      provenance: "corroborated_llm",
      dueAt: supported.feature.dueAt ?? null,
      ownerUserId: deps.resolveOwner(supported.fact),
      sourceFactId: supported.fact.id,
      metadata: { corroborationKey },
    });
    await replaceCurrentEvidence(deps, result.subEntityId, evidenceForEntries(entries, supported.parent.id));
    return { support, materialized: true, subEntityId: result.subEntityId };
  }

  const supported = resolveSupportedFeature(deps, entries);
  await closeCurrentFeatureSubEntity(deps, corroborationKey, supported);
  return { support, materialized: false };
}

interface FeatureInput extends SubEntityParentInput {
  featureId: string;
  featureName: string;
  corroborationKey?: string;
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
    corroborationKey: readOptionalString(raw.corroborationKey),
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

function featureProvenance(source: string): string {
  return isLlmFeatureSource(source) ? "corroborated_llm" : "structural";
}

function isLlmFeatureSource(source: string): boolean {
  return source === "llm_extraction" || source === "llm";
}

async function loadCorroboratingFeatureFacts(
  deps: MaterializeDeps,
  corroborationKey: string,
): Promise<Array<{ fact: IndexedFileFactRow; feature: FeatureInput }>> {
  const rows = await deps.db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("fact_type", "=", "feature")
    .where("deleted_at", "is", null)
    .orderBy("updated_at", "desc")
    .execute();
  const out: Array<{ fact: IndexedFileFactRow; feature: FeatureInput }> = [];
  for (const row of rows) {
    if (!isLlmFeatureSource(row.source)) continue;
    const feature = readFeature(readJsonObject(row.raw));
    if (feature?.corroborationKey === corroborationKey) out.push({ fact: row, feature });
  }
  return out;
}

function distinctIndexedFileCount(entries: Array<{ fact: IndexedFileFactRow }>): number {
  return new Set(entries.map((entry) => entry.fact.indexed_file_id).filter((id): id is string => Boolean(id))).size;
}

function resolveSupportedFeature(
  deps: MaterializeDeps,
  entries: Array<{ fact: IndexedFileFactRow; feature: FeatureInput }>,
): { fact: IndexedFileFactRow; feature: FeatureInput; parent: EntityRow } | null {
  for (const entry of entries) {
    const parent = resolveParent(deps, entry.feature, ["product"]);
    if (parent) return { ...entry, parent };
  }
  return null;
}

function evidenceForEntries(
  entries: Array<{ fact: IndexedFileFactRow; feature: FeatureInput }>,
  parentEntityId: string,
): Array<{ kind: string; refId: string }> {
  const factIds = entries.map((entry) => entry.fact.id);
  const indexedFileIds = entries.map((entry) => entry.fact.indexed_file_id).filter((id): id is string => Boolean(id));
  const fileIds = entries.flatMap((entry) => entry.feature.evidence.fileIds);
  const entityIds = entries.flatMap((entry) => entry.feature.evidence.entityIds);
  return [
    ...[...new Set(factIds)].map((refId) => ({ kind: "fact", refId })),
    ...[...new Set([...indexedFileIds, ...fileIds])].map((refId) => ({ kind: "file", refId })),
    ...[...new Set([parentEntityId, ...entityIds])].map((refId) => ({ kind: "entity", refId })),
  ];
}

async function replaceCurrentEvidence(
  deps: MaterializeDeps,
  subEntityId: string,
  evidence: Array<{ kind: string; refId: string }>,
): Promise<void> {
  await deps.db.deleteFrom("sub_entity_evidence").where("sub_entity_id", "=", subEntityId).execute();
  const repo = createSubEntityRepository(deps.db);
  for (const edge of evidence) {
    await repo.upsertSubEntityEvidence(subEntityId, edge.kind, edge.refId);
  }
}

async function closeCurrentFeatureSubEntity(
  deps: MaterializeDeps,
  corroborationKey: string,
  supported: { feature: FeatureInput; parent: EntityRow } | null,
): Promise<void> {
  const current = supported
    ? await findCurrentFeatureByParentAndName(
        deps,
        supported.parent.id,
        supported.feature.featureName,
        corroborationKey,
      )
    : await findCurrentFeatureByCorroborationKey(deps, corroborationKey);
  if (!current?.parent_entity_id) return;
  const repo = createSubEntityRepository(deps.db);
  await repo.supersedeSubEntity({
    parentEntityId: current.parent_entity_id,
    kind: "feature",
    dedupName: current.display_name,
    displayName: current.display_name,
    provenance: current.provenance,
    sourceFactId: current.source_fact_id,
    effectiveAt: new Date().toISOString(),
    closeOnly: true,
  });
  await deps.db.deleteFrom("sub_entity_evidence").where("sub_entity_id", "=", current.id).execute();
}

async function findCurrentFeatureByParentAndName(
  deps: MaterializeDeps,
  parentEntityId: string,
  featureName: string,
  corroborationKey: string,
): Promise<SubEntityRow | undefined> {
  const row = await deps.db
    .selectFrom("sub_entities")
    .selectAll()
    .where("parent_scope_key", "=", parentEntityId)
    .where("kind", "=", "feature")
    .where("normalized_name", "=", normalizeName(featureName))
    .where("valid_to", "is", null)
    .executeTakeFirst();
  if (row && readMetadataCorroborationKey(row.metadata_json) === corroborationKey) return row;
  return findCurrentFeatureByCorroborationKey(deps, corroborationKey);
}

async function findCurrentFeatureByCorroborationKey(
  deps: MaterializeDeps,
  corroborationKey: string,
): Promise<SubEntityRow | undefined> {
  const rows = await deps.db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "feature")
    .where("valid_to", "is", null)
    .execute();
  return rows.find((row) => readMetadataCorroborationKey(row.metadata_json) === corroborationKey);
}

function readMetadataCorroborationKey(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { corroborationKey?: unknown };
    return typeof parsed.corroborationKey === "string" ? parsed.corroborationKey : null;
  } catch {
    return null;
  }
}

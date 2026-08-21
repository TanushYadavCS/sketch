import {
  type EntityGraphRelationEndpoint,
  coerceMentionType,
  isHighConfidenceEndpoint,
  isHighConfidenceRelation,
  normalizeMentionType,
  normalizeRelationEndpointType,
  normalizeRelationType,
  relationDirectionAllowed,
} from "./graph";
import { registerEntity } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { normalizeEntityMatchName } from "./name-keys";
import { proposeEntity } from "./propose";

interface CrmRelationEndpoint {
  source: string;
  sourceId: string;
  name: string;
  type: EntityGraphRelationEndpoint["type"];
}

export async function materializeLlmRelationFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const relationType = normalizeRelationType(raw.relationType ?? fact.relation);
  const source = readCoercedRelationEndpoint(raw, "source");
  const target = readCoercedRelationEndpoint(raw, "target");
  const confidenceScore = typeof raw.confidence === "number" ? raw.confidence : 0;
  const sourceConfidence = typeof raw.sourceConfidence === "number" ? raw.sourceConfidence : 0;
  const targetConfidence = typeof raw.targetConfidence === "number" ? raw.targetConfidence : 0;
  if (!relationType || !source || !target) return { kind: "skipped", reason: "invalid_llm_relation" };
  if (deps.birthGateTypes.has("team") && (source.type === "team" || target.type === "team")) {
    return { kind: "skipped", reason: "team_conversational_birth_gated" };
  }
  if (!isHighConfidenceRelation(confidenceScore)) return { kind: "skipped", reason: "low_confidence_relation" };
  if (!isHighConfidenceEndpoint(sourceConfidence) || !isHighConfidenceEndpoint(targetConfidence)) {
    return { kind: "skipped", reason: "low_endpoint_confidence" };
  }
  if (!relationDirectionAllowed(relationType, source.type, target.type)) {
    return { kind: "skipped", reason: "invalid_relation_direction" };
  }
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const linkOnly = fact.indexed_file_id ? await deps.isChatConversationSliceFile(fact.indexed_file_id) : false;

  const sourceResult = await materializeRelationEndpoint(deps, fact, source, triggeredByUserId, "source", { linkOnly });
  if (sourceResult.kind === "suppressed_endpoint") return { kind: "skipped", reason: "relation_endpoint_suppressed" };
  if (sourceResult.kind === "queued_held") return sourceResult;
  const targetResult = await materializeRelationEndpoint(deps, fact, target, triggeredByUserId, "target", { linkOnly });
  if (targetResult.kind === "suppressed_endpoint") return { kind: "skipped", reason: "relation_endpoint_suppressed" };
  if (targetResult.kind === "queued_held") return targetResult;
  if (sourceResult.entity.id === targetResult.entity.id) return { kind: "skipped", reason: "self_relation" };

  let relationshipsWritten = 0;
  const relationshipId = await deps.domainsRepo.upsertRelationship({
    sourceEntityId: sourceResult.entity.id,
    targetEntityId: targetResult.entity.id,
    relationshipType: relationType,
    confidence: "EXTRACTED",
    confidenceScore,
    source: "llm_extraction",
  });
  if (!relationshipId) return { kind: "skipped", reason: "relationship_would_cycle" };
  relationshipsWritten++;
  if (fact.indexed_file_id) {
    await deps.domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: fact.indexed_file_id,
      chunkIndex: 0,
      note: `llm_relation:${relationType}`,
      sourceFactId: fact.id,
    });
  }
  if (relationType === "partner_of") {
    const reverseId = await deps.domainsRepo.upsertRelationship({
      sourceEntityId: targetResult.entity.id,
      targetEntityId: sourceResult.entity.id,
      relationshipType: relationType,
      confidence: "EXTRACTED",
      confidenceScore,
      source: "llm_extraction",
    });
    if (reverseId) {
      relationshipsWritten++;
    }
    if (reverseId && fact.indexed_file_id) {
      await deps.domainsRepo.addEvidence({
        relationshipId: reverseId,
        indexedFileId: fact.indexed_file_id,
        chunkIndex: 0,
        note: `llm_relation:${relationType}`,
        sourceFactId: fact.id,
      });
    }
  }

  let mentionsWritten = 0;
  if (fact.indexed_file_id) {
    await createMentionFromFact(deps, {
      entityId: sourceResult.entity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "llm_relation",
      relation: "mentioned",
    });
    await createMentionFromFact(deps, {
      entityId: targetResult.entity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "llm_relation",
      relation: "mentioned",
    });
    mentionsWritten = 2;
  }

  return {
    kind: "relationship_materialized",
    entitiesCreated: Number(sourceResult.created) + Number(targetResult.created),
    entitiesLinked: Number(!sourceResult.created) + Number(!targetResult.created),
    mentionsWritten,
    relationshipsWritten,
  };
}

export async function materializeCrmRelationFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const relationType = normalizeRelationType(raw.relationType ?? fact.relation);
  const source = readCrmRelationEndpoint(raw, "source");
  const target = readCrmRelationEndpoint(raw, "target");
  if (!relationType || !source || !target) return { kind: "skipped", reason: "invalid_crm_relation" };
  if (!relationDirectionAllowed(relationType, source.type, target.type)) {
    return { kind: "skipped", reason: "invalid_relation_direction" };
  }

  const sourceEntity = await resolveCrmEndpoint(deps, source);
  const targetEntity = await resolveCrmEndpoint(deps, target);
  if (!sourceEntity || !targetEntity) return { kind: "skipped", reason: "missing_crm_relation_endpoint" };
  if (sourceEntity.id === targetEntity.id) return { kind: "skipped", reason: "self_relation" };

  const relationshipId = await deps.domainsRepo.upsertRelationship({
    sourceEntityId: sourceEntity.id,
    targetEntityId: targetEntity.id,
    relationshipType: relationType,
    confidence: "EXTRACTED",
    confidenceScore: 1,
    source: fact.source,
  });
  if (!relationshipId) return { kind: "skipped", reason: "relationship_would_cycle" };

  if (fact.indexed_file_id) {
    await deps.domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: fact.indexed_file_id,
      chunkIndex: 0,
      note: `crm_relation:${relationType}`,
      sourceFactId: fact.id,
    });
    await createMentionFromFact(deps, {
      entityId: sourceEntity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "crm_relation",
      relation: "mentioned",
    });
    await createMentionFromFact(deps, {
      entityId: targetEntity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "crm_relation",
      relation: "mentioned",
    });
  }

  return {
    kind: "relationship_materialized",
    entitiesCreated: 0,
    entitiesLinked: 2,
    mentionsWritten: fact.indexed_file_id ? 2 : 0,
    relationshipsWritten: 1,
  };
}

function readCrmRelationEndpoint(raw: Record<string, unknown>, key: "source" | "target"): CrmRelationEndpoint | null {
  const endpoint = raw[key];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return null;
  const record = endpoint as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.sourceId !== "string" || typeof record.name !== "string") {
    return null;
  }
  const type = normalizeRelationEndpointType(record.type);
  if (!type) return null;
  return { source: record.source, sourceId: record.sourceId, name: record.name, type };
}

function readCoercedRelationEndpoint(
  raw: Record<string, unknown>,
  key: "source" | "target",
): EntityGraphRelationEndpoint | null {
  const endpoint = raw[key];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return null;
  const record = endpoint as Record<string, unknown>;
  if (typeof record.name !== "string") return null;
  const coercedType = coerceMentionType(record.name, String(record.type ?? ""));
  const type = normalizeRelationEndpointType(coercedType);
  if (!type) return null;
  const variations = Array.isArray(record.variations)
    ? record.variations.filter((value): value is string => typeof value === "string")
    : [];
  return { name: record.name, type, variations };
}

async function resolveCrmEndpoint(
  deps: MaterializeDeps,
  endpoint: CrmRelationEndpoint,
): Promise<IndexEntityRow | null> {
  const refKey = `${endpoint.source}:${endpoint.sourceId}`;
  const cached = deps.index.bySourceRef.get(refKey);
  if (cached) return cached;
  const found = await deps.entityRepo.getEntityBySourceRef(endpoint.source, endpoint.sourceId);
  if (!found) return null;
  const entity = found;
  deps.index.bySourceRef.set(refKey, entity);
  registerEntity(deps.index, entity);
  return entity;
}

async function materializeRelationEndpoint(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  endpoint: EntityGraphRelationEndpoint,
  triggeredByUserId: string,
  role: "source" | "target",
  options: { linkOnly?: boolean } = {},
): Promise<
  | { kind: "resolved"; entity: IndexEntityRow; created: boolean }
  | { kind: "queued_held"; reviewId: string; reason: "relation_endpoint" }
  | { kind: "suppressed_endpoint" }
> {
  const raw = readJsonObject(fact.raw);
  const coercedType = normalizeMentionType(coerceMentionType(endpoint.name, endpoint.type));
  if (coercedType === "tool") return { kind: "suppressed_endpoint" };
  const normalized = normalizeEntityMatchName(endpoint.type, endpoint.name);
  if (await deps.suppressionRepo.isSuppressed(normalized, endpoint.type)) {
    return { kind: "suppressed_endpoint" };
  }
  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      domainsRepo: deps.domainsRepo,
      lookup: deps.lookup,
      logger: deps.logger,
      birthGateTypes: deps.birthGateTypes,
      birthGateLiveTypes: deps.birthGateLiveTypes,
      birthGateDryRun: deps.birthGateDryRun,
      readEmail: deps.readEmail,
      onEntityResolved: deps.onEntityResolved,
    },
    {
      name: endpoint.name,
      entityType: endpoint.type,
      subtype: "external",
      source: "llm_relation",
      sourceId: options.linkOnly
        ? `${fact.indexed_file_id ?? "no-file"}:${role}:${endpoint.name}`
        : `${fact.indexed_file_id ?? "no-file"}:${fact.content_hash ?? "no-hash"}:${role}:${endpoint.name}`,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      aliases: endpoint.variations,
      metadata: { origin: "ai", relationEndpoint: true },
      provenanceTier: "inferred",
      evidenceDomain: typeof raw.evidenceDomain === "string" ? raw.evidenceDomain : null,
      linkOnly: options.linkOnly,
      queueInsteadOfCreate:
        endpoint.type === "project" || (endpoint.type === "product" && deps.birthGateTypes.has("product")),
    },
  );
  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "relation_endpoint" };
  }
  if (result.kind === "suppressed") return { kind: "suppressed_endpoint" };
  const entity = result.entity;
  registerEntity(deps.index, entity);
  return { kind: "resolved", entity, created: result.kind === "created" };
}

import {
  type EntityGraphRelationEndpoint,
  isHighConfidenceEndpoint,
  isHighConfidenceRelation,
  normalizeRelationType,
  readRelationEndpoint,
  relationDirectionAllowed,
} from "./graph";
import { registerEntity } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { proposeEntity } from "./propose";

export async function materializeLlmRelationFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const relationType = normalizeRelationType(raw.relationType ?? fact.relation);
  const source = readRelationEndpoint(raw, "source");
  const target = readRelationEndpoint(raw, "target");
  const confidenceScore = typeof raw.confidence === "number" ? raw.confidence : 0;
  const sourceConfidence = typeof raw.sourceConfidence === "number" ? raw.sourceConfidence : 0;
  const targetConfidence = typeof raw.targetConfidence === "number" ? raw.targetConfidence : 0;
  if (!relationType || !source || !target) return { kind: "skipped", reason: "invalid_llm_relation" };
  if (!isHighConfidenceRelation(confidenceScore)) return { kind: "skipped", reason: "low_confidence_relation" };
  if (!isHighConfidenceEndpoint(sourceConfidence) || !isHighConfidenceEndpoint(targetConfidence)) {
    return { kind: "skipped", reason: "low_endpoint_confidence" };
  }
  if (!relationDirectionAllowed(relationType, source.type, target.type)) {
    return { kind: "skipped", reason: "invalid_relation_direction" };
  }
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const sourceResult = await materializeRelationEndpoint(deps, fact, source, triggeredByUserId, "source");
  if (sourceResult.kind === "queued_held") return sourceResult;
  const targetResult = await materializeRelationEndpoint(deps, fact, target, triggeredByUserId, "target");
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
    relationshipsWritten++;
    if (fact.indexed_file_id) {
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

async function materializeRelationEndpoint(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  endpoint: EntityGraphRelationEndpoint,
  triggeredByUserId: string,
  role: "source" | "target",
): Promise<
  | { kind: "resolved"; entity: EntityRow; created: boolean }
  | { kind: "queued_held"; reviewId: string; reason: "relation_endpoint" }
> {
  const raw = readJsonObject(fact.raw);
  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      lookup: deps.lookup,
      readEmail: deps.readEmail,
    },
    {
      name: endpoint.name,
      entityType: endpoint.type,
      subtype: "external",
      source: "llm_relation",
      sourceId: `${fact.indexed_file_id ?? "no-file"}:${fact.content_hash ?? "no-hash"}:${role}:${endpoint.name}`,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      aliases: endpoint.variations,
      metadata: { origin: "ai", relationEndpoint: true },
      evidenceDomain: typeof raw.evidenceDomain === "string" ? raw.evidenceDomain : null,
    },
  );
  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "relation_endpoint" };
  }
  const entity = result.entity as unknown as EntityRow;
  registerEntity(deps.index, entity);
  return { kind: "resolved", entity, created: result.kind === "created" };
}

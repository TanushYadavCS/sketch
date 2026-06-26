import { type NonPersonMentionType, coerceMentionType, normalizeMentionType } from "./graph";
import { normalizeEntityMatchName, registerEntity } from "./materialize-deps";
import { isString, readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import { materializePersonFact } from "./materialize-person";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { proposeEntity } from "./propose";

export async function materializeLlmExtractedFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  if (!fact.subject_name) {
    return { kind: "skipped", reason: "missing_llm_subject" };
  }
  const raw = readJsonObject(fact.raw);
  const mentionType = normalizeMentionType(
    coerceMentionType(fact.subject_name, String(raw.type ?? ""), deps.experimentalFlag),
  );
  if (!mentionType) {
    return { kind: "skipped", reason: "missing_or_invalid_mention_type" };
  }
  if (mentionType === "team" && deps.birthGateTypes.has("team") && !deps.birthGateDryRun) {
    return { kind: "skipped", reason: "team_conversational_birth_gated" };
  }
  const normalized = normalizeEntityMatchName(mentionType, fact.subject_name);
  if (!normalized) {
    return { kind: "skipped", reason: "missing_llm_subject" };
  }
  const fileCount = await deps.countActiveLlmFilesForName(normalized, mentionType);
  if (fileCount < deps.llmPromotionThreshold) {
    return { kind: "deferred_below_threshold", reason: "below_promotion_threshold" };
  }

  if (mentionType === "person") {
    return materializePersonFact(deps, fact);
  }
  return materializeNonPersonLlmEntity(deps, fact, mentionType);
}

export async function materializeNonPersonLlmEntity(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  sourceType: NonPersonMentionType,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const variations = Array.isArray(raw.variations) ? raw.variations.filter(isString) : [];
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) {
    return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };
  }

  const normalizedName = normalizeEntityMatchName(sourceType, fact.subject_name as string);
  if (await deps.suppressionRepo.isSuppressed(normalizedName, sourceType)) {
    return { kind: "skipped", reason: "creation_suppressed" };
  }

  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      domainsRepo: deps.domainsRepo,
      lookup: deps.lookup,
      logger: deps.logger,
      birthGateTypes: deps.birthGateTypes,
      birthGateDryRun: deps.birthGateDryRun,
      readEmail: deps.readEmail,
      onEntityResolved: deps.onEntityResolved,
    },
    {
      name: fact.subject_name as string,
      entityType: sourceType,
      subtype: "external",
      source: "llm_extraction",
      sourceId: fact.subject_source_id ?? `${fact.indexed_file_id ?? "no-file"}:${fact.subject_name}`,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      aliases: variations,
      metadata: { origin: "ai" },
      provenanceTier: "inferred",
      evidenceDomain: typeof raw.evidenceDomain === "string" ? raw.evidenceDomain : null,
    },
  );

  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "non_person_collision" };
  }

  const entity = result.entity as unknown as EntityRow;
  const created = result.kind === "created";
  registerEntity(deps.index, entity);

  if (!fact.indexed_file_id) {
    return { kind: created ? "entity_created" : "entity_linked", entity, mentionWritten: false };
  }
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "INFERRED",
    source: "llm_extraction",
    relation: "mentioned",
  });
  return {
    kind: created ? "entity_created" : "entity_linked",
    entity,
    mentionWritten: true,
  };
}

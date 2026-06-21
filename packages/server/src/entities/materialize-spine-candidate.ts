import { normalizeEntityMatchName, registerEntity } from "./materialize-deps";
import { createMentionFromFact } from "./materialize-mentions";
import { buildSeedProvenanceNote, isProjectCandidateSeed } from "./materialize-structural-gate";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import type { ProposeEntityType } from "./propose";

export function canonicalSpineTypeForStructuralSource(sourceType: string): ProposeEntityType | null {
  if (sourceType === "project" || isProjectCandidateSeed(sourceType)) return "project";
  if (sourceType === "team") return "team";
  if (sourceType === "product") return "product";
  return null;
}

export async function materializeSpineCandidate(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  args: {
    subjectSource: string;
    subjectSourceId: string;
    sourceType: string;
    sourceUrl?: string;
    raw: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    forceQueue?: boolean;
  },
): Promise<MaterializeResult> {
  const spineType = canonicalSpineTypeForStructuralSource(args.sourceType);
  if (!spineType) {
    const entity = (await deps.entityRepo.upsertEntityFromTool({
      name: fact.subject_name as string,
      sourceType: args.sourceType,
      source: args.subjectSource,
      sourceId: args.subjectSourceId,
      sourceUrl: args.sourceUrl,
      sourceRefId: fact.indexed_file_id ?? undefined,
      metadata: args.metadata,
    })) as unknown as EntityRow;
    registerEntity(deps.index, entity);
    deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
    return { kind: "structural", entity };
  }

  const existing = await deps.entityRepo.getEntityBySourceRef(args.subjectSource, args.subjectSourceId);
  if (existing && existing.source_type === spineType) {
    const entity = existing as unknown as EntityRow;
    if (fact.indexed_file_id) {
      await createMentionFromFact(deps, {
        entityId: entity.id,
        indexedFileId: fact.indexed_file_id,
        contextSnippet: fact.context_snippet ?? null,
        confidence: "EXTRACTED",
        source: `${fact.source}_structural_seed`,
        relation: "mentioned",
      });
    }
    deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
    return { kind: "entity_linked", entity, mentionWritten: Boolean(fact.indexed_file_id), countEntity: false };
  }

  if (spineType === "project" && existing && isProjectCandidateSeed(existing.source_type)) {
    const entity = await promoteLegacyProjectContainer(deps, existing as unknown as EntityRow, fact, args.metadata);
    if (fact.indexed_file_id) {
      await createMentionFromFact(deps, {
        entityId: entity.id,
        indexedFileId: fact.indexed_file_id,
        contextSnippet: fact.context_snippet ?? null,
        confidence: "EXTRACTED",
        source: `${fact.source}_structural_seed`,
        relation: "mentioned",
      });
    }
    deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
    return { kind: "entity_linked", entity, mentionWritten: Boolean(fact.indexed_file_id), countEntity: false };
  }

  if (args.forceQueue || deps.birthGateTypes.has(spineType)) {
    const owner = deps.resolveOwner(fact);
    if (!owner) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

    const subjectName = fact.subject_name as string;
    const { row, skipEvidence } = await deps.reviewRepo.upsertSeedReviewRow({
      proposedName: subjectName,
      normalizedName: normalizeEntityMatchName(spineType, subjectName),
      entityType: spineType,
      seedSource: args.subjectSource,
      seedSourceId: args.subjectSourceId,
      candidateEntityId: null,
      triggeredByUserId: owner,
      metadata: args.metadata,
    });

    if (skipEvidence) {
      return { kind: "skipped", reason: row.status === "rejected" ? "seed_durably_rejected" : "seed_already_resolved" };
    }

    if (fact.indexed_file_id) {
      await deps.reviewRepo.upsertEvidence({
        reviewId: row.id,
        indexedFileId: fact.indexed_file_id,
        source: `${fact.source}_structural_seed`,
        note: buildSeedProvenanceNote(args.raw, args.sourceType),
      });
    }
    return { kind: "queued", reviewId: row.id };
  }

  const entity = (await deps.entityRepo.upsertEntityFromTool({
    name: fact.subject_name as string,
    sourceType: spineType,
    source: args.subjectSource,
    sourceId: args.subjectSourceId,
    sourceUrl: args.sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata: args.metadata,
  })) as unknown as EntityRow;
  registerEntity(deps.index, entity);
  deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
  return { kind: "structural", entity };
}

async function promoteLegacyProjectContainer(
  deps: MaterializeDeps,
  existing: EntityRow,
  fact: IndexedFileFactRow,
  metadata?: Record<string, unknown>,
): Promise<EntityRow> {
  const now = new Date().toISOString();
  const nextMetadata = metadata ? JSON.stringify(metadata) : existing.metadata;
  await deps.db
    .updateTable("entities")
    .set({
      name: fact.subject_name ?? existing.name,
      source_type: "project",
      metadata: nextMetadata,
      updated_at: now,
    })
    .where("id", "=", existing.id)
    .execute();
  return {
    ...existing,
    name: fact.subject_name ?? existing.name,
    source_type: "project",
    metadata: nextMetadata,
    updated_at: now,
  };
}

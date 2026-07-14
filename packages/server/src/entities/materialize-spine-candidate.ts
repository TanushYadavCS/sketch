import { deriveQualifiedSeedName } from "../connectors/container-name";
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
    const entity = await upsertEntityFromSeed(deps, {
      name: fact.subject_name as string,
      sourceType: args.sourceType,
      source: args.subjectSource,
      sourceId: args.subjectSourceId,
      sourceUrl: args.sourceUrl,
      sourceRefId: fact.indexed_file_id ?? undefined,
      metadata: args.metadata,
      aliases: extractSeedAliases(args.raw),
    });
    deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
    return { kind: "structural", entity };
  }

  const existing = await deps.entityRepo.getEntityBySourceRef(args.subjectSource, args.subjectSourceId);
  if (existing && existing.source_type === spineType) {
    const entity = await applySeedAliases(deps, existing, extractSeedAliases(args.raw));
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
    const entity = await applySeedAliases(
      deps,
      await promoteLegacyProjectContainer(deps, existing, fact, args.metadata),
      extractSeedAliases(args.raw),
    );
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

  const reviewRow = await deps.reviewRepo.findSeedReviewRow(args.subjectSource, args.subjectSourceId);
  const autoBirth = !args.forceQueue && deps.structuralAutoBirthTypes.has(spineType) && !reviewRow;
  const shouldQueue =
    Boolean(reviewRow) || args.forceQueue || (deps.birthGateTypes.has(spineType) && !deps.birthGateDryRun);

  if (!autoBirth && shouldQueue) {
    const owner = deps.resolveOwner(fact);
    if (!owner) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

    const { name: subjectName, aliases: seedAliases } = deriveQualifiedSeedName({
      source: args.subjectSource,
      subjectName: fact.subject_name as string,
      raw: args.raw,
    });
    const { row, skipEvidence } = await deps.reviewRepo.upsertSeedReviewRow({
      proposedName: subjectName,
      normalizedName: normalizeEntityMatchName(spineType, subjectName),
      entityType: spineType,
      seedSource: args.subjectSource,
      seedSourceId: args.subjectSourceId,
      candidateEntityId: null,
      triggeredByUserId: owner,
      metadata: args.metadata,
      seedAliases,
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

  const { name: qualifiedName, aliases: qualifiedAliases } = deriveQualifiedSeedName({
    source: args.subjectSource,
    subjectName: fact.subject_name as string,
    raw: args.raw,
  });
  const entity = await upsertEntityFromSeed(deps, {
    name: qualifiedName,
    sourceType: spineType,
    source: args.subjectSource,
    sourceId: args.subjectSourceId,
    sourceUrl: args.sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata: args.metadata,
    aliases: qualifiedAliases,
  });
  deps.index.bySourceRef.set(`${args.subjectSource}:${args.subjectSourceId}`, entity);
  return { kind: "structural", entity };
}

function extractSeedAliases(raw: Record<string, unknown>): string[] {
  const aliases = raw.aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
}

async function upsertEntityFromSeed(
  deps: MaterializeDeps,
  input: {
    name: string;
    sourceType: string;
    source: string;
    sourceId: string;
    sourceUrl?: string;
    sourceRefId?: string;
    metadata?: Record<string, unknown>;
    aliases: string[];
  },
): Promise<EntityRow> {
  const entity = await deps.entityRepo.upsertEntityFromTool({
    name: input.name,
    sourceType: input.sourceType,
    source: input.source,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    sourceRefId: input.sourceRefId,
    metadata: input.metadata,
    provenanceTier: "structural",
  });
  return applySeedAliases(deps, entity, input.aliases);
}

async function applySeedAliases(deps: MaterializeDeps, entity: EntityRow, aliases: string[]): Promise<EntityRow> {
  let refreshed = entity;
  for (const alias of aliases) {
    await deps.entityRepo.appendAlias(refreshed.id, alias);
  }
  if (aliases.length > 0) {
    refreshed = (await deps.entityRepo.getEntity(refreshed.id)) ?? refreshed;
  }
  registerEntity(deps.index, refreshed);
  return refreshed;
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

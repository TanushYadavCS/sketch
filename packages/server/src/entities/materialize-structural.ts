import { normalizeEntityMatchName } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import { buildSeedProvenanceNote, isProjectCandidateSeed } from "./materialize-structural-gate";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

function readCrmAccountDomains(metadata: Record<string, unknown> | undefined): string[] {
  const value = metadata?.crmAccountDomains;
  if (!Array.isArray(value)) return [];
  return value.filter((domain): domain is string => typeof domain === "string" && domain.length > 0);
}

export async function materializeStructuralSeed(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const subjectSource = fact.subject_source ?? fact.source;
  const subjectSourceId = fact.subject_source_id;
  if (!subjectSourceId || !fact.subject_name) return { kind: "skipped", reason: "missing_structural_subject" };

  let sourceType: string;
  if (typeof raw.sourceType === "string") {
    sourceType = raw.sourceType;
  } else if (typeof raw.fileType === "string") {
    sourceType = `${fact.source}_${raw.fileType}`;
  } else {
    sourceType = fact.source;
  }
  const sourceUrl = typeof raw.providerUrl === "string" ? raw.providerUrl : (raw.sourceUrl as string | undefined);
  const sourcePath = typeof raw.sourcePath === "string" ? raw.sourcePath : undefined;
  const metadataFromRaw =
    raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : undefined;
  const metadata = metadataFromRaw ?? (sourcePath ? { path: sourcePath } : undefined);

  if (isProjectCandidateSeed(sourceType)) {
    return materializeProjectCandidate(deps, fact, { subjectSource, subjectSourceId, sourceType, raw, metadata });
  }

  const entity = (await deps.entityRepo.upsertEntityFromTool({
    name: fact.subject_name,
    sourceType,
    source: subjectSource,
    sourceId: subjectSourceId,
    sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata,
  })) as unknown as EntityRow;
  if (subjectSource === "zoho_crm" && sourceType === "company") {
    const domains = readCrmAccountDomains(metadataFromRaw);
    for (const [index, domain] of domains.entries()) {
      const result = await deps.domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: entity.id,
        domain,
        source: "zoho_crm",
        confidence: 1,
        isPrimary: index === 0,
      });
      if (result === "inserted" || result === "updated" || result === "unchanged") {
        const bucket = deps.index.companyIdsByDomain.get(domain);
        if (bucket) {
          if (!bucket.includes(entity.id)) bucket.push(entity.id);
        } else {
          deps.index.companyIdsByDomain.set(domain, [entity.id]);
        }
      }
      if (result === "skipped_manual_conflict" || result === "skipped_auto_conflict") {
        deps.logger?.warn(
          {
            entityId: entity.id,
            entityName: entity.name,
            domain,
            factId: fact.id,
            result,
          },
          "Skipped conflicting Zoho CRM Account domain claim",
        );
      }
    }
  }
  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity);
  return { kind: "structural", entity };
}

/**
 * Project birth gate. A connector container (Linear project, ClickUp
 * space/folder) does not auto-create a `project` entity — it is proposed for
 * human review keyed on its stable `(source, source_id)` handle, which
 * survives container renames. Confirm creates the entity (see
 * `confirmReview` create-on-confirm); reject is a durable sticky memo.
 */
async function materializeProjectCandidate(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  args: {
    subjectSource: string;
    subjectSourceId: string;
    sourceType: string;
    raw: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<MaterializeResult> {
  const owner = deps.resolveOwner(fact);
  if (!owner) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const existing = await deps.entityRepo.getEntityBySourceRef(args.subjectSource, args.subjectSourceId);
  if (existing && existing.source_type === "project") {
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

  const subjectName = fact.subject_name as string;
  const { row, skipEvidence } = await deps.reviewRepo.upsertSeedReviewRow({
    proposedName: subjectName,
    normalizedName: normalizeEntityMatchName("project", subjectName),
    entityType: "project",
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

export async function materializeParentEntity(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  if (!fact.indexed_file_id || !fact.subject_source || !fact.subject_source_id) {
    return { kind: "skipped", reason: "missing_parent_subject" };
  }
  const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
  let entity = deps.index.bySourceRef.get(refKey);
  if (!entity) {
    const found = await deps.entityRepo.getEntityBySourceRef(fact.subject_source, fact.subject_source_id);
    if (found) {
      entity = found as unknown as EntityRow;
      deps.index.bySourceRef.set(refKey, entity);
    }
  }
  if (!entity) {
    return { kind: "skipped", reason: "missing_parent_seed" };
  }
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "EXTRACTED",
    source: `${fact.source}_parent_entity`,
    relation: "mentioned",
  });
  return { kind: "entity_linked", entity, mentionWritten: true, countEntity: false };
}

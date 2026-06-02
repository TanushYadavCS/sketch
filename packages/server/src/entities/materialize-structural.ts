import { readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";

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

  const entity = (await deps.entityRepo.upsertEntityFromTool({
    name: fact.subject_name,
    sourceType,
    source: subjectSource,
    sourceId: subjectSourceId,
    sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata,
  })) as unknown as EntityRow;
  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity);
  return { kind: "structural", entity };
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

import { registerEntity } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { proposeEntity } from "./propose";

export async function materializeProjectSeed(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const subjectSource = fact.subject_source ?? fact.source;
  const subjectSourceId = fact.subject_source_id;
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!subjectSourceId || !fact.subject_name) return { kind: "skipped", reason: "missing_structural_subject" };
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const metadata =
    raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : undefined;

  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      domainsRepo: deps.domainsRepo,
      lookup: deps.lookup,
      readEmail: deps.readEmail,
      onEntityResolved: deps.onEntityResolved,
    },
    {
      name: fact.subject_name,
      entityType: "project",
      subtype: "external",
      source: subjectSource,
      sourceId: subjectSourceId,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      metadata,
    },
  );

  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "non_person_collision" };
  }

  const entity = result.entity as unknown as EntityRow;
  registerEntity(deps.index, entity);
  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity);
  return { kind: result.kind === "created" ? "entity_created" : "entity_linked", entity, mentionWritten: false };
}

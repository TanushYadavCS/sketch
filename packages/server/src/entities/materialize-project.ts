import { registerEntity } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import { materializeSpineCandidate } from "./materialize-spine-candidate";
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

  if (deps.birthGateTypes.has("project")) {
    return materializeSpineCandidate(deps, fact, {
      subjectSource,
      subjectSourceId,
      sourceType: "project",
      raw,
      metadata,
    });
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
      name: fact.subject_name,
      entityType: "project",
      subtype: "external",
      source: subjectSource,
      sourceId: subjectSourceId,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      metadata,
      provenanceTier: "structural",
    },
  );

  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "non_person_collision" };
  }

  const entity = result.entity as unknown as EntityRow;
  const refreshed = await applySeedAliases(deps, entity, extractSeedAliases(raw));
  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, refreshed);
  return {
    kind: result.kind === "created" ? "entity_created" : "entity_linked",
    entity: refreshed,
    mentionWritten: false,
  };
}

function extractSeedAliases(raw: Record<string, unknown>): string[] {
  const aliases = raw.aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
}

async function applySeedAliases(deps: MaterializeDeps, entity: EntityRow, aliases: string[]): Promise<EntityRow> {
  let refreshed = entity;
  for (const alias of aliases) {
    await deps.entityRepo.appendAlias(refreshed.id, alias);
  }
  if (aliases.length > 0) {
    refreshed = ((await deps.entityRepo.getEntity(refreshed.id)) ?? refreshed) as unknown as EntityRow;
  }
  registerEntity(deps.index, refreshed);
  return refreshed;
}

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { isPg } from "../db/dialect";
import type { DB } from "../db/schema";
import type { CleanupAction, CleanupVerdict } from "./cleanup-adjudication";
import { mergeEntitiesInTransaction } from "./merge";

type RowState = "applied" | "skipped" | "failed";

export type RollbackManifestEntry = {
  table: string;
  primaryKey: Record<string, string | number | null>;
  before: Record<string, unknown> | null;
};

export type CleanupApplyManifest = {
  runId: string;
  verdictPath: string;
  generatedAt: string;
  mutations: RollbackManifestEntry[];
};

export type CleanupApplyPlanRow = {
  entityId: string;
  name: string;
  action: CleanupAction | "needs_human_fix";
  state: RowState;
  targetEntityId: string | null;
  resolvedTargetEntityId: string | null;
  reason: string | null;
  wouldChange: Record<string, number>;
};

export type CleanupApplyResult = {
  runId: string;
  rows: CleanupApplyPlanRow[];
  counts: Record<CleanupAction | "needs_human_fix", { applied: number; skipped: number; failed: number }>;
  manifest: CleanupApplyManifest | null;
};

type LiveProject = {
  id: string;
  name: string;
};

type ValidPlannedRow = CleanupApplyPlanRow & {
  state: "applied";
  action: CleanupAction;
};

const ACTIONS: CleanupAction[] = ["keep", "merge_into", "nest_under", "archive"];

function emptyCounts(): CleanupApplyResult["counts"] {
  return {
    keep: { applied: 0, skipped: 0, failed: 0 },
    merge_into: { applied: 0, skipped: 0, failed: 0 },
    nest_under: { applied: 0, skipped: 0, failed: 0 },
    archive: { applied: 0, skipped: 0, failed: 0 },
    needs_human_fix: { applied: 0, skipped: 0, failed: 0 },
  };
}

function recordCount(
  counts: CleanupApplyResult["counts"],
  action: CleanupApplyPlanRow["action"],
  state: RowState,
): void {
  const bucket = ACTIONS.includes(action as CleanupAction) ? (action as CleanupAction) : "needs_human_fix";
  counts[bucket][state] += 1;
}

function skippedRow(verdict: CleanupVerdict, reason: string): CleanupApplyPlanRow {
  return {
    entityId: verdict.entityId,
    name: verdict.name,
    action: verdict.action,
    state: "skipped",
    targetEntityId: verdict.targetEntityId,
    resolvedTargetEntityId: null,
    reason,
    wouldChange: {},
  };
}

function failedRow(
  verdict: CleanupVerdict,
  reason: string,
  resolvedTargetEntityId: string | null,
): CleanupApplyPlanRow {
  return {
    entityId: verdict.entityId,
    name: verdict.name,
    action: verdict.action,
    state: "failed",
    targetEntityId: verdict.targetEntityId,
    resolvedTargetEntityId,
    reason,
    wouldChange: {},
  };
}

function detectMapCycles(map: Map<string, string>): Set<string> {
  const failed = new Set<string>();
  for (const start of map.keys()) {
    const seen = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor) {
      const firstSeen = seen.get(cursor);
      if (firstSeen !== undefined) {
        for (const id of [...seen.entries()].filter(([, index]) => index >= firstSeen).map(([id]) => id))
          failed.add(id);
        break;
      }
      seen.set(cursor, seen.size);
      cursor = map.get(cursor);
    }
  }
  return failed;
}

function resolveTarget(map: Map<string, string>, targetId: string): string | null {
  const seen = new Set<string>();
  let cursor = targetId;
  while (map.has(cursor)) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    cursor = map.get(cursor) ?? cursor;
  }
  return cursor;
}

function parseEntityIdList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function liveProjects(db: Kysely<DB>, ids: string[]): Promise<Map<string, LiveProject>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name"])
    .where("id", "in", [...new Set(ids)])
    .where("source_type", "=", "project")
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

async function archiveReferenceCounts(
  db: Kysely<DB>,
  entityId: string,
): Promise<{ tasks: number; relationships: number }> {
  const tasks = await db
    .selectFrom("tasks")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("parent_entity_id", "=", entityId),
        eb("assignee_entity_id", "=", entityId),
        eb("client_entity_id", "=", entityId),
      ]),
    )
    .execute();
  const relationships = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .execute();
  return { tasks: tasks.length, relationships: relationships.length };
}

async function mutationCounts(db: Kysely<DB>, action: CleanupAction, entityId: string, targetId: string | null) {
  if (action === "keep") return {};
  if (action === "archive") return { entities: 1 };
  if (action === "nest_under") {
    const existing =
      targetId === null
        ? null
        : await db
            .selectFrom("entity_relationships")
            .select("id")
            .where("source_entity_id", "=", entityId)
            .where("target_entity_id", "=", targetId)
            .where("relationship_type", "=", "part_of")
            .executeTakeFirst();
    return { entity_relationships: existing ? 0 : 1 };
  }
  const counts: Record<string, number> = { entities: 2, entity_merges: 1 };
  const simpleRefs = [
    ["entity_source_refs", "entity_id"],
    ...(isPg(db) ? ([["entity_name_embeddings", "entity_id"]] as const) : []),
    ["entity_name_proposals", "entity_id"],
    ["entity_mentions", "entity_id"],
    ["entity_contact_points", "entity_id"],
    ["entity_share_emails", "entity_id"],
    ["entity_alias_rejections", "entity_id"],
    ["entity_domains", "entity_id"],
    ["entity_project_bindings", "entity_id"],
    ["entity_project_member_overrides", "entity_id"],
    ["slack_user_sync_state", "entity_id"],
    ["user_entity_links", "entity_id"],
    ["project_minting_verdicts", "company_entity_id"],
    ["weekly_mint_run_events", "company_entity_id"],
    ["company_relationship_declarations", "subject_entity_id"],
    ["work_cycles", "scope_entity_id"],
  ] as const;
  for (const [table, column] of simpleRefs) {
    const rows = await db.selectFrom(table).select(column).where(column, "=", entityId).execute();
    if (rows.length > 0) counts[table] = rows.length;
  }
  const relationships = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .execute();
  if (relationships.length > 0) counts.entity_relationships = relationships.length;
  const tasks = await db
    .selectFrom("tasks")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("parent_entity_id", "=", entityId),
        eb("assignee_entity_id", "=", entityId),
        eb("client_entity_id", "=", entityId),
      ]),
    )
    .execute();
  if (tasks.length > 0) counts.tasks = tasks.length;
  const taskEvidence = await db
    .selectFrom("task_evidence")
    .select("task_id")
    .where("kind", "=", "entity")
    .where("ref_id", "=", entityId)
    .execute();
  if (taskEvidence.length > 0) counts.task_evidence = taskEvidence.length;
  const reviewRows = await db.selectFrom("entity_review_queue").selectAll().execute();
  const reviewCount = reviewRows.filter(
    (row) =>
      row.candidate_entity_id === entityId ||
      row.resolved_entity_id === entityId ||
      parseEntityIdList(row.candidate_entity_ids).includes(entityId),
  ).length;
  if (reviewCount > 0) counts.entity_review_queue = reviewCount;
  const candidateRows = await db.selectFrom("entity_candidates").selectAll().execute();
  const candidateCount = candidateRows.filter(
    (row) =>
      row.promoted_entity_id === entityId || parseEntityIdList(row.observed_person_entity_ids).includes(entityId),
  ).length;
  if (candidateCount > 0) counts.entity_candidates = candidateCount;
  const subEntities = await db
    .selectFrom("sub_entities")
    .select("id")
    .where((eb) => eb.or([eb("parent_entity_id", "=", entityId), eb("parent_scope_key", "=", entityId)]))
    .execute();
  if (subEntities.length > 0) counts.sub_entities = subEntities.length;
  return counts;
}

async function partOfCycleIds(
  db: Kysely<DB>,
  mergeMap: Map<string, string>,
  nests: Array<{ entityId: string; targetEntityId: string }>,
): Promise<Set<string>> {
  const graph = new Map<string, string>();
  const existing = await db
    .selectFrom("entity_relationships")
    .select(["source_entity_id", "target_entity_id"])
    .where("relationship_type", "=", "part_of")
    .execute();
  for (const row of existing) {
    const source = resolveTarget(mergeMap, row.source_entity_id) ?? row.source_entity_id;
    const target = resolveTarget(mergeMap, row.target_entity_id) ?? row.target_entity_id;
    if (source !== target) graph.set(source, target);
  }
  for (const nest of nests) graph.set(nest.entityId, nest.targetEntityId);
  return detectMapCycles(graph);
}

function primaryKeyFor(
  table: string,
  rowId: string | null,
  before: Record<string, unknown> | null,
): Record<string, string | number | null> {
  if (table === "entity_share_emails") {
    const separator = rowId?.indexOf(":") ?? -1;
    return {
      entity_id: String(before?.entity_id ?? (separator >= 0 ? rowId?.slice(0, separator) : "")),
      email: String(before?.email ?? (separator >= 0 ? rowId?.slice(separator + 1) : "")),
    };
  }
  if (table === "task_evidence") {
    const [taskId, kind, refId] = rowId?.split("\u0000") ?? [];
    return {
      task_id: String(before?.task_id ?? taskId ?? ""),
      kind: String(before?.kind ?? kind ?? ""),
      ref_id: String(before?.ref_id ?? refId ?? ""),
    };
  }
  if (table === "slack_user_sync_state") {
    const [teamId, slackUserId] = rowId?.split("\u0000") ?? [];
    return {
      team_id: String(before?.team_id ?? teamId ?? ""),
      slack_user_id: String(before?.slack_user_id ?? slackUserId ?? ""),
    };
  }
  if (table === "company_relationship_declarations") {
    return { subject_entity_id: String(before?.subject_entity_id ?? rowId ?? "") };
  }
  if (table === "entity_name_embeddings") return { entity_id: String(before?.entity_id ?? rowId ?? "") };
  return { id: rowId };
}

function addManifestEntry(
  mutations: RollbackManifestEntry[],
  table: string,
  rowId: string | null,
  before: Record<string, unknown> | null,
): void {
  mutations.push({ table, primaryKey: primaryKeyFor(table, rowId, before), before });
}

async function applyNest(db: Kysely<DB>, row: ValidPlannedRow, mutations: RollbackManifestEntry[]): Promise<void> {
  if (!row.resolvedTargetEntityId) throw new Error(`nest target missing for ${row.entityId}`);
  const existing = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where("source_entity_id", "=", row.entityId)
    .where("target_entity_id", "=", row.resolvedTargetEntityId)
    .where("relationship_type", "=", "part_of")
    .executeTakeFirst();
  if (existing) return;
  const id = randomUUID();
  addManifestEntry(mutations, "entity_relationships", id, null);
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: row.entityId,
      target_entity_id: row.resolvedTargetEntityId,
      relationship_type: "part_of",
      confidence: "high",
      confidence_score: 1,
      source: "project_cleanup_apply",
    })
    .execute();
}

async function applyArchive(db: Kysely<DB>, row: ValidPlannedRow, mutations: RollbackManifestEntry[]): Promise<void> {
  const before = await db.selectFrom("entities").selectAll().where("id", "=", row.entityId).executeTakeFirstOrThrow();
  addManifestEntry(mutations, "entities", row.entityId, before);
  await db
    .updateTable("entities")
    .set({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .where("id", "=", row.entityId)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .execute();
}

async function applyMerge(db: Kysely<DB>, row: ValidPlannedRow, mutations: RollbackManifestEntry[]): Promise<void> {
  if (!row.resolvedTargetEntityId) throw new Error(`merge target missing for ${row.entityId}`);
  const sourceBefore = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", row.entityId)
    .executeTakeFirstOrThrow();
  const targetBefore = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", row.resolvedTargetEntityId)
    .executeTakeFirstOrThrow();
  addManifestEntry(mutations, "entities", row.entityId, sourceBefore);
  addManifestEntry(mutations, "entities", row.resolvedTargetEntityId, targetBefore);
  const result = await mergeEntitiesInTransaction(db, {
    survivorId: row.resolvedTargetEntityId,
    loserId: row.entityId,
    mergedBy: "project_cleanup_apply",
  });
  for (const move of result.moves) {
    if ("kind" in move) continue;
    if ("collided" in move || "selfLoopDropped" in move) {
      addManifestEntry(mutations, move.table, "rowId" in move ? move.rowId : null, move.payload);
      continue;
    }
    if ("colChanges" in move) {
      addManifestEntry(
        mutations,
        move.table,
        move.rowId,
        Object.fromEntries(Object.entries(move.colChanges).map(([column, change]) => [column, change.before])),
      );
      continue;
    }
    addManifestEntry(
      mutations,
      move.table,
      move.rowId,
      Object.fromEntries(Object.entries(move.repoint).map(([column, change]) => [column, change.from])),
    );
  }
  addManifestEntry(mutations, "entity_merges", result.mergeId, null);
}

export async function planProjectCleanup(db: Kysely<DB>, verdicts: CleanupVerdict[]): Promise<CleanupApplyPlanRow[]> {
  const rows: CleanupApplyPlanRow[] = [];
  const executable = verdicts.filter((verdict) => verdict.approved && verdict.validation === "ok");
  const sourceIds = executable.map((verdict) => verdict.entityId);
  const targetIds = executable
    .filter((verdict) => verdict.action === "merge_into" || verdict.action === "nest_under")
    .flatMap((verdict) => (verdict.targetEntityId ? [verdict.targetEntityId] : []));
  const live = await liveProjects(db, [...sourceIds, ...targetIds]);
  const archiveSources = new Set(
    executable.filter((verdict) => verdict.action === "archive").map((verdict) => verdict.entityId),
  );
  const mergeMap = new Map<string, string>();
  for (const verdict of executable) {
    if (verdict.action === "merge_into" && verdict.targetEntityId)
      mergeMap.set(verdict.entityId, verdict.targetEntityId);
  }
  const mergeCycleIds = detectMapCycles(mergeMap);
  const plannedNests = executable
    .filter((verdict) => verdict.action === "nest_under" && verdict.targetEntityId)
    .map((verdict) => ({
      entityId: verdict.entityId,
      targetEntityId: resolveTarget(mergeMap, verdict.targetEntityId ?? "") ?? verdict.targetEntityId ?? "",
    }));
  const partOfCycles = await partOfCycleIds(db, mergeMap, plannedNests);

  for (const verdict of verdicts) {
    if (!verdict.approved || verdict.validation !== "ok") {
      rows.push(skippedRow(verdict, !verdict.approved ? "not_approved" : "validation_not_ok"));
      continue;
    }
    if (!ACTIONS.includes(verdict.action as CleanupAction)) {
      rows.push(failedRow(verdict, "invalid_action", null));
      continue;
    }
    const action = verdict.action as CleanupAction;
    if (!live.has(verdict.entityId)) {
      rows.push(failedRow(verdict, "source_not_live_project", null));
      continue;
    }
    if (mergeCycleIds.has(verdict.entityId)) {
      rows.push(failedRow(verdict, "merge_cycle", null));
      continue;
    }
    const resolvedTarget =
      action === "merge_into" || action === "nest_under"
        ? verdict.targetEntityId
          ? resolveTarget(mergeMap, verdict.targetEntityId)
          : null
        : null;
    if ((action === "merge_into" || action === "nest_under") && !resolvedTarget) {
      rows.push(failedRow(verdict, "missing_or_cyclic_target", resolvedTarget));
      continue;
    }
    if (resolvedTarget && resolvedTarget === verdict.entityId) {
      rows.push(failedRow(verdict, "self_target_after_resolution", resolvedTarget));
      continue;
    }
    if (resolvedTarget && !live.has(resolvedTarget)) {
      rows.push(failedRow(verdict, "target_not_live_project", resolvedTarget));
      continue;
    }
    if (resolvedTarget && archiveSources.has(resolvedTarget)) {
      rows.push(failedRow(verdict, "target_archived_this_run", resolvedTarget));
      continue;
    }
    if (
      action === "nest_under" &&
      (partOfCycles.has(verdict.entityId) || (resolvedTarget && partOfCycles.has(resolvedTarget)))
    ) {
      rows.push(failedRow(verdict, "part_of_cycle", resolvedTarget));
      continue;
    }
    if (action === "archive") {
      const refs = await archiveReferenceCounts(db, verdict.entityId);
      if (refs.tasks > 0 || refs.relationships > 0) {
        rows.push(
          failedRow(verdict, `archive_referenced: tasks=${refs.tasks}, relationships=${refs.relationships}`, null),
        );
        continue;
      }
    }
    rows.push({
      entityId: verdict.entityId,
      name: verdict.name,
      action,
      state: "applied",
      targetEntityId: verdict.targetEntityId,
      resolvedTargetEntityId: resolvedTarget,
      reason: null,
      wouldChange: await mutationCounts(db, action, verdict.entityId, resolvedTarget),
    });
  }

  return rows;
}

export async function applyProjectCleanup(
  db: Kysely<DB>,
  verdicts: CleanupVerdict[],
  opts: { execute: boolean; verdictPath: string },
): Promise<CleanupApplyResult> {
  const runId = randomUUID();
  const rows = await planProjectCleanup(db, verdicts);
  const counts = emptyCounts();
  for (const row of rows) recordCount(counts, row.action, row.state);

  if (!opts.execute) return { runId, rows, counts, manifest: null };

  const mutations: RollbackManifestEntry[] = [];
  await db.transaction().execute(async (trx) => {
    for (const row of rows.filter((row): row is ValidPlannedRow => row.state === "applied" && row.action !== "keep")) {
      if (row.action === "merge_into") await applyMerge(trx, row, mutations);
    }
    for (const row of rows.filter(
      (row): row is ValidPlannedRow => row.state === "applied" && row.action === "nest_under",
    )) {
      await applyNest(trx, row, mutations);
    }
    for (const row of rows.filter(
      (row): row is ValidPlannedRow => row.state === "applied" && row.action === "archive",
    )) {
      await applyArchive(trx, row, mutations);
    }
  });

  return {
    runId,
    rows,
    counts,
    manifest: { runId, verdictPath: opts.verdictPath, generatedAt: new Date().toISOString(), mutations },
  };
}

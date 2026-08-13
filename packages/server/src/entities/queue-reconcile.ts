import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { type ReasonHit, reviewFreezeBoundary } from "./queue-projection";
import { inScope, nonTerminal } from "./queue-scope";

export type QueueRowForPasses = {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  proposed_email: string | null;
  candidate_entity_id: string | null;
  source: string | null;
  status: string;
};

export type LiveEntity = { id: string; name: string; source_type: string; created_at: string };
type EntityState = { id: string; deleted_at: string | null; merged_into_entity_id: string | null };

export type ReconcileResult = {
  hits: ReasonHit[];
  repointed: number;
  cleared: number;
};

const MERGE_CHAIN_MAX_HOPS = 16;

/**
 * NUL separates the two parts so a type can never run into a name — no entity
 * type or proposed name contains one.
 */
export function nameKey(entityType: string, name: string): string {
  return `${entityType}\u0000${name.trim().toLowerCase()}`;
}

export async function loadQueueRows(db: Kysely<DB>): Promise<QueueRowForPasses[]> {
  return db
    .selectFrom("entity_review_queue")
    .select([
      "id",
      "proposed_name",
      "normalized_name",
      "entity_type",
      "proposed_email",
      "candidate_entity_id",
      "source",
      "status",
    ])
    .where((eb) => inScope(eb))
    .where((eb) => nonTerminal(eb))
    .orderBy("first_seen_at", "asc")
    .orderBy("id", "asc")
    .execute();
}

/**
 * The oldest live entity carrying each row's proposed name, keyed on type as
 * well as name. Matching on name alone defers a `person` row because a
 * `company` happens to share its name.
 */
export async function liveEntitiesForNames(
  db: Kysely<DB>,
  rows: QueueRowForPasses[],
): Promise<Map<string, LiveEntity>> {
  const wanted = new Set(rows.map((row) => nameKey(row.entity_type, row.proposed_name)));
  if (wanted.size === 0) return new Map();

  const types = Array.from(new Set(rows.map((row) => row.entity_type)));
  const names = Array.from(new Set(rows.map((row) => row.proposed_name.trim().toLowerCase())));

  const candidates = await db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "created_at"])
    .where("source_type", "in", types)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .where((eb) => eb(eb.fn("lower", ["name"]), "in", names))
    .execute();

  const byKey = new Map<string, LiveEntity>();
  for (const candidate of candidates) {
    const key = nameKey(candidate.source_type, candidate.name);
    if (!wanted.has(key)) continue;
    const held = byKey.get(key);
    const older =
      held === undefined ||
      candidate.created_at < held.created_at ||
      (candidate.created_at === held.created_at && candidate.id < held.id);
    if (older) byKey.set(key, candidate);
  }
  return byKey;
}

/**
 * Candidate rows plus every entity their merge chains pass through. Loading the
 * candidates alone is not enough — a candidate merged into an entity that is
 * itself merged has a survivor that no queue row points at.
 */
async function loadEntityStates(db: Kysely<DB>, rows: QueueRowForPasses[]): Promise<Map<string, EntityState>> {
  const states = new Map<string, EntityState>();
  let toLoad = Array.from(new Set(rows.map((r) => r.candidate_entity_id).filter((id): id is string => id !== null)));

  for (let hop = 0; hop <= MERGE_CHAIN_MAX_HOPS && toLoad.length > 0; hop += 1) {
    const found = await db
      .selectFrom("entities")
      .select(["id", "deleted_at", "merged_into_entity_id"])
      .where("id", "in", toLoad)
      .execute();
    for (const state of found) states.set(state.id, state);
    toLoad = found
      .map((state) => state.merged_into_entity_id)
      .filter((id): id is string => id !== null && !states.has(id));
  }
  return states;
}

/**
 * Walks `merged_into_entity_id` to the end. Returns null when the chain leaves
 * the loaded set or loops, so a broken chain never produces a re-point.
 */
function resolveSurvivor(startId: string, states: Map<string, EntityState>): EntityState | null {
  const seen = new Set<string>();
  let current = states.get(startId) ?? null;
  while (current?.merged_into_entity_id) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const next = states.get(current.merged_into_entity_id);
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * A candidate change — a re-point (A2, A3) or a clear (A4) — writes four
 * columns, never just the pointer. `candidate_generated_at` is what lets a
 * later reader tell the candidate moved; a stale score and a stale alternates
 * list describe a pair that is no longer being asked about, and `merge.ts`
 * rewrites only the scalar column, so nothing else cleans them up.
 *
 * The `candidate_entity_id` predicate is the re-check from §2.3: the value was
 * read before the rules ran, and a row whose candidate moved since then is left
 * for the next run rather than overwritten.
 */
async function writeCandidate(
  db: Kysely<DB>,
  rowIds: string[],
  target: string | null,
  expectedCandidateId: string,
  boundary: string,
): Promise<number> {
  const result = await db
    .updateTable("entity_review_queue")
    .set({
      candidate_entity_id: target,
      candidate_entity_ids: null,
      candidate_score: null,
      candidate_generated_at: new Date().toISOString(),
    })
    .where("id", "in", rowIds)
    .where("candidate_entity_id", "=", expectedCandidateId)
    .where("status", "in", ["pending", "deferred"])
    .where((eb) => eb.or([eb("review_started_at", "is", null), eb("review_started_at", "<", boundary)]))
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Phase A — the register already answered it.
 *
 * Reads `entities` and writes queue columns only. No mentions, no aliases, no
 * merges: the facts behind these rows are still in `indexed_file_facts` and
 * materialize normally, so setting a row aside loses nothing.
 */
export async function reconcileQueue(
  db: Kysely<DB>,
  rows: QueueRowForPasses[],
  byName: Map<string, LiveEntity>,
): Promise<ReconcileResult> {
  const states = await loadEntityStates(db, rows);

  const boundary = reviewFreezeBoundary();
  const hits: ReasonHit[] = [];
  const groups = new Map<string, { target: string | null; expected: string; rowIds: string[] }>();

  const group = (rowId: string, expected: string, target: string | null): void => {
    const key = `${expected}\u0000${target ?? ""}`;
    const held = groups.get(key) ?? { target, expected, rowIds: [] };
    held.rowIds.push(rowId);
    groups.set(key, held);
  };

  for (const row of rows) {
    const live = byName.get(nameKey(row.entity_type, row.proposed_name)) ?? null;
    const candidateId = row.candidate_entity_id;

    if (candidateId === null) {
      if (live) hits.push({ rowId: row.id, reason: "name_already_resolved" });
      continue;
    }

    const state = states.get(candidateId) ?? null;
    const candidateGone = state === null || state.deleted_at !== null || state.merged_into_entity_id !== null;

    if (candidateGone) {
      const survivor = resolveSurvivor(candidateId, states);
      const usable = survivor && survivor.deleted_at === null && survivor.id !== candidateId ? survivor : null;

      if (usable) {
        group(row.id, candidateId, usable.id);
        if (live && live.id === usable.id) hits.push({ rowId: row.id, reason: "name_already_resolved" });
        continue;
      }

      group(row.id, candidateId, null);
      if (live) hits.push({ rowId: row.id, reason: "name_already_resolved" });
      continue;
    }

    if (live && live.id !== candidateId) {
      group(row.id, candidateId, live.id);
      hits.push({ rowId: row.id, reason: "name_already_resolved" });
      continue;
    }

    if (live && live.id === candidateId) hits.push({ rowId: row.id, reason: "name_already_resolved" });
  }

  let repointed = 0;
  let cleared = 0;
  for (const held of groups.values()) {
    const written = await writeCandidate(db, held.rowIds, held.target, held.expected, boundary);
    if (held.target === null) cleared += written;
    else repointed += written;
  }

  return { hits, repointed, cleared };
}

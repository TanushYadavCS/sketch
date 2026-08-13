import type { Kysely } from "kysely";
import { readReviewFreezeMs } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";

export type PassReason =
  | "name_already_resolved"
  | "different_emails"
  | "co_listed_participants"
  | "type_mismatch"
  | "no_shared_file"
  | "bare_name_only";

/**
 * Certainty order: what the register says, then what is certainly true, then
 * what the evidence does not support.
 *
 * Priority 4 is reserved for a model pass and is not implemented here. Adding a
 * rung is the only change that pass makes to this module — it writes a verdict,
 * and the projection reads it.
 */
export const REASON_PRIORITY: Record<PassReason, number> = {
  name_already_resolved: 1,
  different_emails: 2,
  co_listed_participants: 2,
  type_mismatch: 2,
  no_shared_file: 3,
  bare_name_only: 3,
};

const ALL_REASONS = Object.keys(REASON_PRIORITY) as PassReason[];

const DEFER_MAX_PRIORITY = 2;

/**
 * Only a reason that answers the row hides it. Priority 3 says the evidence does
 * not support a merge, which is not the same as knowing there is nothing to
 * merge — a large share of those rows are real merges a person would confirm on
 * sight. They keep `pending` and carry their reason, so the queue stays honest
 * until a model pass can rule on them.
 */
function statusForReason(reason: PassReason): "deferred" | "pending" {
  return REASON_PRIORITY[reason] <= DEFER_MAX_PRIORITY ? "deferred" : "pending";
}

export type ReasonHit = { rowId: string; reason: PassReason };

export type ProjectionCounts = {
  set: Partial<Record<PassReason, number>>;
  cleared: number;
  frozen: number;
};

/**
 * Keeps the highest-priority reason per row. Ties break on the reason name so
 * two rules at the same priority always resolve the same way.
 */
export function resolveReasons(hits: ReasonHit[]): Map<string, PassReason> {
  const best = new Map<string, PassReason>();
  for (const hit of hits) {
    const current = best.get(hit.rowId);
    if (current === undefined) {
      best.set(hit.rowId, hit.reason);
      continue;
    }
    const currentPriority = REASON_PRIORITY[current];
    const hitPriority = REASON_PRIORITY[hit.reason];
    if (hitPriority < currentPriority || (hitPriority === currentPriority && hit.reason < current)) {
      best.set(hit.rowId, hit.reason);
    }
  }
  return best;
}

export function reviewFreezeBoundary(): string {
  return new Date(Date.now() - readReviewFreezeMs()).toISOString();
}

/**
 * Writes `(status, pass_reason)` for every row the passes examined.
 *
 * The freeze predicate lives on the UPDATE, not on the query that selected the
 * rows: a row can be picked up, opened by a person, and then written, and a
 * guard that ran before the person arrived does not guard anything. A row that
 * fails the predicate is left for the next run, which costs nothing because the
 * projection recomputes rather than mutates.
 */
export async function applyProjection(
  db: Kysely<DB>,
  rowIds: string[],
  reasons: Map<string, PassReason>,
): Promise<ProjectionCounts> {
  const counts: ProjectionCounts = { set: {}, cleared: 0, frozen: 0 };
  if (rowIds.length === 0) return counts;

  const boundary = reviewFreezeBoundary();
  let written = 0;

  for (const reason of ALL_REASONS) {
    const ids = rowIds.filter((id) => reasons.get(id) === reason);
    if (ids.length === 0) continue;
    const result = await db
      .updateTable("entity_review_queue")
      .set({ status: statusForReason(reason), pass_reason: reason })
      .where("id", "in", ids)
      .where("status", "in", ["pending", "deferred"])
      .where((eb) => eb.or([eb("review_started_at", "is", null), eb("review_started_at", "<", boundary)]))
      .executeTakeFirst();
    const updated = Number(result.numUpdatedRows ?? 0);
    counts.set[reason] = updated;
    written += updated;
  }

  const clearIds = rowIds.filter((id) => !reasons.has(id));
  if (clearIds.length > 0) {
    const result = await db
      .updateTable("entity_review_queue")
      .set({ status: "pending", pass_reason: null })
      .where("id", "in", clearIds)
      .where("status", "in", ["pending", "deferred"])
      .where((eb) => eb.or([eb("review_started_at", "is", null), eb("review_started_at", "<", boundary)]))
      .executeTakeFirst();
    counts.cleared = Number(result.numUpdatedRows ?? 0);
    written += counts.cleared;
  }

  counts.frozen = Math.max(0, rowIds.length - written);
  return counts;
}

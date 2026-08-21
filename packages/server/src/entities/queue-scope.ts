import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from "kysely";
import { TERMINAL_STATUS_LIST } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";

/**
 * Sources whose rows ask "which entity is this account?" rather than "are these
 * two names the same?". They are keyed on (source, source_id) instead of
 * (normalized_name, entity_type), a person's own link decision drives them, and
 * none of the reconcile or structural rules describes them.
 */
export const IDENTITY_LINK_SOURCES = ["user_entity_link", "slack_user"] as const;

/**
 * Rows both passes may touch.
 *
 * The null guard on `source` is load-bearing: `source NOT IN (...)` evaluates to
 * NULL for a NULL source, so a bare NOT IN silently drops rows that were never
 * identity links to begin with.
 */
export function inScope(
  eb: ExpressionBuilder<DB, "entity_review_queue">,
): ExpressionWrapper<DB, "entity_review_queue", SqlBool> {
  return eb.and([
    eb.or([
      eb("entity_review_queue.source", "is", null),
      eb("entity_review_queue.source", "not in", [...IDENTITY_LINK_SOURCES]),
    ]),
    eb("entity_review_queue.candidate_user_ids", "is", null),
  ]);
}

/**
 * `retired` is not terminal (the proposal upsert can revive it on new
 * evidence), but the passes must not load it: every projection write is
 * guarded to pending/deferred, so a retired row would only sit in the row set
 * and count as frozen forever.
 */
export function nonTerminal(
  eb: ExpressionBuilder<DB, "entity_review_queue">,
): ExpressionWrapper<DB, "entity_review_queue", SqlBool> {
  return eb("entity_review_queue.status", "not in", [...TERMINAL_STATUS_LIST, "retired"]);
}

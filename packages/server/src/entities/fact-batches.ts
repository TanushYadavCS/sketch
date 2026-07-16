/**
 * Keyset-paginated batch iteration over `indexed_file_facts`.
 *
 * The process shares one heap across HTTP, Slack, agent runs, and sync. A
 * "materialize-then-process" pass that loads the entire unmaterialized backlog
 * up front (every fact row including its `raw` payload) holds far more than the
 * slice it is working on, which contributed to a production Gmail-sync OOM.
 *
 * `forEachFactBatch` bounds the live set to one batch at a time. Each batch is
 * released before the next is fetched, so peak heap scales with the batch size,
 * not the backlog size.
 *
 * Pages are ordered by `(created_at, id)` ascending, not by `id` alone. Fact
 * ids are `randomUUID` strings, so an id-only order would process facts in
 * RANDOM chronological order — and sub-entity supersession (decisions,
 * commitments, features) dedups a same-valued observation into its predecessor
 * only when facts arrive oldest-first, so random order splits one logical
 * decision into duplicate rows. `created_at` restores the chronological order
 * the pre-batching whole-table load produced in practice, and `id` breaks ties
 * into a stable total order (facts created in the same timestamp tick keep an
 * arbitrary but deterministic relative order). Both columns are immutable, so
 * the cursor only moves forward: already-seen rows are never re-fetched (even
 * when stamped `materialized_at` mid-run) and unseen rows are never skipped.
 */

export const DEFAULT_FACT_BATCH_SIZE = 250;

export interface FactBatchCursor {
  createdAt: string;
  id: string;
}

/**
 * Drive `fetchBatch` with an advancing keyset cursor until it returns a short
 * (or empty) batch, invoking `handleBatch` on each non-empty batch.
 *
 * `fetchBatch(cursor, limit)` must return rows with `(created_at, id)` strictly
 * greater than the cursor, ordered by `created_at` then `id` ascending, capped
 * at `limit`. The first call receives empty strings, which sort before any
 * timestamp or `randomUUID`. Yielding to the event loop is the caller's
 * responsibility (typically per-fact inside `handleBatch`) so this stays a pure
 * paginator.
 */
export async function forEachFactBatch<T extends { id: string; created_at: string }>(
  fetchBatch: (cursor: FactBatchCursor, limit: number) => Promise<T[]>,
  handleBatch: (rows: T[]) => Promise<void>,
  batchSize: number = DEFAULT_FACT_BATCH_SIZE,
): Promise<void> {
  let cursor: FactBatchCursor = { createdAt: "", id: "" };
  for (;;) {
    const rows = await fetchBatch(cursor, batchSize);
    if (rows.length === 0) break;
    await handleBatch(rows);
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
    if (rows.length < batchSize) break;
  }
}

/**
 * Two-phase keyset iteration: page a narrow candidate projection, then load the
 * full payload rows for one page at a time.
 *
 * The backlog sweep classifies every open fact but only needs each fact's `raw`
 * payload when it actually materializes it. `fetchCandidates` returns the narrow
 * `(id, created_at, fact_type)` projection used to page and classify; it drives
 * the cursor and the short-page termination exactly like `forEachFactBatch`, so
 * pagination is independent of how many candidates pass. `fetchPayload` then
 * loads the full rows for the passing ids of that page with a single query, and
 * `handlePage` receives them restored to `(created_at, id)` ascending order (the
 * candidate order) regardless of the order the payload query returned.
 *
 * A candidate whose payload row is absent (concurrently deleted, materialized,
 * or quarantined between the two phases) is dropped, so ineligible rows are
 * never handed to `handlePage`. Peak retained payload is bounded by the passing
 * subset of one page, not the whole backlog.
 *
 * `fetchPayload` must issue one `WHERE id IN (...)` query; the id list is bounded
 * by `batchSize`, so callers must keep `batchSize` within the dialect bind-param
 * limit (the 250 default is well within both SQLite and Postgres limits).
 */
export async function forEachFactCandidatePage<C extends { id: string; created_at: string }, R extends { id: string }>(
  fetchCandidates: (cursor: FactBatchCursor, limit: number) => Promise<C[]>,
  fetchPayload: (ids: string[]) => Promise<R[]>,
  handlePage: (rows: R[]) => Promise<void>,
  batchSize: number = DEFAULT_FACT_BATCH_SIZE,
): Promise<void> {
  await forEachFactBatch(
    fetchCandidates,
    async (candidates) => {
      const passing = candidates.map((c) => c.id);
      if (passing.length === 0) return;
      const payload = await fetchPayload(passing);
      const byId = new Map<string, R>(payload.map((row) => [row.id, row]));
      const ordered: R[] = [];
      for (const candidate of candidates) {
        const row = byId.get(candidate.id);
        if (row) ordered.push(row);
      }
      await handlePage(ordered);
    },
    batchSize,
  );
}

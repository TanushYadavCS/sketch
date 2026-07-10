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
 * not the backlog size. Callers page by ascending `id` (a `randomUUID` string,
 * a stable total order that is portable across SQLite and Postgres) so every
 * fact is visited exactly once even when rows are stamped `materialized_at`
 * mid-run: the cursor only moves forward, so already-seen ids are never
 * re-fetched and unseen ids are never skipped.
 */

export const DEFAULT_FACT_BATCH_SIZE = 250;

/**
 * Drive `fetchBatch` with an advancing keyset cursor until it returns a short
 * (or empty) batch, invoking `handleBatch` on each non-empty batch.
 *
 * `fetchBatch(cursor, limit)` must return rows with `id > cursor`, ordered by
 * `id` ascending, capped at `limit`. The first call receives `""`, which sorts
 * before any `randomUUID`. Yielding to the event loop is the caller's
 * responsibility (typically per-fact inside `handleBatch`) so this stays a pure
 * paginator.
 */
export async function forEachFactBatch<T extends { id: string }>(
  fetchBatch: (cursor: string, limit: number) => Promise<T[]>,
  handleBatch: (rows: T[]) => Promise<void>,
  batchSize: number = DEFAULT_FACT_BATCH_SIZE,
): Promise<void> {
  let cursor = "";
  for (;;) {
    const rows = await fetchBatch(cursor, batchSize);
    if (rows.length === 0) break;
    await handleBatch(rows);
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }
}

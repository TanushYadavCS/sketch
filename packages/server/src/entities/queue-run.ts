import type { Kysely } from "kysely";
import type { QueueRunSnapshot } from "../db/repositories/graph-pass-runs";
import type { DB } from "../db/schema";
import { applyProjection, resolveReasons } from "./queue-projection";
import { liveEntitiesForNames, loadQueueRows, reconcileQueue } from "./queue-reconcile";
import { structuralPass } from "./queue-structural";

/**
 * One queue graph pass: reconcile, then structure, then one projection.
 *
 * The rows are re-read between the two passes because phase A re-points and
 * clears candidates, and phase B's rules are all about the candidate. Neither
 * pass writes to the graph, and the projection recomputes `(status,
 * pass_reason)` from scratch, so a run that overlaps another converges rather
 * than corrupting anything.
 */
export async function runQueuePasses(db: Kysely<DB>): Promise<QueueRunSnapshot> {
  const initialRows = await loadQueueRows(db);
  const byName = await liveEntitiesForNames(db, initialRows);
  const reconciled = await reconcileQueue(db, initialRows, byName);

  const rows = await loadQueueRows(db);
  const structural = await structuralPass(db, rows, byName);

  const reasons = resolveReasons([...reconciled.hits, ...structural.hits]);
  const counts = await applyProjection(
    db,
    rows.map((row) => row.id),
    reasons,
  );

  return {
    kind: "queue",
    scannedRows: rows.length,
    set: counts.set as Record<string, number>,
    cleared: counts.cleared,
    frozen: counts.frozen,
    candidatesRepointed: reconciled.repointed,
    candidatesCleared: reconciled.cleared,
  };
}

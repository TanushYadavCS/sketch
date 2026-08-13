import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { QueueRunSnapshot } from "../db/repositories/graph-pass-runs";
import type { DB } from "../db/schema";
import { runDuplicateDrain } from "./duplicate-drain";
import { applyProjection, resolveReasons } from "./queue-projection";
import { liveEntitiesForNames, loadQueueRows, reconcileQueue } from "./queue-reconcile";
import { structuralPass } from "./queue-structural";

export interface QueueDrainSequenceHandle {
  done: Promise<void>;
  stop: () => void;
}

/**
 * One queue graph pass: reconcile, then structure, then one projection.
 *
 * The rows are re-read between the two passes because phase A re-points and
 * clears candidates, and phase B's rules are all about the candidate. Neither
 * pass writes to the graph. The projection recomputes `(status, pass_reason)`
 * from scratch, so overlapping runs converge once every emitted reason still
 * describes the post-reconcile row.
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

/**
 * Runs boot graph maintenance in the measured order: queue, duplicate drain,
 * queue. The sequence is intentionally in-memory and assumes a single server
 * process; there is no durable lock preventing two booting processes from
 * interleaving their drains.
 */
export function startQueueDrainSequence(db: Kysely<DB>, logger?: Logger): QueueDrainSequenceHandle {
  let stopped = false;
  const done = (async () => {
    await runQueuePasses(db);
    try {
      await runDuplicateDrain(db, { logger, shouldStop: () => stopped });
    } finally {
      await runQueuePasses(db);
    }
  })()
    .then(() => undefined)
    .catch((err) => {
      logger?.error({ err }, "queue/drain startup sequence failed");
    });
  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}

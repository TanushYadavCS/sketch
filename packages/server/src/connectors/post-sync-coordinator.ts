import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import type { DB } from "../db/schema";
import {
  type PostSyncGraphInputs,
  type PostSyncGraphPipelineParams,
  createPostSyncGraphInputCollector,
  runPostSyncGraphPipeline,
} from "./post-sync";

export interface ScheduledPostSyncContext {
  db: Kysely<DB>;
  logger: Logger;
  coMentionContributesToThreshold?: number;
  floorRetryMaxFilesPerDomain?: number;
}

type PostSyncPipelineRunner = (params: PostSyncGraphPipelineParams) => Promise<void>;
type GraphPassRunRepository = ReturnType<typeof createGraphPassRunRepository>;

export interface PostSyncCoordinator {
  enqueue(inputs: PostSyncGraphInputs, context: ScheduledPostSyncContext): Promise<void>;
  drain(context: ScheduledPostSyncContext): Promise<void>;
  restoreUnfinished(context: ScheduledPostSyncContext): Promise<void>;
}

/**
 * Coalesces scheduled cohorts without attaching any input to two successful drains.
 * Failed snapshots restore their union without replacing reconcile inputs from newer cohorts.
 */
export function createPostSyncCoordinator(
  runPipeline: PostSyncPipelineRunner,
  runs?: GraphPassRunRepository,
): PostSyncCoordinator {
  const pending = createPostSyncGraphInputCollector();
  const restoredRunIds: string[] = [];
  let dirty = false;
  let queue: Promise<void> = Promise.resolve();

  async function drainDirty(context: ScheduledPostSyncContext): Promise<void> {
    while (dirty && pending.hasInputs()) {
      const snapshot = pending.take();
      const restoredRunId = restoredRunIds.shift();
      const runId = runs ? await runs.start({ kind: "post_sync", ...snapshot }, restoredRunId) : null;
      dirty = false;
      try {
        await runPipeline({
          db: context.db,
          syncLogger: context.logger.child({ component: "scheduled-post-sync" }),
          ...snapshot,
          coMentionContributesToThreshold: context.coMentionContributesToThreshold,
          floorRetryMaxFilesPerDomain: context.floorRetryMaxFilesPerDomain,
        });
        if (runId) await runs?.complete(runId);
      } catch (err) {
        pending.restore(snapshot);
        dirty = true;
        if (runId) {
          const message = err instanceof Error ? err.message : String(err);
          await runs?.fail(runId, message);
        }
        throw err;
      }
    }
  }

  function scheduleDrain(context: ScheduledPostSyncContext): Promise<void> {
    const run = queue.then(() => drainDirty(context));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    enqueue(inputs, context) {
      pending.add(inputs);
      dirty = true;
      return scheduleDrain(context);
    },
    drain(context) {
      return scheduleDrain(context);
    },
    async restoreUnfinished(context) {
      if (!runs) return;
      const unfinished = (await runs.listUnfinished()).filter((run) => run.inputSnapshot.kind === "post_sync");
      for (const run of unfinished) {
        if (run.inputSnapshot.kind !== "post_sync") continue;
        pending.restore(run.inputSnapshot);
        restoredRunIds.push(run.id);
        dirty = true;
      }
      if (unfinished.length > 0) {
        await scheduleDrain(context);
      }
    },
  };
}

const coordinators = new WeakMap<Kysely<DB>, PostSyncCoordinator>();

export function getPostSyncCoordinator(db: Kysely<DB>): PostSyncCoordinator {
  const existing = coordinators.get(db);
  if (existing) return existing;
  const coordinator = createPostSyncCoordinator(runPostSyncGraphPipeline, createGraphPassRunRepository(db));
  coordinators.set(db, coordinator);
  return coordinator;
}

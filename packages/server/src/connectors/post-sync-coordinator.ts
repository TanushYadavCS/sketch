import type { Kysely } from "kysely";
import type { Logger } from "pino";
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

export interface PostSyncCoordinator {
  enqueue(inputs: PostSyncGraphInputs, context: ScheduledPostSyncContext): Promise<void>;
  drain(context: ScheduledPostSyncContext): Promise<void>;
}

/**
 * Coalesces scheduled cohorts without attaching any input to two successful drains.
 * Failed snapshots restore their union without replacing reconcile inputs from newer cohorts.
 */
export function createPostSyncCoordinator(runPipeline: PostSyncPipelineRunner): PostSyncCoordinator {
  const pending = createPostSyncGraphInputCollector();
  let dirty = false;
  let queue: Promise<void> = Promise.resolve();

  async function drainDirty(context: ScheduledPostSyncContext): Promise<void> {
    while (dirty && pending.hasInputs()) {
      const snapshot = pending.take();
      dirty = false;
      try {
        await runPipeline({
          db: context.db,
          syncLogger: context.logger.child({ component: "scheduled-post-sync" }),
          ...snapshot,
          coMentionContributesToThreshold: context.coMentionContributesToThreshold,
          floorRetryMaxFilesPerDomain: context.floorRetryMaxFilesPerDomain,
        });
      } catch (err) {
        pending.restore(snapshot);
        dirty = true;
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
  };
}

const coordinators = new WeakMap<Kysely<DB>, PostSyncCoordinator>();

export function getPostSyncCoordinator(db: Kysely<DB>): PostSyncCoordinator {
  const existing = coordinators.get(db);
  if (existing) return existing;
  const coordinator = createPostSyncCoordinator(runPostSyncGraphPipeline);
  coordinators.set(db, coordinator);
  return coordinator;
}

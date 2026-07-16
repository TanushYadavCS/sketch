import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createTaskRepository } from "../db/repositories/tasks";
import { reconcileWorkCycles } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
import { sweepCoMentionContributesTo } from "../entities/co-mention-sweep";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { reconcileStructuralAssigneeContributesTo } from "../entities/structural-assignee";
import { floorRetryForDomains } from "./engagement-floor";
import { sweepDomainPromotions } from "./smart-enrichment";

export interface PostSyncGraphPipelineParams {
  db: Kysely<DB>;
  syncLogger: Logger;
  affectedIndexedFileIds: string[];
  sources: string[];
  workCycleReconciles: PostSyncWorkCycleReconcile[];
  coMentionContributesToThreshold?: number;
  floorRetryMaxFilesPerDomain?: number;
}

export interface PostSyncWorkCycleReconcile {
  connectorConfigId: string;
  syncRunId: string;
}

export interface PostSyncGraphInputs {
  affectedIndexedFileIds: string[];
  sources: string[];
  workCycleReconciles: PostSyncWorkCycleReconcile[];
}

export interface PostSyncGraphInputCollector {
  add(inputs: PostSyncGraphInputs): void;
  restore(inputs: PostSyncGraphInputs): void;
  take(): PostSyncGraphInputs;
  hasInputs(): boolean;
}

export function createPostSyncGraphInputCollector(): PostSyncGraphInputCollector {
  const affectedIndexedFileIds = new Set<string>();
  const sources = new Set<string>();
  const workCycleReconciles = new Map<string, PostSyncWorkCycleReconcile>();

  return {
    add(inputs) {
      for (const indexedFileId of inputs.affectedIndexedFileIds) affectedIndexedFileIds.add(indexedFileId);
      for (const source of inputs.sources) sources.add(source);
      for (const input of inputs.workCycleReconciles) {
        workCycleReconciles.set(input.connectorConfigId, input);
      }
    },
    restore(inputs) {
      for (const indexedFileId of inputs.affectedIndexedFileIds) affectedIndexedFileIds.add(indexedFileId);
      for (const source of inputs.sources) sources.add(source);
      for (const input of inputs.workCycleReconciles) {
        if (!workCycleReconciles.has(input.connectorConfigId)) {
          workCycleReconciles.set(input.connectorConfigId, input);
        }
      }
    },
    take() {
      const snapshot = {
        affectedIndexedFileIds: [...affectedIndexedFileIds],
        sources: [...sources],
        workCycleReconciles: [...workCycleReconciles.values()],
      };
      affectedIndexedFileIds.clear();
      sources.clear();
      workCycleReconciles.clear();
      return snapshot;
    },
    hasInputs() {
      return affectedIndexedFileIds.size > 0 || sources.size > 0 || workCycleReconciles.size > 0;
    },
  };
}

export async function runPostSyncGraphPipeline({
  db,
  syncLogger,
  affectedIndexedFileIds,
  sources,
  workCycleReconciles,
  coMentionContributesToThreshold,
  floorRetryMaxFilesPerDomain,
}: PostSyncGraphPipelineParams): Promise<void> {
  const materializeSummary = await materializeUnmaterializedFacts(db, syncLogger);
  if (materializeSummary.factsRead > 0) {
    syncLogger.info({ materializeSummary }, "Post-sync fact materialization complete");
  }
  const taskRepo = createTaskRepository(db);
  const reanchoredTasks = await taskRepo.reanchorNullParentTasks();
  let expiredTasks = 0;
  for (const source of sources) {
    expiredTasks += await taskRepo.expireOrphanedTasks(source);
  }
  if (reanchoredTasks.count > 0 || expiredTasks > 0) {
    syncLogger.info({ reanchoredTasks: reanchoredTasks.count, expiredTasks }, "Post-sync task sweep complete");
  }
  if (affectedIndexedFileIds.length > 0) {
    await reconcileStructuralAssigneeContributesTo(
      db,
      syncLogger.child({ component: "structural-assignee-producer" }),
      {
        scope: { kind: "files", indexedFileIds: affectedIndexedFileIds },
      },
    );
  }
  if (reanchoredTasks.taskIds.length > 0) {
    await reconcileStructuralAssigneeContributesTo(
      db,
      syncLogger.child({ component: "structural-assignee-producer" }),
      {
        scope: { kind: "tasks", taskIds: reanchoredTasks.taskIds },
      },
    );
  }
  for (const { connectorConfigId, syncRunId } of workCycleReconciles) {
    const closedWorkCycles = await reconcileWorkCycles(db, {
      connectorConfigId,
      syncRunId,
      at: new Date().toISOString(),
    });
    if (closedWorkCycles > 0) {
      syncLogger.info({ closedWorkCycles }, "Post-sync work cycle reconcile complete");
    }
  }

  const domainSweep = await sweepDomainPromotions(db, syncLogger.child({ component: "domain-sweep" }));
  if (domainSweep.promotedDomains.length > 0) {
    await floorRetryForDomains(
      { db, logger: syncLogger.child({ component: "domain-floor-retry" }) },
      domainSweep.promotedDomains,
      { maxFilesPerDomain: floorRetryMaxFilesPerDomain },
    );
  }

  await sweepCoMentionContributesTo(db, syncLogger.child({ component: "co-mention-sweep" }), {
    scope: { kind: "files", indexedFileIds: affectedIndexedFileIds },
    threshold: coMentionContributesToThreshold,
  });
}

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createTaskRepository } from "../db/repositories/tasks";
import { reconcileWorkCycles } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
import { sweepCoMentionContributesTo } from "../entities/co-mention-sweep";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { floorRetryForDomains } from "./engagement-floor";
import { sweepDomainPromotions } from "./smart-enrichment";

export interface PostSyncGraphPipelineParams {
  db: Kysely<DB>;
  syncLogger: Logger;
  affectedIndexedFileIds: string[];
  coMentionContributesToThreshold?: number;
  floorRetryMaxFilesPerDomain?: number;
  source?: string;
  syncRunId?: string;
  connectorConfigId?: string;
  experimentalFlag?: boolean;
  runCycleReconcile?: boolean;
}

export async function runPostSyncGraphPipeline({
  db,
  syncLogger,
  affectedIndexedFileIds,
  coMentionContributesToThreshold,
  floorRetryMaxFilesPerDomain,
  source,
  syncRunId,
  connectorConfigId,
  experimentalFlag,
  runCycleReconcile,
}: PostSyncGraphPipelineParams): Promise<void> {
  const materializeSummary = await materializeUnmaterializedFacts(db, syncLogger);
  if (materializeSummary.factsRead > 0) {
    syncLogger.info({ materializeSummary }, "Post-sync fact materialization complete");
  }
  const taskRepo = createTaskRepository(db);
  const reanchoredTasks = await taskRepo.reanchorNullParentTasks();
  const expiredTasks = await taskRepo.expireOrphanedTasks(source);
  if (reanchoredTasks > 0 || expiredTasks > 0) {
    syncLogger.info({ reanchoredTasks, expiredTasks }, "Post-sync task sweep complete");
  }
  if (experimentalFlag && runCycleReconcile && connectorConfigId && syncRunId) {
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

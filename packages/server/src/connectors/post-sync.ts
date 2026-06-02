import type { Kysely } from "kysely";
import type { Logger } from "pino";
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
}

export async function runPostSyncGraphPipeline({
  db,
  syncLogger,
  affectedIndexedFileIds,
  coMentionContributesToThreshold,
  floorRetryMaxFilesPerDomain,
}: PostSyncGraphPipelineParams): Promise<void> {
  const materializeSummary = await materializeUnmaterializedFacts(db, syncLogger);
  if (materializeSummary.factsRead > 0) {
    syncLogger.info({ materializeSummary }, "Post-sync fact materialization complete");
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

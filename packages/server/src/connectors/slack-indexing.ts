import { chunkSlackConversations } from "./slack-chunker";
import {
  DEFAULT_SLACK_SALIENCE_BATCH_LIMIT,
  SLACK_EMISSION_REFRESH_DAYS,
  archiveAllSlackChannelFiles,
  backfillSlackFileAccess,
  emitSlackSyncedItems,
  processSlackSalience,
  reconcileSlackChannelAcls,
} from "./slack-salience";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

function assertSystemCredentials(credentials: ConnectorCredentials): void {
  if (credentials.type !== "system") {
    throw new Error("Slack indexing connector requires system credentials");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Indexes Slack channels Sketch is a member of into the knowledge graph:
 * chunk captured messages into per-stream slices, gate them through LLM
 * salience, emit kept slices as indexed files, then reconcile channel ACLs
 * independent of emission. Membership is the opt-in — there is no per-channel
 * flag or registry.
 */
export function createSlackIndexingConnector(): Connector {
  return {
    type: "slack",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: false,

    async validateCredentials(credentials: ConnectorCredentials): Promise<void> {
      assertSystemCredentials(credentials);
    },

    async *sync({
      db,
      connectorConfigId,
      credentials,
      logger,
      scopeConfig,
      salienceGenerator,
      slackIndexing,
      appConfig,
    }): AsyncGenerator<SyncedItem> {
      assertSystemCredentials(credentials);
      if (!db) throw new Error("Slack indexing connector requires database access");
      if (!connectorConfigId) throw new Error("Slack indexing connector requires its connector config id");
      const grandfatheringEnabled = appConfig?.SLACK_ACCESS_GRANDFATHERING ?? true;
      const backfilledFileAccess = await backfillSlackFileAccess({ db, grandfatheringEnabled });
      if (backfilledFileAccess > 0) logger.info({ backfilledFileAccess }, "Backfilled Slack historical file access");
      if (!slackIndexing || !(await slackIndexing.isConfigured())) {
        await archiveAllSlackChannelFiles({ db, logger, connectorConfigId, grandfatheringEnabled });
        logger.warn("Slack indexing skipped: no Slack bot token configured");
        return;
      }

      await chunkSlackConversations({ db, logger });

      await processSlackSalience({
        db,
        logger,
        facade: slackIndexing,
        generator: salienceGenerator ?? null,
        batchLimit: positiveInteger(scopeConfig.salienceBatchLimit) ?? DEFAULT_SLACK_SALIENCE_BATCH_LIMIT,
      });

      let emitted = 0;
      let skippedNoScope = 0;
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: slackIndexing,
        emissionRefreshDays: positiveInteger(scopeConfig.emissionRefreshDays) ?? SLACK_EMISSION_REFRESH_DAYS,
        grandfatheringEnabled,
        onSkippedNoScope: () => {
          skippedNoScope += 1;
        },
      })) {
        emitted += 1;
        yield item;
      }

      await reconcileSlackChannelAcls({ db, logger, facade: slackIndexing, connectorConfigId, grandfatheringEnabled });
      logger.info({ emitted, skippedNoScope }, "Completed Slack indexing sync");
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}

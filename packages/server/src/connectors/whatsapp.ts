import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { BrowseResult, Connector, ConnectorCredentials, SyncedItem } from "./types";
import {
  type WhatsAppBackfillGraphKnobs,
  type WhatsAppChunkerKnobs,
  chunkWhatsAppIndexingGroups,
} from "./whatsapp-chunker";
import {
  DEFAULT_WHATSAPP_SALIENCE_BATCH_LIMIT,
  WHATSAPP_EMISSION_REFRESH_DAYS,
  emitWhatsAppSyncedItems,
  processWhatsAppSalience,
} from "./whatsapp-salience";

function assertSystemCredentials(credentials: ConnectorCredentials): void {
  if (credentials.type !== "system") {
    throw new Error("WhatsApp connector requires system credentials");
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function chunkerDefaultsFromScopeConfig(scopeConfig: Record<string, unknown>): Partial<WhatsAppChunkerKnobs> {
  return {
    gapMinutes: positiveInteger(scopeConfig.sliceGapMinutes),
    maxAgeMinutes: positiveInteger(scopeConfig.sliceMaxAgeMinutes),
    maxMessages: positiveInteger(scopeConfig.sliceMaxMessages),
  };
}

function salienceBatchLimitFromScopeConfig(scopeConfig: Record<string, unknown>): number {
  return positiveInteger(scopeConfig.salienceBatchLimit) ?? DEFAULT_WHATSAPP_SALIENCE_BATCH_LIMIT;
}

function emissionRefreshDaysFromScopeConfig(scopeConfig: Record<string, unknown>): number {
  return positiveInteger(scopeConfig.emissionRefreshDays) ?? WHATSAPP_EMISSION_REFRESH_DAYS;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function backfillGraphKnobsFromScopeConfig(scopeConfig: Record<string, unknown>): Partial<WhatsAppBackfillGraphKnobs> {
  return {
    pageMessages: positiveInteger(scopeConfig.backfillGraphPageMessages),
    pageTokens: positiveInteger(scopeConfig.backfillGraphPageTokens),
    cycleMessages: positiveInteger(scopeConfig.backfillGraphCycleMessages),
    pendingSlicesMax: nonNegativeInteger(scopeConfig.backfillGraphPendingSlicesMax),
    pendingFilesMax: nonNegativeInteger(scopeConfig.backfillGraphPendingFilesMax),
    openFactsMax: nonNegativeInteger(scopeConfig.backfillGraphOpenFactsMax),
  };
}

export function createWhatsAppConnector(): Connector {
  return {
    type: "whatsapp",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: false,

    async validateCredentials(credentials: ConnectorCredentials): Promise<void> {
      assertSystemCredentials(credentials);
    },

    async browse({ db, credentials }): Promise<BrowseResult> {
      assertSystemCredentials(credentials);
      if (!db) {
        throw new Error("WhatsApp connector requires database access");
      }
      const groups = await createWhatsAppGroupRepository(db).list();
      return {
        type: "flat",
        items: groups
          .map((group) => ({
            id: group.jid,
            name: group.name,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      };
    },

    async *sync({ db, credentials, logger, scopeConfig, salienceGenerator }): AsyncGenerator<SyncedItem> {
      assertSystemCredentials(credentials);
      if (!db) {
        throw new Error("WhatsApp connector requires database access");
      }
      const groups = await createWhatsAppGroupRepository(db).listIndexEnabled();
      logger.debug({ groupCount: groups.length }, "Loaded opted-in WhatsApp groups for indexing");
      await chunkWhatsAppIndexingGroups({
        db,
        groups,
        logger,
        defaultKnobs: chunkerDefaultsFromScopeConfig(scopeConfig),
        backfillGraphKnobs: backfillGraphKnobsFromScopeConfig(scopeConfig),
      });
      const salienceSummary = await processWhatsAppSalience({
        db,
        groups,
        logger,
        generator: salienceGenerator,
        batchLimit: salienceBatchLimitFromScopeConfig(scopeConfig),
      });
      let skippedNoScope = salienceSummary.skippedNoScope;
      let emitted = 0;
      for await (const item of emitWhatsAppSyncedItems({
        db,
        logger,
        emissionRefreshDays: emissionRefreshDaysFromScopeConfig(scopeConfig),
        onSkippedNoScope: () => {
          skippedNoScope += 1;
        },
      })) {
        emitted += 1;
        yield item;
      }
      logger.info({ emitted, skippedNoScope }, "Completed WhatsApp synced item emission");
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}

import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";
import { type WhatsAppChunkerKnobs, chunkWhatsAppIndexingGroups } from "./whatsapp-chunker";

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

export function createWhatsAppConnector(): Connector {
  return {
    type: "whatsapp",
    perUserAuth: false,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials: ConnectorCredentials): Promise<void> {
      assertSystemCredentials(credentials);
    },

    async *sync({ db, credentials, logger, scopeConfig }): AsyncGenerator<SyncedItem> {
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
      });
      yield* [] as SyncedItem[];
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}

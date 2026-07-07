import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

function assertSystemCredentials(credentials: ConnectorCredentials): void {
  if (credentials.type !== "system") {
    throw new Error("WhatsApp connector requires system credentials");
  }
}

export function createWhatsAppConnector(): Connector {
  return {
    type: "whatsapp",
    perUserAuth: false,
    requiresOAuthClientSetup: false,

    async validateCredentials(credentials: ConnectorCredentials): Promise<void> {
      assertSystemCredentials(credentials);
    },

    async *sync({ db, credentials, logger }): AsyncGenerator<SyncedItem> {
      assertSystemCredentials(credentials);
      if (!db) {
        throw new Error("WhatsApp connector requires database access");
      }
      const groups = await createWhatsAppGroupRepository(db).listIndexEnabled();
      logger.debug({ groupCount: groups.length }, "Loaded opted-in WhatsApp groups for indexing");
      yield* [] as SyncedItem[];
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}

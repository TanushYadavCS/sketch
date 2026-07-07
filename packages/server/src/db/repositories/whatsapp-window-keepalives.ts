import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, WhatsAppWindowKeepAlivesTable } from "../schema";

export type WhatsAppWindowKeepAliveRow = Selectable<WhatsAppWindowKeepAlivesTable>;

export function createWhatsAppWindowKeepAliveRepository(db: Kysely<DB>) {
  return {
    async get(recipientUserId: string): Promise<WhatsAppWindowKeepAliveRow | undefined> {
      return db
        .selectFrom("whatsapp_window_keepalives")
        .selectAll()
        .where("recipient_user_id", "=", recipientUserId)
        .executeTakeFirst();
    },

    async recordAttempt(recipientUserId: string, sentAt: string): Promise<WhatsAppWindowKeepAliveRow> {
      const existing = await this.get(recipientUserId);
      if (existing) {
        await db
          .updateTable("whatsapp_window_keepalives")
          .set({ sent_at: sentAt, updated_at: sql<string>`CURRENT_TIMESTAMP` })
          .where("recipient_user_id", "=", recipientUserId)
          .execute();
        return db
          .selectFrom("whatsapp_window_keepalives")
          .selectAll()
          .where("recipient_user_id", "=", recipientUserId)
          .executeTakeFirstOrThrow();
      }

      try {
        await db
          .insertInto("whatsapp_window_keepalives")
          .values({ recipient_user_id: recipientUserId, sent_at: sentAt })
          .execute();
      } catch {
        await db
          .updateTable("whatsapp_window_keepalives")
          .set({ sent_at: sentAt, updated_at: sql<string>`CURRENT_TIMESTAMP` })
          .where("recipient_user_id", "=", recipientUserId)
          .execute();
      }

      return db
        .selectFrom("whatsapp_window_keepalives")
        .selectAll()
        .where("recipient_user_id", "=", recipientUserId)
        .executeTakeFirstOrThrow();
    },
  };
}

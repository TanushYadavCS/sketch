import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export function createInboxMessagesRepository(db: Kysely<DB>) {
  return {
    async create(data: {
      senderUserId: string;
      recipientUserId: string;
      message: string;
      platform: string;
      channelId?: string;
      messageRef?: string;
    }) {
      const id = randomUUID();
      await db
        .insertInto("inbox_messages")
        .values({
          id,
          sender_user_id: data.senderUserId,
          recipient_user_id: data.recipientUserId,
          message: data.message,
          platform: data.platform,
          channel_id: data.channelId ?? null,
          message_ref: data.messageRef ?? null,
        })
        .execute();

      return db.selectFrom("inbox_messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async listPendingForRecipient(recipientUserId: string) {
      return db
        .selectFrom("inbox_messages")
        .selectAll()
        .where("recipient_user_id", "=", recipientUserId)
        .where("consumed_at", "is", null)
        .orderBy("created_at", "asc")
        .execute();
    },

    async markConsumed(ids: string[], consumedAt = new Date().toISOString()) {
      if (ids.length === 0) return;

      await db
        .updateTable("inbox_messages")
        .set({ consumed_at: consumedAt })
        .where("id", "in", ids)
        .where("consumed_at", "is", null)
        .execute();
    },
  };
}

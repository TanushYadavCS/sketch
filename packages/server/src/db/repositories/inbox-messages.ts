import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createInboxMessagesRepository(db: Kysely<DB>) {
  return {
    async create(data: {
      senderUserId: string;
      recipientUserId: string;
      message: string;
      kind?: string;
      metadata?: Record<string, unknown> | null;
      resolutionMode?: string;
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
          kind: data.kind ?? "note",
          metadata: data.metadata == null ? null : JSON.stringify(data.metadata),
          resolution_mode: data.resolutionMode ?? "auto_consume",
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
        .where(({ eb, and, or }) =>
          or([
            and([
              eb("resolution_mode", "=", "auto_consume"),
              eb("consumed_at", "is", null),
              eb("resolved_at", "is", null),
            ]),
            and([eb("resolution_mode", "=", "explicit"), eb("resolved_at", "is", null)]),
          ]),
        )
        .orderBy("created_at", "asc")
        .execute();
    },

    async findById(id: string) {
      return db.selectFrom("inbox_messages").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async updateWorkflow(id: string, metadata: Record<string, unknown>) {
      const existing = await db.selectFrom("inbox_messages").selectAll().where("id", "=", id).executeTakeFirst();
      if (!existing || existing.resolution_mode !== "explicit" || existing.resolved_at) return undefined;

      const merged = { ...(parseMetadata(existing.metadata) ?? {}), ...metadata };
      await db
        .updateTable("inbox_messages")
        .set({ metadata: JSON.stringify(merged) })
        .where("id", "=", id)
        .where("resolution_mode", "=", "explicit")
        .where("resolved_at", "is", null)
        .execute();

      return db.selectFrom("inbox_messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async resolve(id: string, resolvedAt = new Date().toISOString()) {
      await db
        .updateTable("inbox_messages")
        .set({ resolved_at: resolvedAt })
        .where("id", "=", id)
        .where("resolution_mode", "=", "explicit")
        .where("resolved_at", "is", null)
        .execute();

      return db.selectFrom("inbox_messages").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async markConsumed(ids: string[], consumedAt = new Date().toISOString()) {
      if (ids.length === 0) return;

      await db
        .updateTable("inbox_messages")
        .set({ consumed_at: consumedAt })
        .where("id", "in", ids)
        .where("resolution_mode", "=", "auto_consume")
        .where("consumed_at", "is", null)
        .where("resolved_at", "is", null)
        .execute();
    },
  };
}

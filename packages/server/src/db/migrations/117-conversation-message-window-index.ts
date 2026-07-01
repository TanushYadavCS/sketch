import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_conversation_messages_window")
    .on("conversation_messages")
    .columns(["conversation_id", "received_at", "id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_conversation_messages_window").execute();
}

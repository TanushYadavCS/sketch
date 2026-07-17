import { type Kysely, sql } from "kysely";
import { effectiveWhatsAppMessageTimestamp } from "../../whatsapp/provider-timestamp";
import type { DB } from "../schema";

const BACKFILL_BATCH_SIZE = 500;

async function backfillEffectiveAt(db: Kysely<DB>): Promise<void> {
  const now = new Date();
  let lastId = 0;

  for (;;) {
    const rows = await db
      .selectFrom("conversation_messages")
      .select(["id", "provider_timestamp", "received_at"])
      .where("id", ">", lastId)
      .orderBy("id", "asc")
      .limit(BACKFILL_BATCH_SIZE)
      .execute();
    if (rows.length === 0) return;

    const cases = rows.map(
      (row) =>
        sql`WHEN ${row.id} THEN ${effectiveWhatsAppMessageTimestamp(row.provider_timestamp, row.received_at, now)}`,
    );
    const ids = rows.map((row) => row.id);
    await sql`UPDATE conversation_messages
      SET effective_at = CASE id ${sql.join(cases, sql.raw(" "))} END
      WHERE id IN (${sql.join(ids)})`.execute(db);
    lastId = rows[rows.length - 1]?.id ?? lastId;
  }
}

async function bootstrapLiveStarts(db: Kysely<DB>): Promise<void> {
  const conversations = await db
    .selectFrom("conversation_messages as message")
    .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
    .select(["message.conversation_id as conversation_id", "conversation.provider_conversation_id as group_jid"])
    .select((eb) => eb.fn.min<string>("message.effective_at").as("live_start_effective_at"))
    .where("conversation.platform", "=", "whatsapp")
    .where("conversation.kind", "=", "group")
    .groupBy(["message.conversation_id", "conversation.provider_conversation_id"])
    .execute();

  for (const conversation of conversations) {
    if (!conversation.live_start_effective_at) continue;
    const first = await db
      .selectFrom("conversation_messages")
      .select("id")
      .where("conversation_id", "=", conversation.conversation_id)
      .where("effective_at", "=", conversation.live_start_effective_at)
      .orderBy("id", "asc")
      .executeTakeFirst();
    if (!first) continue;

    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: conversation.group_jid,
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: conversation.live_start_effective_at,
        live_start_message_id: first.id,
      })
      .onConflict((oc) =>
        oc.column("group_jid").doUpdateSet({
          live_start_effective_at: sql`COALESCE(whatsapp_backfill_checkpoints.live_start_effective_at, excluded.live_start_effective_at)`,
          live_start_message_id: sql`COALESCE(whatsapp_backfill_checkpoints.live_start_message_id, excluded.live_start_message_id)`,
        }),
      )
      .execute();
  }
}

export async function up(rawDb: Kysely<unknown>): Promise<void> {
  const db = rawDb as Kysely<DB>;
  await rawDb.schema
    .alterTable("conversation_messages")
    .addColumn("source", "text", (col) => col.notNull().defaultTo("live"))
    .execute();
  await rawDb.schema.alterTable("conversation_messages").addColumn("effective_at", "text").execute();
  await rawDb.schema.alterTable("conversation_messages").addColumn("connection_key", "text").execute();
  await rawDb.schema.alterTable("conversation_messages").addColumn("backfill_range_id", "text").execute();
  await rawDb.schema.alterTable("whatsapp_backfill_checkpoints").addColumn("live_start_effective_at", "text").execute();
  await rawDb.schema
    .alterTable("whatsapp_backfill_checkpoints")
    .addColumn("live_start_message_id", "integer")
    .execute();

  await backfillEffectiveAt(db);
  await rawDb.schema
    .createIndex("idx_conversation_messages_effective")
    .on("conversation_messages")
    .columns(["conversation_id", "effective_at", "id"])
    .execute();
  await bootstrapLiveStarts(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_conversation_messages_effective").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").dropColumn("live_start_message_id").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").dropColumn("live_start_effective_at").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("backfill_range_id").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("connection_key").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("effective_at").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("source").execute();
}

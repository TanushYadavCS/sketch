import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_backfill_ranges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("group_jid", "text", (col) => col.notNull())
    .addColumn("range_key", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("connection_key", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("lower_bound_at", "text", (col) => col.notNull())
    .addColumn("upper_bound_at", "text", (col) => col.notNull())
    .addColumn("cursor_remote_jid", "text")
    .addColumn("cursor_message_id", "text")
    .addColumn("cursor_from_me", "integer")
    .addColumn("cursor_provider_timestamp", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_retry_at", "text")
    .addColumn("last_error", "text")
    .addColumn("claim_token", "text")
    .addColumn("claimed_at", "text")
    .addColumn("request_session_id", "text")
    .addColumn("request_lease_generation", "integer")
    .addColumn("requested_at", "text")
    .addColumn("response_deadline_at", "text")
    .addColumn("terminal_status", "text")
    .addColumn("last_served_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("whatsapp_backfill_ranges_group_range_key_uidx", ["group_jid", "range_key"])
    .addCheckConstraint("whatsapp_backfill_ranges_kind_check", sql`kind IN ('initial', 'gap')`)
    .addCheckConstraint(
      "whatsapp_backfill_ranges_status_check",
      sql`status IN ('awaiting_anchor', 'pending', 'claimed', 'in_flight', 'materializing', 'complete', 'exhausted')`,
    )
    .addCheckConstraint(
      "whatsapp_backfill_ranges_terminal_status_check",
      sql`terminal_status IS NULL OR terminal_status IN ('complete', 'exhausted')`,
    )
    .execute();

  await db.schema
    .createIndex("whatsapp_backfill_ranges_work_idx")
    .on("whatsapp_backfill_ranges")
    .columns(["status", "next_retry_at", "last_served_at", "created_at"])
    .execute();
  await db.schema
    .createIndex("whatsapp_backfill_ranges_connection_idx")
    .on("whatsapp_backfill_ranges")
    .columns(["group_jid", "connection_key"])
    .execute();

  await db.schema.alterTable("whatsapp_inbound_events").addColumn("request_session_id", "text").execute();
  await db.schema.alterTable("whatsapp_inbound_events").addColumn("backfill_range_id", "text").execute();
  await db.schema
    .alterTable("conversation_messages")
    .addColumn("provider_from_me", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await sql`UPDATE conversation_messages SET provider_from_me = 1 WHERE is_bot = 1`.execute(db);
  await db.schema
    .createIndex("whatsapp_inbound_events_request_session_idx")
    .on("whatsapp_inbound_events")
    .column("request_session_id")
    .execute();
  await db.schema
    .createIndex("whatsapp_inbound_events_backfill_range_idx")
    .on("whatsapp_inbound_events")
    .column("backfill_range_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("whatsapp_inbound_events_backfill_range_idx").execute();
  await db.schema.dropIndex("whatsapp_inbound_events_request_session_idx").execute();
  await db.schema.alterTable("whatsapp_inbound_events").dropColumn("backfill_range_id").execute();
  await db.schema.alterTable("whatsapp_inbound_events").dropColumn("request_session_id").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("provider_from_me").execute();
  await db.schema.dropTable("whatsapp_backfill_ranges").execute();
}

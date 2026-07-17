import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_backfill_ranges").addColumn("graph_cursor_effective_at", "text").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").addColumn("graph_cursor_message_id", "integer").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").addColumn("graph_completed_at", "text").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").addColumn("graph_last_served_at", "text").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").addColumn("graph_halted_at", "text").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").addColumn("graph_halt_reason", "text").execute();
  await db.schema
    .createIndex("whatsapp_backfill_ranges_graph_work_idx")
    .on("whatsapp_backfill_ranges")
    .columns(["status", "graph_completed_at", "group_jid", "lower_bound_at", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("whatsapp_backfill_ranges_graph_work_idx").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").dropColumn("graph_halt_reason").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").dropColumn("graph_halted_at").execute();
  await db.schema.alterTable("whatsapp_backfill_checkpoints").dropColumn("graph_last_served_at").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").dropColumn("graph_completed_at").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").dropColumn("graph_cursor_message_id").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").dropColumn("graph_cursor_effective_at").execute();
}

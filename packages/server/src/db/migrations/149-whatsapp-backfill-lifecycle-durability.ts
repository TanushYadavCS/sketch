import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_backfill_ranges").addColumn("parent_range_id", "text").execute();
  await db.schema
    .createIndex("whatsapp_backfill_ranges_parent_idx")
    .on("whatsapp_backfill_ranges")
    .column("parent_range_id")
    .execute();

  await db.schema
    .createTable("whatsapp_connection_transitions")
    .addColumn("connection_key", "text", (col) => col.primaryKey())
    .addColumn("lease_generation", "integer", (col) => col.notNull())
    .addColumn("socket_generation", "integer", (col) => col.notNull())
    .addColumn("disconnected_at", "text")
    .addColumn("connected_at", "text", (col) => col.notNull())
    .addColumn("reconciled_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
  await db.schema
    .createIndex("whatsapp_connection_transitions_reconcile_idx")
    .on("whatsapp_connection_transitions")
    .columns(["reconciled_at", "connected_at", "connection_key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("whatsapp_connection_transitions").execute();
  await db.schema.dropIndex("whatsapp_backfill_ranges_parent_idx").execute();
  await db.schema.alterTable("whatsapp_backfill_ranges").dropColumn("parent_range_id").execute();
}

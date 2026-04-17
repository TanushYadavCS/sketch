/**
 * Add sync_interval_minutes to settings table.
 * Controls the global sync scheduler frequency (default: 30 minutes).
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("settings")
    .addColumn("sync_interval_minutes", "integer", (col) => col.defaultTo(30))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").dropColumn("sync_interval_minutes").execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("slack_file_access_backfill").addColumn("claimed_at", "text").execute();
  await db.schema.alterTable("slack_file_access_backfill").addColumn("last_indexed_file_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("slack_file_access_backfill").dropColumn("last_indexed_file_id").execute();
  await db.schema.alterTable("slack_file_access_backfill").dropColumn("claimed_at").execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("indexed_file_facts")
    .addColumn("connector_config_id", "text", (col) => col.references("connector_configs.id").onDelete("set null"))
    .execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("created_by_user_id", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("last_seen_sync_run_id", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("deleted_at", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("content_hash", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("materialized_at", "text").execute();

  await db.schema
    .createIndex("idx_indexed_file_facts_materialize")
    .on("indexed_file_facts")
    .columns(["deleted_at", "materialized_at"])
    .execute();

  await db.schema
    .createIndex("idx_indexed_file_facts_connector_sync")
    .on("indexed_file_facts")
    .columns(["connector_config_id", "last_seen_sync_run_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_indexed_file_facts_connector_sync").ifExists().execute();
  await db.schema.dropIndex("idx_indexed_file_facts_materialize").ifExists().execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("materialized_at").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("content_hash").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("deleted_at").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("last_seen_sync_run_id").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("created_by_user_id").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("connector_config_id").execute();
}

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_files").addColumn("rollup_group_id", "text").execute();

  await db.schema
    .createIndex("idx_indexed_files_rollup_group")
    .on("indexed_files")
    .columns(["connector_config_id", "rollup_group_id"])
    .execute();

  await db.schema
    .createTable("crm_object_summaries")
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("group_id", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("activity_count", "integer", (col) => col.notNull())
    .addColumn("basis_first_at", "text")
    .addColumn("basis_last_at", "text")
    .addColumn("basis_hash", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("crm_object_summaries_pk", ["connector_config_id", "group_id"])
    .execute();

  await db.schema
    .createIndex("idx_crm_object_summaries_updated")
    .on("crm_object_summaries")
    .columns(["updated_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_crm_object_summaries_updated").execute();
  await db.schema.dropTable("crm_object_summaries").execute();
  await db.schema.dropIndex("idx_indexed_files_rollup_group").execute();
  await db.schema.alterTable("indexed_files").dropColumn("rollup_group_id").execute();
}

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_project_member_overrides")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("mode", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull().references("users.id").onDelete("restrict"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
  await db.schema
    .createIndex("idx_entity_project_member_overrides_entity")
    .on("entity_project_member_overrides")
    .column("entity_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_project_member_overrides_unique")
    .on("entity_project_member_overrides")
    .columns(["entity_id", "indexed_file_id"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_indexed_file_facts_parent_container")
    .on("indexed_file_facts")
    .columns(["subject_source", "subject_source_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_indexed_file_facts_parent_container").execute();
  await db.schema.dropTable("entity_project_member_overrides").execute();
}

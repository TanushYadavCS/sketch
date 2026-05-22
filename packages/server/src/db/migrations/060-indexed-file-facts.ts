import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("indexed_file_facts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("indexed_file_id", "text", (col) => col.references("indexed_files.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("fact_type", "text", (col) => col.notNull())
    .addColumn("relation", "text", (col) => col.notNull())
    .addColumn("subject_name", "text")
    .addColumn("subject_email", "text")
    .addColumn("subject_source", "text")
    .addColumn("subject_source_id", "text")
    .addColumn("context_snippet", "text")
    .addColumn("raw", "text")
    .addColumn("fact_key", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_indexed_file_facts_file")
    .on("indexed_file_facts")
    .column("indexed_file_id")
    .execute();

  await db.schema
    .createIndex("idx_indexed_file_facts_source_type")
    .on("indexed_file_facts")
    .columns(["source", "fact_type"])
    .execute();

  await db.schema
    .createIndex("idx_indexed_file_facts_email")
    .on("indexed_file_facts")
    .column("subject_email")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("indexed_file_facts").execute();
}

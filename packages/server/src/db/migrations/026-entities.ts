import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entities")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("source_type", "text", (col) => col.notNull())
    .addColumn("subtype", "text")
    .addColumn("aliases", "text")
    .addColumn("metadata", "text")
    .addColumn("source_ref_id", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("confirmed"))
    .addColumn("hotness", "real", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_entities_source_type").on("entities").columns(["source_type"]).execute();
  await db.schema.createIndex("idx_entities_status").on("entities").columns(["status"]).execute();
  await db.schema.createIndex("idx_entities_hotness").on("entities").columns(["hotness"]).execute();

  await db.schema
    .createTable("entity_source_refs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("source_id", "text", (col) => col.notNull())
    .addColumn("source_url", "text")
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_entity_source_refs_source_id")
    .on("entity_source_refs")
    .columns(["source", "source_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_entity_source_refs_entity")
    .on("entity_source_refs")
    .columns(["entity_id"])
    .execute();

  await db.schema
    .createTable("entity_mentions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("chunk_index", "integer")
    .addColumn("context_snippet", "text")
    .addColumn("mentioned_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_entity_mentions_entity").on("entity_mentions").columns(["entity_id"]).execute();

  await db.schema.createIndex("idx_entity_mentions_file").on("entity_mentions").columns(["indexed_file_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_mentions").execute();
  await db.schema.dropTable("entity_source_refs").execute();
  await db.schema.dropTable("entities").execute();
}

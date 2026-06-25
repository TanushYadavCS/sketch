import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("entities").addColumn("deleted_at", "text").execute();
  await db.schema
    .alterTable("entities")
    .addColumn("merged_into_entity_id", "text", (col) => col.references("entities.id").onDelete("restrict"))
    .execute();

  await db.schema
    .createTable("entity_merges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("survivor_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("merged_entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("restrict"))
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("moves", "text", (col) => col.notNull())
    .addColumn("merged_by_user_id", "text", (col) => col.notNull().references("users.id").onDelete("restrict"))
    .addColumn("merged_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("unmerged_at", "text")
    .addColumn("unmerged_by_user_id", "text", (col) => col.references("users.id").onDelete("restrict"))
    .execute();

  await db.schema.createIndex("entity_merges_survivor_idx").on("entity_merges").column("survivor_entity_id").execute();
  await db.schema.createIndex("entity_merges_merged_idx").on("entity_merges").column("merged_entity_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_merges").execute();
  await db.schema.alterTable("entities").dropColumn("merged_into_entity_id").execute();
  await db.schema.alterTable("entities").dropColumn("deleted_at").execute();
}

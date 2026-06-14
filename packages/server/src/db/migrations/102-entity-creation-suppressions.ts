import { type Kysely, sql } from "kysely";

/**
 * Durable suppression of entity (re)creation, keyed on (normalized_name,
 * entity_type). Written when an admin soft-deletes an entity so the loose LLM
 * creation paths (mention promotion + relation endpoints) do not re-mint the
 * same junk on the next enrichment. Consulted only by those LLM paths — the
 * deterministic structural birth gate and manual admin creation are not gated.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_creation_suppressions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("normalized_name", "text", (col) => col.notNull())
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("original_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("reason", "text")
    .addColumn("created_by", "text", (col) => col.notNull().references("users.id").onDelete("restrict"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_entity_creation_suppressions_unique")
    .on("entity_creation_suppressions")
    .columns(["normalized_name", "entity_type"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_creation_suppressions").execute();
}

/**
 * Smart enrichment: summary_status column + entity_candidates table.
 *
 * - summary_status tracks AI-generated summary progress per file
 * - entity_candidates stores unmatched entity mentions for multi-file confirmation
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add summary_status to indexed_files
  await db.schema
    .alterTable("indexed_files")
    .addColumn("summary_status", "text", (col) => col.notNull().defaultTo("pending"))
    .execute();

  // Entity candidates table for multi-file confirmation
  await db.schema
    .createTable("entity_candidates")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("variations", "text")
    .addColumn("first_seen_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("seen_file_ids", "text", (col) => col.notNull())
    .addColumn("seen_count", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("promoted_entity_id", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema.createIndex("idx_entity_candidates_name").on("entity_candidates").columns(["name"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_candidates").execute();
  // SQLite can't drop columns, but Postgres can
  try {
    await db.schema.alterTable("indexed_files").dropColumn("summary_status").execute();
  } catch {
    // SQLite: column remains but is unused
  }
}

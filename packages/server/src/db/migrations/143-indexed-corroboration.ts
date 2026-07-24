import { type Kysely, sql } from "kysely";

const LLM_CORROBORATION_INDEX = "idx_indexed_file_facts_llm_corroboration";
const LLM_THIRD_PARTY_INDEX = "idx_indexed_file_facts_llm_third_party";
const FEATURE_CORROBORATION_INDEX = "idx_indexed_file_facts_feature_corroboration";

/**
 * Fix 2b groundwork: nullable normalization projections that let corroboration
 * counting, third-party mention lookup, and feature corroboration run as indexed
 * SQL instead of table-wide `raw` payload scans.
 *
 * The columns are populated by new fact writes (see `indexed-file-facts.ts`) and,
 * for rows written before this migration, by the post-startup normalization
 * backfill. Readers stay on the legacy JS scan until that backfill marks itself
 * complete, so this migration deliberately rewrites no existing row.
 *
 * `normalization_backfill_state` holds the single durable cursor for that
 * backfill; it is a Fix 2b table, unrelated to the deferred Fix 3 event tables.
 *
 * `normalization_projected_at` marks a row whose projections have been applied by
 * the write path or the backfill. It is the backfill's completion invariant: the
 * marker flips to complete only when no projected-type row still has a NULL
 * marker, which a nullable projection column alone cannot express (a valid row
 * can legitimately project to all-NULL columns).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_file_facts").addColumn("normalized_subject_name", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("normalized_mention_name", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("raw_mention_type", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("mention_type", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("feature_corroboration_key", "text").execute();
  await db.schema.alterTable("indexed_file_facts").addColumn("normalization_projected_at", "text").execute();

  await db.schema
    .createIndex(LLM_CORROBORATION_INDEX)
    .on("indexed_file_facts")
    .columns(["raw_mention_type", "normalized_subject_name", "indexed_file_id"])
    .where(sql.ref("fact_type"), "=", "llm_extracted")
    .where(sql.ref("deleted_at"), "is", null)
    .execute();

  await db.schema
    .createIndex(LLM_THIRD_PARTY_INDEX)
    .on("indexed_file_facts")
    .columns(["raw_mention_type", "normalized_mention_name"])
    .where(sql.ref("fact_type"), "=", "llm_extracted")
    .where(sql.ref("deleted_at"), "is", null)
    .where(sql.ref("source"), "=", "llm_extraction")
    .execute();

  await db.schema
    .createIndex(FEATURE_CORROBORATION_INDEX)
    .on("indexed_file_facts")
    .columns(["feature_corroboration_key"])
    .where(sql.ref("fact_type"), "=", "feature")
    .where(sql.ref("deleted_at"), "is", null)
    .execute();

  await db.schema
    .createTable("normalization_backfill_state")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("cursor_created_at", "text")
    .addColumn("cursor_id", "text")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db
    .insertInto("normalization_backfill_state" as never)
    .values({ id: "v1", status: "pending", cursor_created_at: null, cursor_id: null } as never)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("normalization_backfill_state").ifExists().execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("normalization_projected_at").execute();
  await db.schema.dropIndex(FEATURE_CORROBORATION_INDEX).ifExists().execute();
  await db.schema.dropIndex(LLM_THIRD_PARTY_INDEX).ifExists().execute();
  await db.schema.dropIndex(LLM_CORROBORATION_INDEX).ifExists().execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("feature_corroboration_key").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("mention_type").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("raw_mention_type").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("normalized_mention_name").execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("normalized_subject_name").execute();
}

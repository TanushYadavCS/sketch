/**
 * Cluster verdict storage for the project-minting pass (PR-P2).
 *
 * One row per stage-3 verdict. Nothing here writes entities: a verdict is a
 * proposal a human reads against its dossier. `status` stays "pending" until
 * PR-P3 adds the review surface; re-running a cluster supersedes the previous
 * pending row (`superseded_at`) rather than mutating it, so verdict history
 * survives re-runs.
 */
import { type Kysely, sql } from "kysely";

const TABLE = "project_minting_verdicts";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("company_entity_id", "text", (col) => col.notNull())
    .addColumn("company_name", "text", (col) => col.notNull())
    .addColumn("file_count", "integer", (col) => col.notNull())
    .addColumn("dossier", "text", (col) => col.notNull())
    .addColumn("verdict", "text", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("prompt_version", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("superseded_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
  await db.schema
    .createIndex("idx_project_minting_verdicts_company_status")
    .on(TABLE)
    .columns(["company_entity_id", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).execute();
}

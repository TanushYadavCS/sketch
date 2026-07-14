import { type Kysely, sql } from "kysely";

const OPEN_MATERIALIZABLE_INDEX = "idx_indexed_file_facts_open_materializable";

/**
 * Adds the input fingerprint used to preserve completed materialization verdicts
 * across unchanged fact upserts, plus the bounded partial index used by backlog
 * sweeps on both SQLite and Postgres.
 *
 * The literal 5 in the index predicate mirrors MAX_MATERIALIZATION_ATTEMPTS
 * (materialize-replay.ts) at migration time and must stay frozen even if that
 * constant changes later; migrations are immutable history, so a future cap
 * change requires a new migration that rebuilds this index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_file_facts").addColumn("materialization_input_hash", "text").execute();

  await db.schema
    .createIndex(OPEN_MATERIALIZABLE_INDEX)
    .on("indexed_file_facts")
    .columns(["fact_type", "created_at", "id"])
    .where(sql.ref("deleted_at"), "is", null)
    .where(sql.ref("materialized_at"), "is", null)
    .where(sql.ref("materialization_attempts"), "<", 5)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(OPEN_MATERIALIZABLE_INDEX).ifExists().execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("materialization_input_hash").execute();
}

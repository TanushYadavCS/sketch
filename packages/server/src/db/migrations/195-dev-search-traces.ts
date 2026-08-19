import { type Kysely, sql } from "kysely";

/**
 * Captured traces of real `Search` tool calls, for the dev-tools search tab.
 *
 * Written only while `DEV_TOOLS_ENABLED` is on, so the table is created everywhere but
 * stays empty on a deployment that never enabled the flag.
 *
 * `user_id` and `conversation_id` are nullable because automation steps and public-MCP
 * clients reach `handleSearch` without either. No foreign key to `users`: a trace is a
 * debugging record, and losing the whole trace because its user row was deleted would
 * remove evidence at exactly the moment someone wants it.
 *
 * Stages live in one JSON column rather than a child table. Nothing ever queries by
 * stage — they are always read together with their trace — so a second table would buy a
 * join and a cascade and nothing else.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("dev_search_traces")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("origin", "text", (col) => col.notNull())
    .addColumn("user_id", "text")
    .addColumn("conversation_id", "integer")
    .addColumn("query", "text", (col) => col.notNull())
    .addColumn("args_json", "text", (col) => col.notNull())
    .addColumn("principals_json", "text", (col) => col.notNull())
    .addColumn("stages_json", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error", "text")
    .addColumn("result_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("duration_ms", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  /**
   * Both the feed's ordering and prune-on-insert read this. The `id` tiebreak matters:
   * `CURRENT_TIMESTAMP` is second-precision on SQLite, so without it two traces landing in
   * the same second make "the newest 500" nondeterministic.
   */
  await db.schema
    .createIndex("idx_dev_search_traces_recent")
    .on("dev_search_traces")
    .columns(["started_at", "id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_dev_search_traces_recent").execute();
  await db.schema.dropTable("dev_search_traces").execute();
}

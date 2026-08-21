import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

/**
 * What a traced `Search` actually handed back, and any answers synthesised from it.
 *
 * Child tables rather than more JSON on `dev_search_traces`: the trace row is read on
 * every feed render, and result text would be dragged into every list query for nothing.
 * Separate tables also let the text age out on its own while the ranking data survives.
 *
 * `created_at_ms` is epoch millis, so it must be `bigint` on Postgres: `integer` there is
 * int4, which caps at 2,147,483,647 while `Date.now()` is already ~1.79e12. SQLite's
 * INTEGER is 64-bit and accepts it either way, which is why this only bites on Postgres.
 *
 * It is epoch millis rather than a timestamp string. The existing `started_at`
 * uses `CURRENT_TIMESTAMP`, which SQLite renders space-separated (`2026-08-20 06:36:54`)
 * while `toISOString()` uses a `T`. Space sorts below `T`, so a lexical `<` against an
 * ISO cutoff treats every row as expired and empties the table on the first prune —
 * on SQLite only, so Postgres tests pass. Integers have no format to disagree about.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("dev_search_trace_results")
    .addColumn("trace_id", "text", (col) => col.notNull().references("dev_search_traces.id").onDelete("cascade"))
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("hit_file_id", "text", (col) => col.notNull())
    .addColumn("result_kind", "text", (col) => col.notNull())
    .addColumn("file_name", "text", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("provider_url", "text")
    /** The rendered block the agent received, verbatim — summary or snippet, cut at 200. */
    .addColumn("agent_text", "text", (col) => col.notNull())
    /** The untruncated text behind it, so the page can show what the agent did not see. */
    .addColumn("snippet", "text")
    .addColumn("summary", "text")
    .addColumn("score", "real", (col) => col.notNull())
    .addColumn("similarity", "real")
    .addColumn("created_at_ms", isPg(db) ? "bigint" : "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("dev_search_trace_results_pk", ["trace_id", "position"])
    .execute();

  await db.schema
    .createIndex("idx_dev_search_trace_results_age")
    .on("dev_search_trace_results")
    .column("created_at_ms")
    .execute();

  await db.schema
    .createTable("dev_search_syntheses")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("trace_id", "text", (col) => col.notNull().references("dev_search_traces.id").onDelete("cascade"))
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    /** Stored so a surprising answer can be diagnosed without re-deriving what was sent. */
    .addColumn("prompt", "text", (col) => col.notNull())
    .addColumn("answer", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error", "text")
    .addColumn("duration_ms", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at_ms", isPg(db) ? "bigint" : "integer", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_dev_search_syntheses_trace")
    .on("dev_search_syntheses")
    .columns(["trace_id", "created_at_ms"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("dev_search_syntheses").ifExists().execute();
  await db.schema.dropTable("dev_search_trace_results").ifExists().execute();
}

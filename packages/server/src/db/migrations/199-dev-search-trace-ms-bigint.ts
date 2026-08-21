import type { Kysely } from "kysely";
import { isPg } from "../dialect";

/**
 * Widens `created_at_ms` to `bigint` on Postgres, where migration 198 first created it
 * as `integer`.
 *
 * `integer` is int4 on Postgres and caps at 2,147,483,647, but these columns hold
 * `Date.now()` — already ~1.79e12. Every insert failed with `value "1787229046476" is
 * out of range for type integer`, and because the trace write is one transaction, the
 * parent row rolled back too: searches ran but no trace was ever stored. SQLite's
 * INTEGER is 64-bit, so the whole suite passed and only Postgres deployments broke.
 *
 * Re-running against an already-widened column is a no-op, so this is safe on databases
 * created after 198 was corrected.
 */
const TARGETS: [table: string, column: string][] = [
  ["dev_search_trace_results", "created_at_ms"],
  ["dev_search_syntheses", "created_at_ms"],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  for (const [table, column] of TARGETS) {
    await db.schema
      .alterTable(table)
      .alterColumn(column, (col) => col.setDataType("bigint"))
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  for (const [table, column] of TARGETS) {
    await db.schema
      .alterTable(table)
      .alterColumn(column, (col) => col.setDataType("integer"))
      .execute();
  }
}

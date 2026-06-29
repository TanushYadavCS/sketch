import type { Kysely } from "kysely";
import { sql } from "kysely";

const TABLE = "indexed_files";
const COLUMN = "is_all_day";

/**
 * Adds an explicit all-day discriminator to calendar rows so the Daily Brief
 * meetings section can exclude whole-day events precisely.
 *
 * Previously all-day events were detected by their UTC-midnight `source_created_at`
 * sentinel, which also matched genuine timed meetings that happen to start at
 * exactly 00:00 UTC (for example a 5:30 AM IST standup). The connector now sets
 * this flag at sync time; the backfill classifies existing calendar rows with the
 * old heuristic so the column is reliable immediately, and re-syncs self-correct
 * any timed-midnight row the heuristic misclassified.
 *
 * Guarded via introspection so re-running after a partially applied upgrade is a
 * no-op, matching the recovery behavior the migration suite exercises.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns.has(COLUMN)) {
    await db.schema
      .alterTable(TABLE)
      .addColumn(COLUMN, "integer", (col) => col.notNull().defaultTo(0))
      .execute();
    await sql`
      UPDATE ${sql.table(TABLE)}
      SET ${sql.ref(COLUMN)} = 1
      WHERE source = 'google_calendar'
        AND source_created_at LIKE '%T00:00:00.000Z'
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (columns.has(COLUMN)) {
    await db.schema.alterTable(TABLE).dropColumn(COLUMN).execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

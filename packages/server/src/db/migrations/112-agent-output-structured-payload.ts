import type { Kysely } from "kysely";

const TABLE = "agent_output_items";
const COLUMN = "structured_payload_json";

/**
 * Adds a per-item structured payload column so sections whose items carry
 * section-specific structured data (e.g. the Daily Brief meetings section, with
 * start time and attendee list) can persist it alongside the generic item shape.
 * Nullable: sections that have no structured payload leave it null.
 *
 * Guarded via introspection so re-running after a partially applied upgrade
 * (ledger row cleared but column present) is a no-op, matching the recovery
 * behavior the migration suite exercises.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns.has(COLUMN)) {
    await db.schema.alterTable(TABLE).addColumn(COLUMN, "text").execute();
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

import type { Kysely } from "kysely";

const TABLE = "scheduled_tasks";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns.has("origin_message_id")) {
    await db.schema.alterTable(TABLE).addColumn("origin_message_id", "integer").execute();
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

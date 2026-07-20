import { type Kysely, sql } from "kysely";

const TABLE = "agent_output_items";
const COLUMN = "task_id";
const INDEX = "idx_agent_output_items_task_id";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns) return;

  if (!columns.has(COLUMN)) {
    await db.schema
      .alterTable(TABLE)
      .addColumn(COLUMN, "text", (col) => col.references("tasks.id").onDelete("set null"))
      .execute();
  }

  await sql`CREATE INDEX IF NOT EXISTS ${sql.ref(INDEX)} ON ${sql.table(TABLE)} (${sql.ref(COLUMN)})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(INDEX).ifExists().execute();

  const columns = await getColumns(db);
  if (columns?.has(COLUMN)) {
    await db.schema.alterTable(TABLE).dropColumn(COLUMN).execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string> | null> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return table ? new Set(table.columns.map((column) => column.name)) : null;
}

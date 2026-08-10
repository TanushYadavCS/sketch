import type { Kysely } from "kysely";
import { sql } from "kysely";

const TABLE = "scheduled_tasks";

export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  const columns = new Set(table?.columns.map((column) => column.name) ?? []);

  if (!columns.has("execution_mode")) {
    await db.schema
      .alterTable(TABLE)
      .addColumn("execution_mode", "text", (column) => column.notNull().defaultTo("hybrid"))
      .execute();
  }

  await sql`UPDATE scheduled_tasks SET execution_mode = 'hybrid' WHERE execution_mode IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  if (table?.columns.some((column) => column.name === "execution_mode")) {
    await db.schema.alterTable(TABLE).dropColumn("execution_mode").execute();
  }
}

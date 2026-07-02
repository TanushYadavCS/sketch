import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await hasColumn(db, "connector_configs", "credential_source")) return;

  await db.schema
    .alterTable("connector_configs")
    .addColumn("credential_source", "text", (col) => col.notNull().defaultTo("local"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "connector_configs", "credential_source"))) return;

  await db.schema.alterTable("connector_configs").dropColumn("credential_source").execute();
}

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === tableName);
  return table?.columns.some((column) => column.name === columnName) ?? false;
}

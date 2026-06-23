import { type Kysely, sql } from "kysely";

const TABLE = "scheduled_tasks";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);

  if (!columns.has("updated_at")) {
    await db.schema
      .alterTable(TABLE)
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }
  if (!columns.has("revision")) {
    await db.schema
      .alterTable(TABLE)
      .addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
  }
  if (!columns.has("last_edited_by")) {
    await db.schema.alterTable(TABLE).addColumn("last_edited_by", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);

  if (columns.has("last_edited_by")) {
    await db.schema.alterTable(TABLE).dropColumn("last_edited_by").execute();
  }
  if (columns.has("revision")) {
    await db.schema.alterTable(TABLE).dropColumn("revision").execute();
  }
  if (columns.has("updated_at")) {
    await db.schema.alterTable(TABLE).dropColumn("updated_at").execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

import type { Kysely } from "kysely";
import { sql } from "kysely";

const TABLE = "settings";

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns.has("embedding_provider")) {
    await db.schema.alterTable(TABLE).addColumn("embedding_provider", "text").execute();
  }

  await sql`
    UPDATE settings
    SET embedding_provider = 'gemini'
    WHERE embedding_provider IS NULL
      AND gemini_api_key IS NOT NULL
      AND trim(gemini_api_key) <> ''
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (columns.has("embedding_provider")) {
    await db.schema.alterTable(TABLE).dropColumn("embedding_provider").execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

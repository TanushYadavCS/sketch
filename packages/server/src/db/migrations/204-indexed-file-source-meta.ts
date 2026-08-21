import type { Kysely } from "kysely";

const TABLE = "indexed_files";
const COLUMN = "source_meta";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(TABLE).addColumn(COLUMN, "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(TABLE).dropColumn(COLUMN).execute();
}

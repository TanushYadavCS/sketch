import type { Kysely } from "kysely";

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName && table.columns.some((column) => column.name === columnName));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await hasColumn(db, "slack_user_sync_state", "last_roster_seen_at")) return;
  await db.schema.alterTable("slack_user_sync_state").addColumn("last_roster_seen_at", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "slack_user_sync_state", "last_roster_seen_at"))) return;
  await db.schema.alterTable("slack_user_sync_state").dropColumn("last_roster_seen_at").execute();
}

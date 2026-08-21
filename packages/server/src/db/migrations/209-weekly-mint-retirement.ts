import { type Kysely, sql } from "kysely";

async function hasColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === tableName);
  return table?.columns.some((column) => column.name === columnName) ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasColumn(db, "entity_review_queue", "retired_reason"))) {
    await db.schema.alterTable("entity_review_queue").addColumn("retired_reason", "text").execute();
  }
  if (!(await hasColumn(db, "weekly_mint_candidates", "retired_at"))) {
    await db.schema.alterTable("weekly_mint_candidates").addColumn("retired_at", "text").execute();
  }
  if (!(await hasColumn(db, "weekly_mint_candidates", "retired_reason"))) {
    await db.schema.alterTable("weekly_mint_candidates").addColumn("retired_reason", "text").execute();
  }
  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_mint_candidates_active_company
    ON weekly_mint_candidates(company_key, retired_at, updated_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_weekly_mint_candidates_active_company`.execute(db);
  if (await hasColumn(db, "weekly_mint_candidates", "retired_reason")) {
    await db.schema.alterTable("weekly_mint_candidates").dropColumn("retired_reason").execute();
  }
  if (await hasColumn(db, "weekly_mint_candidates", "retired_at")) {
    await db.schema.alterTable("weekly_mint_candidates").dropColumn("retired_at").execute();
  }
  if (await hasColumn(db, "entity_review_queue", "retired_reason")) {
    await db.schema.alterTable("entity_review_queue").dropColumn("retired_reason").execute();
  }
}

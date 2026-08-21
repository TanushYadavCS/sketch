import { type Kysely, sql } from "kysely";

async function hasTable(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasTable(db, "weekly_mint_candidates"))) {
    await db.schema
      .createTable("weekly_mint_candidates")
      .addColumn("review_id", "text", (col) => col.notNull().references("entity_review_queue.id").onDelete("cascade"))
      .addColumn("company_key", "text", (col) => col.notNull())
      .addColumn("last_grouped_at", "text")
      .addColumn("dry_streak", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("scan_days", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("scan_first_day", "text")
      .addColumn("scan_last_day", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addPrimaryKeyConstraint("weekly_mint_candidates_pk", ["review_id", "company_key"])
      .execute();
  }

  if (!(await hasTable(db, "weekly_mint_runs"))) {
    await db.schema
      .createTable("weekly_mint_runs")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("run_key", "text", (col) => col.notNull())
      .addColumn("lease_token", "text")
      .addColumn("status", "text", (col) => col.notNull())
      .addColumn("stage", "text", (col) => col.notNull())
      .addColumn("company_cursor", "text")
      .addColumn("clock_week", "text", (col) => col.notNull())
      .addColumn("candidates_grouped", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("verdicts_requested", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("verdicts_stored", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("aged_out", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("heartbeat_at", "text")
      .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("completed_at", "text")
      .addColumn("error", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint("weekly_mint_runs_key_unique", ["run_key"])
      .execute();
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_mint_candidates_company
    ON weekly_mint_candidates(company_key, updated_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_mint_runs_status_heartbeat
    ON weekly_mint_runs(status, heartbeat_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_weekly_mint_runs_status_heartbeat`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_weekly_mint_candidates_company`.execute(db);
  if (await hasTable(db, "weekly_mint_runs")) {
    await db.schema.dropTable("weekly_mint_runs").execute();
  }
  if (await hasTable(db, "weekly_mint_candidates")) {
    await db.schema.dropTable("weekly_mint_candidates").execute();
  }
}

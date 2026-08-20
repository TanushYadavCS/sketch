import { type Kysely, sql } from "kysely";

async function hasTable(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const tables = await db.introspection.getTables();
  return tables.some((table) => table.name === tableName);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await hasTable(db, "weekly_mint_run_events"))) {
    await db.schema
      .createTable("weekly_mint_run_events")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("run_id", "text", (col) => col.notNull().references("weekly_mint_runs.id").onDelete("cascade"))
      .addColumn("container_key", "text", (col) => col.notNull())
      .addColumn("company_entity_id", "text")
      .addColumn("company_name", "text", (col) => col.notNull())
      .addColumn("kind", "text", (col) => col.notNull())
      .addColumn("detail", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }

  if (!(await hasTable(db, "weekly_mint_traces"))) {
    await db.schema
      .createTable("weekly_mint_traces")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("run_id", "text", (col) => col.notNull().references("weekly_mint_runs.id").onDelete("cascade"))
      .addColumn("container_key", "text", (col) => col.notNull())
      .addColumn("seq", "integer", (col) => col.notNull())
      .addColumn("kind", "text", (col) => col.notNull())
      .addColumn("payload", "text", (col) => col.notNull())
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_mint_run_events_run
    ON weekly_mint_run_events(run_id, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_mint_traces_run_container_seq
    ON weekly_mint_traces(run_id, container_key, seq)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_weekly_mint_traces_run_container_seq`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_weekly_mint_run_events_run`.execute(db);
  if (await hasTable(db, "weekly_mint_traces")) {
    await db.schema.dropTable("weekly_mint_traces").execute();
  }
  if (await hasTable(db, "weekly_mint_run_events")) {
    await db.schema.dropTable("weekly_mint_run_events").execute();
  }
}

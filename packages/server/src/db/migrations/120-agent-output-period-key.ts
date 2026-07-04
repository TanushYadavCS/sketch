import { type Kysely, sql } from "kysely";

/**
 * Adds a scheduler period key separate from the calendar output date.
 *
 * `output_date` remains the display/date-arithmetic day. `period_key` is the
 * scoped scheduler de-dup bucket, so hourly routes can create multiple outputs
 * on the same calendar day without colliding with daily routes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db, "agent_outputs");

  if (!columns.has("period_key")) {
    await db.schema.alterTable("agent_outputs").addColumn("period_key", "text").execute();
  }

  await sql`
    UPDATE agent_outputs
       SET period_key = output_date
     WHERE period_key IS NULL OR period_key = ''
  `.execute(db);

  await sql`DROP INDEX IF EXISTS idx_agent_outputs_key_user_date`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_key_user_period`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_latest`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_running_unique`.execute(db);

  await db.schema
    .createIndex("idx_agent_outputs_key_user_period")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "period_key", "source_key"])
    .execute();
  await db.schema
    .createIndex("idx_agent_outputs_latest")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "period_key", "source_key", "status", "generated_at"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_agent_outputs_running_unique
      ON agent_outputs (agent_key, user_id, period_key, source_key)
     WHERE status = 'running'
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Migration 120-agent-output-period-key is irreversible: it changes agent output scheduler de-dup keys.",
  );
}

async function getColumns(db: Kysely<unknown>, tableName: string): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === tableName);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

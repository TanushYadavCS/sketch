import { type Kysely, sql } from "kysely";

/**
 * Adds output scope to the generic prebuilt-agent output table.
 *
 * The running coalescing constraint stays partial and only applies to rows whose
 * status is `running`, now keyed by source. Completed history remains append-only
 * for manual reruns and repeated same-day generations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db, "agent_outputs");

  if (!columns.has("source_key")) {
    await db.schema
      .alterTable("agent_outputs")
      .addColumn("source_key", "text", (col) => col.notNull().defaultTo(""))
      .execute();
  }
  if (!columns.has("source_label")) {
    await db.schema.alterTable("agent_outputs").addColumn("source_label", "text").execute();
  }

  await sql`DROP INDEX IF EXISTS idx_agent_outputs_key_user_date`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_latest`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_latest_unscoped`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_agent_outputs_running_unique`.execute(db);

  await db.schema
    .createIndex("idx_agent_outputs_key_user_date")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "output_date", "source_key"])
    .execute();
  await db.schema
    .createIndex("idx_agent_outputs_latest")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "output_date", "source_key", "status", "generated_at"])
    .execute();
  await db.schema
    .createIndex("idx_agent_outputs_latest_unscoped")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "output_date", "status", "generated_at"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_agent_outputs_running_unique
      ON agent_outputs (agent_key, user_id, output_date, source_key)
     WHERE status = 'running'
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Migration 119-agent-outputs-source-scope is irreversible: it adds persisted source scope columns to agent_outputs.",
  );
}

async function getColumns(db: Kysely<unknown>, tableName: string): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === tableName);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

import { type Kysely, sql } from "kysely";

const RUNS_TABLE = "graph_verdict_runs";
const VERDICTS_TABLE = "graph_verdicts";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(RUNS_TABLE)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("proposed_by_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("token_id", "text")
    .addColumn("note", "text")
    .addColumn("verdicts_proposed", "integer", (col) => col.notNull())
    .addColumn("verdicts_stored", "integer", (col) => col.notNull())
    .addColumn("verdicts_bounced", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable(VERDICTS_TABLE)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("run_id", "text", (col) => col.notNull().references("graph_verdict_runs.id").onDelete("cascade"))
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("subject_entity_id", "text", (col) => col.notNull())
    .addColumn("subject_name", "text")
    .addColumn("subject_entity_type", "text")
    .addColumn("target_entity_id", "text")
    .addColumn("target_name", "text")
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("evidence_json", "text", (col) => col.notNull())
    .addColumn("evidence_fingerprint", "text", (col) => col.notNull())
    .addColumn("validation_status", "text", (col) => col.notNull())
    .addColumn("validation_reason", "text")
    .addColumn("would_change_json", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("superseded_at", "text")
    .addColumn("decided_at", "text")
    .addColumn("decided_by_user_id", "text")
    .addColumn("applied_ledger_ref", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_subject_status
    ON graph_verdicts(subject_entity_id, status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_run_id
    ON graph_verdicts(run_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_status_created
    ON graph_verdicts(status, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status = 'awaiting_human' AND superseded_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_status_created`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_run_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_subject_status`.execute(db);
  await db.schema.dropTable(VERDICTS_TABLE).execute();
  await db.schema.dropTable(RUNS_TABLE).execute();
}

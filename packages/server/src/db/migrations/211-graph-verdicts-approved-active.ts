import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
  await db.schema.alterTable("graph_verdicts").addColumn("resolved_target_entity_id", "text").execute();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status IN ('awaiting_human', 'approved') AND superseded_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status = 'awaiting_human' AND superseded_at IS NULL`.execute(db);
  await db.schema.alterTable("graph_verdicts").dropColumn("resolved_target_entity_id").execute();
}

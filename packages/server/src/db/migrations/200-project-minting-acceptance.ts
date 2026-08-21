import { type Kysely, sql } from "kysely";

const VERDICTS = "project_minting_verdicts";
const ENTITIES = "entities";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(ENTITIES).addColumn("project_lifecycle_status", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("decided_at", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("decided_by_user_id", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("struck_projects", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("accepted_result", "text").execute();
  await sql`CREATE INDEX IF NOT EXISTS idx_project_minting_verdicts_status_decided
    ON project_minting_verdicts(status, decided_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_project_minting_verdicts_status_decided`.execute(db);
  await db.schema.alterTable(VERDICTS).dropColumn("accepted_result").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("struck_projects").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("decided_by_user_id").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("decided_at").execute();
  await db.schema.alterTable(ENTITIES).dropColumn("project_lifecycle_status").execute();
}

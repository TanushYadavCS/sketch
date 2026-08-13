/**
 * Snapshot the resolved declaration pair on each generated verdict so accept can
 * detect registry changes since generation without comparing the model's
 * nominated axes. Pending rows are superseded because pre-snapshot NULL would
 * otherwise mean "unknown old row" instead of "undeclared at generation".
 */
import { type Kysely, sql } from "kysely";

const VERDICTS = "project_minting_verdicts";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(VERDICTS).addColumn("declared_counterparty_kind", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("declared_client_stage", "text").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("relationship_state").execute();
  await sql`
    UPDATE project_minting_verdicts
    SET superseded_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending' AND superseded_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(VERDICTS).addColumn("relationship_state", "text").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("declared_client_stage").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("declared_counterparty_kind").execute();
}

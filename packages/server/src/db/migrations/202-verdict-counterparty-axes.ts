/**
 * Store verdict counterparty nominations in columns alongside the legacy
 * collapsed relationship state.
 *
 * `counterparty_kind` and `client_stage` mirror the verdict JSON's two axes so
 * pipeline views never parse JSON. `relationship_state` remains until the
 * accept-gate slice removes the bridge that still feeds old consumers.
 */
import type { Kysely } from "kysely";

const VERDICTS = "project_minting_verdicts";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(VERDICTS).addColumn("counterparty_kind", "text").execute();
  await db.schema.alterTable(VERDICTS).addColumn("client_stage", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(VERDICTS).dropColumn("client_stage").execute();
  await db.schema.alterTable(VERDICTS).dropColumn("counterparty_kind").execute();
}

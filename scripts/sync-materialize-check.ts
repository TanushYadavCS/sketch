import { sql } from "kysely";
import { loadConfig } from "../packages/server/src/config";
import { runConnectorSync } from "../packages/server/src/connectors/sync";
import { createDatabase } from "../packages/server/src/db";
import { createLogger } from "../packages/server/src/logger";

const connectorId = process.argv[2];
if (!connectorId) {
  console.error("usage: tsx scripts/sync-materialize-check.ts <connector-config-id>");
  process.exit(1);
}

async function snapshot(db: Awaited<ReturnType<typeof createDatabase>>, label: string) {
  const totals = await sql<{
    entities: number;
    mentions: number;
    refs: number;
    facts: number;
    matzd: number;
    tombstoned: number;
  }>`
    SELECT
      (SELECT count(*) FROM entities) AS entities,
      (SELECT count(*) FROM entity_mentions) AS mentions,
      (SELECT count(*) FROM entity_source_refs) AS refs,
      (SELECT count(*) FROM indexed_file_facts WHERE deleted_at IS NULL) AS facts,
      (SELECT count(*) FROM indexed_file_facts WHERE materialized_at IS NOT NULL AND deleted_at IS NULL) AS matzd,
      (SELECT count(*) FROM indexed_file_facts WHERE deleted_at IS NOT NULL) AS tombstoned
  `.execute(db);
  const owner = await sql<{ filled: number; null_owner: number }>`
    SELECT
      (SELECT count(*) FROM indexed_file_facts WHERE created_by_user_id IS NOT NULL) AS filled,
      (SELECT count(*) FROM indexed_file_facts WHERE created_by_user_id IS NULL) AS null_owner
  `.execute(db);
  const connectorFacts = await sql<{ filled: number; null_conn: number }>`
    SELECT
      (SELECT count(*) FROM indexed_file_facts WHERE connector_config_id IS NOT NULL) AS filled,
      (SELECT count(*) FROM indexed_file_facts WHERE connector_config_id IS NULL) AS null_conn
  `.execute(db);
  console.log(`--- ${label} ---`);
  console.log("totals:        ", totals.rows[0]);
  console.log("owner column:  ", owner.rows[0]);
  console.log("connector col: ", connectorFacts.rows[0]);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);

  await snapshot(db, "BEFORE sync");

  console.log(`\nTriggering sync for connector ${connectorId}...\n`);
  const result = await runConnectorSync(db, connectorId, logger);
  console.log("sync result:", {
    itemsAdded: result.itemsAdded,
    itemsUpdated: result.itemsUpdated,
    itemsArchived: result.itemsArchived,
    itemsSkipped: result.itemsSkipped,
    error: result.error,
  });

  await snapshot(db, "AFTER sync");
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ZCP-03 — backfill contact points for the existing Zoho CRM book.
 *
 * The Zoho connector now emits `entity_contact_points` (email + phone), but
 * incremental sync only re-pulls records Zoho reports as modified, so the book
 * synced before this feature shipped never re-materializes. This one-off,
 * explicit operation forces a full re-pull by nulling the connector's
 * `sync_cursor`, then runs a sync once.
 *
 * Re-processing is safe and idempotent: `upsertContactPoint` is keyed on
 * `(entity_id, kind, value)`, indexed-file content is content-hash deduped, and
 * the sync still emits facts on the `unchanged` branch — so contact points land
 * on the EXISTING entities (IDs, cross-source merges, and review decisions are
 * preserved). This is why it is preferred over delete + reconnect.
 *
 * Usage:
 *   tsx scripts/zoho-contact-points-backfill.ts            # dry run: report only
 *   tsx scripts/zoho-contact-points-backfill.ts --apply    # reset cursor + sync
 *   tsx scripts/zoho-contact-points-backfill.ts --apply <connector-config-id>
 *
 * With no id, operates over every `zoho_crm` connector config (per-user keys).
 */
import { sql } from "kysely";
import { loadConfig } from "../packages/server/src/config";
import { runConnectorSync } from "../packages/server/src/connectors/sync";
import { createDatabase } from "../packages/server/src/db";
import { createConnectorRepository } from "../packages/server/src/db/repositories/connectors";
import { createLogger } from "../packages/server/src/logger";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const explicitId = args.find((a) => !a.startsWith("--"));

async function coverage(db: Awaited<ReturnType<typeof createDatabase>>, label: string) {
  const row = await sql<{
    total_points: number;
    email_points: number;
    phone_points: number;
    zoho_points: number;
    entities_with_points: number;
    zoho_entities: number;
  }>`
    SELECT
      (SELECT count(*) FROM entity_contact_points) AS total_points,
      (SELECT count(*) FROM entity_contact_points WHERE kind = 'email') AS email_points,
      (SELECT count(*) FROM entity_contact_points WHERE kind = 'phone') AS phone_points,
      (SELECT count(*) FROM entity_contact_points WHERE source = 'zoho_crm') AS zoho_points,
      (SELECT count(DISTINCT entity_id) FROM entity_contact_points) AS entities_with_points,
      (SELECT count(DISTINCT entity_id) FROM entity_source_refs WHERE source = 'zoho_crm') AS zoho_entities
  `.execute(db);
  console.log(`--- contact-point coverage: ${label} ---`);
  console.log(row.rows[0]);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = await createDatabase(config);
  const repo = createConnectorRepository(db, config.ENCRYPTION_KEY);

  const configs = explicitId
    ? [await repo.findConfigById(explicitId)].filter((c): c is NonNullable<typeof c> => c != null)
    : await repo.findConfigsByType("zoho_crm");

  const targets = configs.filter((c) => c.connector_type === "zoho_crm");
  if (targets.length === 0) {
    console.error("No zoho_crm connector configs found to back fill.");
    process.exit(1);
  }
  if (explicitId && targets.length !== configs.length) {
    console.error(`Connector ${explicitId} is not a zoho_crm connector. Refusing.`);
    process.exit(1);
  }

  console.log(`Targets: ${targets.map((c) => c.id).join(", ")}`);
  await coverage(db, "BEFORE");

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to reset sync_cursor and sync each target.");
    await db.destroy();
    return;
  }

  for (const target of targets) {
    console.log(`\n[${target.id}] resetting sync_cursor → null`);
    await repo.updateConfig(target.id, { syncCursor: null });

    console.log(`[${target.id}] running full re-sync...`);
    const result = await runConnectorSync(db, target.id, logger, config);
    console.log(`[${target.id}] sync result:`, {
      itemsProcessed: result.itemsProcessed,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      itemsArchived: result.itemsArchived,
      errors: result.errors,
    });
  }

  await coverage(db, "AFTER");
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";

/**
 * Serializes ensure calls: connector_configs has no type-uniqueness
 * constraint, so the single-process promise chain is the race guard between
 * the startup ensure and a concurrent onSlackTokensUpdated ensure.
 */
let ensureChain: Promise<void> = Promise.resolve();

/**
 * Idempotently provisions the singleton Slack indexing connector config so
 * runAllSyncs discovers it. Unlike user-added connectors there is no admin-API
 * creation path: configuring the Slack bot IS the setup gesture. Ownership
 * follows the WhatsApp convention of an admin-owned org-wide system connector;
 * with no admin user yet (fresh install mid-onboarding) the ensure is skipped
 * and retried on the next call.
 */
export async function ensureSlackConnectorConfig(options: {
  db: Kysely<DB>;
  encryptionKey?: string;
  logger: Logger;
}): Promise<void> {
  const run = async (): Promise<void> => {
    const { db, encryptionKey, logger } = options;
    const existing = await db
      .selectFrom("connector_configs")
      .select(["id", "sync_status"])
      .where("connector_type", "=", "slack")
      .executeTakeFirst();
    if (existing && existing.sync_status !== "disabled") return;

    const owner = await createUserRepository(db).findFirstAdmin();
    if (!owner) {
      logger.info("Slack connector config not provisioned yet: no admin user exists");
      return;
    }

    const repo = createConnectorRepository(db, encryptionKey);
    if (existing) {
      /**
       * The singleton is system-managed and its only disable path is owner
       * removal (archiveConnectorsForOwner scrubs credentials and flips it to
       * disabled). Ensure therefore reactivates a disabled row under the
       * current first admin instead of leaving Slack indexing dead after the
       * original owner leaves the workspace.
       */
      await repo.updateConfig(existing.id, {
        credentials: JSON.stringify({ type: "system" }),
        syncStatus: "pending",
        errorMessage: null,
      });
      await db.updateTable("connector_configs").set({ created_by: owner.id }).where("id", "=", existing.id).execute();
      logger.info(
        { connectorConfigId: existing.id, ownerId: owner.id },
        "Reactivated disabled Slack indexing connector config",
      );
      return;
    }

    const created = await repo.createConfig({
      connectorType: "slack",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      syncStatus: "pending",
      createdBy: owner.id,
    });
    logger.info({ connectorConfigId: created.id }, "Provisioned Slack indexing connector config");
  };

  const chained = ensureChain.then(run, run);
  ensureChain = chained.catch(() => undefined);
  return chained;
}

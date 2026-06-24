import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import type { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { cleanupEmptyRelationships, cleanupRelationshipEvidenceForFacts } from "../entities/materialize";
import type { ConnectorType } from "./types";

type IndexedFileFactRepository = ReturnType<typeof createIndexedFileFactRepository>;

export interface ReconcileConnectorSyncParams {
  db: Kysely<DB>;
  factRepo: IndexedFileFactRepository;
  connectorConfigId: string;
  connectorType: ConnectorType;
  syncRunId: string;
  seenSyncIdentityKeys: Set<string>;
  allowLargeReconcile?: boolean;
  maxReconcileRatio?: number;
  encryptionKey?: string;
  logger: Logger;
}

export interface RemoveConnectorSourceItemsParams {
  db: Kysely<DB>;
  connectorConfigId: string;
  connectorType: ConnectorType;
  providerFileIds?: string[];
  providerMessageIds?: string[];
  sourceCreatedBefore?: string;
}

/**
 * Reconcile stale facts and archive files missing from a full connector sync.
 * A large stale ratio is treated as a probable adapter outage or partial API
 * response, not a legitimate archive sweep; the repository owns the default
 * threshold and this helper only passes through explicit operator overrides.
 */
export async function reconcileConnectorSync({
  db,
  factRepo,
  connectorConfigId,
  connectorType,
  syncRunId,
  seenSyncIdentityKeys,
  allowLargeReconcile,
  maxReconcileRatio,
  encryptionKey,
  logger,
}: ReconcileConnectorSyncParams): Promise<{
  itemsArchived: number;
  affectedIndexedFileIds: string[];
  reconciled: boolean;
}> {
  const repo = createConnectorRepository(db, encryptionKey);
  const entityRepo = createEntityRepository(db);
  const reconcileResult = await factRepo.reconcileStaleFacts(
    { kind: "connector", connectorConfigId, syncRunId },
    null,
    {
      force: allowLargeReconcile,
      maxDeletionRatio: maxReconcileRatio,
    },
  );

  if (reconcileResult.skipped) {
    logger.warn(
      {
        connectorConfigId,
        activeBefore: reconcileResult.activeBefore,
        wouldTombstone: reconcileResult.wouldTombstone,
        ratio: reconcileResult.skipped.ratio,
        threshold: reconcileResult.skipped.threshold,
        override: "SYNC_ALLOW_LARGE_RECONCILE=true",
      },
      "Stale-fact reconcile skipped: delta exceeds threshold",
    );
    return { itemsArchived: 0, affectedIndexedFileIds: [], reconciled: false };
  }

  const itemsArchived = await repo.archiveStaleFiles(connectorConfigId, seenSyncIdentityKeys);
  if (itemsArchived > 0) {
    await entityRepo.archiveEntitiesForArchivedFiles();
  }

  await cleanupRelationshipEvidenceForFacts(db, reconcileResult.tombstonedFactIds);
  await cleanupEmptyRelationships(db);

  if (reconcileResult.affectedIndexedFileIds.length > 0) {
    await deleteMaterializedFactMentions(db, connectorType, reconcileResult.affectedIndexedFileIds);
    await factRepo.clearMaterializedAtForActiveFacts(reconcileResult.affectedIndexedFileIds);
  }

  return { itemsArchived, affectedIndexedFileIds: reconcileResult.affectedIndexedFileIds, reconciled: true };
}

export async function removeConnectorSourceItems({
  db,
  connectorConfigId,
  connectorType,
  providerFileIds = [],
  providerMessageIds = [],
  sourceCreatedBefore,
}: RemoveConnectorSourceItemsParams): Promise<{ itemsDeleted: number; affectedIndexedFileIds: string[] }> {
  const fileIdSet = new Set<string>();

  if (providerFileIds.length > 0) {
    const rows = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("connector_config_id", "=", connectorConfigId)
      .where("provider_file_id", "in", providerFileIds)
      .execute();
    for (const row of rows) fileIdSet.add(row.id);
  }

  if (providerMessageIds.length > 0) {
    const rows = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("connector_config_id", "=", connectorConfigId)
      .where("provider_message_id", "in", providerMessageIds)
      .execute();
    for (const row of rows) fileIdSet.add(row.id);
  }

  if (sourceCreatedBefore) {
    const rows = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("connector_config_id", "=", connectorConfigId)
      .where("source_created_at", "<", sourceCreatedBefore)
      .execute();
    for (const row of rows) fileIdSet.add(row.id);
  }

  const indexedFileIds = [...fileIdSet];
  if (indexedFileIds.length === 0) return { itemsDeleted: 0, affectedIndexedFileIds: [] };

  await db.transaction().execute(async (trx) => {
    const factRows = await trx
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("indexed_file_id", "in", indexedFileIds)
      .where("deleted_at", "is", null)
      .execute();
    const factIds = factRows.map((row) => row.id);

    if (factIds.length > 0) {
      await cleanupRelationshipEvidenceForFacts(trx as unknown as Kysely<DB>, factIds);
      await cleanupEmptyRelationships(trx as unknown as Kysely<DB>);
      const now = new Date().toISOString();
      await trx
        .updateTable("indexed_file_facts")
        .set({ indexed_file_id: null, deleted_at: now, materialized_at: null, updated_at: now })
        .where("id", "in", factIds)
        .execute();
    }

    await deleteMaterializedFactMentions(trx as unknown as Kysely<DB>, connectorType, indexedFileIds);
    await trx.deleteFrom("entity_mentions").where("indexed_file_id", "in", indexedFileIds).execute();
    await trx.deleteFrom("indexed_files").where("id", "in", indexedFileIds).execute();
  });

  return { itemsDeleted: indexedFileIds.length, affectedIndexedFileIds: indexedFileIds };
}

async function deleteMaterializedFactMentions(
  db: Kysely<DB>,
  connectorType: string,
  indexedFileIds: string[],
): Promise<void> {
  if (indexedFileIds.length === 0) return;
  const sources = [
    `${connectorType}_attendee`,
    `${connectorType}_correspondent`,
    `${connectorType}_assignee`,
    `${connectorType}_author`,
    `${connectorType}_parent_entity`,
    "assignee",
    "parent_entity",
  ];
  await db
    .deleteFrom("entity_mentions")
    .where("indexed_file_id", "in", indexedFileIds)
    .where("confidence", "=", "EXTRACTED")
    .where("source", "in", sources)
    .execute();
}

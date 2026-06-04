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
}: ReconcileConnectorSyncParams): Promise<{ itemsArchived: number; affectedIndexedFileIds: string[] }> {
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
    return { itemsArchived: 0, affectedIndexedFileIds: [] };
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

  return { itemsArchived, affectedIndexedFileIds: reconcileResult.affectedIndexedFileIds };
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

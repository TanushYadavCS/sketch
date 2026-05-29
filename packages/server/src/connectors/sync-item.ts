import type { Kysely } from "kysely";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { clearEnrichmentData } from "./enrichment";
import type { ConnectorType, SyncedItem } from "./types";

type ConnectorRepository = ReturnType<typeof createConnectorRepository>;

export type ExistingContentHashMap = Map<string, { id: string; contentHash: string | null }>;

export type ProcessSyncedItemResult =
  | { kind: "skipped_empty" }
  | { kind: "unchanged"; indexedFileId: string }
  | { kind: "created"; indexedFileId: string }
  | { kind: "updated"; indexedFileId: string };

export interface ProcessSyncedItemParams {
  db: Kysely<DB>;
  repo: ConnectorRepository;
  connectorConfigId: string;
  connectorType: ConnectorType;
  item: SyncedItem;
  existingHashes: ExistingContentHashMap;
}

export async function loadExistingContentHashes(
  db: Kysely<DB>,
  connectorType: ConnectorType,
): Promise<ExistingContentHashMap> {
  const existingHashes: ExistingContentHashMap = new Map();
  const existingFiles = await db
    .selectFrom("indexed_files")
    .select(["id", "provider_file_id", "content_hash"])
    .where("source", "=", connectorType)
    .where("is_archived", "=", 0)
    .execute();
  for (const f of existingFiles) {
    existingHashes.set(f.provider_file_id, { id: f.id, contentHash: f.content_hash });
  }
  return existingHashes;
}

/**
 * Persist one synced item and its file access metadata. Changed/new item writes
 * run in a transaction and return after commit; fact emission remains in the
 * caller on the outer DB connection to avoid better-sqlite3 transaction lock
 * deadlocks with the entity/fact materialization path.
 */
export async function processSyncedItem({
  db,
  repo,
  connectorConfigId,
  connectorType,
  item,
  existingHashes,
}: ProcessSyncedItemParams): Promise<ProcessSyncedItemResult> {
  if (!item.fileName && !item.content) {
    return { kind: "skipped_empty" };
  }

  const existing = existingHashes.get(item.providerFileId);
  if (existing && existing.contentHash === item.contentHash) {
    await db
      .updateTable("indexed_files")
      .set({
        synced_at: new Date().toISOString(),
        file_name: item.fileName ?? undefined,
        source_path: item.sourcePath ?? undefined,
        provider_url: item.providerUrl ?? undefined,
        file_type: item.fileType ?? undefined,
        content_category: item.contentCategory ?? undefined,
        source_created_at: item.sourceCreatedAt ?? undefined,
        source_updated_at: item.sourceUpdatedAt ?? undefined,
        mime_type: item.mimeType ?? undefined,
      })
      .where("id", "=", existing.id)
      .execute();

    await repo.linkConnectorFile(connectorConfigId, existing.id);
    await syncItemAccess(repo, connectorConfigId, existing.id, item);
    return { kind: "unchanged", indexedFileId: existing.id };
  }

  const itemResult = await db.transaction().execute(async (trx) => {
    const txRepo = createConnectorRepository(trx);
    const upsertResult = await txRepo.upsertFile({
      connectorConfigId,
      source: connectorType,
      providerFileId: item.providerFileId,
      providerUrl: item.providerUrl,
      fileName: item.fileName,
      fileType: item.fileType,
      contentCategory: item.contentCategory,
      content: item.content,
      sourcePath: item.sourcePath,
      contentHash: item.contentHash,
      sourceCreatedAt: item.sourceCreatedAt,
      sourceUpdatedAt: item.sourceUpdatedAt,
      mimeType: item.mimeType,
    });

    if (upsertResult.contentChanged) {
      await clearEnrichmentData(trx, upsertResult.id);
    }

    await txRepo.linkConnectorFile(connectorConfigId, upsertResult.id);
    await syncItemAccess(txRepo, connectorConfigId, upsertResult.id, item);
    return upsertResult;
  });

  return { kind: itemResult.created ? "created" : "updated", indexedFileId: itemResult.id };
}

async function syncItemAccess(
  repo: ConnectorRepository,
  connectorConfigId: string,
  indexedFileId: string,
  item: SyncedItem,
): Promise<void> {
  if (item.accessScope) {
    const scopeId = await repo.upsertAccessScope(connectorConfigId, item.accessScope);
    await repo.setFileAccessScope(indexedFileId, scopeId);
  } else if (item.accessEmails && item.accessEmails.length > 0) {
    await repo.syncFileAccessEmails(indexedFileId, item.accessEmails);
  }
}

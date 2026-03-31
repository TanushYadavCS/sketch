/**
 * Sync runner — orchestrates connector sync runs.
 *
 * Handles the full lifecycle: credential refresh, sync execution,
 * content hashing for change detection, summary generation (placeholder),
 * and cursor management.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createClickUpConnector } from "./clickup";
import { type EmbeddingProviderConfig, createEmbeddingProvider } from "./embeddings";
import { clearEnrichmentData, runEnrichment } from "./enrichment";
import { createGoogleDriveConnector } from "./google-drive";
import { createLinearConnector } from "./linear";
import { createNotionConnector } from "./notion";
import type { Connector, ConnectorCredentials, ConnectorType, SyncResult } from "./types";

// ── Sync progress tracking (in-memory, ephemeral) ──────────────────────────
export interface SyncProgress {
  connectorId: string;
  connectorType: string;
  phase: "syncing" | "enriching";
  itemsProcessed: number;
  itemsCreated: number;
  itemsSkipped: number;
  startedAt: string;
}

const activeSyncs = new Map<string, SyncProgress>();

export function getSyncProgress(): SyncProgress[] {
  return [...activeSyncs.values()];
}

/**
 * Extract a useful error message from fetch/network errors.
 * Node.js fetch errors bury the real cause (ECONNREFUSED, ETIMEDOUT, etc.)
 * inside err.cause — this pulls it out for display.
 */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const cause = "cause" in err && err.cause instanceof Error ? err.cause.message : null;
  if (cause && err.message !== cause) {
    return `${err.message} (${cause})`;
  }
  return err.message;
}

const connectorFactories: Record<ConnectorType, () => Connector> = {
  google_drive: createGoogleDriveConnector,
  clickup: createClickUpConnector,
  notion: createNotionConnector,
  linear: createLinearConnector,
};

export function getConnector(type: ConnectorType): Connector {
  const factory = connectorFactories[type];
  if (!factory) throw new Error(`Unknown connector type: ${type}`);
  return factory();
}

function parseCredentials(encrypted: string): ConnectorCredentials {
  return JSON.parse(encrypted) as ConnectorCredentials;
}

function serializeCredentials(credentials: ConnectorCredentials): string {
  return JSON.stringify(credentials);
}

/**
 * Run a sync for a single connector config.
 */
export async function runConnectorSync(db: Kysely<DB>, connectorConfigId: string, logger: Logger): Promise<SyncResult> {
  const repo = createConnectorRepository(db);
  const entityRepo = createEntityRepository(db);
  const config = await repo.findConfigById(connectorConfigId);

  if (!config) {
    throw new Error(`Connector config not found: ${connectorConfigId}`);
  }

  const connector = getConnector(config.connector_type as ConnectorType);
  let credentials = parseCredentials(config.credentials);
  const scopeConfig = JSON.parse(config.scope_config) as Record<string, unknown>;

  const syncLogger = logger.child({ connectorId: config.id, type: config.connector_type });
  syncLogger.info("Starting sync");

  await repo.updateConfig(config.id, { syncStatus: "syncing", errorMessage: null });

  const progress: SyncProgress = {
    connectorId: config.id,
    connectorType: config.connector_type,
    phase: "syncing",
    itemsProcessed: 0,
    itemsCreated: 0,
    itemsSkipped: 0,
    startedAt: new Date().toISOString(),
  };
  activeSyncs.set(config.id, progress);

  try {
    if (credentials.type === "oauth" && connector.refreshTokens) {
      const refreshed = await connector.refreshTokens(credentials);
      if (refreshed) {
        credentials = refreshed;
        await repo.updateConfig(config.id, {
          credentials: serializeCredentials(credentials),
        });
        syncLogger.debug("OAuth tokens refreshed");
      }
    }

    const result: SyncResult = {
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsArchived: 0,
      newCursor: null,
      errors: [],
    };

    const seenProviderFileIds = new Set<string>();

    // Pre-load existing content hashes for this connector to skip unchanged items
    const existingHashes = new Map<string, { id: string; contentHash: string | null }>();
    const existingFiles = await db
      .selectFrom("indexed_files")
      .select(["id", "provider_file_id", "content_hash"])
      .where("source", "=", config.connector_type)
      .where("is_archived", "=", 0)
      .execute();
    for (const f of existingFiles) {
      existingHashes.set(f.provider_file_id, { id: f.id, contentHash: f.content_hash });
    }

    // Pre-load person entities for assignee linking (avoids per-assignee queries)
    const personEntities = await db.selectFrom("entities").selectAll().where("source_type", "=", "person").execute();
    const personBySourceRef = new Map<string, (typeof personEntities)[0]>();
    const personByNameLower = new Map<string, (typeof personEntities)[0]>();
    for (const p of personEntities) {
      personByNameLower.set(p.name.toLowerCase(), p);
    }
    const sourceRefs = await db
      .selectFrom("entity_source_refs")
      .select(["entity_id", "source", "source_id"])
      .where("source", "=", config.connector_type)
      .execute();
    for (const ref of sourceRefs) {
      const entity = personEntities.find((p) => p.id === ref.entity_id);
      if (entity) personBySourceRef.set(`${ref.source}:${ref.source_id}`, entity);
    }

    for await (const item of connector.sync({
      credentials,
      scopeConfig,
      cursor: config.sync_cursor,
      logger: syncLogger,
      onEntitySeed: async (seed) => {
        await entityRepo.upsertEntityFromTool(seed);
      },
      onPersonSeed: async (seed) => {
        await entityRepo.upsertPersonEntity(seed);
      },
    })) {
      try {
        seenProviderFileIds.add(item.providerFileId);

        if (!item.fileName && !item.content) {
          continue;
        }

        // Skip unchanged items early — just update synced_at timestamp
        const existing = existingHashes.get(item.providerFileId);
        if (existing && existing.contentHash === item.contentHash) {
          await db
            .updateTable("indexed_files")
            .set({ synced_at: new Date().toISOString() })
            .where("id", "=", existing.id)
            .execute();
          result.itemsProcessed++;
          progress.itemsProcessed = result.itemsProcessed;
          progress.itemsSkipped++;
          // Yield every item (better-sqlite3 is synchronous)
          if (result.itemsProcessed % 5 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          continue;
        }

        // Wrap all per-item DB writes in a transaction so a crash mid-item
        // leaves no partial records.
        const itemResult = await db.transaction().execute(async (trx) => {
          const txRepo = createConnectorRepository(trx);

          const upsertResult = await txRepo.upsertFile({
            connectorConfigId: config.id,
            source: config.connector_type,
            providerFileId: item.providerFileId,
            providerUrl: item.providerUrl,
            fileName: item.fileName,
            fileType: item.fileType,
            contentCategory: item.contentCategory,
            content: item.content,
            summary: null,
            tags: JSON.stringify([config.connector_type, item.fileType].filter(Boolean)),
            sourcePath: item.sourcePath,
            contentHash: item.contentHash,
            sourceCreatedAt: item.sourceCreatedAt,
            sourceUpdatedAt: item.sourceUpdatedAt,
            mimeType: item.mimeType,
          });

          // Clear enrichment data if content changed (will be re-enriched)
          if (upsertResult.contentChanged) {
            await clearEnrichmentData(trx, upsertResult.id);
          }

          // Track which connector discovered this file
          await txRepo.linkConnectorFile(config.id, upsertResult.id);

          // Set access: scope-level or per-file emails
          if (item.accessScope) {
            const scopeId = await txRepo.upsertAccessScope(config.id, item.accessScope);
            await txRepo.setFileAccessScope(upsertResult.id, scopeId);
          } else if (item.accessEmails && item.accessEmails.length > 0) {
            await txRepo.syncFileAccessEmails(upsertResult.id, item.accessEmails);
          }

          return upsertResult;
        });

        // Entity operations AFTER transaction — entityRepo uses the outer db connection.
        // Calling it inside a transaction deadlocks on better-sqlite3 (single-connection,
        // exclusive write lock).

        // Promote items to entities (Linear projects, Notion databases)
        const ENTITY_PROMOTING_TYPES: Record<string, string[]> = {
          linear: ["project"],
          notion: ["database"],
        };
        const promotable = ENTITY_PROMOTING_TYPES[config.connector_type] ?? [];
        if (item.fileType && promotable.includes(item.fileType)) {
          await entityRepo.upsertEntityFromTool({
            name: item.fileName,
            sourceType: `${config.connector_type}_${item.fileType}`,
            source: config.connector_type,
            sourceId: item.providerFileId,
            sourceUrl: item.providerUrl ?? undefined,
            sourceRefId: itemResult.id,
            metadata: item.sourcePath ? { path: item.sourcePath } : undefined,
          });
        }
        if (config.connector_type === "fireflies" && item.accessEmails) {
          for (const email of item.accessEmails) {
            await entityRepo.upsertPersonEntity({
              name: email,
              email,
              subtype: "external",
              source: "fireflies",
              sourceId: `${item.providerFileId}:${email}`,
            });
          }
        }

        if (item.assignees && item.assignees.length > 0) {
          for (const assignee of item.assignees) {
            const sourceRefKey =
              config.connector_type === "clickup"
                ? `${config.connector_type}:assignee:${assignee.name}`
                : `${config.connector_type}:user:${assignee.name}`;
            const entity = personBySourceRef.get(sourceRefKey) ?? personByNameLower.get(assignee.name.toLowerCase());
            if (entity) {
              await entityRepo.createMention({
                entityId: entity.id,
                indexedFileId: itemResult.id,
                contextSnippet: `Assigned to ${assignee.name}`,
              });
            }
          }
        }

        if (itemResult.created) {
          result.itemsCreated++;
          progress.itemsCreated++;
        } else {
          result.itemsUpdated++;
        }
        result.itemsProcessed++;
        progress.itemsProcessed = result.itemsProcessed;

        // Sleep briefly between items — better-sqlite3 is fully synchronous so
        // each transaction blocks the event loop. A real sleep (not just yield)
        // gives the HTTP server time to handle requests between DB writes.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ fileId: item.providerFileId, error: message });
        syncLogger.warn({ err, providerFileId: item.providerFileId }, "Failed to process item");
      }
    }

    if (!config.sync_cursor && seenProviderFileIds.size > 0) {
      result.itemsArchived = await repo.archiveStaleFiles(config.id, seenProviderFileIds);
      if (result.itemsArchived > 0) {
        await entityRepo.archiveEntitiesForArchivedFiles();
      }
    }

    result.newCursor = await connector.getCursor({
      credentials,
      scopeConfig,
      currentCursor: config.sync_cursor,
      logger: syncLogger,
    });

    await repo.updateConfig(config.id, {
      syncStatus: "active",
      syncCursor: result.newCursor,
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
    });

    activeSyncs.delete(config.id);

    syncLogger.info(
      {
        processed: result.itemsProcessed,
        created: result.itemsCreated,
        updated: result.itemsUpdated,
        archived: result.itemsArchived,
        errors: result.errors.length,
      },
      "Sync complete",
    );

    return result;
  } catch (err) {
    activeSyncs.delete(config.id);
    const message = extractErrorMessage(err);
    syncLogger.error({ err }, "Sync failed");

    await repo.updateConfig(config.id, {
      syncStatus: "error",
      errorMessage: message,
    });

    throw err;
  }
}

export interface SyncSchedulerDeps {
  /** LLM call function for tagging enrichment. */
  llmCall?: (prompt: string) => Promise<import("./llm").LlmCallResult>;
  /** Download image from Google Drive for embedding. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
}

/**
 * Run sync for all connectors that are due, then run enrichment.
 * Called on a schedule (e.g., every 30 minutes).
 */
export async function runAllSyncs(db: Kysely<DB>, logger: Logger, deps?: SyncSchedulerDeps): Promise<void> {
  const repo = createConnectorRepository(db);
  const configs = await repo.findSyncableConfigs();

  logger.info({ connectorCount: configs.length }, "Starting scheduled sync run");

  // Seed person entities from team directory (users table)
  try {
    const entityRepo = createEntityRepository(db);
    const users = await db.selectFrom("users").selectAll().execute();
    for (const user of users) {
      await entityRepo.upsertPersonEntity({
        name: user.name,
        email: user.email ?? undefined,
        subtype: "internal",
        source: "team",
        sourceId: user.id,
      });
    }
    if (users.length > 0) {
      logger.debug({ count: users.length }, "Team directory entities seeded");
    }
  } catch (err) {
    logger.error({ err }, "Failed to seed team directory entities");
  }

  for (const config of configs) {
    try {
      await runConnectorSync(db, config.id, logger);
    } catch (err) {
      logger.error({ err, connectorId: config.id }, "Scheduled sync failed for connector");
    }
  }

  // Run enrichment after all syncs complete
  try {
    const settings = await db
      .selectFrom("settings")
      .select(["gemini_api_key", "org_name", "enrichment_enabled"])
      .where("id", "=", "default")
      .executeTakeFirst();

    if (settings?.enrichment_enabled === 0) {
      logger.info("Enrichment disabled, skipping post-sync enrichment");
      return;
    }

    const embeddingProvider = settings?.gemini_api_key
      ? createEmbeddingProvider({ provider: "gemini", apiKey: settings.gemini_api_key })
      : null;

    const enrichResult = await runEnrichment({
      db,
      logger: logger.child({ component: "enrichment" }),
      embeddingProvider,
      llmCall: deps?.llmCall ?? (async () => ({ text: "{}", inputTokens: 0, outputTokens: 0 })),
      downloadImage: deps?.downloadImage,
      orgContext: buildOrgContext(settings?.org_name ?? null),
    });

    if (enrichResult.filesProcessed > 0 || enrichResult.filesFailed > 0) {
      logger.info(
        {
          enriched: enrichResult.filesProcessed,
          failed: enrichResult.filesFailed,
          skipped: enrichResult.filesSkipped,
        },
        "Post-sync enrichment complete",
      );
    }
  } catch (err) {
    logger.error({ err }, "Post-sync enrichment failed");
  }

  // Recompute entity hotness (decay for entities not recently mentioned)
  try {
    const entityRepo = createEntityRepository(db);
    const count = await entityRepo.recomputeAllHotness();
    if (count > 0) {
      logger.debug({ entities: count }, "Entity hotness recomputed");
    }
  } catch (err) {
    logger.error({ err }, "Entity hotness recomputation failed");
  }
}

/**
 * Recover connectors stuck in "syncing" status after a crash/restart.
 * Resets them to "active" so the scheduler can pick them up again.
 */
async function recoverStaleSyncs(db: Kysely<DB>, logger: Logger): Promise<void> {
  const repo = createConnectorRepository(db);
  const stale = await db
    .selectFrom("connector_configs")
    .select(["id", "connector_type"])
    .where("sync_status", "=", "syncing")
    .execute();

  if (stale.length === 0) return;

  for (const config of stale) {
    await repo.updateConfig(config.id, { syncStatus: "active", errorMessage: null });
    logger.warn({ connectorId: config.id, type: config.connector_type }, "Recovered stale syncing connector");
  }

  logger.info({ count: stale.length }, "Recovered stale syncing connectors on startup");
}

/**
 * Create a simple interval-based sync scheduler.
 * Recovers any stuck syncs on startup, then runs periodically.
 * Returns a cleanup function to stop the scheduler.
 */
export interface SyncSchedulerHandle {
  stop(): Promise<void>;
}

export function startSyncScheduler(
  db: Kysely<DB>,
  logger: Logger,
  intervalMs = 30 * 60 * 1000,
  deps?: SyncSchedulerDeps,
): SyncSchedulerHandle {
  let aborted = false;

  // Recover any connectors stuck in "syncing" from a previous crash
  recoverStaleSyncs(db, logger).catch((err) => {
    logger.error({ err }, "Failed to recover stale syncs on startup");
  });

  // Startup enrichment disabled — enrichment now runs only when explicitly
  // triggered from the UI or during the scheduled sync cycle. This prevents
  // DB contention between enrichment and manual syncs.
  const startupPromise = Promise.resolve();
  logger.info("Startup enrichment skipped (trigger manually from UI)");

  const timer = setInterval(() => {
    if (aborted) return;
    runAllSyncs(db, logger, deps).catch((err) => {
      logger.error({ err }, "Sync scheduler tick failed");
    });
  }, intervalMs);

  logger.info({ intervalMs }, "Sync scheduler started");

  return {
    async stop() {
      aborted = true;
      clearInterval(timer);
      await startupPromise;
      logger.info("Sync scheduler stopped");
    },
  };
}

/**
 * Build org context string for the tagging prompt.
 * Uses the org name from settings when available.
 */
function buildOrgContext(orgName: string | null): string {
  return orgName ? `Organization: ${orgName}` : "";
}

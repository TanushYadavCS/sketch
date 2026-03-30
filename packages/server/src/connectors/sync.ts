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
              sourceRefId: upsertResult.id,
              metadata: item.sourcePath ? { path: item.sourcePath } : undefined,
            });
          }

          // Seed person entities from Fireflies attendee emails
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

          // Link assignees to person entities (deterministic, no LLM)
          if (item.assignees && item.assignees.length > 0) {
            for (const assignee of item.assignees) {
              const personEntity = await entityRepo.getEntityBySourceRef(
                config.connector_type,
                config.connector_type === "clickup" ? `assignee:${assignee.name}` : `user:${assignee.name}`,
              );
              // Fall back to name search if source ref doesn't match
              const entity =
                personEntity ??
                (await entityRepo.searchEntities(assignee.name, { sourceTypes: ["person"], limit: 1 }))[0];
              if (entity) {
                await entityRepo.createMention({
                  entityId: entity.id,
                  indexedFileId: upsertResult.id,
                  contextSnippet: `Assigned to ${assignee.name}`,
                });
              }
            }
          }

          // Set access: scope-level or per-file emails
          if (item.accessScope) {
            const scopeId = await txRepo.upsertAccessScope(config.id, item.accessScope);
            await txRepo.setFileAccessScope(upsertResult.id, scopeId);
          } else if (item.accessEmails && item.accessEmails.length > 0) {
            await txRepo.syncFileAccessEmails(upsertResult.id, item.accessEmails);
          }

          return upsertResult;
        });

        if (itemResult.created) {
          result.itemsCreated++;
        } else {
          result.itemsUpdated++;
        }
        result.itemsProcessed++;
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

  // Run enrichment immediately for any pending files (without triggering a full sync).
  // We track the promise so stop() can await it before the DB is destroyed.
  const startupPromise = (async () => {
    try {
      const settings = await db
        .selectFrom("settings")
        .select(["gemini_api_key", "org_name", "enrichment_enabled"])
        .where("id", "=", "default")
        .executeTakeFirst();
      if (aborted) return;
      if (settings?.enrichment_enabled === 0) {
        logger.info("Enrichment disabled, skipping startup enrichment");
        return;
      }
      const embeddingProvider = settings?.gemini_api_key
        ? createEmbeddingProvider({ provider: "gemini", apiKey: settings.gemini_api_key })
        : null;
      const orgContext = buildOrgContext(settings?.org_name ?? null);
      const result = await runEnrichment({
        db,
        logger: logger.child({ component: "enrichment" }),
        embeddingProvider,
        llmCall: deps?.llmCall ?? (async () => ({ text: "{}", inputTokens: 0, outputTokens: 0 })),
        orgContext,
      });
      if (result.filesProcessed > 0 || result.filesFailed > 0) {
        logger.info({ enriched: result.filesProcessed, failed: result.filesFailed }, "Startup enrichment complete");
      }
    } catch (err) {
      if (!aborted) {
        logger.error({ err }, "Startup enrichment failed");
      }
    }
  })();

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

/**
 * Sync runner — orchestrates connector sync runs.
 *
 * Handles the full lifecycle: credential refresh, sync execution,
 * content hashing for change detection, summary generation (placeholder),
 * and cursor management.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { Config } from "../config";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { inferAffiliationFromEmail } from "../entities/affiliations";
import { runFeatureArchiveSweep } from "../entities/feature-archive-sweep";
import { isRecreateActive } from "../entities/recreate-state";
import { resolveConnectorCredentials } from "./credential-providers";
import { reconcileDanglingCrmRollups, refreshCrmActivityRollups } from "./crm-rollup";
import { isEmailSyncedItem, persistEnvelopeMetadata, recordSuppressedEmailRecord } from "./email";
import {
  SCHEDULED_ENRICHMENT_MAX_FILES_PER_RUN,
  SCHEDULED_ENRICHMENT_TIME_BUDGET_MS,
  isEnrichmentActive,
  runEnrichment,
} from "./enrichment";
import {
  createEnrichmentEmbeddingProvider,
  createEnrichmentGenerator,
  resolveOpenRouterEnrichmentConfig,
} from "./enrichment-providers";
import { createGeminiGenerator } from "./gemini-generate";
import { applyMicrosoftOAuthConfig, resolveMicrosoftOAuthConfig } from "./microsoft-graph";
import { runPostSyncGraphPipeline } from "./post-sync";
import { getConnector } from "./registry";
import { emitFactsForSyncedItem } from "./sync-facts";
import { getSyncIdentityForItem, syncIdentityKey } from "./sync-identity";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import { buildSyncNameResolver } from "./sync-name-resolution";
import { reconcileConnectorSync, removeConnectorSourceItems } from "./sync-reconcile";
import { extractErrorMessage, runWithConcurrency, serializeCredentials, truncateErrorMessage } from "./sync-utils";
import type { ConnectorCredentials, ConnectorType, SyncResult } from "./types";

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

export async function seedTeamDirectoryEntities(db: Kysely<DB>, logger: Logger): Promise<number> {
  try {
    const entityRepo = createEntityRepository(db);
    const domainsRepo = createEntityDomainsRepository(db);
    const users = await db.selectFrom("users").selectAll().execute();
    for (const user of users) {
      const entity = await entityRepo.upsertPersonEntity({
        name: user.name,
        email: user.email ?? undefined,
        subtype: "internal",
        source: "team",
        sourceId: user.id,
      });
      // Direct seed path: no file evidence available, so the helper can
      // only write a works_at edge when a corporate domain is already
      // configured. Without evidence it short-circuits on candidate
      // accumulation — that's intentional.
      if (entity && user.email) {
        await inferAffiliationFromEmail(
          { db, domainsRepo },
          { personEntityId: entity.id, email: user.email, evidenceFileId: null },
        );
      }
    }
    if (users.length > 0) {
      logger.debug({ count: users.length }, "Team directory entities seeded");
    }
    return users.length;
  } catch (err) {
    logger.error({ err }, "Failed to seed team directory entities");
    return 0;
  }
}

export { getConnector } from "./registry";

/**
 * Run a sync for a single connector config.
 */
export async function runConnectorSync(
  db: Kysely<DB>,
  connectorConfigId: string,
  logger: Logger,
  appConfig?: Partial<
    Pick<
      Config,
      | "SYNC_ALLOW_LARGE_RECONCILE"
      | "SYNC_MAX_RECONCILE_RATIO"
      | "CO_MENTION_CONTRIBUTES_TO_THRESHOLD"
      | "FLOOR_RETRY_MAX_FILES_PER_DOMAIN"
      | "FEATURE_ARCHIVE_MIN_MENTIONS"
      | "FEATURE_ARCHIVE_AGE_DAYS"
      | "FEATURE_ARCHIVE_MAX_PER_RUN"
      | "GEMINI_MAX_RPM"
      | "GEMINI_MAX_RETRIES"
      | "ENCRYPTION_KEY"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
      | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
      | "OUTLOOK_INITIAL_LOOKBACK_DAYS"
      | "OUTLOOK_MAX_INFLIGHT"
      | "TEAMS_INITIAL_LOOKBACK_DAYS"
      | "TEAMS_MAX_INFLIGHT"
      | "MICROSOFT_CLIENT_ID"
      | "MICROSOFT_CLIENT_SECRET"
      | "MICROSOFT_TENANT"
      | "EXPERIMENTAL_FLAG"
    >
  >,
): Promise<SyncResult> {
  if (isRecreateActive()) {
    logger.info({ connectorId: connectorConfigId }, "Skipping connector sync during entity recreate");
    return {
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsArchived: 0,
      newCursor: null,
      errors: [],
    };
  }

  const repo = createConnectorRepository(db, appConfig?.ENCRYPTION_KEY);
  const entityRepo = createEntityRepository(db);
  const factRepo = createIndexedFileFactRepository(db);
  const userRepo = createUserRepository(db);
  const config = await repo.findConfigById(connectorConfigId);

  if (!config) {
    throw new Error(`Connector config not found: ${connectorConfigId}`);
  }

  const connectorType = config.connector_type as ConnectorType;
  const connector = getConnector(connectorType);
  const storedScopeConfig = JSON.parse(config.scope_config) as Record<string, unknown>;
  const scopeConfig =
    config.connector_type === "outlook"
      ? {
          ...storedScopeConfig,
          initialDays: storedScopeConfig.initialDays ?? appConfig?.OUTLOOK_INITIAL_LOOKBACK_DAYS,
          maxInflight: storedScopeConfig.maxInflight ?? appConfig?.OUTLOOK_MAX_INFLIGHT,
        }
      : config.connector_type === "teams"
        ? {
            ...storedScopeConfig,
            initialDays: storedScopeConfig.initialDays ?? appConfig?.TEAMS_INITIAL_LOOKBACK_DAYS,
            maxInflight: storedScopeConfig.maxInflight ?? appConfig?.TEAMS_MAX_INFLIGHT,
          }
        : storedScopeConfig;
  const owner = await userRepo.findById(config.created_by);
  const ownerEmail = owner?.email ?? null;

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
    const resolvedCredentials = await resolveConnectorCredentials({
      db,
      config,
      appConfig: appConfig ?? {},
      ownerEmail,
      logger: syncLogger,
    });
    let credentials = await resolveConnectorCredentialsForSync({
      db,
      connectorType,
      credentials: resolvedCredentials.credentials,
      appConfig,
    });

    if (resolvedCredentials.credentialSource === "local" && credentials.type === "oauth" && connector.refreshTokens) {
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

    const seenSyncIdentityKeys = new Set<string>();
    const affectedIndexedFileIds = new Set<string>();
    const dirtyCrmRollupGroupIds = new Set<string>();

    const existingHashes = await loadExistingContentHashes(db, connectorType, config.id);
    const resolveNameToEmail = await buildSyncNameResolver(db);
    const syncRunId = randomUUID();
    const factContext = {
      connectorConfigId: config.id,
      createdByUserId: config.created_by,
      lastSeenSyncRunId: syncRunId,
    };

    for await (const item of connector.sync({
      connectorConfigId: config.id,
      credentials,
      accessTokenProvider: resolvedCredentials.accessTokenProvider,
      scopeConfig,
      cursor: config.sync_cursor,
      logger: syncLogger,
      ownerEmail,
      resolveNameToEmail,
      onEntitySeed: async (seed) => {
        await factRepo.upsertFact({
          ...factContext,
          source: seed.source,
          factType: "structural_seed",
          relation: "seeded",
          subjectName: seed.name,
          subjectSource: seed.source,
          subjectSourceId: seed.sourceId,
          raw: seed,
        });
      },
      onPersonSeed: async (seed) => {
        await factRepo.upsertFact({
          ...factContext,
          source: seed.source,
          factType: "person_seed",
          relation: "seeded",
          subjectName: seed.name,
          subjectEmail: seed.email ?? null,
          subjectSource: seed.source,
          subjectSourceId: seed.sourceId,
          raw: seed,
        });
      },
      onEmailSuppressed: async (record) => {
        await recordSuppressedEmailRecord(db, {
          connectorConfigId: config.id,
          record,
        });
      },
      onSourceItemRemoved: async (record) => {
        const removal = await removeConnectorSourceItems({
          db,
          connectorConfigId: config.id,
          connectorType,
          providerFileIds: record.providerFileId ? [record.providerFileId] : undefined,
          providerFileIdPrefixes: record.providerFileIdPrefix ? [record.providerFileIdPrefix] : undefined,
          providerMessageIds: record.providerMessageId ? [record.providerMessageId] : undefined,
          sourceCreatedBefore: record.sourceCreatedBefore,
        });
        result.itemsArchived += removal.itemsDeleted;
        for (const indexedFileId of removal.affectedIndexedFileIds) affectedIndexedFileIds.add(indexedFileId);
      },
    })) {
      try {
        seenSyncIdentityKeys.add(syncIdentityKey(getSyncIdentityForItem(item, config.id, connectorType)));

        const itemResult = await processSyncedItem({
          db,
          repo,
          connectorConfigId: config.id,
          connectorType,
          item,
          existingHashes,
          encryptionKey: appConfig?.ENCRYPTION_KEY,
        });

        if (itemResult.kind === "skipped_empty") {
          continue;
        }

        affectedIndexedFileIds.add(itemResult.indexedFileId);
        for (const groupId of itemResult.rollupGroupIds) dirtyCrmRollupGroupIds.add(groupId);

        if (isEmailSyncedItem(item)) {
          await persistEnvelopeMetadata(db, itemResult.indexedFileId, item.emailEnvelope);
        }

        await emitFactsForSyncedItem({
          db,
          factRepo,
          connector,
          connectorType,
          factContext,
          item,
          indexedFileId: itemResult.indexedFileId,
          emitCorrespondentFacts: connector.emitsCorrespondentFacts ?? false,
          experimentalFlag: appConfig?.EXPERIMENTAL_FLAG ?? false,
        });

        if (itemResult.kind === "unchanged") {
          result.itemsProcessed++;
          progress.itemsProcessed = result.itemsProcessed;
          progress.itemsSkipped++;
          // Yield every item (better-sqlite3 is synchronous)
          if (result.itemsProcessed % 5 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          continue;
        }

        if (itemResult.kind === "created") {
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

    if (!config.sync_cursor && seenSyncIdentityKeys.size > 0) {
      const reconcileResult = await reconcileConnectorSync({
        db,
        factRepo,
        connectorConfigId: config.id,
        connectorType,
        syncRunId,
        seenSyncIdentityKeys,
        allowLargeReconcile: appConfig?.SYNC_ALLOW_LARGE_RECONCILE,
        maxReconcileRatio: appConfig?.SYNC_MAX_RECONCILE_RATIO,
        encryptionKey: appConfig?.ENCRYPTION_KEY,
        logger: syncLogger,
      });
      result.itemsArchived = reconcileResult.itemsArchived;
      for (const indexedFileId of reconcileResult.affectedIndexedFileIds) affectedIndexedFileIds.add(indexedFileId);
    }

    await runPostSyncGraphPipeline({
      db,
      syncLogger,
      affectedIndexedFileIds: [...affectedIndexedFileIds],
      coMentionContributesToThreshold: appConfig?.CO_MENTION_CONTRIBUTES_TO_THRESHOLD,
      floorRetryMaxFilesPerDomain: appConfig?.FLOOR_RETRY_MAX_FILES_PER_DOMAIN,
      source: connectorType,
    });

    if (connectorType === "zoho_crm") {
      await refreshCrmRollupsForSync({
        db,
        connectorConfigId: config.id,
        dirtyGroupIds: [...dirtyCrmRollupGroupIds],
        affectedIndexedFileIds: [...affectedIndexedFileIds],
        syncLogger,
        appConfig,
      });
    }

    result.newCursor = await connector.getCursor({
      credentials,
      accessTokenProvider: resolvedCredentials.accessTokenProvider,
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
      errorMessage: truncateErrorMessage(message),
    });

    throw err;
  }
}

async function refreshCrmRollupsForSync(params: {
  db: Kysely<DB>;
  connectorConfigId: string;
  dirtyGroupIds: string[];
  affectedIndexedFileIds: string[];
  syncLogger: Logger;
  appConfig?: Partial<Pick<Config, "GEMINI_MAX_RPM" | "GEMINI_MAX_RETRIES">>;
}): Promise<void> {
  try {
    const settings = await params.db
      .selectFrom("settings")
      .select(["gemini_api_key", "enrichment_enabled"])
      .where("id", "=", "default")
      .executeTakeFirst();
    const generator =
      settings?.gemini_api_key && settings.enrichment_enabled !== 0
        ? createGeminiGenerator(settings.gemini_api_key, {
            maxRpm: params.appConfig?.GEMINI_MAX_RPM,
            maxRetries: params.appConfig?.GEMINI_MAX_RETRIES,
          })
        : null;
    const reconcile = await reconcileDanglingCrmRollups(params.db, params.connectorConfigId, params.syncLogger);
    const dirtyGroupIds = [...new Set([...params.dirtyGroupIds, ...reconcile.affectedGroupIds])];
    const result = await refreshCrmActivityRollups({
      db: params.db,
      connectorConfigId: params.connectorConfigId,
      dirtyGroupIds,
      affectedIndexedFileIds: params.affectedIndexedFileIds,
      generator,
      logger: params.syncLogger,
    });
    if (result.groupsRefreshed > 0 || result.groupsDeleted > 0 || result.errors.length > 0 || result.groupsCapped > 0) {
      params.syncLogger.info(
        {
          refreshed: result.groupsRefreshed,
          deleted: result.groupsDeleted,
          skipped: result.groupsSkipped,
          capped: result.groupsCapped,
          errors: result.errors.length,
        },
        "CRM activity rollups refreshed",
      );
    }
  } catch (err) {
    params.syncLogger.warn({ err }, "CRM activity rollup refresh failed");
  }
}

export interface SyncSchedulerDeps {
  /** Download image from Google Drive for embedding. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  appConfig?: Partial<
    Pick<
      Config,
      | "SYNC_ALLOW_LARGE_RECONCILE"
      | "SYNC_MAX_RECONCILE_RATIO"
      | "CO_MENTION_CONTRIBUTES_TO_THRESHOLD"
      | "FLOOR_RETRY_MAX_FILES_PER_DOMAIN"
      | "FEATURE_ARCHIVE_MIN_MENTIONS"
      | "FEATURE_ARCHIVE_AGE_DAYS"
      | "FEATURE_ARCHIVE_MAX_PER_RUN"
      | "GEMINI_MAX_RPM"
      | "GEMINI_MAX_RETRIES"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
      | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
      | "EXPERIMENTAL_FLAG"
      | "OUTLOOK_INITIAL_LOOKBACK_DAYS"
      | "OUTLOOK_MAX_INFLIGHT"
      | "TEAMS_INITIAL_LOOKBACK_DAYS"
      | "TEAMS_MAX_INFLIGHT"
      | "MICROSOFT_CLIENT_ID"
      | "MICROSOFT_CLIENT_SECRET"
      | "MICROSOFT_TENANT"
      | "ENCRYPTION_KEY"
      | "OPENROUTER_API_KEY"
    >
  >;
}

const SYNC_CONCURRENCY = 4;
const STALE_SYNCING_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const FEATURE_ARCHIVE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastFeatureArchiveSweepAt = 0;

async function resolveConnectorCredentialsForSync(params: {
  db: Kysely<DB>;
  connectorType: ConnectorType;
  credentials: ConnectorCredentials;
  appConfig?: Partial<
    Pick<Config, "ENCRYPTION_KEY" | "MICROSOFT_CLIENT_ID" | "MICROSOFT_CLIENT_SECRET" | "MICROSOFT_TENANT">
  >;
}): Promise<ConnectorCredentials> {
  if (params.credentials.type !== "oauth" || (params.connectorType !== "outlook" && params.connectorType !== "teams")) {
    return params.credentials;
  }

  const settings = await createSettingsRepository(params.db, params.appConfig?.ENCRYPTION_KEY).get();
  const microsoftConfig = resolveMicrosoftOAuthConfig(settings, {
    clientId: params.appConfig?.MICROSOFT_CLIENT_ID,
    clientSecret: params.appConfig?.MICROSOFT_CLIENT_SECRET,
    tenant: params.appConfig?.MICROSOFT_TENANT,
  });
  return applyMicrosoftOAuthConfig(params.credentials, microsoftConfig);
}

async function getIntervalMsFromSettings(db: Kysely<DB>, fallbackMs: number): Promise<number> {
  try {
    const settings = createSettingsRepository(db);
    const row = await settings.get();
    const minutes = row?.sync_interval_minutes;
    if (typeof minutes === "number" && minutes >= 5) {
      return minutes * 60 * 1000;
    }
  } catch {
    // Fall through to fallback
  }
  return fallbackMs;
}

/**
 * Run sync for all connectors that are due.
 * Called on a schedule (e.g., every 30 minutes).
 */
export async function runAllSyncs(db: Kysely<DB>, logger: Logger, deps?: SyncSchedulerDeps): Promise<void> {
  if (isRecreateActive()) {
    logger.info("Skipping scheduled sync during entity recreate");
    return;
  }

  const repo = createConnectorRepository(db, deps?.appConfig?.ENCRYPTION_KEY);

  await recoverStaleSyncs(db, logger, STALE_SYNCING_THRESHOLD_MS, deps?.appConfig?.ENCRYPTION_KEY);
  await recoverStaleEnrichments(db, logger);

  const intervalMs = await getIntervalMsFromSettings(db, DEFAULT_SYNC_INTERVAL_MS);
  const configs = await repo.findSyncableConfigs({ staleAfterMs: Math.floor(intervalMs / 2) });

  logger.info({ connectorCount: configs.length }, "Starting scheduled sync run");

  await seedTeamDirectoryEntities(db, logger);

  await runWithConcurrency(configs, SYNC_CONCURRENCY, async (config) => {
    try {
      await runConnectorSync(db, config.id, logger, deps?.appConfig);
    } catch (err) {
      logger.error({ err, connectorId: config.id }, "Scheduled sync failed for connector");
    }
  });

  try {
    const entityRepo = createEntityRepository(db);
    const count = await entityRepo.recomputeAllHotness();
    if (count > 0) {
      logger.debug({ entities: count }, "Entity hotness recomputed");
    }
  } catch (err) {
    logger.error({ err }, "Entity hotness recomputation failed");
  }

  const now = Date.now();
  if (now - lastFeatureArchiveSweepAt >= FEATURE_ARCHIVE_SWEEP_INTERVAL_MS) {
    lastFeatureArchiveSweepAt = now;
    try {
      await runFeatureArchiveSweep(db, logger.child({ component: "feature-archive-sweep" }), {
        minMentions: deps?.appConfig?.FEATURE_ARCHIVE_MIN_MENTIONS,
        ageDays: deps?.appConfig?.FEATURE_ARCHIVE_AGE_DAYS,
        maxPerRun: deps?.appConfig?.FEATURE_ARCHIVE_MAX_PER_RUN,
      });
    } catch (err) {
      logger.error({ err }, "Feature archive sweep failed");
    }
  }
}

export async function runScheduledEnrichment(db: Kysely<DB>, logger: Logger, deps?: SyncSchedulerDeps): Promise<void> {
  if (isRecreateActive()) {
    logger.info("Skipping scheduled enrichment during entity recreate");
    return;
  }

  try {
    const settings = await createSettingsRepository(db, deps?.appConfig?.ENCRYPTION_KEY).get();

    if (settings?.enrichment_enabled === 0) {
      logger.info("Enrichment disabled, skipping scheduled enrichment");
      return;
    }

    const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, deps?.appConfig?.OPENROUTER_API_KEY);
    const providerConfig = {
      geminiApiKey: settings?.gemini_api_key,
      embeddingProvider: settings?.embedding_provider,
      geminiMaxRpm: deps?.appConfig?.GEMINI_MAX_RPM,
      geminiMaxRetries: deps?.appConfig?.GEMINI_MAX_RETRIES,
      logger,
      ...openRouterConfig,
    };
    const embeddingProvider = createEnrichmentEmbeddingProvider(providerConfig);
    const generator = createEnrichmentGenerator(providerConfig);

    const enrichResult = await runEnrichment({
      db,
      logger: logger.child({ component: "enrichment" }),
      embeddingProvider,
      generator,
      geminiApiKey: settings?.gemini_api_key,
      geminiMaxRpm: deps?.appConfig?.GEMINI_MAX_RPM,
      geminiMaxRetries: deps?.appConfig?.GEMINI_MAX_RETRIES,
      experimentalFlag: deps?.appConfig?.EXPERIMENTAL_FLAG,
      downloadImage: deps?.downloadImage,
      maxFilesPerRun: SCHEDULED_ENRICHMENT_MAX_FILES_PER_RUN,
      timeBudgetMs: SCHEDULED_ENRICHMENT_TIME_BUDGET_MS,
    });

    if (enrichResult.filesProcessed > 0 || enrichResult.filesFailed > 0 || enrichResult.filesSkipped > 0) {
      logger.info(
        {
          enriched: enrichResult.filesProcessed,
          failed: enrichResult.filesFailed,
          skipped: enrichResult.filesSkipped,
          stoppedReason: enrichResult.stoppedReason,
        },
        "Scheduled enrichment slice complete",
      );
    }
  } catch (err) {
    logger.error({ err }, "Scheduled enrichment failed");
  }
}

/**
 * Recover connectors stuck in "syncing" status. Called on startup with threshold 0
 * (any in-flight row was orphaned by a crash) and at the top of every scheduler tick
 * with a non-zero threshold to recover rows that hung mid-run without crashing the
 * process. Recovered rows are flipped to "error" so `findSyncableConfigs` re-includes
 * them on the next eligibility pass.
 */
async function recoverStaleSyncs(
  db: Kysely<DB>,
  logger: Logger,
  staleThresholdMs = 0,
  encryptionKey?: string,
): Promise<void> {
  const repo = createConnectorRepository(db, encryptionKey);
  const stale = await repo.findStaleSyncingConfigs(staleThresholdMs);

  if (stale.length === 0) return;

  const reason =
    staleThresholdMs > 0 ? `Sync stuck for >${Math.round(staleThresholdMs / 60000)}m — auto-recovered` : null;

  for (const config of stale) {
    await repo.updateConfig(config.id, { syncStatus: "error", errorMessage: reason });
    logger.warn({ connectorId: config.id, type: config.connector_type }, "Recovered stale syncing connector");
  }

  logger.info({ count: stale.length }, "Recovered stale syncing connectors");
}

/**
 * Recover files stuck in embedding_status = "processing" after a crash.
 * Resets them to "pending" so the enrichment loop re-picks them up.
 * Threshold: 1 hour — enrichment runs should complete well within that.
 */
export async function recoverStaleEnrichments(db: Kysely<DB>, logger: Logger): Promise<void> {
  if (isEnrichmentActive()) {
    logger.debug("Skipping stale enrichment recovery while enrichment is active");
    return;
  }

  const staleThreshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const stale = await db
    .selectFrom("indexed_files")
    .select(["id", "file_name"])
    .where("embedding_status", "=", "processing")
    .where("synced_at", "<", staleThreshold)
    .execute();

  if (stale.length === 0) return;

  for (const file of stale) {
    await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "=", file.id).execute();
    logger.warn({ fileId: file.id, fileName: file.file_name }, "Recovered stale enriching file");
  }

  logger.info({ count: stale.length }, "Recovered stale enriching files");
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
  intervalMs = DEFAULT_SYNC_INTERVAL_MS,
  deps?: SyncSchedulerDeps,
): SyncSchedulerHandle {
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledEnrichmentInFlight = false;

  // Recover any connectors stuck in "syncing" from a previous crash
  recoverStaleSyncs(db, logger, 0, deps?.appConfig?.ENCRYPTION_KEY).catch((err) => {
    logger.error({ err }, "Failed to recover stale syncs on startup");
  });

  // Recover any files stuck in enrichment "processing" from a previous crash
  recoverStaleEnrichments(db, logger).catch((err) => {
    logger.error({ err }, "Failed to recover stale enrichments on startup");
  });

  // Startup enrichment disabled — enrichment now runs only when explicitly
  // triggered from the UI or after the scheduled sync cycle. This prevents
  // DB contention between enrichment and sync writes.
  logger.info("Startup enrichment skipped (trigger manually from UI)");

  async function scheduleNext(delayMs?: number): Promise<void> {
    if (aborted) return;
    const nextMs = delayMs ?? (await getIntervalMsFromSettings(db, intervalMs));
    timer = setTimeout(async () => {
      if (aborted) return;
      let shouldRunEnrichment = false;
      try {
        await runAllSyncs(db, logger, deps);
        shouldRunEnrichment = true;
      } catch (err) {
        logger.error({ err }, "Sync scheduler tick failed");
      }
      scheduleNext();
      if (shouldRunEnrichment && !aborted) {
        if (scheduledEnrichmentInFlight || isEnrichmentActive()) {
          logger.warn("Skipping scheduled enrichment because enrichment is active");
          return;
        }
        scheduledEnrichmentInFlight = true;
        try {
          await runScheduledEnrichment(db, logger, deps);
        } catch (err) {
          logger.error({ err }, "Enrichment scheduler tick failed");
        } finally {
          scheduledEnrichmentInFlight = false;
        }
      }
    }, nextMs);
    logger.debug({ intervalMs: nextMs }, "Next sync scheduled");
  }

  scheduleNext();
  logger.info({ intervalMs }, "Sync scheduler started");

  return {
    async stop() {
      aborted = true;
      if (timer) clearTimeout(timer);
      logger.info("Sync scheduler stopped");
    },
  };
}

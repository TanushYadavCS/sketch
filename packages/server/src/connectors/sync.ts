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
import {
  cleanupEmptyRelationships,
  cleanupRelationshipEvidenceForFacts,
  materializeUnmaterializedFacts,
} from "../entities/materialize";
import { isRecreateActive } from "../entities/recreate-state";
import { type EmbeddingProviderConfig, createEmbeddingProvider } from "./embeddings";
import { clearEnrichmentData, runEnrichment } from "./enrichment";
import { createAmbiguityAwareMap, normalizeName } from "./name-normalize";
import { getConnector } from "./registry";
import { sweepDomainPromotions } from "./smart-enrichment";
import type { ConnectorCredentials, ConnectorType, NameResolution, NameResolver, SyncResult } from "./types";

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

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Cap the persisted error so an upstream HTML error page (e.g. Cloudflare 504)
 * can't blow up the connectors UI when it renders config.error_message.
 */
function truncateErrorMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : collapsed;
}

async function deleteMaterializedFactMentions(
  db: Kysely<DB>,
  connectorType: string,
  indexedFileIds: string[],
): Promise<void> {
  if (indexedFileIds.length === 0) return;
  const sources = [
    `${connectorType}_attendee`,
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

export { getConnector } from "./registry";

function parseCredentials(encrypted: string): ConnectorCredentials {
  return JSON.parse(encrypted) as ConnectorCredentials;
}

function serializeCredentials(credentials: ConnectorCredentials): string {
  return JSON.stringify(credentials);
}

/**
 * Read a person entity's email from its JSON metadata column. SQLite and
 * Postgres both store this as a text JSON blob; we parse it once at
 * pre-load time rather than reaching for dialect-specific extraction in
 * the SELECT — the full row is already in memory.
 */
function readPersonEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { email?: unknown };
    if (typeof parsed.email === "string" && parsed.email.length > 0) {
      return parsed.email.toLowerCase();
    }
  } catch {
    // Corrupt metadata — skip rather than fail the whole sync.
  }
  return null;
}

/**
 * Parse a person entity's aliases column (JSON array of strings). Returns
 * an empty array on null/parse-failure to keep callers branch-free.
 */
function parseAliases(aliases: string | null): string[] {
  if (!aliases) return [];
  try {
    const parsed = JSON.parse(aliases);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Corrupt aliases — skip.
  }
  return [];
}

/**
 * Run a sync for a single connector config.
 */
export async function runConnectorSync(
  db: Kysely<DB>,
  connectorConfigId: string,
  logger: Logger,
  appConfig?: Pick<Config, "SYNC_ALLOW_LARGE_RECONCILE" | "SYNC_MAX_RECONCILE_RATIO">,
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

  const repo = createConnectorRepository(db);
  const entityRepo = createEntityRepository(db);
  const factRepo = createIndexedFileFactRepository(db);
  const userRepo = createUserRepository(db);
  const config = await repo.findConfigById(connectorConfigId);

  if (!config) {
    throw new Error(`Connector config not found: ${connectorConfigId}`);
  }

  const connector = getConnector(config.connector_type as ConnectorType);
  let credentials = parseCredentials(config.credentials);
  const scopeConfig = JSON.parse(config.scope_config) as Record<string, unknown>;
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

    // Pre-load person entities for name→email resolution. Entity/source-ref
    // writes happen in the materializer after facts are persisted.
    const allEntities = await db.selectFrom("entities").selectAll().execute();
    // Ambiguity-aware lookup keyed by normalizeName: name → { email, entityId }.
    // Covers canonical name AND aliases (alias-confirmation persists merges
    // there). Conflicting values on the same key drop the key — single
    // unambiguous match only, matching the rule the in-meeting maps use.
    const personEmailByName = createAmbiguityAwareMap<string, { email: string; entityId: string }>();
    for (const p of allEntities.filter((e) => e.source_type === "person")) {
      const email = readPersonEmail(p.metadata);
      if (!email) continue;
      const value = { email, entityId: p.id };
      personEmailByName.add(normalizeName(p.name), value);
      for (const alias of parseAliases(p.aliases)) {
        personEmailByName.add(normalizeName(alias), value);
      }
    }

    // Team-directory map. Sketch's users table is the canonical source for
    // team emails — entity dedup can promote a different stored name, so we
    // keep this separate from personEmailByName and check it first.
    const userEmailByName = createAmbiguityAwareMap<string, string>();
    const userRows = await db
      .selectFrom("users")
      .select(["name", "email"])
      .where("email", "is not", null)
      .where("type", "!=", "external")
      .execute();
    for (const u of userRows) {
      if (!u.email) continue;
      userEmailByName.add(normalizeName(u.name), u.email.toLowerCase());
    }

    // Closure over both maps with users-first precedence. Built once per
    // sync; snapshot semantics — a user added mid-sync won't appear until
    // the next run. Connectors that don't need it leave the field unset.
    const resolveNameToEmail: NameResolver = (name: string): NameResolution | null => {
      const key = normalizeName(name);
      const userEmail = userEmailByName.get(key);
      if (userEmail) return { email: userEmail, source: "users" };
      const entityHit = personEmailByName.get(key);
      if (entityHit) return { email: entityHit.email, entityId: entityHit.entityId, source: "entities" };
      return null;
    };

    const connectorType = config.connector_type;
    const syncRunId = randomUUID();
    const factContext = {
      connectorConfigId: config.id,
      createdByUserId: config.created_by,
      lastSeenSyncRunId: syncRunId,
    };

    async function seedAttendeePerson(
      attendee: { name?: string; email?: string },
      providerFileId: string,
      indexedFileId: string,
      contentHash: string | null,
    ): Promise<void> {
      if (!attendee.name) return;
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash,
        source: connectorType,
        factType: "attendee",
        relation: "attended",
        subjectName: attendee.name,
        subjectEmail: attendee.email ?? null,
        subjectSource: connectorType,
        subjectSourceId: `${providerFileId}:${attendee.email ?? attendee.name}`,
        contextSnippet: `Attended ${providerFileId}`,
        raw: { providerFileId, attendee },
      });
    }

    async function seedAuthorPerson(
      author: { name?: string; email?: string; sourceId?: string },
      providerFileId: string,
      indexedFileId: string,
      contentHash: string | null,
    ): Promise<void> {
      if (!author.email && !author.name) return;
      await factRepo.upsertFact({
        ...factContext,
        indexedFileId,
        contentHash,
        source: connectorType,
        factType: "author",
        relation: "authored",
        subjectName: author.name ?? null,
        subjectEmail: author.email ?? null,
        subjectSource: connectorType,
        subjectSourceId: author.sourceId ?? author.email ?? `${providerFileId}:${author.name}`,
        contextSnippet: `Authored ${providerFileId}`,
        raw: { providerFileId, author },
      });
    }

    for await (const item of connector.sync({
      credentials,
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
    })) {
      try {
        seenProviderFileIds.add(item.providerFileId);

        if (!item.fileName && !item.content) {
          continue;
        }

        // Skip unchanged items early — update metadata and synced_at timestamp.
        // Content hash matches, so we don't re-process content, but metadata
        // (file name, path, URL, timestamps) may have changed at the source.
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

          // Track which connector discovered this file (idempotent).
          // Without this, unchanged files never get linked to a new connector
          // config, breaking connector-scoped counts/listing and orphan logic.
          await repo.linkConnectorFile(config.id, existing.id);

          // Sync ACL even when content is unchanged — permissions may have
          // changed (e.g. attendee removed, scope membership updated).
          if (item.accessScope) {
            const scopeId = await repo.upsertAccessScope(config.id, item.accessScope);
            await repo.setFileAccessScope(existing.id, scopeId);
          } else if (item.accessEmails && item.accessEmails.length > 0) {
            await repo.syncFileAccessEmails(existing.id, item.accessEmails);
          }

          const promotable = connector.promotableFileTypes ?? [];
          if (item.fileType && promotable.includes(item.fileType)) {
            await factRepo.upsertFact({
              ...factContext,
              indexedFileId: existing.id,
              contentHash: item.contentHash,
              source: connectorType,
              factType: "structural_seed",
              relation: "seeded",
              subjectName: item.fileName,
              subjectSource: connectorType,
              subjectSourceId: item.providerFileId,
              contextSnippet: item.sourcePath,
              raw: {
                providerFileId: item.providerFileId,
                providerUrl: item.providerUrl,
                fileType: item.fileType,
                sourcePath: item.sourcePath,
              },
            });
          }

          if (item.parentEntities && item.parentEntities.length > 0) {
            for (const parent of item.parentEntities) {
              await factRepo.upsertFact({
                ...factContext,
                indexedFileId: existing.id,
                contentHash: item.contentHash,
                source: connectorType,
                factType: "parent_entity",
                relation: "mentioned",
                subjectSource: parent.source,
                subjectSourceId: parent.sourceId,
                contextSnippet: parent.contextSnippet ?? null,
                raw: { providerFileId: item.providerFileId, parent },
              });
            }
          }

          if (item.attendees) {
            for (const a of item.attendees) {
              await seedAttendeePerson(a, item.providerFileId, existing.id, item.contentHash);
            }
          }

          if (item.assignees && item.assignees.length > 0) {
            for (const assignee of item.assignees) {
              const sourceRefKey = connector.assigneeSourceRefKey
                ? connector.assigneeSourceRefKey(assignee.name)
                : `${config.connector_type}:user:${assignee.name}`;
              await factRepo.upsertFact({
                ...factContext,
                indexedFileId: existing.id,
                contentHash: item.contentHash,
                source: connectorType,
                factType: "assignee",
                relation: "assigned",
                subjectName: assignee.name,
                subjectEmail: assignee.email ?? null,
                subjectSource: sourceRefKey.split(":")[0] ?? connectorType,
                subjectSourceId: sourceRefKey.split(":").slice(1).join(":") || assignee.name,
                contextSnippet: `Assigned to ${assignee.name}`,
                raw: { providerFileId: item.providerFileId, assignee, sourceRefKey },
              });
            }
          }

          if (item.authorEmail || item.authorName) {
            await seedAuthorPerson(
              { name: item.authorName, email: item.authorEmail, sourceId: item.authorSourceId },
              item.providerFileId,
              existing.id,
              item.contentHash,
            );
          }

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

        // Promote items to entities based on connector's promotableFileTypes
        const promotable = connector.promotableFileTypes ?? [];
        if (item.fileType && promotable.includes(item.fileType)) {
          await factRepo.upsertFact({
            ...factContext,
            indexedFileId: itemResult.id,
            contentHash: item.contentHash,
            source: connectorType,
            factType: "structural_seed",
            relation: "seeded",
            subjectName: item.fileName,
            subjectSource: connectorType,
            subjectSourceId: item.providerFileId,
            contextSnippet: item.sourcePath,
            raw: {
              providerFileId: item.providerFileId,
              providerUrl: item.providerUrl,
              fileType: item.fileType,
              sourcePath: item.sourcePath,
            },
          });
        }

        if (item.attendees) {
          for (const a of item.attendees) {
            await seedAttendeePerson(a, item.providerFileId, itemResult.id, item.contentHash);
          }
        }

        if (item.assignees && item.assignees.length > 0) {
          for (const assignee of item.assignees) {
            const sourceRefKey = connector.assigneeSourceRefKey
              ? connector.assigneeSourceRefKey(assignee.name)
              : `${config.connector_type}:user:${assignee.name}`;
            await factRepo.upsertFact({
              ...factContext,
              indexedFileId: itemResult.id,
              contentHash: item.contentHash,
              source: connectorType,
              factType: "assignee",
              relation: "assigned",
              subjectName: assignee.name,
              subjectEmail: assignee.email ?? null,
              subjectSource: sourceRefKey.split(":")[0] ?? connectorType,
              subjectSourceId: sourceRefKey.split(":").slice(1).join(":") || assignee.name,
              contextSnippet: `Assigned to ${assignee.name}`,
              raw: { providerFileId: item.providerFileId, assignee, sourceRefKey },
            });
          }
        }

        if (item.authorEmail || item.authorName) {
          await seedAuthorPerson(
            { name: item.authorName, email: item.authorEmail, sourceId: item.authorSourceId },
            item.providerFileId,
            itemResult.id,
            item.contentHash,
          );
        }

        if (item.parentEntities && item.parentEntities.length > 0) {
          for (const parent of item.parentEntities) {
            await factRepo.upsertFact({
              ...factContext,
              indexedFileId: itemResult.id,
              contentHash: item.contentHash,
              source: connectorType,
              factType: "parent_entity",
              relation: "mentioned",
              subjectSource: parent.source,
              subjectSourceId: parent.sourceId,
              contextSnippet: parent.contextSnippet ?? null,
              raw: { providerFileId: item.providerFileId, parent },
            });
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
      const reconcileResult = await factRepo.reconcileStaleFacts(
        { kind: "connector", connectorConfigId: config.id, syncRunId },
        null,
        {
          force: appConfig?.SYNC_ALLOW_LARGE_RECONCILE,
          maxDeletionRatio: appConfig?.SYNC_MAX_RECONCILE_RATIO,
        },
      );

      if (reconcileResult.skipped) {
        syncLogger.warn(
          {
            connectorConfigId: config.id,
            activeBefore: reconcileResult.activeBefore,
            wouldTombstone: reconcileResult.wouldTombstone,
            ratio: reconcileResult.skipped.ratio,
            threshold: reconcileResult.skipped.threshold,
            override: "SYNC_ALLOW_LARGE_RECONCILE=true",
          },
          "Stale-fact reconcile skipped: delta exceeds threshold",
        );
      } else {
        result.itemsArchived = await repo.archiveStaleFiles(config.id, seenProviderFileIds);
        if (result.itemsArchived > 0) {
          await entityRepo.archiveEntitiesForArchivedFiles();
        }

        await cleanupRelationshipEvidenceForFacts(db, reconcileResult.tombstonedFactIds);
        await cleanupEmptyRelationships(db);

        if (reconcileResult.affectedIndexedFileIds.length > 0) {
          await deleteMaterializedFactMentions(db, connectorType, reconcileResult.affectedIndexedFileIds);
          await factRepo.clearMaterializedAtForActiveFacts(reconcileResult.affectedIndexedFileIds);
        }
      }
    }

    const materializeSummary = await materializeUnmaterializedFacts(db, syncLogger);
    if (materializeSummary.factsRead > 0) {
      syncLogger.info({ materializeSummary }, "Post-sync fact materialization complete");
    }

    await sweepDomainPromotions(db, syncLogger.child({ component: "domain-sweep" }));

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
      errorMessage: truncateErrorMessage(message),
    });

    throw err;
  }
}

export interface SyncSchedulerDeps {
  /** Download image from Google Drive for embedding. */
  downloadImage?: (providerFileId: string, connectorConfigId: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  appConfig?: Pick<Config, "SYNC_ALLOW_LARGE_RECONCILE" | "SYNC_MAX_RECONCILE_RATIO">;
}

/**
 * Bounded-concurrency runner. `Promise.allSettled` semantics — one item failing
 * does not abort the others.
 */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(limit, queue.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) return;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

const SYNC_CONCURRENCY = 4;
const STALE_SYNCING_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;

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
 * Run sync for all connectors that are due, then run enrichment.
 * Called on a schedule (e.g., every 30 minutes).
 */
export async function runAllSyncs(db: Kysely<DB>, logger: Logger, deps?: SyncSchedulerDeps): Promise<void> {
  if (isRecreateActive()) {
    logger.info("Skipping scheduled sync during entity recreate");
    return;
  }

  const repo = createConnectorRepository(db);

  // Auto-recover any connector stuck in `syncing` past the staleness threshold —
  // a row stuck mid-process is otherwise excluded from `findSyncableConfigs` and
  // would never retry until the server restarts.
  await recoverStaleSyncs(db, logger, STALE_SYNCING_THRESHOLD_MS);

  // Same idea for enrichment: scheduled runs only claim `pending`/`failed` (so
  // an in-flight run can't be re-claimed mid-flight and race on chunk inserts),
  // which means a crashed run's `processing` row would otherwise be stranded
  // until startup. Reset stale `processing` rows before each tick.
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

  // Run enrichment after all syncs complete
  try {
    const settings = await db
      .selectFrom("settings")
      .select(["gemini_api_key", "enrichment_enabled"])
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
      geminiApiKey: settings?.gemini_api_key,
      downloadImage: deps?.downloadImage,
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
 * Recover connectors stuck in "syncing" status. Called on startup with threshold 0
 * (any in-flight row was orphaned by a crash) and at the top of every scheduler tick
 * with a non-zero threshold to recover rows that hung mid-run without crashing the
 * process. Recovered rows are flipped to "error" so `findSyncableConfigs` re-includes
 * them on the next eligibility pass.
 */
async function recoverStaleSyncs(db: Kysely<DB>, logger: Logger, staleThresholdMs = 0): Promise<void> {
  const repo = createConnectorRepository(db);
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

  // Recover any connectors stuck in "syncing" from a previous crash
  recoverStaleSyncs(db, logger).catch((err) => {
    logger.error({ err }, "Failed to recover stale syncs on startup");
  });

  // Recover any files stuck in enrichment "processing" from a previous crash
  recoverStaleEnrichments(db, logger).catch((err) => {
    logger.error({ err }, "Failed to recover stale enrichments on startup");
  });

  // Startup enrichment disabled — enrichment now runs only when explicitly
  // triggered from the UI or during the scheduled sync cycle. This prevents
  // DB contention between enrichment and manual syncs.
  logger.info("Startup enrichment skipped (trigger manually from UI)");

  async function scheduleNext(): Promise<void> {
    if (aborted) return;
    const nextMs = await getIntervalMsFromSettings(db, intervalMs);
    timer = setTimeout(async () => {
      if (aborted) return;
      try {
        await runAllSyncs(db, logger, deps);
      } catch (err) {
        logger.error({ err }, "Sync scheduler tick failed");
      }
      scheduleNext();
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

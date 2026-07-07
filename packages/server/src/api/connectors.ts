/**
 * Connectors API — manage external data sources and trigger syncs.
 *
 * Admin-facing endpoints for:
 * - CRUD on connector configs (with credential validation + auto-sync)
 * - Triggering manual syncs
 * - Searching indexed files
 * - AI enrichment (summary generation)
 *
 * Route ordering: static paths (/all-files, /search, /sources, /files/...)
 * must be registered before dynamic /:id to prevent param capture.
 */
import { canvasAppSlugForPersonalConnector, personalCanvasConnectorTypeFromAppId } from "@sketch/shared";
import { type Context, Hono } from "hono";
import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config";
import { browseClickUpWorkspaces } from "../connectors/clickup";
import {
  CanvasConnectorCredentialProvider,
  ConnectorCredentialConfigError,
  assertStoredCredentialStorageConfigured,
  canvasOAuthPlaceholderCredentials,
  connectorCredentialSourceStatus,
  isCanvasOAuthConnector,
  isLocalConnectorBlockedInCanvasMode,
  resolveConnectorCredentials,
} from "../connectors/credential-providers";
import { parseEmailAddrJson, parseEmailAddrListJson } from "../connectors/email/envelope-metadata";
import type { EmailAddr } from "../connectors/email/normalized-email";
import { isEnrichmentActive, runEnrichment } from "../connectors/enrichment";
import {
  createEnrichmentEmbeddingProvider,
  createEnrichmentGenerator,
  resolveOpenRouterEnrichmentConfig,
} from "../connectors/enrichment-providers";
import { buildCredentialHint } from "../connectors/fireflies";
import { ensureValidToken, listFolderContents, listMyDriveFolders, listSharedDrives } from "../connectors/google-drive";
import { browseNotionRootPages, getBrowseStatus, startNotionBrowse } from "../connectors/notion";
import { buildOtterCredentialHint } from "../connectors/otter";
import { VALID_CONNECTOR_TYPES, getConnector } from "../connectors/registry";
import {
  browseFiles,
  filterAccessibleFileIds,
  getFileContent,
  listIndexedSources,
  search,
  searchFiles,
} from "../connectors/search";
import { getSyncProgress, runConnectorSync } from "../connectors/sync";
import { removeConnectorSourceItems } from "../connectors/sync-reconcile";
import { parseCredentials, serializeCredentials } from "../connectors/sync-utils";
import type { ConnectorCredentials, ConnectorType, OAuthCredentials } from "../connectors/types";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createFileSharesRepository } from "../db/repositories/file-shares";
import { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { HIDDEN_ENTITY_SOURCE_TYPES } from "../entities/profile-facts";
import {
  type ConnectorPermissions,
  connectorPermissions,
  denyIfNotAdmin,
  denyUnless,
  getContentViewer,
  getFileViewer,
  isAdmin,
} from "./auth-helpers";

type ConnectorRepo = ReturnType<typeof createConnectorRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

function emailLabel(addr: EmailAddr): string {
  return addr.name?.trim() || addr.email;
}

function sortBySentAtAsc<T extends { sent_at: string | null; indexed_file_id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.sent_at && b.sent_at && a.sent_at !== b.sent_at) return a.sent_at.localeCompare(b.sent_at);
    if (a.sent_at && !b.sent_at) return -1;
    if (!a.sent_at && b.sent_at) return 1;
    return a.indexed_file_id.localeCompare(b.indexed_file_id);
  });
}

interface IndexedFileRowForResponse {
  id: string;
  file_name: string;
  file_type: string | null;
  content_category: string;
  source: string;
  source_path: string | null;
  provider_url: string | null;
  synced_at: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  summary: string | null;
  summary_status: string;
  embedding_status: string;
}

/** Shared mapping from an indexed_files row to the Files-list response shape. */
function mapIndexedFileRow(
  f: IndexedFileRowForResponse,
  accessInfo: { count: number } | undefined,
  rollup?: { activityCount: number; summary?: string },
) {
  return {
    id: f.id,
    fileName: f.file_name,
    fileType: f.file_type,
    contentCategory: f.content_category,
    source: f.source,
    sourcePath: f.source_path,
    providerUrl: f.provider_url,
    syncedAt: f.synced_at,
    sourceCreatedAt: f.source_created_at,
    sourceUpdatedAt: f.source_updated_at,
    hasSummary: !!f.summary,
    summaryStatus: f.summary_status,
    embeddingStatus: f.embedding_status,
    accessScope: accessInfo ? ("restricted" as const) : ("unrestricted" as const),
    accessCount: accessInfo?.count ?? null,
    ...(rollup
      ? {
          resultKind: "crm_object" as const,
          activityCount: rollup.activityCount,
          ...(rollup.summary ? { rollupSummary: rollup.summary } : {}),
        }
      : {}),
  };
}

/** Run sync in background. Enrichment runs separately on the scheduled sync cycle. */
function syncInBackground(
  db: Kysely<DB>,
  connectorId: string,
  logger: Logger,
  config?: Partial<
    Pick<
      Config,
      | "SYNC_ALLOW_LARGE_RECONCILE"
      | "SYNC_MAX_RECONCILE_RATIO"
      | "CO_MENTION_CONTRIBUTES_TO_THRESHOLD"
      | "GEMINI_MAX_RPM"
      | "GEMINI_MAX_RETRIES"
      | "ENCRYPTION_KEY"
      | "CONNECTOR_CREDENTIAL_SOURCE"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
      | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
    >
  >,
) {
  runConnectorSync(db, connectorId, logger, config).catch((err) => {
    logger.error({ err, connectorId }, "Background sync failed");
  });
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function googleCalendarIdFromProviderFileId(providerFileId: string): string | null {
  const separator = providerFileId.indexOf(":");
  return separator > 0 ? providerFileId.slice(0, separator) : null;
}

export async function pruneGoogleCalendarFilesOutsideScope(params: {
  db: Kysely<DB>;
  connectorConfigId: string;
  scopeConfig: Record<string, unknown>;
  logger?: Logger;
}): Promise<{ itemsDeleted: number; affectedIndexedFileIds: string[] }> {
  if (!hasOwn(params.scopeConfig, "calendarIds")) return { itemsDeleted: 0, affectedIndexedFileIds: [] };

  const selectedCalendarIds = new Set(stringArray(params.scopeConfig.calendarIds));
  const rows = await params.db
    .selectFrom("indexed_files")
    .select("provider_file_id")
    .where("connector_config_id", "=", params.connectorConfigId)
    .where("source", "=", "google_calendar")
    .where("is_archived", "=", 0)
    .execute();

  const providerFileIds = rows
    .filter((row) => {
      const calendarId = googleCalendarIdFromProviderFileId(row.provider_file_id);
      return !calendarId || !selectedCalendarIds.has(calendarId);
    })
    .map((row) => row.provider_file_id);

  const result = await removeConnectorSourceItems({
    db: params.db,
    connectorConfigId: params.connectorConfigId,
    connectorType: "google_calendar",
    providerFileIds,
  });

  if (result.itemsDeleted > 0) {
    params.logger?.info(
      { connectorId: params.connectorConfigId, itemsDeleted: result.itemsDeleted },
      "Pruned Google Calendar files outside selected calendars",
    );
  }

  return result;
}

const VALID_AUTH_TYPES = ["oauth", "api_key", "service_account", "system"] as const;

const createConnectorSchema = z.object({
  connectorType: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
  authType: z.enum(VALID_AUTH_TYPES),
  credentials: z.record(z.string(), z.unknown()),
  scopeConfig: z.record(z.string(), z.unknown()).optional(),
});

const canvasConnectSchema = z.object({
  connectorType: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
  callbackUrl: z.string().url(),
});

const canvasImportSchema = z.object({
  connectorType: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
  accountId: z.string().trim().min(1).optional(),
  scopeConfig: z.record(z.string(), z.unknown()).optional(),
});

const canvasSuggestionSchema = z.object({
  appId: z.string().trim().min(1).max(128),
  accountId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
});

const rotateCredentialsSchema = z
  .object({
    api_key: z.string().trim().min(1).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => value.api_key || value.credentials, "Credentials are required");

const searchSchema = z.object({
  query: z.string().min(1, "Search query is required"),
  source: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

const enrichSchema = z.object({
  fileIds: z.array(z.string()).min(1, "At least one file ID is required"),
  instruction: z.string().min(1, "Instruction is required"),
});

const browseGoogleDriveSchema = z.object({
  credentials: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
});

const browseNotionSchema = z.object({
  credentials: z.object({
    api_key: z.string().min(1),
  }),
});

const browseClickUpSchema = z.object({
  credentials: z.object({
    api_key: z.string().min(1),
  }),
});

const updateScopeSchema = z.object({
  scopeConfig: z.record(z.string(), z.unknown()),
});

const CANVAS_APP_BY_CONNECTOR: Partial<Record<ConnectorType, string>> = {
  google_drive: "google-drive-oauth",
  google_calendar: "google-calendar-oauth",
  gmail: "google-gmail-oauth",
  outlook: "microsoft-outlook-oauth",
  teams: "microsoft-teams-oauth",
  fireflies: "fireflies",
  clickup: "clickup-api-key",
  notion: "notion",
  linear: "linear",
};

const SCOPE_REQUIRED_CONNECTORS = new Set<ConnectorType>(["google_drive", "google_calendar", "clickup", "notion"]);

export function connectorRoutes(
  connectorRepo: ConnectorRepo,
  db: Kysely<DB>,
  logger: Logger,
  userRepo?: UserRepo,
  appConfig?: Partial<
    Pick<
      Config,
      | "SYNC_ALLOW_LARGE_RECONCILE"
      | "SYNC_MAX_RECONCILE_RATIO"
      | "CO_MENTION_CONTRIBUTES_TO_THRESHOLD"
      | "GEMINI_MAX_RPM"
      | "GEMINI_MAX_RETRIES"
      | "ENCRYPTION_KEY"
      | "CONNECTOR_CREDENTIAL_SOURCE"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PEM"
      | "CANVAS_CREDENTIAL_PRIVATE_KEY_PATH"
      | "CANVAS_CREDENTIAL_PUBLIC_KEY_ID"
      | "OPENROUTER_API_KEY"
    >
  >,
) {
  const routes = new Hono();
  const fileSharesRepo = createFileSharesRepository(db);
  const canvasCredentialProvider = new CanvasConnectorCredentialProvider({
    db,
    appConfig: appConfig ?? {},
    logger,
  });

  type ConfigForPermissions = {
    connector_type: string;
    created_by: string;
    sync_status: string;
  };
  type ConfigForMetadata = ConfigForPermissions & {
    credential_hint?: string | null;
  };

  function permissionFields(permissions: ConnectorPermissions) {
    return {
      isOwner: permissions.isOwner,
      canManage: permissions.canManage,
      canDisconnect: permissions.canDisconnect,
      canSync: permissions.canSync,
      canChangeScope: permissions.canChangeScope,
      canUpdateCredentials: permissions.canUpdateCredentials,
      canBrowseScope: permissions.canBrowseScope,
      canEnrich: permissions.canEnrich,
    };
  }

  function permissionsForConfig(c: Context, config: ConfigForPermissions) {
    const meta = getConnector(config.connector_type as ConnectorType);
    const permissions = connectorPermissions(c, config, meta.perUserAuth);
    return { meta, permissions };
  }

  async function metadataFields(c: Context, config: ConfigForMetadata, permissions: ConnectorPermissions) {
    const owner = userRepo ? await userRepo.findById(config.created_by) : undefined;
    return {
      credentialHint: isAdmin(c) || permissions.isOwner ? (config.credential_hint ?? null) : null,
      createdByName: owner?.name ?? null,
      createdByEmail: owner?.email ?? null,
    };
  }

  function configVisible(config: { connector_type: string }): boolean {
    return !!getConnector(config.connector_type as ConnectorType);
  }

  function configEnabled(config: { connector_type: string; sync_status?: string }): boolean {
    return configVisible(config) && config.sync_status !== "disabled";
  }

  function localConnectorBlockedResponse(c: Context, connectorType: ConnectorType) {
    return c.json(
      {
        error: {
          code: "CANVAS_CREDENTIAL_SOURCE_REQUIRED",
          message: `${connectorType} credentials are managed by Canvas in this deployment. Use the Canvas connect flow.`,
        },
      },
      400,
    );
  }

  function localCredentialEncryptionRequiredResponse(c: Context) {
    return c.json(
      {
        error: {
          code: "ENCRYPTION_REQUIRED",
          message: "Set ENCRYPTION_KEY or CONNECTOR_CREDENTIAL_SOURCE=canvas before storing connector credentials",
        },
      },
      400,
    );
  }

  function existingConnectorResponse(config: {
    id: string;
    connector_type: string;
    sync_status: string;
  }) {
    return {
      connector: {
        id: config.id,
        connectorType: config.connector_type,
        syncStatus: config.sync_status,
        alreadyConnected: true,
      },
    };
  }

  function hasNonEmptyStringArray(scopeConfig: Record<string, unknown>, keys: string[]): boolean {
    return keys.some(
      (key) => Array.isArray(scopeConfig[key]) && scopeConfig[key].some((item) => typeof item === "string"),
    );
  }

  function hasUsableExistingScopeConfig(
    connectorType: ConnectorType,
    config?: { scope_config: string | null },
  ): boolean {
    if (!config?.scope_config) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config.scope_config) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (connectorType === "google_drive") return hasNonEmptyStringArray(parsed, ["sharedDrives", "folders"]);
    if (connectorType === "google_calendar") return hasNonEmptyStringArray(parsed, ["calendarIds"]);
    if (connectorType === "clickup") return hasNonEmptyStringArray(parsed, ["workspaces", "spaces"]);
    if (connectorType === "notion") return hasNonEmptyStringArray(parsed, ["rootPages"]);
    return Object.keys(parsed).length > 0;
  }

  function credentialHintForConnector(connectorType: ConnectorType, credentials: ConnectorCredentials): string | null {
    if (connectorType === "otter") return buildOtterCredentialHint(credentials);
    return credentials.type === "api_key" && credentials.api_key ? buildCredentialHint(credentials.api_key) : null;
  }

  function validationLogError(err: unknown) {
    if (err instanceof Error) {
      return { name: err.name, message: err.message };
    }
    return { message: String(err) };
  }

  async function getUserEmails(c: { get: (key: string) => unknown }): Promise<string[]> {
    if (!userRepo) return [];
    const userId = c.get("sub");
    if (typeof userId !== "string" || !userId) return [];
    return userRepo.getAllEmailsForUser(userId);
  }

  async function getOwnerEmail(createdBy: string): Promise<string | null> {
    if (!userRepo) return null;
    const owner = await userRepo.findById(createdBy);
    return owner?.email ?? null;
  }

  async function resolveStoredCredentials(config: {
    id: string;
    connector_type: string;
    credentials: string;
    credential_source?: string;
    created_by: string;
  }) {
    return resolveConnectorCredentials({
      db,
      config,
      appConfig: appConfig ?? {},
      ownerEmail: await getOwnerEmail(config.created_by),
      logger,
    });
  }

  /* ── Static-path routes (must come before /:id) ─────── */

  /**
   * List connectors with file counts.
   * Visibility: org-wide rows (perUserAuth: false) visible to all; per-user rows
   * filtered to admins or the row's owner.
   */
  routes.get("/", async (c) => {
    const viewer = getFileViewer(c);
    const [configs, users] = await Promise.all([connectorRepo.listConfigs(), userRepo ? userRepo.list() : []]);
    const teamMemberCount = users.filter((user) => user.type !== "agent").length;
    const connectorOwnersByType = new Map<string, Set<string>>();

    for (const cfg of configs) {
      if (!configVisible(cfg)) continue;
      const meta = getConnector(cfg.connector_type as ConnectorType);
      if (!meta.perUserAuth) continue;
      const owners = connectorOwnersByType.get(cfg.connector_type) ?? new Set<string>();
      owners.add(cfg.created_by);
      connectorOwnersByType.set(cfg.connector_type, owners);
    }

    const connectorMemberCounts = Object.fromEntries(
      [...connectorOwnersByType.entries()].map(([connectorType, owners]) => [connectorType, owners.size]),
    );

    const visible = configs.filter((cfg) => {
      if (!configVisible(cfg)) return false;
      const { permissions } = permissionsForConfig(c, cfg);
      return permissions.canView;
    });

    const connectorsWithCounts = await Promise.all(
      visible.map(async (cfg) => {
        const { meta, permissions } = permissionsForConfig(c, cfg);
        const metadata = await metadataFields(c, cfg, permissions);
        const fileCount = await connectorRepo.countFilesByConnector(cfg.id, viewer);
        return {
          id: cfg.id,
          connectorType: cfg.connector_type,
          authType: cfg.auth_type,
          credentialSource: cfg.credential_source,
          scopeConfig: JSON.parse(cfg.scope_config),
          syncStatus: cfg.sync_status,
          lastSyncedAt: cfg.last_synced_at,
          errorMessage: cfg.error_message,
          createdBy: cfg.created_by,
          ...metadata,
          createdAt: cfg.created_at,
          fileCount,
          perUserAuth: meta.perUserAuth,
          requiresOAuthClientSetup: meta.requiresOAuthClientSetup,
          hierarchyLevels: meta.hierarchyLevels ?? null,
          ...permissionFields(permissions),
        };
      }),
    );

    return c.json({ connectors: connectorsWithCounts, teamMemberCount, connectorMemberCounts });
  });

  routes.get("/credential-source", async (c) => {
    return c.json(await connectorCredentialSourceStatus({ db, appConfig: appConfig ?? {} }));
  });

  routes.get("/canvas/suggestions", async (c) => {
    const sub = c.get("sub");
    if (!sub || typeof sub !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in required" } }, 401);
    }

    const parsed = canvasSuggestionSchema.safeParse({
      appId: c.req.query("appId"),
      accountId: c.req.query("accountId"),
      source: c.req.query("source"),
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    if (parsed.data.source !== "canvas_user_secrets") {
      return c.json({ suggestion: null });
    }

    const connectorType = personalCanvasConnectorTypeFromAppId(parsed.data.appId);
    if (!connectorType) {
      return c.json({ suggestion: null });
    }

    const connectorMeta = getConnector(connectorType);
    if (!connectorMeta.perUserAuth) {
      return c.json({ suggestion: null });
    }

    const [status, existingConnector] = await Promise.all([
      connectorCredentialSourceStatus({ db, appConfig: appConfig ?? {} }),
      connectorRepo.findByTypeAndOwner(connectorType, sub),
    ]);

    if (!status.canvasConfigured || !status.canvasCredentialImportConfigured || existingConnector) {
      return c.json({ suggestion: null });
    }

    return c.json({
      suggestion: {
        connectorType,
        appId: canvasAppSlugForPersonalConnector(connectorType),
        ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      },
    });
  });

  routes.post("/canvas/connect", async (c) => {
    const sub = c.get("sub");
    const email = c.get("email");
    if (!sub || typeof sub !== "string" || !email) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in with an email is required" } }, 401);
    }

    const parsed = canvasConnectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const connectorType = parsed.data.connectorType as ConnectorType;
    const connectorMeta = getConnector(connectorType);
    const appSlug = CANVAS_APP_BY_CONNECTOR[connectorType];
    if (!appSlug) {
      return c.json({ error: { code: "NOT_SUPPORTED", message: "Connector is not supported in Canvas mode" } }, 400);
    }
    if (!connectorMeta.perUserAuth) {
      const denied = denyIfNotAdmin(c);
      if (denied) return denied;
    }

    try {
      const provider = await canvasCredentialProvider.loadProvider();
      const result = await provider.initiateConnection(
        email,
        appSlug,
        parsed.data.callbackUrl,
        undefined,
        c.get("role") === "admin" ? "admin" : "member",
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof ConnectorCredentialConfigError) {
        return c.json({ error: { code: err.code, message: err.message } }, 400);
      }
      throw err;
    }
  });

  routes.post("/canvas/import", async (c) => {
    const sub = c.get("sub");
    const email = c.get("email");
    if (!sub || typeof sub !== "string" || !email) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in with an email is required" } }, 401);
    }

    if (!canvasCredentialProvider.hasCredentialImportConfig()) {
      return c.json(
        {
          error: {
            code: "CANVAS_CREDENTIAL_IMPORT_NOT_CONFIGURED",
            message: "Canvas credential import requires a configured private key",
          },
        },
        400,
      );
    }

    const parsed = canvasImportSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const connectorType = parsed.data.connectorType as ConnectorType;
    const connectorMeta = getConnector(connectorType);

    let existingConnector:
      | Awaited<ReturnType<typeof connectorRepo.findByTypeAndOwner>>
      | Awaited<ReturnType<typeof connectorRepo.findConfigsByType>>[number]
      | undefined;

    if (!connectorMeta.perUserAuth) {
      const denied = denyIfNotAdmin(c);
      if (denied) return denied;
      existingConnector = (await connectorRepo.findConfigsByType(connectorType))[0];
    } else {
      existingConnector = await connectorRepo.findByTypeAndOwner(connectorType, sub);
    }

    let validationCredentials: ConnectorCredentials;
    try {
      validationCredentials = await canvasCredentialProvider.mint({
        connectorType,
        userEmail: email,
        accountId: parsed.data.accountId,
        userOrgRole: c.get("role") === "admin" ? "admin" : "member",
      });
      await connectorMeta.validateCredentials(validationCredentials);
    } catch (err) {
      if (err instanceof ConnectorCredentialConfigError) {
        return c.json({ error: { code: err.code, message: err.message } }, 400);
      }
      const message = err instanceof Error ? err.message : "Canvas credential import failed";
      logger.warn({ err, connectorType }, "Canvas credential import failed");
      return c.json({ error: { code: "INVALID_CREDENTIALS", message } }, 400);
    }

    if (validationCredentials.type === "api_key" && !appConfig?.ENCRYPTION_KEY) {
      return c.json(
        {
          error: {
            code: "ENCRYPTION_REQUIRED",
            message: "Canvas static-key import requires ENCRYPTION_KEY so the key is encrypted at rest",
          },
        },
        400,
      );
    }

    const needsScope =
      SCOPE_REQUIRED_CONNECTORS.has(connectorType) &&
      !parsed.data.scopeConfig &&
      !hasUsableExistingScopeConfig(connectorType, existingConnector);
    const storedCredentials: ConnectorCredentials = isCanvasOAuthConnector(connectorType)
      ? canvasOAuthPlaceholderCredentials(parsed.data.accountId)
      : validationCredentials;

    const credentialHint =
      validationCredentials.type === "api_key" && validationCredentials.api_key
        ? buildCredentialHint(validationCredentials.api_key)
        : null;

    const scopeConfig =
      parsed.data.scopeConfig !== undefined
        ? JSON.stringify(parsed.data.scopeConfig)
        : (existingConnector?.scope_config ?? undefined);

    if (existingConnector) {
      const config = await connectorRepo.updateConfig(existingConnector.id, {
        credentials: serializeCredentials(storedCredentials),
        credentialSource: "canvas",
        ...(scopeConfig !== undefined ? { scopeConfig } : {}),
        syncStatus: needsScope ? "paused" : "pending",
        errorMessage: null,
        ...(credentialHint !== null ? { credentialHint } : {}),
      });

      if (!needsScope) {
        syncInBackground(db, config.id, logger, appConfig);
      }

      return c.json(existingConnectorResponse(config));
    }

    const config = await connectorRepo.createConfig({
      connectorType,
      authType: isCanvasOAuthConnector(connectorType) ? "oauth" : "api_key",
      credentials: serializeCredentials(storedCredentials),
      credentialSource: "canvas",
      scopeConfig,
      syncStatus: needsScope ? "paused" : "pending",
      createdBy: sub,
      credentialHint,
    });

    if (!needsScope) {
      syncInBackground(db, config.id, logger, appConfig);
    }

    return c.json(
      {
        connector: {
          id: config.id,
          connectorType: config.connector_type,
          syncStatus: config.sync_status,
          alreadyConnected: false,
        },
      },
      201,
    );
  });

  /** Create a new connector — validates credentials then auto-triggers first sync. */
  routes.post("/", async (c) => {
    const sub = c.get("sub");
    if (!sub || typeof sub !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in required" } }, 401);
    }

    const body = await c.req.json();
    const parsed = createConnectorSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const connectorType = parsed.data.connectorType as ConnectorType;
    const connectorMeta = getConnector(connectorType);

    if (isLocalConnectorBlockedInCanvasMode(appConfig, connectorType)) {
      return localConnectorBlockedResponse(c, connectorType);
    }

    try {
      assertStoredCredentialStorageConfigured(appConfig);
    } catch (err) {
      if (err instanceof ConnectorCredentialConfigError) {
        return localCredentialEncryptionRequiredResponse(c);
      }
      throw err;
    }

    // Org-wide connectors (perUserAuth: false) are admin-only.
    if (!connectorMeta.perUserAuth) {
      const denied = denyIfNotAdmin(c);
      if (denied) return denied;
    }

    // Per-user uniqueness guard — clearer error than a unique-index violation.
    if (connectorMeta.perUserAuth) {
      const existing = await connectorRepo.findByTypeAndOwner(connectorType, sub);
      if (existing) {
        return c.json(
          {
            error: {
              code: "ALREADY_CONNECTED",
              message: `You already have a ${connectorType} connection. Rotate the key from Settings instead.`,
            },
          },
          409,
        );
      }
    }

    // Validate credentials by testing the API connection.
    // For OAuth, also refresh the token so we store a valid access_token.
    let credentials = { type: parsed.data.authType, ...parsed.data.credentials } as ConnectorCredentials;
    try {
      if (credentials.type === "oauth" && connectorMeta.refreshTokens) {
        const refreshed = await connectorMeta.refreshTokens(credentials);
        if (refreshed) credentials = refreshed;
      }
      await connectorMeta.validateCredentials(credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid credentials";
      logger.warn(
        { error: validationLogError(err), connectorType: parsed.data.connectorType },
        "Credential validation failed",
      );
      return c.json(
        { error: { code: "INVALID_CREDENTIALS", message: `Credential validation failed: ${message}` } },
        400,
      );
    }

    const credentialHint = credentialHintForConnector(connectorType, credentials);

    const config = await connectorRepo.createConfig({
      connectorType,
      authType: parsed.data.authType,
      credentials: serializeCredentials(credentials),
      credentialSource: "local",
      scopeConfig: parsed.data.scopeConfig ? JSON.stringify(parsed.data.scopeConfig) : undefined,
      createdBy: sub,
      credentialHint,
    });

    // Auto-trigger first sync + enrichment in background (non-blocking)
    syncInBackground(db, config.id, logger, appConfig);

    return c.json(
      {
        connector: {
          id: config.id,
          connectorType: config.connector_type,
          syncStatus: config.sync_status,
        },
      },
      201,
    );
  });

  /** List the JWT user's own connectors (one row per Fireflies/etc API-key connector). */
  routes.get("/mine", async (c) => {
    const sub = c.get("sub");
    if (!sub || typeof sub !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in required" } }, 401);
    }

    const viewer = getFileViewer(c);
    const configs = (await connectorRepo.listByOwner(sub)).filter(configVisible);
    const result = await Promise.all(
      configs.map(async (config) => {
        const { permissions } = permissionsForConfig(c, config);
        const metadata = await metadataFields(c, config, permissions);
        const fileCount = await connectorRepo.countFilesByConnector(config.id, viewer);
        return {
          id: config.id,
          connectorType: config.connector_type,
          createdBy: config.created_by,
          ...metadata,
          syncStatus: config.sync_status,
          lastSyncedAt: config.last_synced_at,
          errorMessage: config.error_message,
          createdAt: config.created_at,
          fileCount,
          ...permissionFields(permissions),
        };
      }),
    );
    return c.json({ connectors: result });
  });

  /** List all files across connectors with pagination, optional source filter, and access info. */
  routes.get("/all-files", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const source = c.req.query("source") || undefined;
    const category = c.req.query("category") || undefined;
    const status = c.req.query("status") || undefined;
    const access = c.req.query("access") || undefined;

    const viewer = getFileViewer(c);
    const filters = { connectorType: source, excludedSources: [], category, status, access };
    // Collapse CRM activity members under their parent object rows.
    const [files, total, enrichedTotal] = await Promise.all([
      connectorRepo.listAllFiles({ limit, offset, viewer, collapseRollups: true, ...filters }),
      connectorRepo.countAllFiles({ viewer, collapseRollups: true, ...filters }),
      connectorRepo.countEnrichedFiles({ viewer, collapseRollups: true, ...filters }),
    ]);

    const fileIds = files.map((f) => f.id);
    const accessMap =
      fileIds.length > 0
        ? await connectorRepo.getFileAccessMap(fileIds)
        : new Map<string, { type: string; count: number }>();

    // Annotate rollup anchors (parent objects with activities) with their live
    // activity count + (optional) generated summary. Count drives the badge/expand
    // so it works before summaries exist (they are async and capped).
    const anchors = files
      .filter((f) => f.rollup_group_id && f.rollup_group_id === f.provider_file_id)
      .map((f) => ({ connectorConfigId: f.connector_config_id, groupId: f.provider_file_id }));
    const [countMap, summaryMap] = await Promise.all([
      connectorRepo.getActivityCounts(anchors),
      connectorRepo.getRollupSummaries(anchors),
    ]);

    return c.json({
      files: files.map((f) => {
        const key = `${f.connector_config_id}::${f.provider_file_id}`;
        const count = f.rollup_group_id === f.provider_file_id ? (countMap.get(key) ?? 0) : 0;
        const rollup = count > 0 ? { activityCount: count, summary: summaryMap.get(key)?.summary } : undefined;
        return mapIndexedFileRow(f, accessMap.get(f.id), rollup);
      }),
      total,
      enrichedTotal,
      hasMore: offset + limit < total,
    });
  });

  /** Activity members rolled up under a CRM object anchor (for the expand action). */
  routes.get("/all-files/:id/activities", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const viewer = getFileViewer(c);

    const anchor = await connectorRepo.getRollupAnchorRef(c.req.param("id"), viewer);
    if (!anchor) {
      return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const members = await connectorRepo.listGroupActivities({
      connectorConfigId: anchor.connector_config_id,
      groupId: anchor.provider_file_id,
      viewer,
      limit,
      offset,
    });

    const memberIds = members.map((f) => f.id);
    const accessMap =
      memberIds.length > 0
        ? await connectorRepo.getFileAccessMap(memberIds)
        : new Map<string, { type: string; count: number }>();

    return c.json({
      files: members.map((f) => mapIndexedFileRow(f, accessMap.get(f.id))),
      hasMore: members.length === limit,
    });
  });

  /** Hybrid search: FTS5 keyword + vector semantic search with RRF merging. */
  routes.get("/search", async (c) => {
    const query = c.req.query("query") ?? "";
    const source = c.req.query("source");
    const category = c.req.query("category");
    const limit = c.req.query("limit");
    const after = c.req.query("after");
    const before = c.req.query("before");

    const parsed = searchSchema.safeParse({ query, source, category, limit });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const userEmails = await getUserEmails(c);
    const results = await search(db, parsed.data.query, {
      source: parsed.data.source,
      category: parsed.data.category,
      limit: parsed.data.limit,
      after: after ?? undefined,
      before: before ?? undefined,
      userEmails,
      geminiMaxRpm: appConfig?.GEMINI_MAX_RPM,
      geminiMaxRetries: appConfig?.GEMINI_MAX_RETRIES,
      openRouterApiKey: appConfig?.OPENROUTER_API_KEY,
      settingsEncryptionKey: appConfig?.ENCRYPTION_KEY,
      logger,
    });
    return c.json({ results });
  });

  /** Get full content of a file, including who has access and linked entities. */
  routes.get("/files/:fileId/content", async (c) => {
    const fileId = c.req.param("fileId");
    // Admin bypass (admin role + admin_can_read_all_files setting) → undefined
    // signals trusted bypass to getFileContent; otherwise pass the caller's
    // resolved emails so the 3-tier RBAC check runs.
    const contentViewer = getContentViewer(c);
    const userEmails = contentViewer.isAdmin ? undefined : await getUserEmails(c);
    const exists = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "file_type", "source", "source_path", "synced_at", "enrichment_status"])
      .where("id", "=", fileId)
      .executeTakeFirst();
    if (!exists) {
      return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }
    const file = await getFileContent(db, fileId, userEmails);
    if (!file) {
      // Admins already see the file metadata in the list; surface name/source/etc.
      // here so they can triage which file is gated and ask the owner. For non-admins,
      // omit metadata — the file isn't in their list, so its name shouldn't leak.
      const callerIsAdmin = isAdmin(c);
      const metadata = callerIsAdmin
        ? {
            file: {
              id: exists.id,
              fileName: exists.file_name,
              fileType: exists.file_type,
              source: exists.source,
              sourcePath: exists.source_path,
              syncedAt: exists.synced_at,
              enrichmentStatus: exists.enrichment_status,
            },
            access: await (async () => {
              const details = await connectorRepo.getFileAccessDetails(fileId);
              const manualShares = await fileSharesRepo.listForFile(fileId);
              const shareWithEveryone = await fileSharesRepo.getOrgWide(fileId);
              return {
                scope: details.length > 0 ? "restricted" : "unrestricted",
                members: details.map((a) => ({
                  email: a.email,
                  userName: a.userName,
                  userId: a.userId,
                  source: a.source,
                  mapped: !!a.userId,
                })),
                manualShares: manualShares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
                shareWithEveryone,
              };
            })(),
          }
        : {};
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "You don't have access to this file's contents.",
            ...metadata,
          },
        },
        403,
      );
    }

    const accessDetails = await connectorRepo.getFileAccessDetails(fileId);
    const manualShares = await fileSharesRepo.listForFile(fileId);
    const shareWithEveryone = await fileSharesRepo.getOrgWide(fileId);

    // Get entities linked to this file via entity_mentions
    const mentions = await db
      .selectFrom("entity_mentions")
      .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
      .select([
        "entities.id",
        "entities.name",
        "entities.source_type",
        "entities.subtype",
        "entity_mentions.context_snippet",
      ])
      .where("entity_mentions.indexed_file_id", "=", fileId)
      .where("entities.source_type", "not in", Array.from(HIDDEN_ENTITY_SOURCE_TYPES))
      .where(whereLiveEntity())
      .execute();

    // Dedupe entities (a file may mention same entity in multiple chunks)
    const seenIds = new Set<string>();
    const linkedEntities = mentions
      .filter((m) => {
        if (seenIds.has(m.id)) return false;
        seenIds.add(m.id);
        return true;
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        sourceType: m.source_type,
        subtype: m.subtype,
      }));

    // For email files, hand the detail sheet enough to fetch the whole visible
    // thread. Safe metadata for a file the caller can already open; also lets a
    // search result opened on `hitFileId` render its conversation.
    let emailThread: { connectorId: string; threadKey: string } | undefined;
    if (file.fileType === "email_message") {
      const env = await db
        .selectFrom("email_message_envelopes")
        .select(["connector_config_id", "thread_id"])
        .where("indexed_file_id", "=", fileId)
        .executeTakeFirst();
      if (env) {
        emailThread = { connectorId: env.connector_config_id, threadKey: env.thread_id ?? fileId };
      }
    }

    return c.json({
      file: { ...file, emailThread },
      access: {
        scope: accessDetails.length > 0 ? "restricted" : "unrestricted",
        members: accessDetails.map((a) => ({
          email: a.email,
          userName: a.userName,
          userId: a.userId,
          source: a.source,
          mapped: !!a.userId,
        })),
        manualShares: manualShares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
        shareWithEveryone,
      },
      entities: linkedEntities,
    });
  });

  /**
   * Manual file share management. Connector reconcile never touches these rows.
   *
   * Authz:
   *   - GET, POST, DELETE individual shares: owning connector canManage
   *   - PUT share-everyone: admin only (org-wide flag)
   *   - PUT batch: canManage for the emails delta, plus admin gate when
   *     shareWithEveryone is in the body
   */
  const shareEmailBodySchema = z.object({ email: z.string().email().toLowerCase() });
  const shareEveryoneBodySchema = z.object({ enabled: z.boolean() });
  const shareBatchBodySchema = z.object({
    emails: z.array(z.string().email().toLowerCase()),
    shareWithEveryone: z.boolean().optional(),
  });

  async function loadFileForShare(c: Context, fileId: string) {
    const config = await connectorRepo.findConfigByFileId(fileId);
    if (!config) return null;
    if (!configEnabled(config)) return null;
    const { permissions } = permissionsForConfig(c, config);
    return { connectorConfigId: config.id, permissions };
  }

  routes.get("/files/:fileId/shares", async (c) => {
    const fileId = c.req.param("fileId");
    const fileOwner = await loadFileForShare(c, fileId);
    if (!fileOwner) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const denied = denyUnless(c, fileOwner.permissions.canManage);
    if (denied) return denied;
    const shares = await fileSharesRepo.listForFile(fileId);
    const shareWithEveryone = await fileSharesRepo.getOrgWide(fileId);
    return c.json({
      shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
      shareWithEveryone,
    });
  });

  routes.post("/files/:fileId/shares", async (c) => {
    const fileId = c.req.param("fileId");
    const fileOwner = await loadFileForShare(c, fileId);
    if (!fileOwner) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const denied = denyUnless(c, fileOwner.permissions.canManage);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareEmailBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    const grantedBy = c.get("sub") as string;
    await fileSharesRepo.grantToEmail(fileId, parsed.data.email, grantedBy);
    const shares = await fileSharesRepo.listForFile(fileId);
    return c.json({ shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })) });
  });

  routes.delete("/files/:fileId/shares/:email", async (c) => {
    const fileId = c.req.param("fileId");
    const email = decodeURIComponent(c.req.param("email"));
    const fileOwner = await loadFileForShare(c, fileId);
    if (!fileOwner) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const denied = denyUnless(c, fileOwner.permissions.canManage);
    if (denied) return denied;
    await fileSharesRepo.revokeFromEmail(fileId, email);
    return c.json({ success: true });
  });

  routes.put("/files/:fileId/share-everyone", async (c) => {
    const fileId = c.req.param("fileId");
    const fileOwner = await loadFileForShare(c, fileId);
    if (!fileOwner) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareEveryoneBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    await fileSharesRepo.setOrgWide(fileId, parsed.data.enabled);
    return c.json({ shareWithEveryone: parsed.data.enabled });
  });

  /**
   * Replace the share set in one transaction. Lets the UI commit the dialog
   * without sequencing several requests; partial-save states aren't possible.
   */
  routes.put("/files/:fileId/shares", async (c) => {
    const fileId = c.req.param("fileId");
    const fileOwner = await loadFileForShare(c, fileId);
    if (!fileOwner) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    const editDenied = denyUnless(c, fileOwner.permissions.canManage);
    if (editDenied) return editDenied;
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareBatchBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    if (parsed.data.shareWithEveryone !== undefined) {
      const adminDenied = denyIfNotAdmin(c);
      if (adminDenied) return adminDenied;
    }
    const grantedBy = c.get("sub") as string;
    const targetEmails = new Set(parsed.data.emails);
    await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("file_share_emails")
        .select("email")
        .where("indexed_file_id", "=", fileId)
        .execute();
      const existingSet = new Set(existing.map((r) => r.email));
      const toAdd = [...targetEmails].filter((e) => !existingSet.has(e));
      const toRemove = [...existingSet].filter((e) => !targetEmails.has(e));
      if (toAdd.length > 0) {
        await trx
          .insertInto("file_share_emails")
          .values(
            toAdd.map((email) => ({
              indexed_file_id: fileId,
              email,
              granted_by_user_id: grantedBy,
            })),
          )
          .onConflict((oc) => oc.columns(["indexed_file_id", "email"]).doNothing())
          .execute();
      }
      if (toRemove.length > 0) {
        await trx
          .deleteFrom("file_share_emails")
          .where("indexed_file_id", "=", fileId)
          .where("email", "in", toRemove)
          .execute();
      }
      if (parsed.data.shareWithEveryone !== undefined) {
        await trx
          .updateTable("indexed_files")
          .set({ share_with_everyone: parsed.data.shareWithEveryone ? 1 : 0 })
          .where("id", "=", fileId)
          .execute();
      }
    });
    const shares = await fileSharesRepo.listForFile(fileId);
    const shareWithEveryone = await fileSharesRepo.getOrgWide(fileId);
    return c.json({
      shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
      shareWithEveryone,
    });
  });

  /** List indexed sources summary. */
  routes.get("/sources", async (c) => {
    const sources = await listIndexedSources(db);
    return c.json({ sources });
  });

  /**
   * Visible file count per source for the caller. Drives the source-filter chips
   * on the Files page so they agree with the file-list view, even when the caller
   * has access via per-file shares to files whose connector row they can't see.
   */
  routes.get("/file-counts-by-source", async (c) => {
    const counts = await connectorRepo.countFilesBySource(getFileViewer(c));
    return c.json({ counts });
  });

  /** Live sync/enrichment progress + pending enrichment count. */
  routes.get("/progress", async (c) => {
    const [pendingResult, summaryStats] = await Promise.all([
      db
        .selectFrom("indexed_files")
        .select(db.fn.count("id").as("count"))
        .where((eb) =>
          eb.or([
            eb("embedding_status", "in", ["pending", "failed"]),
            eb("summary_status", "in", ["pending", "failed"]),
          ]),
        )
        .where("is_archived", "=", 0)
        .executeTakeFirst(),
      db
        .selectFrom("indexed_files")
        .select([
          db.fn.count("id").as("total"),
          sql<number>`sum(case when summary_status = 'done' then 1 else 0 end)`.as("summarized"),
          sql<number>`sum(case when embedding_status = 'done' then 1 else 0 end)`.as("enriched"),
        ])
        .where("is_archived", "=", 0)
        .executeTakeFirst(),
    ]);
    return c.json({
      active: getSyncProgress(),
      pendingEnrichment: Number(pendingResult?.count ?? 0),
      enrichmentActive: isEnrichmentActive(),
      enrichmentStats: {
        total: Number(summaryStats?.total ?? 0),
        enriched: Number(summaryStats?.enriched ?? 0),
        summarized: Number(summaryStats?.summarized ?? 0),
      },
    });
  });

  /* ── Generic browse endpoints ──────────────────────────── */

  /** Browse scope items for a new connection (generic). */
  routes.post("/browse", async (c) => {
    const body = await c.req.json();
    const parsed = z
      .object({
        connectorType: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
        credentials: z.record(z.string(), z.unknown()),
      })
      .safeParse(body);

    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const connectorType = parsed.data.connectorType as ConnectorType;
    const connector = getConnector(connectorType);
    if (!connector.browse) {
      return c.json(
        { error: { code: "NOT_SUPPORTED", message: "This connector does not support scope browsing" } },
        400,
      );
    }

    try {
      const credentials = { type: "api_key", ...parsed.data.credentials } as ConnectorCredentials;
      await connector.validateCredentials(credentials);
      const result = await connector.browse({ credentials, logger });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed";
      logger.warn({ err, connectorType: parsed.data.connectorType }, "Generic browse failed");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /** Poll async browse status (e.g. Notion). */
  routes.get("/browse-status/:jobId", async (c) => {
    const status = getBrowseStatus(c.req.param("jobId"));
    if (!status) {
      return c.json({ error: { code: "NOT_FOUND", message: "Browse job not found or expired" } }, 404);
    }
    return c.json(status);
  });

  /** Browse scope items for an existing connector (generic). */
  routes.get("/:id/browse", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { meta: connector, permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    if (!connector.browseExisting && !connector.browse) {
      return c.json(
        { error: { code: "NOT_SUPPORTED", message: "This connector does not support scope browsing" } },
        400,
      );
    }

    const currentScope = JSON.parse(config.scope_config) as Record<string, unknown>;
    const refresh = c.req.query("refresh") === "true";

    // Return cached browse data if available (unless explicit refresh requested)
    if (!refresh && config.browse_cache) {
      try {
        const cached = JSON.parse(config.browse_cache);
        return c.json({ ...cached, scopeConfig: currentScope, cached: true });
      } catch {
        // Invalid cache — fall through to live browse
      }
    }

    try {
      const resolved = await resolveStoredCredentials(config);
      let credentials = resolved.credentials;
      if (resolved.credentialSource === "local" && credentials.type === "oauth" && connector.refreshTokens) {
        const refreshed = await connector.refreshTokens(credentials as OAuthCredentials);
        if (refreshed) {
          credentials = refreshed;
          await connectorRepo.updateConfig(config.id, {
            credentials: serializeCredentials(credentials),
          });
        }
      }

      const result = connector.browseExisting
        ? await connector.browseExisting({ credentials, logger, accessTokenProvider: resolved.accessTokenProvider })
        : await connector.browse?.({ credentials, logger, accessTokenProvider: resolved.accessTokenProvider });
      if (!result) {
        return c.json({ error: "Connector does not support browsing" }, 400);
      }
      if (result.type === "async") {
        return c.json(result);
      }

      // Cache the browse result for instant loading next time
      await connectorRepo.updateConfig(config.id, { browseCache: JSON.stringify(result) });

      return c.json({ ...result, scopeConfig: currentScope });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed";
      logger.warn({ err, connectorId: config.id }, "Generic browse failed for existing connector");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /** Browse folder/subtree children for tree-type pickers (e.g. Google Drive). */
  routes.get("/:id/browse-children/:parentId", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { meta: connector, permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    if (!connector.browseChildren) {
      return c.json(
        { error: { code: "NOT_SUPPORTED", message: "This connector does not support subtree browsing" } },
        400,
      );
    }

    try {
      const resolved = await resolveStoredCredentials(config);
      let credentials = resolved.credentials;
      if (resolved.credentialSource === "local" && credentials.type === "oauth" && connector.refreshTokens) {
        const refreshed = await connector.refreshTokens(credentials as OAuthCredentials);
        if (refreshed) {
          credentials = refreshed;
          await connectorRepo.updateConfig(config.id, {
            credentials: serializeCredentials(credentials),
          });
        }
      }

      const items = await connector.browseChildren({
        credentials,
        accessTokenProvider: resolved.accessTokenProvider,
        parentId: c.req.param("parentId"),
        logger,
      });
      return c.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed";
      logger.warn({ err, connectorId: config.id }, "Browse children failed");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /* ── Per-connector browse routes (legacy, kept for backward compat) ── */

  /** Browse Google Drive shared drives for the folder picker. */
  routes.post("/google-drive/browse", async (c) => {
    const body = await c.req.json();
    const parsed = browseGoogleDriveSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    try {
      const oauthCreds: OAuthCredentials = {
        type: "oauth",
        client_id: parsed.data.credentials.client_id,
        client_secret: parsed.data.credentials.client_secret,
        refresh_token: parsed.data.credentials.refresh_token,
        access_token: "",
      };

      const validCreds = await ensureValidToken(oauthCreds);
      const sharedDrives = await listSharedDrives(validCreds.access_token);

      // Also fetch root folders for My Drive mode (when no shared drives exist)
      const rootFolders = sharedDrives.length === 0 ? await listMyDriveFolders(validCreds.access_token) : [];

      return c.json({ sharedDrives, rootFolders });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse Google Drive";
      logger.warn({ err }, "Google Drive browse failed");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /**
   * Browse shared drives for an existing connector (uses stored credentials).
   * Used by the manage dialog when admin wants to add/remove drives.
   */
  routes.get("/google-drive/browse/:connectorId", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("connectorId"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    if (config.connector_type !== "google_drive") {
      return c.json({ error: { code: "INVALID_TYPE", message: "Connector is not Google Drive" } }, 400);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    try {
      const resolved = await resolveStoredCredentials(config);
      const credentials = resolved.credentials as OAuthCredentials;
      const validCreds = resolved.accessTokenProvider ? credentials : await ensureValidToken(credentials);

      // Persist refreshed token if it changed
      if (!resolved.accessTokenProvider && validCreds.access_token !== credentials.access_token) {
        await connectorRepo.updateConfig(config.id, {
          credentials: serializeCredentials(validCreds),
        });
      }

      const accessToken = resolved.accessTokenProvider ?? validCreds.access_token;
      const sharedDrives = await listSharedDrives(accessToken);
      const currentScope = JSON.parse(config.scope_config) as Record<string, unknown>;
      const selectedDriveIds = (currentScope.sharedDrives as string[] | undefined) ?? [];
      const selectedFolderIds = (currentScope.folders as string[] | undefined) ?? [];

      // Always fetch root folders so users can pick shared drives, My Drive folders, or both
      const rootFolders = await listMyDriveFolders(accessToken);

      return c.json({
        sharedDrives: sharedDrives.map((d) => ({
          ...d,
          selected: selectedDriveIds.includes(d.id),
        })),
        rootFolders: rootFolders.map((f) => ({
          ...f,
          selected: selectedFolderIds.includes(f.id),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse Google Drive";
      logger.warn({ err, connectorId: config.id }, "Google Drive browse failed for existing connector");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /**
   * Browse contents of a specific folder within a connector's Drive.
   * Returns immediate children (files and subfolders) for the folder picker preview.
   */
  routes.get("/google-drive/browse/:connectorId/folder/:folderId", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("connectorId"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    if (config.connector_type !== "google_drive") {
      return c.json({ error: { code: "INVALID_TYPE", message: "Connector is not Google Drive" } }, 400);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    try {
      const resolved = await resolveStoredCredentials(config);
      const credentials = resolved.credentials as OAuthCredentials;
      const validCreds = resolved.accessTokenProvider ? credentials : await ensureValidToken(credentials);

      if (!resolved.accessTokenProvider && validCreds.access_token !== credentials.access_token) {
        await connectorRepo.updateConfig(config.id, {
          credentials: serializeCredentials(validCreds),
        });
      }

      const accessToken = resolved.accessTokenProvider ?? validCreds.access_token;
      const items = await listFolderContents(accessToken, c.req.param("folderId"));
      return c.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse folder";
      logger.warn({ err, connectorId: config.id }, "Google Drive folder browse failed");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /** Browse ClickUp workspaces and spaces for the scope picker (new connection). */
  routes.post("/clickup/browse", async (c) => {
    const body = await c.req.json();
    const parsed = browseClickUpSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    try {
      const connector = getConnector("clickup");
      await connector.validateCredentials({ type: "api_key", api_key: parsed.data.credentials.api_key });
      const workspaces = await browseClickUpWorkspaces(parsed.data.credentials.api_key);
      return c.json({ workspaces });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse ClickUp";
      logger.warn({ err }, "ClickUp browse failed");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /** Browse ClickUp workspaces for an existing connector (uses stored credentials). */
  routes.get("/clickup/browse/:connectorId", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("connectorId"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    if (config.connector_type !== "clickup") {
      return c.json({ error: { code: "INVALID_TYPE", message: "Connector is not ClickUp" } }, 400);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    try {
      const credentials = parseCredentials(config.credentials) as {
        type: string;
        api_key?: string;
        access_token?: string;
      };
      const token = credentials.api_key ?? credentials.access_token ?? "";
      const workspaces = await browseClickUpWorkspaces(token);
      const currentScope = JSON.parse(config.scope_config) as Record<string, unknown>;
      const selectedWorkspaceIds = (currentScope.workspaces as string[] | undefined) ?? [];
      const selectedSpaceIds = (currentScope.spaces as string[] | undefined) ?? [];

      return c.json({
        workspaces: workspaces.map((w) => ({
          ...w,
          selected: selectedWorkspaceIds.length === 0 || selectedWorkspaceIds.includes(w.id),
          spaces: w.spaces.map((s) => ({
            ...s,
            selected: selectedSpaceIds.length === 0 || selectedSpaceIds.includes(s.id),
          })),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse ClickUp";
      logger.warn({ err, connectorId: config.id }, "ClickUp browse failed for existing connector");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /** Start scanning Notion workspace for root pages. Returns a browseId to poll. */
  routes.post("/notion/browse", async (c) => {
    const body = await c.req.json();
    const parsed = browseNotionSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    try {
      // Validate credentials first (quick /users/me call)
      const connector = getConnector("notion");
      await connector.validateCredentials({ type: "api_key", api_key: parsed.data.credentials.api_key });

      // Start background scan
      const browseId = startNotionBrowse(parsed.data.credentials.api_key);
      return c.json({ browseId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid credentials";
      logger.warn({ err }, "Notion credential validation failed");
      return c.json(
        { error: { code: "INVALID_CREDENTIALS", message: `Credential validation failed: ${message}` } },
        400,
      );
    }
  });

  /** Poll Notion browse progress. Returns root pages found so far. */
  routes.get("/notion/browse-status/:browseId", async (c) => {
    const status = getBrowseStatus(c.req.param("browseId"));
    if (!status) {
      return c.json({ error: { code: "NOT_FOUND", message: "Browse job not found or expired" } }, 404);
    }
    return c.json(status);
  });

  /** Browse Notion root pages for an existing connector (uses stored credentials). */
  routes.get("/notion/browse/:connectorId", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("connectorId"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    if (config.connector_type !== "notion") {
      return c.json({ error: { code: "INVALID_TYPE", message: "Connector is not Notion" } }, 400);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canBrowseScope);
    if (denied) return denied;

    try {
      const credentials = parseCredentials(config.credentials) as {
        type: string;
        api_key?: string;
        access_token?: string;
      };
      const token = credentials.api_key ?? credentials.access_token ?? "";

      const rootPages = await browseNotionRootPages(token);
      const currentScope = JSON.parse(config.scope_config) as Record<string, unknown>;
      const selectedPageIds = (currentScope.rootPages as string[] | undefined) ?? [];

      return c.json({
        rootPages: rootPages.map((p) => ({
          ...p,
          selected: selectedPageIds.includes(p.id),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to browse Notion";
      logger.warn({ err, connectorId: config.id }, "Notion browse failed for existing connector");
      return c.json({ error: { code: "BROWSE_FAILED", message } }, 400);
    }
  });

  /* ── Dynamic :id routes ─────────────────────────────── */

  /** Get a single connector. */
  routes.get("/:id", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { meta, permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const metadata = await metadataFields(c, config, permissions);
    const fileCount = await connectorRepo.countFilesByConnector(config.id, getFileViewer(c));
    return c.json({
      connector: {
        id: config.id,
        connectorType: config.connector_type,
        authType: config.auth_type,
        credentialSource: config.credential_source,
        scopeConfig: JSON.parse(config.scope_config),
        syncStatus: config.sync_status,
        lastSyncedAt: config.last_synced_at,
        errorMessage: config.error_message,
        createdBy: config.created_by,
        ...metadata,
        createdAt: config.created_at,
        fileCount,
        perUserAuth: meta.perUserAuth,
        requiresOAuthClientSetup: meta.requiresOAuthClientSetup,
        hierarchyLevels: meta.hierarchyLevels ?? null,
        ...permissionFields(permissions),
      },
    });
  });

  /** Count entities associated with a connector's files (for disconnect confirmation). */
  routes.get("/:id/entity-count", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const fileIds = await connectorRepo.getOwnedFileIdsForConnector(config.id);
    const entityRepo = createEntityRepository(db);
    const count = await entityRepo.countEntitiesForFiles(fileIds);
    return c.json({ count });
  });

  /**
   * Suppression transparency: what the shared email layer filtered out before
   * indexing, and why. Connector-scoped (owner/admin) — the connector owner is a
   * party to every message in their own perUserAuth mailbox, so no per-message
   * visibility predicate is needed here.
   *
   * Counts-only: `email_suppressed_messages` persists only the reason + provider
   * IDs, so sender/subject are intentionally absent (see GMAIL_CONNECTOR_UI §U3).
   */
  routes.get("/:id/suppressed-emails", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

    const [countRows, recentRows, totalRow] = await Promise.all([
      db
        .selectFrom("email_suppressed_messages")
        .where("connector_config_id", "=", config.id)
        .groupBy("reason")
        .select((eb) => ["reason", eb.fn.count<number>("id").as("count")])
        .execute(),
      db
        .selectFrom("email_suppressed_messages")
        .where("connector_config_id", "=", config.id)
        .select(["provider_file_id", "provider_message_id", "thread_id", "reason", "observed_at"])
        .orderBy("observed_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db
        .selectFrom("email_suppressed_messages")
        .where("connector_config_id", "=", config.id)
        .select((eb) => eb.fn.count<number>("id").as("count"))
        .executeTakeFirst(),
    ]);

    const countsByReason: Record<string, number> = {
      bulk: 0,
      operational: 0,
      role_account: 0,
      inbound_only: 0,
      missing_counterparty: 0,
    };
    for (const row of countRows) {
      countsByReason[row.reason] = Number(row.count);
    }
    const total = Number(totalRow?.count ?? 0);

    return c.json({
      countsByReason,
      recent: recentRows.map((row) => ({
        providerFileId: row.provider_file_id,
        providerMessageId: row.provider_message_id,
        threadId: row.thread_id,
        reason: row.reason,
        observedAt: row.observed_at,
      })),
      total,
      hasMore: offset + recentRows.length < total,
    });
  });

  /**
   * Thread-grouped email for the connector manage view. One row per conversation
   * (`COALESCE(thread_id, indexed_file_id)`), ordered by latest activity.
   * Connector-scoped (owner/admin): returns only envelope metadata (subject,
   * participants, counts), never message bodies, so no per-viewer content
   * predicate is needed here — see the detail route for body access.
   */
  routes.get("/:id/email-threads", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const threadKeyExpr = sql<string>`coalesce(email_message_envelopes.thread_id, email_message_envelopes.indexed_file_id)`;

    const [pageRows, totalRow] = await Promise.all([
      db
        .selectFrom("email_message_envelopes")
        .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
        .where("indexed_files.is_archived", "=", 0)
        .where("email_message_envelopes.connector_config_id", "=", config.id)
        .select((eb) => [
          threadKeyExpr.as("thread_key"),
          eb.fn.count<number>("email_message_envelopes.indexed_file_id").as("message_count"),
        ])
        .groupBy(threadKeyExpr)
        .orderBy(sql`max(email_message_envelopes.sent_at)`, "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db
        .selectFrom((eb) =>
          eb
            .selectFrom("email_message_envelopes")
            .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
            .where("indexed_files.is_archived", "=", 0)
            .where("email_message_envelopes.connector_config_id", "=", config.id)
            .select(threadKeyExpr.as("thread_key"))
            .groupBy(threadKeyExpr)
            .as("t"),
        )
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirst(),
    ]);

    const keys = pageRows.map((row) => row.thread_key);
    const envelopes =
      keys.length > 0
        ? await db
            .selectFrom("email_message_envelopes")
            .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
            .where("indexed_files.is_archived", "=", 0)
            .where("email_message_envelopes.connector_config_id", "=", config.id)
            .where((eb) => eb(threadKeyExpr, "in", keys))
            .select([
              "email_message_envelopes.indexed_file_id",
              "email_message_envelopes.thread_id",
              "email_message_envelopes.subject",
              "email_message_envelopes.sent_at",
              "email_message_envelopes.from_json",
              "email_message_envelopes.to_json",
              "email_message_envelopes.cc_json",
            ])
            .execute()
        : [];

    const byThread = new Map<string, typeof envelopes>();
    for (const env of envelopes) {
      const key = env.thread_id ?? env.indexed_file_id;
      const group = byThread.get(key) ?? [];
      group.push(env);
      byThread.set(key, group);
    }

    const total = Number(totalRow?.count ?? 0);
    const threads = pageRows.map((row) => {
      const group = sortBySentAtAsc(byThread.get(row.thread_key) ?? []);
      const latest = group[group.length - 1];
      const participants = new Map<string, string>();
      for (const env of group) {
        for (const addr of [
          parseEmailAddrJson(env.from_json),
          ...parseEmailAddrListJson(env.to_json),
          ...parseEmailAddrListJson(env.cc_json),
        ]) {
          if (!participants.has(addr.email)) participants.set(addr.email, emailLabel(addr));
        }
      }
      return {
        threadKey: row.thread_key,
        latestIndexedFileId: latest?.indexed_file_id ?? row.thread_key,
        latestSubject: latest?.subject ?? null,
        messageCount: Number(row.message_count),
        lastActivity: latest?.sent_at ?? null,
        participants: [...participants.values()].slice(0, 6),
      };
    });

    return c.json({ threads, total, hasMore: offset + threads.length < total });
  });

  /**
   * Structured thread detail (time-ordered messages with bodies).
   *
   * Content auth is load-bearing: connector metadata access gates route access, but
   * returning message *bodies* additionally requires file-content visibility —
   * the same predicate as GET /files/:fileId/content. A non-bypass admin can
   * manage the connector yet still cannot read private bodies. If no message is
   * content-visible, respond 403 without leaking which messages exist.
   */
  routes.get("/:id/email-threads/:threadKey", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }
    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const threadKey = c.req.param("threadKey");
    const threadKeyExpr = sql<string>`coalesce(email_message_envelopes.thread_id, email_message_envelopes.indexed_file_id)`;
    const rows = await db
      .selectFrom("email_message_envelopes")
      .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
      .where("indexed_files.is_archived", "=", 0)
      .where("email_message_envelopes.connector_config_id", "=", config.id)
      .where((eb) => eb(threadKeyExpr, "=", threadKey))
      .select([
        "email_message_envelopes.indexed_file_id",
        "email_message_envelopes.subject",
        "email_message_envelopes.sent_at",
        "email_message_envelopes.from_json",
        "email_message_envelopes.to_json",
        "email_message_envelopes.cc_json",
        "email_message_envelopes.provider_url",
        "indexed_files.content",
      ])
      .orderBy("email_message_envelopes.sent_at", "asc")
      .execute();

    if (rows.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Thread not found" } }, 404);
    }

    // Mirror GET /files/:fileId/content: admins bypass only with the
    // admin_can_read_all_files setting; everyone else is filtered to visible files.
    const contentViewer = getContentViewer(c);
    const userEmails = contentViewer.isAdmin ? undefined : await getUserEmails(c);
    const visibleIds = await filterAccessibleFileIds(
      db,
      rows.map((row) => row.indexed_file_id),
      userEmails,
    );
    const visible = rows.filter((row) => visibleIds.has(row.indexed_file_id));
    if (visible.length === 0) {
      return c.json({ error: { code: "FORBIDDEN", message: "You don't have access to this thread's contents." } }, 403);
    }

    return c.json({
      messages: visible.map((row) => ({
        indexedFileId: row.indexed_file_id,
        subject: row.subject,
        sentAt: row.sent_at,
        from: parseEmailAddrJson(row.from_json),
        to: parseEmailAddrListJson(row.to_json),
        cc: parseEmailAddrListJson(row.cc_json),
        providerUrl: row.provider_url,
        content: row.content,
      })),
    });
  });

  /**
   * Delete a connector and clean up its derived data: entities sourced from this
   * connector's files are removed; entity_mentions pointing to its files (whether
   * the entity itself is deleted or sourced elsewhere) are cleaned up in deleteConfig.
   */
  routes.delete("/:id", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canDisconnect);
    if (denied) return denied;

    await db.transaction().execute(async (trx) => {
      const txConnectorRepo = createConnectorRepository(trx);
      const txEntityRepo = createEntityRepository(trx);
      const txEntityDomainsRepo = createEntityDomainsRepository(trx);
      const txEntityReviewRepo = createEntityReviewRepo(trx);
      const fileIds = await txConnectorRepo.getOwnedFileIdsForConnector(config.id);
      const relationshipIds = await txEntityDomainsRepo.relationshipIdsWithEvidenceInFiles(fileIds);
      const reviewIds = await txEntityReviewRepo.pendingReviewIdsWithEvidenceInFiles(fileIds);
      await txEntityRepo.deleteEntitiesForFiles(fileIds);
      await txConnectorRepo.deleteConfig(config.id);
      await txEntityDomainsRepo.deleteRelationshipEvidenceForFiles(fileIds);
      await txEntityReviewRepo.deleteReviewEvidenceForFiles(fileIds);
      await txEntityDomainsRepo.deleteEmptyRelationshipsByIds(relationshipIds);
      await txEntityReviewRepo.deleteEmptyPendingReviewsByIds(reviewIds);
    });
    return c.json({ success: true });
  });

  /**
   * Rotate local credentials for an existing connector. Per-user rows are owner-only;
   * org-wide rows are admin-managed.
   */
  routes.post("/:id/rotate-key", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canUpdateCredentials);
    if (denied) return denied;

    if (config.credential_source === "canvas") {
      return localConnectorBlockedResponse(c, config.connector_type as ConnectorType);
    }

    try {
      assertStoredCredentialStorageConfigured(appConfig);
    } catch (err) {
      if (err instanceof ConnectorCredentialConfigError) {
        return localCredentialEncryptionRequiredResponse(c);
      }
      throw err;
    }

    const parsed = rotateCredentialsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }

    const credentials = {
      type: config.auth_type,
      ...(parsed.data.credentials ?? { api_key: parsed.data.api_key }),
    } as ConnectorCredentials;
    try {
      await getConnector(config.connector_type as ConnectorType).validateCredentials(credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid credentials";
      logger.warn(
        { error: validationLogError(err), connectorType: config.connector_type },
        "Credential rotation validation failed",
      );
      return c.json({ error: { code: "INVALID_CREDENTIALS", message } }, 400);
    }

    await connectorRepo.updateConfig(config.id, {
      credentials: serializeCredentials(credentials),
      credentialHint: credentialHintForConnector(config.connector_type as ConnectorType, credentials),
      syncStatus: "active",
      errorMessage: null,
    });

    return c.json({ ok: true });
  });

  /** Update connector scope config (add/remove drives, folders, etc.). */
  routes.patch("/:id/scope", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canChangeScope);
    if (denied) return denied;

    const body = await c.req.json();
    const parsed = updateScopeSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    // Merge into the existing scope_config and clear the sync cursor to force a full re-sync.
    // hierarchyMapping and the workspace/space selections are sibling keys edited by separate
    // flows, so a partial update must preserve the keys it does not touch rather than replace.
    const existingScope =
      config.scope_config && typeof config.scope_config === "string"
        ? (JSON.parse(config.scope_config) as Record<string, unknown>)
        : {};
    const mergedScope = { ...existingScope, ...parsed.data.scopeConfig };
    await connectorRepo.updateConfig(config.id, {
      scopeConfig: JSON.stringify(mergedScope),
      syncCursor: null,
      errorMessage: null,
    });

    if (config.connector_type === "google_calendar") {
      await pruneGoogleCalendarFilesOutsideScope({
        db,
        connectorConfigId: config.id,
        scopeConfig: parsed.data.scopeConfig,
        logger,
      });
    }

    // Auto-trigger re-sync + enrichment in background
    syncInBackground(db, config.id, logger, appConfig);

    const updated = await connectorRepo.findConfigById(config.id);
    if (!updated) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found after update" } }, 404);
    }
    return c.json({
      connector: {
        id: updated.id,
        connectorType: updated.connector_type,
        scopeConfig: JSON.parse(updated.scope_config),
        syncStatus: updated.sync_status,
      },
    });
  });

  /** Trigger a manual sync (creates a sync job). */
  routes.post("/:id/syncs", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canSync);
    if (denied) return denied;

    if (config.sync_status === "syncing") {
      // Reset stale "syncing" status — the previous sync likely crashed
      await connectorRepo.updateConfig(config.id, { syncStatus: "active", errorMessage: null });
      logger.warn({ connectorId: config.id }, "Reset stale syncing status via manual trigger");
    }

    // Run sync then enrichment in background
    syncInBackground(db, config.id, logger, appConfig);

    return c.json({ sync: { connectorId: config.id, status: "started" } }, 201);
  });

  /** List files for a connector, including access scope info. */
  routes.get("/:id/files", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configVisible(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canView);
    if (denied) return denied;

    const files = await connectorRepo.listFilesByConnector(config.id, { archived: false });
    const fileIds = files.map((f) => f.id);
    const accessMap = await connectorRepo.getFileAccessMap(fileIds);

    return c.json({
      files: files.map((f) => {
        const accessInfo = accessMap.get(f.id);
        return {
          id: f.id,
          fileName: f.file_name,
          fileType: f.file_type,
          contentCategory: f.content_category,
          source: f.source,
          sourcePath: f.source_path,
          providerUrl: f.provider_url,
          syncedAt: f.synced_at,
          sourceCreatedAt: f.source_created_at,
          sourceUpdatedAt: f.source_updated_at,
          hasSummary: !!f.summary,
          accessScope: accessInfo ? "restricted" : "unrestricted",
          accessCount: accessInfo?.count ?? null,
        };
      }),
    });
  });

  /** Enrich files with AI-generated summaries and context (creates an enrichment job). */
  routes.post("/:id/enrichments", async (c) => {
    const config = await connectorRepo.findConfigById(c.req.param("id"));
    if (!config || !configEnabled(config)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Connector not found" } }, 404);
    }

    const { permissions } = permissionsForConfig(c, config);
    const denied = denyUnless(c, permissions.canEnrich);
    if (denied) return denied;

    const body = await c.req.json();
    const parsed = enrichSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    // TODO: Queue LLM enrichment jobs. For now, mark files as enriching
    // and return a job ID. The actual LLM calls will be implemented when
    // the enrichment worker is built.
    const jobId = `enrich-${Date.now()}`;
    logger.info({ jobId, connectorId: config.id, fileCount: parsed.data.fileIds.length }, "Enrichment requested");

    return c.json({ enrichment: { jobId, connectorId: config.id, fileCount: parsed.data.fileIds.length } }, 201);
  });

  /** Enrich a single file (tagging + embedding). For testing/debugging. */
  routes.post("/files/:fileId/enrichments", async (c) => {
    const fileId = c.req.param("fileId");
    const file = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name"])
      .where("id", "=", fileId)
      .executeTakeFirst();

    if (!file) {
      return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const owningConfig = await connectorRepo.findConfigByFileId(fileId);
    if (!owningConfig || !configEnabled(owningConfig)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Owning connector not found" } }, 404);
    }
    const { permissions } = permissionsForConfig(c, owningConfig);
    const denied = denyUnless(c, permissions.canEnrich);
    if (denied) return denied;

    const settings = await createSettingsRepository(db, appConfig?.ENCRYPTION_KEY).get();
    const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, appConfig?.OPENROUTER_API_KEY);
    const providerConfig = {
      geminiApiKey: settings?.gemini_api_key,
      embeddingProvider: settings?.embedding_provider,
      geminiMaxRpm: appConfig?.GEMINI_MAX_RPM,
      geminiMaxRetries: appConfig?.GEMINI_MAX_RETRIES,
      logger,
      ...openRouterConfig,
    };
    const embeddingProvider = createEnrichmentEmbeddingProvider(providerConfig);
    const generator = createEnrichmentGenerator(providerConfig);

    // Enrich only this specific file.
    // This endpoint is the per-file "Enrich File" debug surface — always dump
    // LLM calls to disk for inspection. Each call gets its own dated subdir
    // under data/llm-dumps/ so runs don't clobber each other.
    const dumpStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const debugDumpDir = `data/llm-dumps/${fileId}__${dumpStamp}`;
    runEnrichment({
      db,
      logger: logger.child({ component: "enrichment", fileId }),
      embeddingProvider,
      generator,
      geminiApiKey: settings?.gemini_api_key,
      geminiMaxRpm: appConfig?.GEMINI_MAX_RPM,
      geminiMaxRetries: appConfig?.GEMINI_MAX_RETRIES,
      fileIds: [fileId],
      debugDumpDir,
    }).catch((err) => {
      logger.error({ err, fileId }, "Single file enrichment failed");
    });

    return c.json({ success: true, fileId, fileName: file.file_name });
  });

  return routes;
}

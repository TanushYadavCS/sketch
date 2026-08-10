/**
 * Repository for connector_configs, indexed_files, access_scopes, and file_access tables.
 * Handles CRUD + FTS5 search over indexed content.
 *
 * Access model: when entity sync is enabled, chat files require current scope
 * membership unless an explicit share door opens them. Disabled mode restores
 * the pre-stack access doors for every source.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { decodeSecretField, encodeSecretField } from "../../auth/secret-fields";
import { getSyncIdentity, syncIdentityKey } from "../../connectors/sync-identity";
import { forEachChunk } from "../../connectors/sync-utils";
import {
  type AccessPrincipal,
  type AccessPrincipalInput,
  type ConnectorType,
  type ContentCategory,
  type SyncStatus,
  normalizeAccessPrincipals,
} from "../../connectors/types";
import {
  normalizeSlackIdentityUserId,
  normalizeWhatsAppIdentityLid,
  normalizeWhatsAppIdentityPhone,
} from "../../identity-normalization";
import { normalizeSourceTimestampForStorage } from "../../timestamps";
import type { DB } from "../schema";
import { fileVisibilityRuleSql } from "./file-visibility-rule";

export { accessPrincipalPredicateSql } from "./file-visibility-rule";

/**
 * File-list viewer for RBAC. Admins bypass; others match by email.
 *
 * Source of truth for "can a user see file X" — used by every repo function
 * that returns indexed files to a UI. The agent/tool path is gated separately.
 */
export interface FileViewer {
  email: string | null;
  emails?: string[];
  phone?: string | null;
  slackUserId?: string | null;
  whatsappLid?: string | null;
  isAdmin: boolean;
  slackEntitySyncEnabled?: boolean;
}

export function viewerPrincipals(viewer: FileViewer): AccessPrincipal[] {
  const principals: AccessPrincipalInput[] = [];
  if (viewer.email !== null) principals.push(viewer.email);
  principals.push(...(viewer.emails ?? []));
  if (viewer.phone !== null && viewer.phone !== undefined) principals.push({ type: "phone", value: viewer.phone });
  if (viewer.slackUserId !== null && viewer.slackUserId !== undefined) {
    principals.push({ type: "slack_user", value: viewer.slackUserId });
  }
  if (viewer.whatsappLid !== null && viewer.whatsappLid !== undefined) {
    principals.push({ type: "whatsapp_lid", value: viewer.whatsappLid });
  }
  return normalizeAccessPrincipals(principals);
}

type ResolvedPrincipal = { userId: string; userName: string | null; email: string | null };

function principalLookupKey(type: string, value: string): string {
  const normalized =
    type === "email"
      ? value.trim().toLowerCase()
      : type === "phone"
        ? (normalizeWhatsAppIdentityPhone(value) ?? value.trim())
        : type === "whatsapp_lid"
          ? (normalizeWhatsAppIdentityLid(value) ?? value.trim())
          : (normalizeSlackIdentityUserId(value) ?? "");
  return `${type}\u0000${normalized}`;
}

function maskPrincipalValue(type: string, value: string): string {
  const trimmed = value.trim();
  if (type !== "phone" && type !== "whatsapp_lid") return trimmed;
  if (trimmed.length <= 4) return "…";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

async function loadPrincipalResolution(
  db: Kysely<DB>,
  principals: AccessPrincipal[],
): Promise<Map<string, ResolvedPrincipal>> {
  if (principals.length === 0) return new Map();

  const valuesByType = new Map<AccessPrincipal["type"], string[]>();
  for (const principal of principals) {
    const values = valuesByType.get(principal.type) ?? [];
    values.push(principal.value);
    valuesByType.set(principal.type, values);
  }
  const emailValues = valuesByType.get("email") ?? [];
  const providerIdentities =
    emailValues.length > 0
      ? await db
          .selectFrom("user_provider_identities")
          .select(["user_id", "provider_email"])
          .where("provider_email", "in", emailValues)
          .execute()
      : [];
  const providerUserIds = providerIdentities.map((identity) => identity.user_id);
  const users = await db
    .selectFrom("users")
    .select(["id", "name", "email", "whatsapp_number", "whatsapp_lid", "slack_user_id"])
    .where((eb) =>
      eb.or([
        ...(emailValues.length > 0 ? [eb("email", "in", emailValues)] : []),
        ...((valuesByType.get("phone") ?? []).length > 0
          ? [eb("whatsapp_number", "in", valuesByType.get("phone") ?? [])]
          : []),
        ...((valuesByType.get("whatsapp_lid") ?? []).length > 0
          ? [eb("whatsapp_lid", "in", valuesByType.get("whatsapp_lid") ?? [])]
          : []),
        ...((valuesByType.get("slack_user") ?? []).length > 0
          ? [eb("slack_user_id", "in", valuesByType.get("slack_user") ?? [])]
          : []),
        ...(providerUserIds.length > 0 ? [eb("id", "in", providerUserIds)] : []),
      ]),
    )
    .execute();
  const resolved = new Map<string, ResolvedPrincipal>();
  const usersById = new Map(users.map((user) => [user.id, user]));
  for (const user of users) {
    const identity = { userId: user.id, userName: user.name, email: user.email };
    if (user.email) resolved.set(principalLookupKey("email", user.email), identity);
    if (user.whatsapp_number) resolved.set(principalLookupKey("phone", user.whatsapp_number), identity);
    if (user.whatsapp_lid) resolved.set(principalLookupKey("whatsapp_lid", user.whatsapp_lid), identity);
    if (user.slack_user_id) resolved.set(principalLookupKey("slack_user", user.slack_user_id), identity);
  }
  for (const identity of providerIdentities) {
    const user = usersById.get(identity.user_id);
    if (user && identity.provider_email) {
      resolved.set(principalLookupKey("email", identity.provider_email), {
        userId: user.id,
        userName: user.name,
        email: user.email,
      });
    }
  }
  return resolved;
}

/**
 * Predicate matching files visible to `viewer`. Composed into queries via `.where(...)`.
 *
 *   unrestricted      = no scope AND no per-file shares, except restricted chat sources
 *   scoped            = caller is in access_scope_members for the file's scope
 *   per-file          = caller has a row in file_access, except restricted chat sources
 *   manual share      = caller's email is in file_share_emails for the file
 *   org-wide          = indexed_files.share_with_everyone = 1
 *   entity-share prop = caller has access to an entity mentioned in the file
 *                       (via entity_share_emails OR entities.share_with_everyone).
 *                       Read-time only — no rows are written to file_access.
 *
 * v1 matches the caller's primary email only; multi-email users (Slack login email
 * differs from connector-side email) under-see — the safe failure direction. v2 will
 * swap `= :email` for `IN (:emails[])` once we wire `getAllEmailsForUser` through.
 *
 * `alias` is the SQL identifier for `indexed_files` at the call site; pass a
 * different name when the file table is aliased (entity visibility predicate
 * inlines this with the alias of the outer query's join).
 *
 * Acyclic: this references the entity-share tables directly. It MUST NOT call
 * entityVisibilityPredicate, which depends on file visibility — otherwise the
 * planner sees mutually-recursive EXISTS chains.
 */
export function fileVisibilityPredicate(viewer: FileViewer, alias = "indexed_files") {
  return fileVisibilityRuleSql({
    principals: viewerPrincipals(viewer),
    slackEntitySyncEnabled: viewer.slackEntitySyncEnabled ?? true,
    archived: "include",
    alias,
  });
}

function decodeConnectorConfigRow<T extends { credentials: string }>(row: T, encryptionKey?: string): T {
  return {
    ...row,
    credentials: decodeSecretField(row.credentials, encryptionKey, "connector_configs.credentials"),
  };
}

/** CRM activity file types whose bodyless ("empty reminder") rows are hidden from the list. */
const CRM_ACTIVITY_FILE_TYPES_SQL = sql.join(
  ["crm_task", "crm_call", "crm_event", "crm_meeting", "crm_note"].map((t) => sql`${t}`),
);

const CONNECTOR_SCOPED_PROVIDER_FILE_ID_SOURCES = new Set<string>(["google_calendar", "outlook_calendar", "teams"]);

/**
 * The Files-list (browse) visibility rule, Gmail-style:
 *  - drop rollup *members* (activities shown under their parent object instead), and
 *  - drop bodyless CRM activities ("empty reminders") entirely — they're only
 *    counted under their object, never listed.
 * Keeps rollup anchors (rollup_group_id = provider_file_id), ungrouped non-CRM
 * rows (NULL), and CRM activities that carry real content (content_category = 'document').
 */
const browseVisibilityPredicate = sql<boolean>`(
  (indexed_files.rollup_group_id IS NULL OR indexed_files.rollup_group_id = indexed_files.provider_file_id)
  AND NOT (
    indexed_files.content_category = 'structured'
    AND indexed_files.file_type IN (${CRM_ACTIVITY_FILE_TYPES_SQL})
  )
)`;

export function createConnectorRepository(db: Kysely<DB>, encryptionKey?: string) {
  return {
    /** List all connector configs. */
    async listConfigs() {
      const rows = await db.selectFrom("connector_configs").selectAll().orderBy("created_at", "desc").execute();
      return rows.map((row) => decodeConnectorConfigRow(row, encryptionKey));
    },

    /** Find a connector config by ID. */
    async findConfigById(id: string) {
      const row = await db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? decodeConnectorConfigRow(row, encryptionKey) : undefined;
    },

    /** Find connector configs by type. */
    async findConfigsByType(connectorType: ConnectorType) {
      const rows = await db
        .selectFrom("connector_configs")
        .selectAll()
        .where("connector_type", "=", connectorType)
        .execute();
      return rows.map((row) => decodeConnectorConfigRow(row, encryptionKey));
    },

    /**
     * Find connector configs that are ready to sync.
     * `staleAfterMs` skips configs synced within that window so we don't re-attempt
     * a connector that just finished. Defaults to 15 minutes (half the default tick).
     */
    async findSyncableConfigs(opts?: { staleAfterMs?: number }) {
      const staleAfterMs = opts?.staleAfterMs ?? 15 * 60 * 1000;
      const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
      const rows = await db
        .selectFrom("connector_configs")
        .selectAll()
        .where("sync_status", "in", ["active", "pending", "error"])
        .where((eb) => eb.or([eb("last_synced_at", "is", null), eb("last_synced_at", "<", cutoff)]))
        .execute();
      return rows.map((row) => decodeConnectorConfigRow(row, encryptionKey));
    },

    /** Find connector configs stuck in `syncing` state past the staleness threshold. */
    async findStaleSyncingConfigs(staleThresholdMs: number) {
      const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
      return db
        .selectFrom("connector_configs")
        .select(["id", "connector_type", "updated_at"])
        .where("sync_status", "=", "syncing")
        .where("updated_at", "<", cutoff)
        .execute();
    },

    /** All connector configs owned by a user. */
    async listByOwner(createdBy: string) {
      const rows = await db
        .selectFrom("connector_configs")
        .selectAll()
        .where("created_by", "=", createdBy)
        .orderBy("created_at", "desc")
        .execute();
      return rows.map((row) => decodeConnectorConfigRow(row, encryptionKey));
    },

    /**
     * Archive all connectors owned by a user — flip to disabled and scrub credentials.
     * Used when a user is removed from the workspace. Their indexed_files remain so
     * other attendees still see their previously-synced meetings via file_access.
     */
    async archiveConnectorsForOwner(createdBy: string): Promise<{ archived: number }> {
      const owned = await this.listByOwner(createdBy);
      for (const config of owned) {
        const scrubbed = JSON.stringify({ type: config.auth_type, scrubbed: true });
        await db
          .updateTable("connector_configs")
          .set({
            sync_status: "disabled",
            credentials: encodeSecretField(scrubbed, encryptionKey),
            credential_hint: null,
            error_message: "Owner removed from workspace",
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", config.id)
          .execute();
      }
      return { archived: owned.length };
    },

    /** Find a connector config of a given type owned by the given user (used for per-user uniqueness). */
    async findByTypeAndOwner(connectorType: ConnectorType, createdBy: string) {
      const row = await db
        .selectFrom("connector_configs")
        .selectAll()
        .where("connector_type", "=", connectorType)
        .where("created_by", "=", createdBy)
        .executeTakeFirst();
      return row ? decodeConnectorConfigRow(row, encryptionKey) : undefined;
    },

    /** Look up the connector config that owns a given indexed file (for file-scoped authz). */
    async findConfigByFileId(fileId: string) {
      return db
        .selectFrom("indexed_files")
        .innerJoin("connector_configs", "connector_configs.id", "indexed_files.connector_config_id")
        .where("indexed_files.id", "=", fileId)
        .select([
          "connector_configs.id",
          "connector_configs.connector_type",
          "connector_configs.created_by",
          "connector_configs.sync_status",
        ])
        .executeTakeFirst();
    },

    /** Create a new connector config. */
    async createConfig(data: {
      connectorType: ConnectorType;
      authType: string;
      credentials: string;
      credentialSource?: "local" | "canvas";
      scopeConfig?: string;
      syncStatus?: SyncStatus;
      createdBy: string;
      credentialHint?: string | null;
    }) {
      const id = randomUUID();
      await db
        .insertInto("connector_configs")
        .values({
          id,
          connector_type: data.connectorType,
          auth_type: data.authType,
          credentials: encodeSecretField(data.credentials, encryptionKey),
          credential_source: data.credentialSource ?? "local",
          scope_config: data.scopeConfig ?? "{}",
          ...(data.syncStatus ? { sync_status: data.syncStatus } : {}),
          created_by: data.createdBy,
          credential_hint: data.credentialHint ?? null,
        })
        .execute();

      const row = await db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return decodeConnectorConfigRow(row, encryptionKey);
    },

    /** Update connector config fields. */
    async updateConfig(
      id: string,
      data: Partial<{
        credentials: string;
        scopeConfig: string;
        syncStatus: SyncStatus;
        syncCursor: string | null;
        lastSyncedAt: string | null;
        errorMessage: string | null;
        browseCache: string | null;
        credentialHint: string | null;
        credentialSource: "local" | "canvas";
      }>,
    ) {
      const values: Record<string, unknown> = {};
      if (data.credentials !== undefined) values.credentials = encodeSecretField(data.credentials, encryptionKey);
      if (data.scopeConfig !== undefined) values.scope_config = data.scopeConfig;
      if (data.syncStatus !== undefined) values.sync_status = data.syncStatus;
      if (data.syncCursor !== undefined) values.sync_cursor = data.syncCursor;
      if (data.lastSyncedAt !== undefined) values.last_synced_at = data.lastSyncedAt;
      if (data.errorMessage !== undefined) values.error_message = data.errorMessage;
      if (data.browseCache !== undefined) values.browse_cache = data.browseCache;
      if (data.credentialHint !== undefined) values.credential_hint = data.credentialHint;
      if (data.credentialSource !== undefined) values.credential_source = data.credentialSource;

      if (Object.keys(values).length > 0) {
        values.updated_at = new Date().toISOString();
        await db.updateTable("connector_configs").set(values).where("id", "=", id).execute();
      }

      const row = await db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return decodeConnectorConfigRow(row, encryptionKey);
    },

    /** Get all file IDs linked to a connector. */
    async getFileIdsForConnector(connectorId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("connector_files")
        .select("indexed_file_id")
        .where("connector_config_id", "=", connectorId)
        .execute();
      return rows.map((r) => r.indexed_file_id);
    },

    async getOwnedFileIdsForConnector(connectorId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("indexed_files")
        .select("id")
        .where("connector_config_id", "=", connectorId)
        .execute();
      return rows.map((r) => r.id);
    },

    /**
     * Delete a connector config and all associated data.
     * Files discovered only by this connector are archived (not deleted).
     * Files also linked to other connectors keep their rows.
     */
    async deleteConfig(id: string) {
      // 1. Delete access scopes owned by this connector
      await db
        .deleteFrom("access_scope_members")
        .where(
          "access_scope_id",
          "in",
          db.selectFrom("access_scopes").select("id").where("connector_config_id", "=", id),
        )
        .execute();
      await db.deleteFrom("access_scopes").where("connector_config_id", "=", id).execute();

      // 2. Find files linked to this connector
      const linkedFiles = await db
        .selectFrom("connector_files")
        .select("indexed_file_id")
        .where("connector_config_id", "=", id)
        .execute();
      const linkedFileIds = linkedFiles.map((f) => f.indexed_file_id);

      // 3. Remove connector_files links
      await db.deleteFrom("connector_files").where("connector_config_id", "=", id).execute();

      // 4. Archive orphaned files (no remaining connector links)
      if (linkedFileIds.length > 0) {
        const stillLinked = await db
          .selectFrom("connector_files")
          .select("indexed_file_id")
          .where("indexed_file_id", "in", linkedFileIds)
          .execute();
        const stillLinkedIds = new Set(stillLinked.map((f) => f.indexed_file_id));
        const orphanedIds = linkedFileIds.filter((fid) => !stillLinkedIds.has(fid));

        if (orphanedIds.length > 0) {
          await db.deleteFrom("file_access").where("indexed_file_id", "in", orphanedIds).execute();
          // Remove entity_mentions pointing to files we're about to archive — covers the
          // cross-source case where an entity sourced elsewhere was mentioned in this
          // connector's files. Without this, surviving entities show stale mentions to
          // archived files. Mentions for entities we delete in deleteEntitiesForFiles are
          // already handled by FK CASCADE on entity delete.
          await db.deleteFrom("entity_mentions").where("indexed_file_id", "in", orphanedIds).execute();
          await db
            .updateTable("indexed_files")
            .set({ is_archived: 1, access_scope_id: null })
            .where("id", "in", orphanedIds)
            .execute();
        }
      }

      // 5. Delete the connector config itself
      return db.deleteFrom("connector_configs").where("id", "=", id).execute();
    },

    /**
     * Upsert an indexed file by message identity when present, otherwise by the
     * legacy global provider-file identity.
     */
    async upsertFile(data: {
      source: string;
      providerFileId: string;
      providerMessageId?: string | null;
      threadId?: string | null;
      providerUrl: string | null;
      fileName: string;
      fileType: string | null;
      contentCategory: ContentCategory;
      content: string | null;
      sourcePath: string | null;
      contentHash: string | null;
      sourceCreatedAt: string | null;
      sourceUpdatedAt: string | null;
      connectorConfigId: string;
      mimeType?: string | null;
      rollupGroupId?: string | null;
      isAllDay?: boolean;
    }) {
      const now = new Date().toISOString();
      const sourceCreatedAt = normalizeSourceTimestampForStorage(data.sourceCreatedAt);
      const sourceUpdatedAt = normalizeSourceTimestampForStorage(data.sourceUpdatedAt);

      const existing = data.providerMessageId
        ? await db
            .selectFrom("indexed_files")
            .selectAll()
            .where("connector_config_id", "=", data.connectorConfigId)
            .where("provider_message_id", "=", data.providerMessageId)
            .executeTakeFirst()
        : CONNECTOR_SCOPED_PROVIDER_FILE_ID_SOURCES.has(data.source)
          ? await db
              .selectFrom("indexed_files")
              .selectAll()
              .where("connector_config_id", "=", data.connectorConfigId)
              .where("source", "=", data.source)
              .where("provider_file_id", "=", data.providerFileId)
              .where("provider_message_id", "is", null)
              .executeTakeFirst()
          : await db
              .selectFrom("indexed_files")
              .selectAll()
              .where("source", "=", data.source)
              .where("provider_file_id", "=", data.providerFileId)
              .where("provider_message_id", "is", null)
              .executeTakeFirst();

      if (existing) {
        const contentChanged = data.contentHash !== existing.content_hash;
        const categoryChanged = data.contentCategory !== existing.content_category;
        const sourceVersionChanged =
          data.contentHash === null &&
          existing.content_hash === null &&
          data.content === null &&
          existing.content === null &&
          sourceUpdatedAt !== existing.source_updated_at;
        const updates: Record<string, unknown> = {
          provider_file_id: data.providerFileId,
          provider_message_id: data.providerMessageId ?? null,
          thread_id: data.threadId ?? null,
          provider_url: data.providerUrl,
          file_name: data.fileName,
          file_type: data.fileType,
          content_category: data.contentCategory,
          content: data.content,
          source_path: data.sourcePath,
          content_hash: data.contentHash,
          is_archived: 0,
          source_created_at: sourceCreatedAt,
          source_updated_at: sourceUpdatedAt,
          rollup_group_id: data.rollupGroupId ?? null,
          synced_at: now,
        };
        if (data.mimeType !== undefined) updates.mime_type = data.mimeType;
        if (data.isAllDay !== undefined) updates.is_all_day = data.isAllDay ? 1 : 0;
        if (contentChanged || categoryChanged || sourceVersionChanged) {
          updates.embedding_status = "pending";
          updates.summary_status = "pending";
          updates.embedding_attempts = 0;
          updates.embedding_next_retry_at = null;
          updates.summary_attempts = 0;
          updates.summary_next_retry_at = null;
        }

        await db.updateTable("indexed_files").set(updates).where("id", "=", existing.id).execute();

        return { id: existing.id, created: false, contentChanged, categoryChanged, sourceVersionChanged };
      }

      const id = randomUUID();
      await db
        .insertInto("indexed_files")
        .values({
          id,
          connector_config_id: data.connectorConfigId,
          provider_file_id: data.providerFileId,
          provider_message_id: data.providerMessageId ?? null,
          thread_id: data.threadId ?? null,
          provider_url: data.providerUrl,
          file_name: data.fileName,
          file_type: data.fileType,
          content_category: data.contentCategory,
          content: data.content,
          source: data.source,
          source_path: data.sourcePath,
          content_hash: data.contentHash,
          source_created_at: sourceCreatedAt,
          source_updated_at: sourceUpdatedAt,
          rollup_group_id: data.rollupGroupId ?? null,
          synced_at: now,
          is_all_day: data.isAllDay ? 1 : 0,
          mime_type: data.mimeType ?? null,
          embedding_status: "pending",
          summary_status: "pending",
        })
        .execute();

      return { id, created: true, contentChanged: false, categoryChanged: false, sourceVersionChanged: false };
    },

    /** Link a connector to a file (many-to-many). Idempotent. */
    async linkConnectorFile(connectorConfigId: string, indexedFileId: string) {
      await sql`INSERT INTO connector_files (connector_config_id, indexed_file_id) VALUES (${connectorConfigId}, ${indexedFileId}) ON CONFLICT DO NOTHING`.execute(
        db,
      );
    },

    /**
     * Create or update an access scope and its members.
     * Returns the scope ID.
     */
    async upsertAccessScope(
      connectorConfigId: string,
      scope: { scopeType: string; providerScopeId: string; label: string; members: AccessPrincipalInput[] },
    ): Promise<string> {
      const existing = await db
        .selectFrom("access_scopes")
        .select("id")
        .where("connector_config_id", "=", connectorConfigId)
        .where("provider_scope_id", "=", scope.providerScopeId)
        .executeTakeFirst();

      let scopeId: string;
      if (existing) {
        scopeId = existing.id;
        await db
          .updateTable("access_scopes")
          .set({ scope_type: scope.scopeType, label: scope.label })
          .where("id", "=", scopeId)
          .execute();
      } else {
        scopeId = randomUUID();
        await db
          .insertInto("access_scopes")
          .values({
            id: scopeId,
            connector_config_id: connectorConfigId,
            scope_type: scope.scopeType,
            provider_scope_id: scope.providerScopeId,
            label: scope.label,
          })
          .execute();
      }

      // Replace members
      await db.deleteFrom("access_scope_members").where("access_scope_id", "=", scopeId).execute();
      const uniqueMembers = normalizeAccessPrincipals(scope.members);
      if (uniqueMembers.length > 0) {
        await db
          .insertInto("access_scope_members")
          .values(
            uniqueMembers.map((principal) => ({
              access_scope_id: scopeId,
              principal_type: principal.type,
              principal_value: principal.value,
            })),
          )
          .execute();
      }

      return scopeId;
    },

    /** Set the access scope FK on an indexed file. */
    async setFileAccessScope(fileId: string, scopeId: string) {
      await db.updateTable("indexed_files").set({ access_scope_id: scopeId }).where("id", "=", fileId).execute();
    },

    /**
     * All access scopes of one type owned by a connector config. Powers ACL
     * reconciliation runs that must see scopes for quiet channels no current
     * emission would touch.
     */
    async listAccessScopesForConnector(
      connectorConfigId: string,
      scopeType: string,
    ): Promise<Array<{ id: string; providerScopeId: string; label: string | null }>> {
      const rows = await db
        .selectFrom("access_scopes")
        .select(["id", "provider_scope_id", "label"])
        .where("connector_config_id", "=", connectorConfigId)
        .where("scope_type", "=", scopeType)
        .execute();
      return rows.map((row) => ({ id: row.id, providerScopeId: row.provider_scope_id, label: row.label }));
    },

    /**
     * Archives every indexed file attached to the given scopes and severs the
     * per-file grants and conversation-slice links, so a later re-emission can
     * relink cleanly. Used when a channel loses visibility (bot removed) or
     * its last teammate member.
     */
    async archiveFilesForAccessScopes(scopeIds: string[]): Promise<number> {
      if (scopeIds.length === 0) return 0;
      const files = await db
        .selectFrom("indexed_files")
        .select(["id"])
        .where("access_scope_id", "in", scopeIds)
        .execute();
      const fileIds = files.map((file) => file.id);
      if (fileIds.length === 0) return 0;

      await db.deleteFrom("file_access").where("indexed_file_id", "in", fileIds).execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: null })
        .where("indexed_file_id", "in", fileIds)
        .execute();
      await db
        .updateTable("indexed_files")
        .set({ is_archived: 1, access_scope_id: null })
        .where("id", "in", fileIds)
        .execute();
      return fileIds.length;
    },

    /**
     * Replace per-file access emails for an indexed file.
     * Used for Google Drive My Drive files with individual sharing.
     */
    async syncFileAccessEmails(indexedFileId: string, principalInput: AccessPrincipalInput[]) {
      await db.deleteFrom("file_access").where("indexed_file_id", "=", indexedFileId).execute();

      const unique = normalizeAccessPrincipals(principalInput);
      if (unique.length === 0) return;

      await db
        .insertInto("file_access")
        .values(
          unique.map((principal) => ({
            indexed_file_id: indexedFileId,
            principal_type: principal.type,
            principal_value: principal.value,
          })),
        )
        .execute();
    },

    /** Add per-file email stamps without revoking existing stamps. */
    async grantFileAccessEmails(indexedFileId: string, principalInput: AccessPrincipalInput[]) {
      const unique = normalizeAccessPrincipals(principalInput);
      if (unique.length === 0) return;

      await sql`
        INSERT INTO file_access (indexed_file_id, principal_type, principal_value)
        VALUES ${sql.join(unique.map((principal) => sql`(${indexedFileId}, ${principal.type}, ${principal.value})`))}
        ON CONFLICT DO NOTHING
      `.execute(db);
    },

    /**
     * Get access info for a batch of file IDs.
     * Returns a map of fileId → { type, count }.
     * Files not in the map are unrestricted.
     */
    async getFileAccessMap(fileIds: string[]): Promise<Map<string, { type: "scope" | "file"; count: number }>> {
      if (fileIds.length === 0) return new Map();

      const map = new Map<string, { type: "scope" | "file"; count: number }>();

      // Check scope-based access
      const scopeFiles = await db
        .selectFrom("indexed_files")
        .select(["indexed_files.id", "indexed_files.access_scope_id"])
        .where("indexed_files.id", "in", fileIds)
        .where("indexed_files.access_scope_id", "is not", null)
        .execute();

      const scopeIds = scopeFiles
        .map((row) => row.access_scope_id)
        .filter((scopeId): scopeId is string => scopeId !== null);
      const [scopeMembers, fileAccessRows] = await Promise.all([
        scopeIds.length > 0
          ? db
              .selectFrom("access_scope_members")
              .select(["access_scope_id", "principal_type", "principal_value"])
              .where("access_scope_id", "in", scopeIds)
              .execute()
          : Promise.resolve([]),
        db
          .selectFrom("file_access")
          .select(["indexed_file_id", "principal_type", "principal_value"])
          .where("indexed_file_id", "in", fileIds)
          .execute(),
      ]);
      const accessRows = [...scopeMembers, ...fileAccessRows];
      const resolution = await loadPrincipalResolution(
        db,
        accessRows.map((row) => ({ type: row.principal_type as AccessPrincipal["type"], value: row.principal_value })),
      );
      const scopeMembersByScope = new Map<string, typeof scopeMembers>();
      for (const member of scopeMembers) {
        const members = scopeMembersByScope.get(member.access_scope_id) ?? [];
        members.push(member);
        scopeMembersByScope.set(member.access_scope_id, members);
      }
      for (const row of scopeFiles) {
        const members = scopeMembersByScope.get(row.access_scope_id as string) ?? [];
        const uniqueMembers = new Set(
          members.map((member) => {
            const resolved = resolution.get(principalLookupKey(member.principal_type, member.principal_value));
            return resolved
              ? `user:${resolved.userId}`
              : `principal:${member.principal_type}\u0000${member.principal_value}`;
          }),
        );
        map.set(row.id, { type: "scope", count: uniqueMembers.size });
      }

      const membersByFile = new Map<string, Set<string>>();
      for (const row of fileAccessRows) {
        const members = membersByFile.get(row.indexed_file_id) ?? new Set<string>();
        const resolved = resolution.get(principalLookupKey(row.principal_type, row.principal_value));
        members.add(
          resolved ? `user:${resolved.userId}` : `principal:${row.principal_type}\u0000${row.principal_value}`,
        );
        membersByFile.set(row.indexed_file_id, members);
      }
      for (const [indexedFileId, members] of membersByFile) {
        if (!map.has(indexedFileId)) {
          map.set(indexedFileId, { type: "file", count: members.size });
        }
      }

      return map;
    },

    /**
     * Get detailed access info for a single file.
     * Resolves from scope members or per-file access, with user name resolution.
     */
    async getFileAccessDetails(
      fileId: string,
    ): Promise<{ email: string; userName: string | null; userId: string | null; source: "scope" | "file" }[]> {
      const file = await db
        .selectFrom("indexed_files")
        .select(["id", "access_scope_id"])
        .where("id", "=", fileId)
        .executeTakeFirst();

      if (!file) return [];

      const rows = file.access_scope_id
        ? await db
            .selectFrom("access_scope_members")
            .select(["principal_type", "principal_value"])
            .where("access_scope_id", "=", file.access_scope_id)
            .execute()
        : await db
            .selectFrom("file_access")
            .select(["principal_type", "principal_value"])
            .where("indexed_file_id", "=", fileId)
            .execute();
      const source = file.access_scope_id ? ("scope" as const) : ("file" as const);
      const resolution = await loadPrincipalResolution(
        db,
        rows.map((row) => ({ type: row.principal_type as AccessPrincipal["type"], value: row.principal_value })),
      );
      const seen = new Set<string>();
      return rows
        .flatMap((row) => {
          const resolved = resolution.get(principalLookupKey(row.principal_type, row.principal_value));
          const dedupeKey = resolved
            ? `user:${resolved.userId}`
            : `principal:${row.principal_type}\u0000${row.principal_value}`;
          if (seen.has(dedupeKey)) return [];
          seen.add(dedupeKey);
          return [
            {
              email: resolved?.email ?? maskPrincipalValue(row.principal_type, row.principal_value),
              userName: resolved?.userName ?? null,
              userId: resolved?.userId ?? null,
              source,
            },
          ];
        })
        .sort(
          (left, right) =>
            Number(left.userName === null) - Number(right.userName === null) ||
            (left.userName ?? "").localeCompare(right.userName ?? "") ||
            left.email.localeCompare(right.email),
        );
    },

    /**
     * Archive files not seen in this sync for a given connector.
     *
     * `seenSyncIdentityKeys` is only consulted in-memory (`.has()`), so passing
     * the whole set — 100k+ entries on an initial full sync — carries no SQL
     * bind-variable risk. The derived stale/orphaned id lists, however, feed
     * `IN (...)` deletes and updates, so those are chunked. Each chunk commits on
     * its own connection; the archive is idempotent per id, so a chunk landing
     * independently cannot corrupt state.
     */
    async archiveStaleFiles(connectorConfigId: string, seenSyncIdentityKeys: Set<string>) {
      if (seenSyncIdentityKeys.size === 0) return 0;

      const linkedFiles = await db
        .selectFrom("connector_files")
        .innerJoin("indexed_files", "indexed_files.id", "connector_files.indexed_file_id")
        .select([
          "indexed_files.id",
          "indexed_files.connector_config_id",
          "indexed_files.source",
          "indexed_files.provider_file_id",
          "indexed_files.provider_message_id",
        ])
        .where("connector_files.connector_config_id", "=", connectorConfigId)
        .where("indexed_files.is_archived", "=", 0)
        .execute();

      const stale = linkedFiles.filter((f) => {
        const identity = getSyncIdentity({
          connectorConfigId: f.connector_config_id,
          connectorType: f.source,
          providerFileId: f.provider_file_id,
          providerMessageId: f.provider_message_id,
        });
        return !seenSyncIdentityKeys.has(syncIdentityKey(identity));
      });
      if (stale.length === 0) return 0;

      const staleIds = stale.map((f) => f.id);

      // Remove this connector's link to stale files
      await forEachChunk(staleIds, async (batch) => {
        await db
          .deleteFrom("connector_files")
          .where("connector_config_id", "=", connectorConfigId)
          .where("indexed_file_id", "in", batch)
          .execute();
      });

      // Archive files that have no remaining connector links
      const stillLinkedIds = new Set<string>();
      await forEachChunk(staleIds, async (batch) => {
        const stillLinked = await db
          .selectFrom("connector_files")
          .select("indexed_file_id")
          .where("indexed_file_id", "in", batch)
          .execute();
        for (const f of stillLinked) stillLinkedIds.add(f.indexed_file_id);
      });
      const orphanedIds = staleIds.filter((id) => !stillLinkedIds.has(id));

      await forEachChunk(orphanedIds, async (batch) => {
        await db
          .updateTable("indexed_files")
          .set({ is_archived: 1, access_scope_id: null })
          .where("id", "in", batch)
          .execute();
      });

      return orphanedIds.length;
    },

    /**
     * Search indexed files using FTS5.
     * For the full search API with sanitization, use connectors/search.ts instead.
     * This method sanitizes the query to prevent FTS5 syntax errors.
     */
    async searchFiles(query: string, opts?: { source?: string; limit?: number }) {
      const limit = opts?.limit ?? 20;

      // Sanitize: strip FTS5 special characters to prevent syntax errors.
      // Strips operators and punctuation that cause MATCH to throw.
      const sanitized = query
        .replace(/[*"()+\-]/g, " ")
        .replace(/\b(OR|AND|NOT|NEAR)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!sanitized) return [];

      const results = await sql`
				SELECT indexed_files.*, rank as relevance
				FROM indexed_files
				INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
				WHERE indexed_files_fts MATCH ${sanitized}
				AND indexed_files.is_archived = 0
				${opts?.source ? sql`AND indexed_files.source = ${opts.source}` : sql``}
				ORDER BY rank
				LIMIT ${limit}
			`.execute(db);

      return results.rows;
    },

    /** Get a single indexed file by ID. */
    async findFileById(fileId: string) {
      return db.selectFrom("indexed_files").selectAll().where("id", "=", fileId).executeTakeFirst();
    },

    /** List files for a connector (via connector_files junction). */
    async listFilesByConnector(connectorConfigId: string, opts?: { archived?: boolean }) {
      let q = db
        .selectFrom("indexed_files")
        .innerJoin("connector_files", "connector_files.indexed_file_id", "indexed_files.id")
        .selectAll("indexed_files")
        .where("connector_files.connector_config_id", "=", connectorConfigId);

      if (opts?.archived !== undefined) {
        q = q.where("indexed_files.is_archived", "=", opts.archived ? 1 : 0);
      }

      return q.orderBy("indexed_files.synced_at", "desc").execute();
    },

    /** List connector configs accessible by a set of connector IDs. */
    async listConfigsByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom("connector_configs")
        .selectAll()
        .where("id", "in", ids)
        .orderBy("created_at", "desc")
        .execute();
      return rows.map((row) => decodeConnectorConfigRow(row, encryptionKey));
    },

    /**
     * List files across all connectors with pagination.
     * Ordered by synced_at descending (most recently synced first).
     */
    async listAllFiles(opts: {
      limit: number;
      offset: number;
      connectorType?: string;
      excludedSources?: string[];
      category?: string;
      status?: string;
      access?: string;
      viewer: FileViewer;
      /** Collapse CRM activity members under their parent object (default off). */
      collapseRollups?: boolean;
    }) {
      let query = db
        .selectFrom("indexed_files")
        .select([
          "indexed_files.id",
          "indexed_files.connector_config_id",
          "indexed_files.provider_file_id",
          "indexed_files.rollup_group_id",
          "indexed_files.file_name",
          "indexed_files.file_type",
          "indexed_files.content_category",
          "indexed_files.source",
          "indexed_files.source_path",
          "indexed_files.provider_url",
          "indexed_files.synced_at",
          "indexed_files.source_created_at",
          "indexed_files.source_updated_at",
          "indexed_files.summary",
          "indexed_files.embedding_status",
          "indexed_files.summary_status",
          "indexed_files.access_scope_id",
        ])
        .where("indexed_files.is_archived", "=", 0);

      if (opts.collapseRollups) {
        query = query.where(browseVisibilityPredicate);
      }

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
      }
      if (opts.excludedSources && opts.excludedSources.length > 0) {
        query = query.where("indexed_files.source", "not in", opts.excludedSources);
      }
      if (opts.category) {
        query = query.where("indexed_files.content_category", "=", opts.category);
      }
      if (opts.status === "enriched") {
        query = query.where("indexed_files.summary", "is not", null);
      } else if (opts.status === "pending") {
        query = query.where((eb) =>
          eb.or([
            eb("indexed_files.embedding_status", "in", ["pending", "failed"]),
            eb("indexed_files.summary_status", "in", ["pending", "failed"]),
          ]),
        );
      } else if (opts.status === "raw") {
        query = query
          .where("indexed_files.summary", "is", null)
          .where("indexed_files.embedding_status", "not in", ["pending", "failed"])
          .where("indexed_files.summary_status", "not in", ["pending", "failed"]);
      }
      if (opts.access === "restricted") {
        query = query.where("indexed_files.access_scope_id", "is not", null);
      } else if (opts.access === "unrestricted") {
        query = query.where("indexed_files.access_scope_id", "is", null);
      }
      if (!opts.viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(opts.viewer));
      }

      return query
        .orderBy(
          sql`coalesce(indexed_files.source_updated_at, indexed_files.source_created_at, indexed_files.synced_at) desc`,
        )
        .limit(opts.limit)
        .offset(opts.offset)
        .execute();
    },

    /**
     * Look up CRM rollup summaries for a set of anchor objects.
     * Keyed by `${connectorConfigId}::${groupId}` to drive the collapsed
     * "N activities + summary" rows in the Files list.
     */
    async getRollupSummaries(
      anchors: Array<{ connectorConfigId: string; groupId: string }>,
    ): Promise<Map<string, { activityCount: number; summary: string }>> {
      const map = new Map<string, { activityCount: number; summary: string }>();
      if (anchors.length === 0) return map;
      const configIds = [...new Set(anchors.map((a) => a.connectorConfigId))];
      const groupIds = [...new Set(anchors.map((a) => a.groupId))];
      const rows = await db
        .selectFrom("crm_object_summaries")
        .select(["connector_config_id", "group_id", "summary", "activity_count"])
        .where("connector_config_id", "in", configIds)
        .where("group_id", "in", groupIds)
        .execute();
      for (const r of rows) {
        map.set(`${r.connector_config_id}::${r.group_id}`, {
          activityCount: Number(r.activity_count),
          summary: r.summary,
        });
      }
      return map;
    },

    /**
     * Live count of activity members rolled up under each anchor object.
     * Drives the "N activities" badge + expand affordance independently of
     * whether a summary has been generated yet (summaries are capped/async).
     */
    async getActivityCounts(
      anchors: Array<{ connectorConfigId: string; groupId: string }>,
    ): Promise<Map<string, number>> {
      const map = new Map<string, number>();
      if (anchors.length === 0) return map;
      const configIds = [...new Set(anchors.map((a) => a.connectorConfigId))];
      const groupIds = [...new Set(anchors.map((a) => a.groupId))];
      const rows = await db
        .selectFrom("indexed_files")
        .select([
          "indexed_files.connector_config_id",
          "indexed_files.rollup_group_id",
          sql<number>`count(*)`.as("count"),
        ])
        .where("indexed_files.is_archived", "=", 0)
        .where("indexed_files.connector_config_id", "in", configIds)
        .where("indexed_files.rollup_group_id", "in", groupIds)
        .whereRef("indexed_files.provider_file_id", "!=", "indexed_files.rollup_group_id")
        .groupBy(["indexed_files.connector_config_id", "indexed_files.rollup_group_id"])
        .execute();
      for (const r of rows) {
        if (r.rollup_group_id) {
          map.set(`${r.connector_config_id}::${r.rollup_group_id}`, Number(r.count));
        }
      }
      return map;
    },

    /** Resolve a file's group identity (for the rollup-members endpoint), viewer-scoped. */
    async getRollupAnchorRef(fileId: string, viewer: FileViewer) {
      let query = db
        .selectFrom("indexed_files")
        .select([
          "indexed_files.id",
          "indexed_files.connector_config_id",
          "indexed_files.provider_file_id",
          "indexed_files.rollup_group_id",
          "indexed_files.source",
        ])
        .where("indexed_files.id", "=", fileId)
        .where("indexed_files.is_archived", "=", 0);
      if (!viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(viewer));
      }
      return query.executeTakeFirst();
    },

    /** List the activity member files rolled up under one parent object, viewer-scoped. */
    async listGroupActivities(opts: {
      connectorConfigId: string;
      groupId: string;
      viewer: FileViewer;
      limit: number;
      offset: number;
    }) {
      let query = db
        .selectFrom("indexed_files")
        .select([
          "indexed_files.id",
          "indexed_files.connector_config_id",
          "indexed_files.provider_file_id",
          "indexed_files.rollup_group_id",
          "indexed_files.file_name",
          "indexed_files.file_type",
          "indexed_files.content_category",
          "indexed_files.source",
          "indexed_files.source_path",
          "indexed_files.provider_url",
          "indexed_files.synced_at",
          "indexed_files.source_created_at",
          "indexed_files.source_updated_at",
          "indexed_files.summary",
          "indexed_files.embedding_status",
          "indexed_files.summary_status",
          "indexed_files.access_scope_id",
        ])
        .where("indexed_files.is_archived", "=", 0)
        .where("indexed_files.connector_config_id", "=", opts.connectorConfigId)
        .where("indexed_files.rollup_group_id", "=", opts.groupId)
        .where("indexed_files.provider_file_id", "!=", opts.groupId);
      if (!opts.viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(opts.viewer));
      }
      return query
        .orderBy(
          sql`coalesce(indexed_files.source_updated_at, indexed_files.source_created_at, indexed_files.synced_at) desc`,
        )
        .limit(opts.limit)
        .offset(opts.offset)
        .execute();
    },

    /**
     * Count non-archived files that have a summary, across the same filter
     * set as `listAllFiles`/`countAllFiles`. Drives the "X enriched" badge
     * in the Files header — must be filtered globally, not over the page
     * slice (the prior page-local count silently misreported the global
     * total whenever the user paged past the first 50 rows).
     */
    async countEnrichedFiles(opts: {
      viewer: FileViewer;
      connectorType?: string;
      excludedSources?: string[];
      category?: string;
      status?: string;
      access?: string;
      collapseRollups?: boolean;
    }) {
      let query = db
        .selectFrom("indexed_files")
        .select(sql`count(*)`.as("count"))
        .where("indexed_files.is_archived", "=", 0);

      if (opts.collapseRollups) {
        query = query.where(browseVisibilityPredicate);
      }
      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
      }
      if (opts.excludedSources && opts.excludedSources.length > 0) {
        query = query.where("indexed_files.source", "not in", opts.excludedSources);
      }
      if (opts.category) {
        query = query.where("indexed_files.content_category", "=", opts.category);
      }
      if (opts.status === "raw") {
        query = query
          .where("indexed_files.summary", "is", null)
          .where("indexed_files.embedding_status", "not in", ["pending", "failed"])
          .where("indexed_files.summary_status", "not in", ["pending", "failed"]);
      } else {
        query = query.where("indexed_files.summary", "is not", null);
      }
      if (opts.status === "pending") {
        query = query.where((eb) =>
          eb.or([
            eb("indexed_files.embedding_status", "in", ["pending", "failed"]),
            eb("indexed_files.summary_status", "in", ["pending", "failed"]),
          ]),
        );
      }
      if (opts.access === "restricted") {
        query = query.where("indexed_files.access_scope_id", "is not", null);
      } else if (opts.access === "unrestricted") {
        query = query.where("indexed_files.access_scope_id", "is", null);
      }
      if (!opts.viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(opts.viewer));
      }

      const result = await query.executeTakeFirstOrThrow();
      return Number(result.count);
    },

    /** Count non-archived files with optional filters. RBAC-gated for non-admins. */
    async countAllFiles(opts: {
      viewer: FileViewer;
      connectorType?: string;
      excludedSources?: string[];
      category?: string;
      status?: string;
      access?: string;
      collapseRollups?: boolean;
    }) {
      let query = db
        .selectFrom("indexed_files")
        .select(sql`count(*)`.as("count"))
        .where("indexed_files.is_archived", "=", 0);

      if (opts.collapseRollups) {
        query = query.where(browseVisibilityPredicate);
      }

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
      }
      if (opts.excludedSources && opts.excludedSources.length > 0) {
        query = query.where("indexed_files.source", "not in", opts.excludedSources);
      }
      if (opts.category) {
        query = query.where("indexed_files.content_category", "=", opts.category);
      }
      if (opts.status === "enriched") {
        query = query.where("indexed_files.summary", "is not", null);
      } else if (opts.status === "pending") {
        query = query.where((eb) =>
          eb.or([
            eb("indexed_files.embedding_status", "in", ["pending", "failed"]),
            eb("indexed_files.summary_status", "in", ["pending", "failed"]),
          ]),
        );
      } else if (opts.status === "raw") {
        query = query
          .where("indexed_files.summary", "is", null)
          .where("indexed_files.embedding_status", "not in", ["pending", "failed"])
          .where("indexed_files.summary_status", "not in", ["pending", "failed"]);
      }
      if (opts.access === "restricted") {
        query = query.where("indexed_files.access_scope_id", "is not", null);
      } else if (opts.access === "unrestricted") {
        query = query.where("indexed_files.access_scope_id", "is", null);
      }
      if (!opts.viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(opts.viewer));
      }

      const result = await query.executeTakeFirstOrThrow();
      return Number(result.count);
    },

    /**
     * Count visible files grouped by source. RBAC-gated for non-admins.
     *
     * Drives the source-filter chip on the Files page. Connector rows are filtered
     * by ownership for per-user types (Fireflies etc.), so summing `fileCount`
     * across visible rows under-counts for a viewer who has file-access via
     * meetings someone else's connector synced. Aggregating directly from
     * indexed_files with the same predicate the list uses keeps chip + list
     * counts in agreement for every viewer.
     */
    async countFilesBySource(viewer: FileViewer): Promise<Array<{ source: string; count: number }>> {
      let query = db
        .selectFrom("indexed_files")
        .select(["indexed_files.source", sql<number>`count(*)`.as("count")])
        .where("indexed_files.is_archived", "=", 0)
        .where(browseVisibilityPredicate)
        .groupBy("indexed_files.source");
      if (!viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(viewer));
      }
      const rows = await query.execute();
      return rows.map((r) => ({ source: r.source, count: Number(r.count) }));
    },

    /**
     * Count files for a connector (via junction table). RBAC-gated for non-admins.
     * Drives the source-filter chip count on the Files page — must agree with the
     * row count returned by listAllFiles for the same viewer.
     */
    async countFilesByConnector(connectorConfigId: string, viewer: FileViewer) {
      let query = db
        .selectFrom("connector_files")
        .innerJoin("indexed_files", "indexed_files.id", "connector_files.indexed_file_id")
        .select(sql`count(*)`.as("count"))
        .where("connector_files.connector_config_id", "=", connectorConfigId)
        .where("indexed_files.is_archived", "=", 0);
      if (!viewer.isAdmin) {
        query = query.where(fileVisibilityPredicate(viewer));
      }

      const result = await query.executeTakeFirstOrThrow();
      return Number(result.count);
    },
  };
}

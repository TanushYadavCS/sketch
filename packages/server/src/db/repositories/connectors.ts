/**
 * Repository for connector_configs, indexed_files, access_scopes, and file_access tables.
 * Handles CRUD + FTS5 search over indexed content.
 *
 * Access model (3 tiers):
 * 1. No scope + no file_access rows → unrestricted, visible to all
 * 2. Has access_scope_id → check access_scope_members for user's email
 * 3. Has file_access rows → check for user's email (per-file Google Drive My Drive)
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { decodeSecretField, encodeSecretField } from "../../auth/secret-fields";
import { getSyncIdentity, syncIdentityKey } from "../../connectors/sync-identity";
import type { ConnectorType, ContentCategory, SyncStatus } from "../../connectors/types";
import type { DB } from "../schema";

/**
 * File-list viewer for RBAC. Admins bypass; others match by email.
 *
 * Source of truth for "can a user see file X" — used by every repo function
 * that returns indexed files to a UI. The agent/tool path is gated separately.
 */
export interface FileViewer {
  email: string | null;
  isAdmin: boolean;
}

/**
 * Predicate matching files visible to `viewer`. Composed into queries via `.where(...)`.
 *
 *   unrestricted      = no scope AND no per-file shares
 *   scoped            = caller is in access_scope_members for the file's scope
 *   per-file          = caller has a row in file_access for the file
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
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    throw new Error(`fileVisibilityPredicate: invalid table alias "${alias}"`);
  }
  const t = sql.raw(alias);
  const email = viewer.email ?? "";
  return sql<boolean>`(
    (${t}.access_scope_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_access fa WHERE fa.indexed_file_id = ${t}.id))
    OR EXISTS (SELECT 1 FROM access_scope_members asm
               WHERE asm.access_scope_id = ${t}.access_scope_id
                 AND asm.email = ${email})
    OR EXISTS (SELECT 1 FROM file_access fa
               WHERE fa.indexed_file_id = ${t}.id
                 AND fa.email = ${email})
    OR EXISTS (SELECT 1 FROM file_share_emails fse
               WHERE fse.indexed_file_id = ${t}.id
                 AND fse.email = ${email})
    OR ${t}.share_with_everyone = 1
    OR EXISTS (
      SELECT 1 FROM entity_mentions em_shared
      INNER JOIN entities ent_shared ON ent_shared.id = em_shared.entity_id
      LEFT JOIN entity_share_emails ese
        ON ese.entity_id = ent_shared.id AND ese.email = ${email}
      WHERE em_shared.indexed_file_id = ${t}.id
        AND (ent_shared.share_with_everyone = 1 OR ese.email IS NOT NULL)
    )
  )`;
}

function decodeConnectorConfigRow<T extends { credentials: string }>(row: T, encryptionKey?: string): T {
  return {
    ...row,
    credentials: decodeSecretField(row.credentials, encryptionKey, "connector_configs.credentials"),
  };
}

/**
 * Keeps rollup *anchors* and ungrouped rows, dropping CRM activity members.
 * A member is a row whose `rollup_group_id` points at a different parent record;
 * anchors have `rollup_group_id = provider_file_id`, and non-CRM rows have it NULL.
 */
const rollupAnchorPredicate = sql<boolean>`(
  indexed_files.rollup_group_id IS NULL
  OR indexed_files.rollup_group_id = indexed_files.provider_file_id
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
        .select(["connector_configs.id", "connector_configs.connector_type", "connector_configs.created_by"])
        .executeTakeFirst();
    },

    /** Create a new connector config. */
    async createConfig(data: {
      connectorType: ConnectorType;
      authType: string;
      credentials: string;
      scopeConfig?: string;
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
          scope_config: data.scopeConfig ?? "{}",
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
    }) {
      const now = new Date().toISOString();

      const existing = data.providerMessageId
        ? await db
            .selectFrom("indexed_files")
            .selectAll()
            .where("connector_config_id", "=", data.connectorConfigId)
            .where("provider_message_id", "=", data.providerMessageId)
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
          source_created_at: data.sourceCreatedAt,
          source_updated_at: data.sourceUpdatedAt,
          rollup_group_id: data.rollupGroupId ?? null,
          synced_at: now,
        };
        if (data.mimeType !== undefined) updates.mime_type = data.mimeType;
        if (contentChanged || categoryChanged) {
          updates.embedding_status = "pending";
          updates.summary_status = "pending";
          updates.embedding_attempts = 0;
          updates.embedding_next_retry_at = null;
          updates.summary_attempts = 0;
          updates.summary_next_retry_at = null;
        }

        await db.updateTable("indexed_files").set(updates).where("id", "=", existing.id).execute();

        return { id: existing.id, created: false, contentChanged, categoryChanged };
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
          source_created_at: data.sourceCreatedAt,
          source_updated_at: data.sourceUpdatedAt,
          rollup_group_id: data.rollupGroupId ?? null,
          synced_at: now,
          mime_type: data.mimeType ?? null,
          embedding_status: "pending",
          summary_status: "pending",
        })
        .execute();

      return { id, created: true, contentChanged: false, categoryChanged: false };
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
      scope: { scopeType: string; providerScopeId: string; label: string; memberEmails: string[] },
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
      if (scope.memberEmails.length > 0) {
        await db
          .insertInto("access_scope_members")
          .values(scope.memberEmails.map((email) => ({ access_scope_id: scopeId, email })))
          .execute();
      }

      return scopeId;
    },

    /** Set the access scope FK on an indexed file. */
    async setFileAccessScope(fileId: string, scopeId: string) {
      await db.updateTable("indexed_files").set({ access_scope_id: scopeId }).where("id", "=", fileId).execute();
    },

    /**
     * Replace per-file access emails for an indexed file.
     * Used for Google Drive My Drive files with individual sharing.
     */
    async syncFileAccessEmails(indexedFileId: string, emails: string[]) {
      await db.deleteFrom("file_access").where("indexed_file_id", "=", indexedFileId).execute();

      const unique = [...new Set(emails)];
      if (unique.length === 0) return;

      await db
        .insertInto("file_access")
        .values(unique.map((email) => ({ indexed_file_id: indexedFileId, email })))
        .execute();
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
        .select([
          "indexed_files.id",
          "indexed_files.access_scope_id",
          sql<number>`(SELECT count(*) FROM access_scope_members WHERE access_scope_id = indexed_files.access_scope_id)`.as(
            "member_count",
          ),
        ])
        .where("indexed_files.id", "in", fileIds)
        .where("indexed_files.access_scope_id", "is not", null)
        .execute();

      for (const row of scopeFiles) {
        map.set(row.id, { type: "scope", count: Number(row.member_count) });
      }

      // Check per-file access
      const fileAccessRows = await sql<{ indexed_file_id: string; cnt: number }>`
				SELECT indexed_file_id, count(*) as cnt
				FROM file_access
				WHERE indexed_file_id IN (${sql.join(
          fileIds.map((id) => sql`${id}`),
          sql`,`,
        )})
				GROUP BY indexed_file_id
			`.execute(db);

      for (const row of fileAccessRows.rows) {
        if (!map.has(row.indexed_file_id)) {
          map.set(row.indexed_file_id, { type: "file", count: Number(row.cnt) });
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

      if (file.access_scope_id) {
        const rows = await sql<{
          email: string;
          user_name: string | null;
          user_id: string | null;
        }>`
					SELECT
						asm.email,
						u.name AS user_name,
						u.id AS user_id
					FROM access_scope_members asm
					LEFT JOIN user_provider_identities upi
						ON upi.provider_email = asm.email
					LEFT JOIN users u
						ON u.id = upi.user_id
					WHERE asm.access_scope_id = ${file.access_scope_id}
					ORDER BY u.name IS NULL, u.name, asm.email
				`.execute(db);

        return rows.rows.map((r) => ({
          email: r.email,
          userName: r.user_name,
          userId: r.user_id,
          source: "scope" as const,
        }));
      }

      const rows = await sql<{
        email: string;
        user_name: string | null;
        user_id: string | null;
      }>`
				SELECT
					fa.email,
					u.name AS user_name,
					u.id AS user_id
				FROM file_access fa
				LEFT JOIN user_provider_identities upi
					ON upi.provider_email = fa.email
				LEFT JOIN users u
					ON u.id = upi.user_id
				WHERE fa.indexed_file_id = ${fileId}
				ORDER BY u.name IS NULL, u.name, fa.email
			`.execute(db);

      return rows.rows.map((r) => ({
        email: r.email,
        userName: r.user_name,
        userId: r.user_id,
        source: "file" as const,
      }));
    },

    /** Archive files not seen in this sync for a given connector. */
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
      await db
        .deleteFrom("connector_files")
        .where("connector_config_id", "=", connectorConfigId)
        .where("indexed_file_id", "in", staleIds)
        .execute();

      // Archive files that have no remaining connector links
      const stillLinked = await db
        .selectFrom("connector_files")
        .select("indexed_file_id")
        .where("indexed_file_id", "in", staleIds)
        .execute();
      const stillLinkedIds = new Set(stillLinked.map((f) => f.indexed_file_id));
      const orphanedIds = staleIds.filter((id) => !stillLinkedIds.has(id));

      if (orphanedIds.length > 0) {
        await db
          .updateTable("indexed_files")
          .set({ is_archived: 1, access_scope_id: null })
          .where("id", "in", orphanedIds)
          .execute();
      }

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
        query = query.where(rollupAnchorPredicate);
      }

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
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
      category?: string;
      status?: string;
      access?: string;
    }) {
      let query = db
        .selectFrom("indexed_files")
        .select(sql`count(*)`.as("count"))
        .where("indexed_files.is_archived", "=", 0);

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
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
        query = query.where(rollupAnchorPredicate);
      }

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
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
        .where(rollupAnchorPredicate)
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

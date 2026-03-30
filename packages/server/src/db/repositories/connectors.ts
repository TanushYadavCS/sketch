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
import type { ConnectorType, ContentCategory, SyncStatus } from "../../connectors/types";
import type { DB } from "../schema";

export function createConnectorRepository(db: Kysely<DB>) {
  return {
    /** List all connector configs. */
    async listConfigs() {
      return db.selectFrom("connector_configs").selectAll().orderBy("created_at", "desc").execute();
    },

    /** Find a connector config by ID. */
    async findConfigById(id: string) {
      return db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirst();
    },

    /** Find connector configs by type. */
    async findConfigsByType(connectorType: ConnectorType) {
      return db.selectFrom("connector_configs").selectAll().where("connector_type", "=", connectorType).execute();
    },

    /** Find connector configs that are ready to sync. */
    async findSyncableConfigs() {
      return db.selectFrom("connector_configs").selectAll().where("sync_status", "in", ["active", "pending"]).execute();
    },

    /** Create a new connector config. */
    async createConfig(data: {
      connectorType: ConnectorType;
      authType: string;
      credentials: string;
      scopeConfig?: string;
      createdBy: string;
    }) {
      const id = randomUUID();
      await db
        .insertInto("connector_configs")
        .values({
          id,
          connector_type: data.connectorType,
          auth_type: data.authType,
          credentials: data.credentials,
          scope_config: data.scopeConfig ?? "{}",
          created_by: data.createdBy,
        })
        .execute();

      return db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
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
      }>,
    ) {
      const values: Record<string, unknown> = {};
      if (data.credentials !== undefined) values.credentials = data.credentials;
      if (data.scopeConfig !== undefined) values.scope_config = data.scopeConfig;
      if (data.syncStatus !== undefined) values.sync_status = data.syncStatus;
      if (data.syncCursor !== undefined) values.sync_cursor = data.syncCursor;
      if (data.lastSyncedAt !== undefined) values.last_synced_at = data.lastSyncedAt;
      if (data.errorMessage !== undefined) values.error_message = data.errorMessage;

      if (Object.keys(values).length > 0) {
        values.updated_at = new Date().toISOString();
        await db.updateTable("connector_configs").set(values).where("id", "=", id).execute();
      }

      return db.selectFrom("connector_configs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
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
     * Upsert an indexed file by (source, provider_file_id).
     * A file exists once regardless of how many connectors discover it.
     */
    async upsertFile(data: {
      source: string;
      providerFileId: string;
      providerUrl: string | null;
      fileName: string;
      fileType: string | null;
      contentCategory: ContentCategory;
      content: string | null;
      summary: string | null;
      tags: string | null;
      sourcePath: string | null;
      contentHash: string | null;
      sourceCreatedAt: string | null;
      sourceUpdatedAt: string | null;
      connectorConfigId: string;
      mimeType?: string | null;
    }) {
      const now = new Date().toISOString();

      const existing = await db
        .selectFrom("indexed_files")
        .selectAll()
        .where("source", "=", data.source)
        .where("provider_file_id", "=", data.providerFileId)
        .executeTakeFirst();

      if (existing) {
        // If content changed, mark for re-embedding
        const contentChanged = data.contentHash !== existing.content_hash;
        const updates: Record<string, unknown> = {
          provider_url: data.providerUrl,
          file_name: data.fileName,
          file_type: data.fileType,
          content_category: data.contentCategory,
          content: data.content,
          summary: data.summary,
          tags: data.tags,
          source_path: data.sourcePath,
          content_hash: data.contentHash,
          is_archived: 0,
          source_created_at: data.sourceCreatedAt,
          source_updated_at: data.sourceUpdatedAt,
          synced_at: now,
        };
        if (data.mimeType !== undefined) updates.mime_type = data.mimeType;
        if (contentChanged) updates.embedding_status = "pending";

        await db.updateTable("indexed_files").set(updates).where("id", "=", existing.id).execute();

        return { id: existing.id, created: false, contentChanged };
      }

      const id = randomUUID();
      await db
        .insertInto("indexed_files")
        .values({
          id,
          connector_config_id: data.connectorConfigId,
          provider_file_id: data.providerFileId,
          provider_url: data.providerUrl,
          file_name: data.fileName,
          file_type: data.fileType,
          content_category: data.contentCategory,
          content: data.content,
          summary: data.summary,
          tags: data.tags,
          source: data.source,
          source_path: data.sourcePath,
          content_hash: data.contentHash,
          source_created_at: data.sourceCreatedAt,
          source_updated_at: data.sourceUpdatedAt,
          synced_at: now,
          mime_type: data.mimeType ?? null,
          embedding_status: "pending",
        })
        .execute();

      return { id, created: true, contentChanged: false };
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

      if (emails.length === 0) return;

      await db
        .insertInto("file_access")
        .values(emails.map((email) => ({ indexed_file_id: indexedFileId, email })))
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
    async archiveStaleFiles(connectorConfigId: string, seenProviderFileIds: Set<string>) {
      if (seenProviderFileIds.size === 0) return 0;

      const linkedFiles = await db
        .selectFrom("connector_files")
        .innerJoin("indexed_files", "indexed_files.id", "connector_files.indexed_file_id")
        .select(["indexed_files.id", "indexed_files.provider_file_id"])
        .where("connector_files.connector_config_id", "=", connectorConfigId)
        .where("indexed_files.is_archived", "=", 0)
        .execute();

      const stale = linkedFiles.filter((f) => !seenProviderFileIds.has(f.provider_file_id));
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

    /** Update a file's summary after LLM generation. */
    async updateFileSummary(fileId: string, summary: string, tags: string | null) {
      await db.updateTable("indexed_files").set({ summary, tags }).where("id", "=", fileId).execute();
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
      return db
        .selectFrom("connector_configs")
        .selectAll()
        .where("id", "in", ids)
        .orderBy("created_at", "desc")
        .execute();
    },

    /**
     * List files across all connectors with pagination.
     * Ordered by synced_at descending (most recently synced first).
     */
    async listAllFiles(opts: { limit: number; offset: number; connectorType?: string }) {
      let query = db
        .selectFrom("indexed_files")
        .select([
          "indexed_files.id",
          "indexed_files.connector_config_id",
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
          "indexed_files.access_scope_id",
        ])
        .where("indexed_files.is_archived", "=", 0);

      if (opts.connectorType) {
        query = query.where("indexed_files.source", "=", opts.connectorType);
      }

      return query.orderBy("indexed_files.synced_at", "desc").limit(opts.limit).offset(opts.offset).execute();
    },

    /** Count non-archived files, optionally filtered by source type. */
    async countAllFiles(connectorType?: string) {
      let query = db
        .selectFrom("indexed_files")
        .select(sql`count(*)`.as("count"))
        .where("indexed_files.is_archived", "=", 0);

      if (connectorType) {
        query = query.where("indexed_files.source", "=", connectorType);
      }

      const result = await query.executeTakeFirstOrThrow();
      return Number(result.count);
    },

    /** Count files per connector (via junction table). */
    async countFilesByConnector(connectorConfigId: string) {
      const result = await db
        .selectFrom("connector_files")
        .innerJoin("indexed_files", "indexed_files.id", "connector_files.indexed_file_id")
        .select(sql`count(*)`.as("count"))
        .where("connector_files.connector_config_id", "=", connectorConfigId)
        .where("indexed_files.is_archived", "=", 0)
        .executeTakeFirstOrThrow();

      return Number(result.count);
    },
  };
}

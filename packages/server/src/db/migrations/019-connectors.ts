/**
 * Connectors and indexed files infrastructure.
 *
 * Creates connector_configs, indexed_files (with enrichment + embedding columns),
 * and FTS5 full-text search with triggers (SQLite only).
 */
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  const isPostgres = isPg(db);

  await db.schema
    .createTable("connector_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_type", "text", (col) => col.notNull()) // 'google_drive', 'clickup', 'notion', 'linear'
    .addColumn("auth_type", "text", (col) => col.notNull()) // 'oauth', 'api_key', 'integration_token'
    .addColumn("credentials", "text", (col) => col.notNull()) // encrypted JSON blob
    .addColumn("scope_config", "text", (col) => col.notNull().defaultTo("{}")) // JSON: folders, spaces, etc.
    .addColumn("sync_status", "text", (col) => col.notNull().defaultTo("pending")) // pending, active, syncing, paused, error
    .addColumn("sync_cursor", "text") // provider-specific sync token
    .addColumn("last_synced_at", "text")
    .addColumn("error_message", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("indexed_files")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("provider_file_id", "text", (col) => col.notNull())
    .addColumn("provider_url", "text")
    .addColumn("file_name", "text", (col) => col.notNull())
    .addColumn("file_type", "text") // 'document', 'spreadsheet', 'presentation', 'task', 'issue', 'page'
    .addColumn("content_category", "text", (col) => col.notNull()) // 'document' (full content) or 'structured' (metadata only)
    .addColumn("content", "text") // full text content for documents
    .addColumn("summary", "text") // LLM-generated summary
    .addColumn("tags", "text") // JSON array
    .addColumn("source", "text", (col) => col.notNull()) // 'google_drive', 'clickup', 'notion', 'linear'
    .addColumn("source_path", "text") // folder/space path
    .addColumn("content_hash", "text") // SHA-256 for change detection
    .addColumn("is_archived", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("source_created_at", "text")
    .addColumn("source_updated_at", "text")
    .addColumn("synced_at", "text", (col) => col.notNull())
    .addColumn("indexed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("context_note", "text")
    .addColumn("enrichment_status", "text", (col) => col.notNull().defaultTo("raw"))
    .addColumn("access_scope_id", "text")
    .addColumn("mime_type", "text")
    .addColumn("embedding_status", "text", (col) => col.defaultTo("pending"))
    .execute();

  // Indexes for common queries
  await db.schema
    .createIndex("idx_indexed_files_connector")
    .on("indexed_files")
    .columns(["connector_config_id"])
    .execute();

  await db.schema
    .createIndex("idx_indexed_files_provider")
    .on("indexed_files")
    .columns(["source", "provider_file_id"])
    .execute();

  await db.schema.createIndex("idx_indexed_files_not_archived").on("indexed_files").columns(["is_archived"]).execute();

  if (isPostgres) {
    await sql`ALTER TABLE indexed_files ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('english',
        regexp_replace(coalesce(file_name, ''), '[._\\-/]', ' ', 'g') || ' ' ||
        coalesce(summary, '') || ' ' ||
        coalesce(tags, '') || ' ' ||
        coalesce(source, '') || ' ' ||
        coalesce(source_path, '')
      )
    ) STORED`.execute(db);

    await sql`CREATE INDEX idx_indexed_files_search_vector ON indexed_files USING GIN (search_vector)`.execute(db);
    return;
  }

  // SQLite: FTS5 virtual table for full-text search over file name, summary, tags, source, and source_path
  await sql`
		CREATE VIRTUAL TABLE indexed_files_fts USING fts5(
			file_name,
			summary,
			tags,
			source,
			source_path,
			content='indexed_files',
			content_rowid='rowid'
		)
	`.execute(db);

  // Triggers to keep FTS5 in sync with indexed_files
  await sql`
		CREATE TRIGGER indexed_files_ai AFTER INSERT ON indexed_files BEGIN
			INSERT INTO indexed_files_fts(rowid, file_name, summary, tags, source, source_path)
			VALUES (new.rowid, new.file_name, new.summary, new.tags, new.source, new.source_path);
		END
	`.execute(db);

  await sql`
		CREATE TRIGGER indexed_files_ad AFTER DELETE ON indexed_files BEGIN
			INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, summary, tags, source, source_path)
			VALUES ('delete', old.rowid, old.file_name, old.summary, old.tags, old.source, old.source_path);
		END
	`.execute(db);

  await sql`
		CREATE TRIGGER indexed_files_au AFTER UPDATE ON indexed_files BEGIN
			INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, summary, tags, source, source_path)
			VALUES ('delete', old.rowid, old.file_name, old.summary, old.tags, old.source, old.source_path);
			INSERT INTO indexed_files_fts(rowid, file_name, summary, tags, source, source_path)
			VALUES (new.rowid, new.file_name, new.summary, new.tags, new.source, new.source_path);
		END
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const isPostgres = isPg(db);

  if (!isPostgres) {
    await sql`DROP TRIGGER IF EXISTS indexed_files_au`.execute(db);
    await sql`DROP TRIGGER IF EXISTS indexed_files_ad`.execute(db);
    await sql`DROP TRIGGER IF EXISTS indexed_files_ai`.execute(db);
    await sql`DROP TABLE IF EXISTS indexed_files_fts`.execute(db);
  }

  await db.schema.dropTable("indexed_files").execute();
  await db.schema.dropTable("connector_configs").execute();
}

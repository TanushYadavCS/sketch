/**
 * Remove tags and summary from FTS5 index.
 *
 * Tags concept is being removed — entities replace them.
 * Summary was LLM-generated — removing LLM enrichment.
 * FTS5 now indexes: file_name, source, source_path.
 *
 * The columns remain in the indexed_files table (SQLite can't drop columns easily)
 * but are no longer written to or queried.
 */
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  const isPostgres = isPg(db);

  if (isPostgres) {
    // Drop and recreate search_vector without tags/summary
    await sql`DROP INDEX IF EXISTS idx_indexed_files_search_vector`.execute(db);
    await sql`ALTER TABLE indexed_files DROP COLUMN IF EXISTS search_vector`.execute(db);
    await sql`ALTER TABLE indexed_files ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('english',
        regexp_replace(coalesce(file_name, ''), '[._\\-/]', ' ', 'g') || ' ' ||
        coalesce(source, '') || ' ' ||
        coalesce(source_path, '')
      )
    ) STORED`.execute(db);
    await sql`CREATE INDEX idx_indexed_files_search_vector ON indexed_files USING GIN (search_vector)`.execute(db);
    return;
  }

  // SQLite: drop and recreate FTS5 virtual table + triggers without tags/summary
  await sql`DROP TRIGGER IF EXISTS indexed_files_au`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ai`.execute(db);
  await sql`DROP TABLE IF EXISTS indexed_files_fts`.execute(db);

  await sql`
    CREATE VIRTUAL TABLE indexed_files_fts USING fts5(
      file_name,
      source,
      source_path,
      content='indexed_files',
      content_rowid='rowid'
    )
  `.execute(db);

  // Triggers to keep FTS5 in sync
  await sql`
    CREATE TRIGGER indexed_files_ai AFTER INSERT ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(rowid, file_name, source, source_path)
      VALUES (new.rowid, new.file_name, new.source, new.source_path);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER indexed_files_ad AFTER DELETE ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, source, source_path)
      VALUES ('delete', old.rowid, old.file_name, old.source, old.source_path);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER indexed_files_au AFTER UPDATE ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, source, source_path)
      VALUES ('delete', old.rowid, old.file_name, old.source, old.source_path);
      INSERT INTO indexed_files_fts(rowid, file_name, source, source_path)
      VALUES (new.rowid, new.file_name, new.source, new.source_path);
    END
  `.execute(db);

  // Backfill FTS5 from existing data
  await sql`
    INSERT INTO indexed_files_fts(rowid, file_name, source, source_path)
    SELECT rowid, file_name, source, source_path FROM indexed_files WHERE is_archived = 0
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const isPostgres = isPg(db);

  if (isPostgres) {
    // Restore search_vector with tags/summary
    await sql`DROP INDEX IF EXISTS idx_indexed_files_search_vector`.execute(db);
    await sql`ALTER TABLE indexed_files DROP COLUMN IF EXISTS search_vector`.execute(db);
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

  // SQLite: restore FTS5 with tags/summary
  await sql`DROP TRIGGER IF EXISTS indexed_files_au`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ai`.execute(db);
  await sql`DROP TABLE IF EXISTS indexed_files_fts`.execute(db);

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

  await sql`
    INSERT INTO indexed_files_fts(rowid, file_name, summary, tags, source, source_path)
    SELECT rowid, file_name, summary, tags, source, source_path FROM indexed_files WHERE is_archived = 0
  `.execute(db);
}

import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

/**
 * Puts summaries back into keyword search, and ranks the fields against each other.
 *
 * Summary was removed from the index in `034-drop-tags-from-fts` alongside tags. That left
 * keyword search covering file name, source and source path only — so on a corpus whose
 * names are generated (`WhatsApp: Internal OW - 2026-07-30T…`) every document looks alike to
 * the keyword arm, and a summary was searchable by nothing at all.
 *
 * Weights rather than a flat concatenation: `ts_rank`'s default weight vector is
 * `{D:0.1, C:0.2, B:0.4, A:1.0}`, so labelling the fields is enough to make a name match
 * outrank a summary match 2.5x and a path match 5x, with no change at the query site.
 *
 * `source` drops out — it is a controlled vocabulary with a real exact filter, and carrying
 * it as free text only adds noise. `source_path` stays at weight C: nothing else in
 * `hybridSearch` filters on path, so dropping it would lose Drive folder and ClickUp list
 * names with nothing to replace them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS idx_indexed_files_search_vector`.execute(db);
    await sql`ALTER TABLE indexed_files DROP COLUMN IF EXISTS search_vector`.execute(db);
    await sql`ALTER TABLE indexed_files ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', regexp_replace(coalesce(file_name, ''), '[._\\-/]', ' ', 'g')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('english', regexp_replace(coalesce(source_path, ''), '[._\\-/]', ' ', 'g')), 'C')
    ) STORED`.execute(db);
    await sql`CREATE INDEX idx_indexed_files_search_vector ON indexed_files USING GIN (search_vector)`.execute(db);

    /**
     * Trigram index for fuzzy name matching. `to_tsvector` stems, it does not tolerate
     * typos — "Olivr" never matches "Oliver" through the tsvector.
     *
     * Availability is checked rather than attempted-and-caught: a failed statement aborts
     * the surrounding migration transaction in Postgres, so catching the error is not enough
     * to keep going. `pg_trgm` is absent from PGlite and restricted on some managed
     * offerings; fuzzy matching is an enhancement to keyword search, not a prerequisite, so
     * a deployment without it keeps working with one fewer capability rather than failing
     * to start.
     */
    const trgm = await sql<{ name: string }>`SELECT name FROM pg_available_extensions WHERE name = 'pg_trgm'`.execute(
      db,
    );
    if (trgm.rows.length > 0) {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);
      await sql`CREATE INDEX idx_indexed_files_name_trgm ON indexed_files USING GIN (file_name gin_trgm_ops)`.execute(
        db,
      );
    }
    return;
  }

  await sql`DROP TRIGGER IF EXISTS indexed_files_au`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS indexed_files_ai`.execute(db);
  await sql`DROP TABLE IF EXISTS indexed_files_fts`.execute(db);

  await sql`
    CREATE VIRTUAL TABLE indexed_files_fts USING fts5(
      file_name,
      summary,
      source_path,
      content='indexed_files',
      content_rowid='rowid'
    )
  `.execute(db);

  await sql`
    CREATE TRIGGER indexed_files_ai AFTER INSERT ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(rowid, file_name, summary, source_path)
      VALUES (new.rowid, new.file_name, new.summary, new.source_path);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER indexed_files_ad AFTER DELETE ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, summary, source_path)
      VALUES ('delete', old.rowid, old.file_name, old.summary, old.source_path);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER indexed_files_au AFTER UPDATE ON indexed_files BEGIN
      INSERT INTO indexed_files_fts(indexed_files_fts, rowid, file_name, summary, source_path)
      VALUES ('delete', old.rowid, old.file_name, old.summary, old.source_path);
      INSERT INTO indexed_files_fts(rowid, file_name, summary, source_path)
      VALUES (new.rowid, new.file_name, new.summary, new.source_path);
    END
  `.execute(db);

  await sql`
    INSERT INTO indexed_files_fts(rowid, file_name, summary, source_path)
    SELECT rowid, file_name, summary, source_path FROM indexed_files WHERE is_archived = 0
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS idx_indexed_files_name_trgm`.execute(db);
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

  await sql`
    INSERT INTO indexed_files_fts(rowid, file_name, source, source_path)
    SELECT rowid, file_name, source, source_path FROM indexed_files WHERE is_archived = 0
  `.execute(db);
}

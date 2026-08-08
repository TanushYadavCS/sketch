import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_indexed_files_scoped_provider`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_indexed_files_teams_provider`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_indexed_files_source_provider`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_indexed_files_source_provider
    ON indexed_files(source, provider_file_id)
    WHERE provider_message_id IS NULL AND source NOT IN ('teams', 'google_calendar', 'outlook_calendar')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_indexed_files_scoped_provider
    ON indexed_files(connector_config_id, source, provider_file_id)
    WHERE provider_message_id IS NULL AND source IN ('teams', 'google_calendar', 'outlook_calendar')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_indexed_files_scoped_provider`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_indexed_files_source_provider`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_indexed_files_source_provider
    ON indexed_files(source, provider_file_id)
    WHERE provider_message_id IS NULL AND source NOT IN ('teams', 'google_calendar')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_indexed_files_scoped_provider
    ON indexed_files(connector_config_id, source, provider_file_id)
    WHERE provider_message_id IS NULL AND source IN ('teams', 'google_calendar')
  `.execute(db);
}

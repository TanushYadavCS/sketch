import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_files").addColumn("provider_message_id", "text").execute();
  await db.schema.alterTable("indexed_files").addColumn("thread_id", "text").execute();

  await sql`DROP INDEX IF EXISTS idx_indexed_files_source_provider`.execute(db);
  await sql`
    CREATE UNIQUE INDEX idx_indexed_files_source_provider
    ON indexed_files(source, provider_file_id)
    WHERE provider_message_id IS NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX uq_indexed_files_message_id
    ON indexed_files(connector_config_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX idx_indexed_files_thread_id
    ON indexed_files(connector_config_id, thread_id)
    WHERE thread_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_indexed_files_thread_id`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_indexed_files_message_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_indexed_files_source_provider`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_indexed_files_source_provider ON indexed_files(source, provider_file_id)`.execute(
    db,
  );
  await db.schema.alterTable("indexed_files").dropColumn("thread_id").execute();
  await db.schema.alterTable("indexed_files").dropColumn("provider_message_id").execute();
}

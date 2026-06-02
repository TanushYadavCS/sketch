import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("indexed_files")
    .addColumn("embedding_attempts", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("indexed_files").addColumn("embedding_next_retry_at", "text").execute();
  await db.schema
    .alterTable("indexed_files")
    .addColumn("summary_attempts", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("indexed_files").addColumn("summary_next_retry_at", "text").execute();

  await sql`CREATE INDEX idx_indexed_files_embedding_retry ON indexed_files(embedding_status, embedding_next_retry_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_indexed_files_summary_retry ON indexed_files(summary_status, summary_next_retry_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_indexed_files_summary_retry`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_indexed_files_embedding_retry`.execute(db);
  await db.schema.alterTable("indexed_files").dropColumn("summary_next_retry_at").execute();
  await db.schema.alterTable("indexed_files").dropColumn("summary_attempts").execute();
  await db.schema.alterTable("indexed_files").dropColumn("embedding_next_retry_at").execute();
  await db.schema.alterTable("indexed_files").dropColumn("embedding_attempts").execute();
}

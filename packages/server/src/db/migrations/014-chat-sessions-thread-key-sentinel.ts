/**
 * Replaces the expression-based unique index on chat_sessions with a plain column-based one.
 *
 * The original index used COALESCE(thread_key, '') which works in SQLite but not Postgres
 * (Postgres doesn't allow expressions in ON CONFLICT targets). Instead we switch to using
 * an empty string '' as the sentinel for "no thread" so the unique constraint is just
 * (workspace_key, thread_key) — compatible with both databases.
 *
 * Steps: convert existing NULL thread_key rows to '', drop the expression index,
 * set NOT NULL + DEFAULT '' on thread_key, create a plain unique index.
 */
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE chat_sessions SET thread_key = '' WHERE thread_key IS NULL`.execute(db);

  await sql`DROP INDEX IF EXISTS chat_sessions_workspace_thread_uidx`.execute(db);

  const isPostgres = isPg(db);

  if (isPostgres) {
    await sql`ALTER TABLE chat_sessions ALTER COLUMN thread_key SET NOT NULL`.execute(db);
    await sql`ALTER TABLE chat_sessions ALTER COLUMN thread_key SET DEFAULT ''`.execute(db);
    await sql`ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_workspace_thread_uidx UNIQUE (workspace_key, thread_key)`.execute(
      db,
    );
  } else {
    /**
     * SQLite doesn't support ALTER COLUMN to add NOT NULL or change defaults, so we
     * recreate the table.
     */
    await sql`CREATE TABLE chat_sessions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_key TEXT NOT NULL,
      thread_key TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(workspace_key, thread_key)
    )`.execute(db);

    await sql`INSERT INTO chat_sessions_new (id, workspace_key, thread_key, session_id, updated_at)
      SELECT id, workspace_key, thread_key, session_id, updated_at FROM chat_sessions`.execute(db);

    await sql`DROP TABLE chat_sessions`.execute(db);

    await sql`ALTER TABLE chat_sessions_new RENAME TO chat_sessions`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE chat_sessions SET thread_key = NULL WHERE thread_key = ''`.execute(db);
}

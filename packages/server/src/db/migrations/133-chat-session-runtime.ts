import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`ALTER TABLE chat_sessions ADD COLUMN runtime text NOT NULL DEFAULT 'sdk'`.execute(db);
    await sql`ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_workspace_thread_uidx`.execute(db);
    await sql`ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_workspace_thread_uidx UNIQUE (workspace_key, thread_key, runtime)`.execute(
      db,
    );
    return;
  }

  await sql`CREATE TABLE chat_sessions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT NOT NULL,
    thread_key TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT 'sdk',
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(workspace_key, thread_key, runtime)
  )`.execute(db);

  await sql`INSERT INTO chat_sessions_new (id, workspace_key, thread_key, runtime, session_id, updated_at)
    SELECT id, workspace_key, thread_key, 'sdk', session_id, updated_at FROM chat_sessions`.execute(db);

  await sql`DROP TABLE chat_sessions`.execute(db);
  await sql`ALTER TABLE chat_sessions_new RENAME TO chat_sessions`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DELETE FROM chat_sessions WHERE runtime <> 'sdk'`.execute(db);
    await sql`ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_workspace_thread_uidx`.execute(db);
    await sql`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS runtime`.execute(db);
    await sql`ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_workspace_thread_uidx UNIQUE (workspace_key, thread_key)`.execute(
      db,
    );
    return;
  }

  await sql`CREATE TABLE chat_sessions_old (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT NOT NULL,
    thread_key TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(workspace_key, thread_key)
  )`.execute(db);

  await sql`INSERT INTO chat_sessions_old (id, workspace_key, thread_key, session_id, updated_at)
    SELECT id, workspace_key, thread_key, session_id, updated_at FROM chat_sessions
    WHERE runtime = 'sdk'`.execute(db);

  await sql`DROP TABLE chat_sessions`.execute(db);
  await sql`ALTER TABLE chat_sessions_old RENAME TO chat_sessions`.execute(db);
}

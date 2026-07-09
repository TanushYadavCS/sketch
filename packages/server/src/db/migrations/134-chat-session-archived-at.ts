import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const ACTIVE_SESSION_INDEX = "chat_sessions_workspace_thread_uidx";

async function createActiveSessionIndex(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex(ACTIVE_SESSION_INDEX)
    .unique()
    .on("chat_sessions")
    .columns(["workspace_key", "thread_key", "runtime"])
    .where(sql.ref("archived_at"), "is", null)
    .execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`ALTER TABLE chat_sessions ADD COLUMN archived_at text DEFAULT NULL`.execute(db);
    await sql`ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_workspace_thread_uidx`.execute(db);
    await createActiveSessionIndex(db);
    return;
  }

  await sql`CREATE TABLE chat_sessions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT NOT NULL,
    thread_key TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT 'sdk',
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    archived_at TEXT DEFAULT NULL
  )`.execute(db);

  await sql`INSERT INTO chat_sessions_new (id, workspace_key, thread_key, runtime, session_id, updated_at, archived_at)
    SELECT id, workspace_key, thread_key, runtime, session_id, updated_at, NULL FROM chat_sessions`.execute(db);

  await sql`DROP TABLE chat_sessions`.execute(db);
  await sql`ALTER TABLE chat_sessions_new RENAME TO chat_sessions`.execute(db);
  await createActiveSessionIndex(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(ACTIVE_SESSION_INDEX).ifExists().execute();

  if (isPg(db)) {
    await sql`DELETE FROM chat_sessions WHERE archived_at IS NOT NULL`.execute(db);
    await sql`ALTER TABLE chat_sessions DROP COLUMN IF EXISTS archived_at`.execute(db);
    await sql`ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_workspace_thread_uidx UNIQUE (workspace_key, thread_key, runtime)`.execute(
      db,
    );
    return;
  }

  await sql`CREATE TABLE chat_sessions_old (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT NOT NULL,
    thread_key TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT 'sdk',
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(workspace_key, thread_key, runtime)
  )`.execute(db);

  await sql`INSERT INTO chat_sessions_old (id, workspace_key, thread_key, runtime, session_id, updated_at)
    SELECT id, workspace_key, thread_key, runtime, session_id, updated_at FROM chat_sessions
    WHERE archived_at IS NULL`.execute(db);

  await sql`DROP TABLE chat_sessions`.execute(db);
  await sql`ALTER TABLE chat_sessions_old RENAME TO chat_sessions`.execute(db);
}

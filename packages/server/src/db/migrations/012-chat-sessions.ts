/**
 * Creates the chat_sessions table and migrates existing file-based session IDs into it.
 *
 * Previously, session IDs were persisted as JSON files inside each workspace directory.
 * Workspace-level sessions lived at {workspace}/session.json; thread-level sessions lived at
 * {workspace}/sessions/{threadTs}.json. Moving them to DB lets scheduled tasks and other
 * non-file-system code paths look up and update sessions without touching the filesystem.
 *
 * The UNIQUE constraint uses COALESCE(thread_key, '') so both workspace-level rows
 * (thread_key IS NULL) and thread-level rows (thread_key = '<threadTs>') are covered by
 * a single unique index — SQLite treats two NULLs as distinct, so a plain UNIQUE on
 * (workspace_key, thread_key) would allow duplicate workspace-level rows.
 * Migration 014 replaces this with a plain column-based constraint using '' as sentinel.
 *
 * Migration direction: up() migrates files → DB and removes them. down() drops the table
 * only (no attempt to recreate files — this is a one-way data migration).
 */
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  const isPostgres = isPg(db);

  if (isPostgres) {
    // Postgres: use serial for auto-incrementing PK (autoIncrement() generates
    // 'auto_increment' which is not valid Postgres syntax).
    await sql`CREATE TABLE chat_sessions (
      id serial PRIMARY KEY,
      workspace_key text NOT NULL,
      thread_key text,
      session_id text NOT NULL,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(db);
  } else {
    await db.schema
      .createTable("chat_sessions")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("workspace_key", "text", (col) => col.notNull())
      .addColumn("thread_key", "text")
      .addColumn("session_id", "text", (col) => col.notNull())
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }

  await sql`CREATE UNIQUE INDEX chat_sessions_workspace_thread_uidx ON chat_sessions (workspace_key, COALESCE(thread_key, ''))`.execute(
    db,
  );

  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? "./data");
  const workspacesDir = `${dataDir}/workspaces`;

  let workspaceEntries: string[];
  try {
    workspaceEntries = await readdir(workspacesDir);
  } catch {
    // No workspaces directory yet — nothing to migrate.
    return;
  }

  for (const workspaceKey of workspaceEntries) {
    const workspaceDir = `${workspacesDir}/${workspaceKey}`;

    // Workspace-level session
    const sessionFile = `${workspaceDir}/session.json`;
    try {
      const raw = await readFile(sessionFile, "utf-8");
      const parsed = JSON.parse(raw) as { sessionId?: string };
      if (parsed.sessionId) {
        await (db as Kysely<Record<string, unknown>>)
          .insertInto("chat_sessions")
          .values({ workspace_key: workspaceKey, thread_key: null, session_id: parsed.sessionId })
          .execute();
        await rm(sessionFile);
      }
    } catch {
      // File missing or unreadable — skip.
    }

    // Thread-level sessions
    const sessionsDir = `${workspaceDir}/sessions`;
    let threadFiles: string[];
    try {
      threadFiles = await readdir(sessionsDir);
    } catch {
      threadFiles = [];
    }

    for (const fileName of threadFiles) {
      if (!fileName.endsWith(".json")) continue;
      const threadKey = fileName.slice(0, -5); // strip .json
      const filePath = `${sessionsDir}/${fileName}`;
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw) as { sessionId?: string };
        if (parsed.sessionId) {
          await (db as Kysely<Record<string, unknown>>)
            .insertInto("chat_sessions")
            .values({ workspace_key: workspaceKey, thread_key: threadKey, session_id: parsed.sessionId })
            .execute();
          await rm(filePath);
        }
      } catch {
        // File missing or unreadable — skip.
      }
    }

    // Remove empty sessions/ directory if it exists
    try {
      const remaining = await readdir(sessionsDir);
      if (remaining.length === 0) {
        await rm(sessionsDir, { recursive: true });
      }
    } catch {
      // Directory already gone or never existed.
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("chat_sessions").execute();
}

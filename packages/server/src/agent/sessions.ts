/**
 * Persists the Claude Agent SDK session ID per workspace (and optionally per thread) in the DB.
 *
 * DMs and group chats use a workspace-level row (thread_key = '').
 * Channel mentions use per-thread rows (thread_key = threadTs) so threads don't
 * bleed into each other. The workspace_key is the directory name under workspaces/:
 * a user ID for DMs, "channel-{channelId}" for Slack channels, or "wa-group-{jid}"
 * for WhatsApp groups.
 *
 * Uses '' (empty string) as the sentinel for "no thread" so the active-session
 * uniqueness index works identically in SQLite and Postgres.
 */
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/schema";
import type { AgentRuntimeKind } from "./runtime/contracts";

const SDK_RUNTIME = "sdk";
const CURRENT_TIMESTAMP_TEXT = sql<string>`CAST(CURRENT_TIMESTAMP AS TEXT)`;

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

async function updateActiveSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  threadKey: string,
  runtime: AgentRuntimeKind,
): Promise<boolean> {
  const result = await db
    .updateTable("chat_sessions")
    .set({ session_id: sessionId, updated_at: CURRENT_TIMESTAMP_TEXT })
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey)
    .where("runtime", "=", runtime)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

async function hasArchivedSessionId(db: Kysely<DB>, sessionId: string, runtime: AgentRuntimeKind): Promise<boolean> {
  const row = await db
    .selectFrom("chat_sessions")
    .select("id")
    .where("runtime", "=", runtime)
    .where("session_id", "=", sessionId)
    .where("archived_at", "is not", null)
    .executeTakeFirst();
  return row !== undefined;
}

export async function getSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  threadKey?: string,
): Promise<string | undefined> {
  return getSessionIdForRuntime(db, workspaceKey, threadKey, SDK_RUNTIME);
}

export async function getSessionIdForRuntime(
  db: Kysely<DB>,
  workspaceKey: string,
  threadKey: string | undefined,
  runtime: AgentRuntimeKind,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("chat_sessions")
    .select("session_id")
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey ?? "")
    .where("runtime", "=", runtime)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  return row?.session_id;
}

export async function saveSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  threadKey?: string,
): Promise<void> {
  await saveSessionIdForRuntime(db, workspaceKey, sessionId, threadKey, SDK_RUNTIME);
}

export async function saveSessionIdForRuntime(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  threadKey: string | undefined,
  runtime: AgentRuntimeKind,
): Promise<void> {
  const normalizedThreadKey = threadKey ?? "";
  if (await hasArchivedSessionId(db, sessionId, runtime)) return;
  if (await updateActiveSessionId(db, workspaceKey, sessionId, normalizedThreadKey, runtime)) return;

  try {
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: workspaceKey, thread_key: normalizedThreadKey, runtime, session_id: sessionId })
      .execute();
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    if (!(await updateActiveSessionId(db, workspaceKey, sessionId, normalizedThreadKey, runtime))) throw error;
  }
}

export class SessionWorkspaceConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session id belongs to another workspace: ${sessionId}`);
    this.name = "SessionWorkspaceConflictError";
  }
}

/**
 * Caller-supplied AI SDK session ids are externally meaningful but agent_messages is still keyed only by session_id.
 * Until that table grows a workspace key, the run path must reserve each explicit id for exactly one workspace.
 */
export async function assertSessionIdBelongsToRuntimeWorkspace(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  runtime: AgentRuntimeKind,
): Promise<void> {
  const rows = await db
    .selectFrom("chat_sessions")
    .select("workspace_key")
    .where("runtime", "=", runtime)
    .where("session_id", "=", sessionId)
    .execute();

  if (rows.some((row) => row.workspace_key !== workspaceKey)) {
    throw new SessionWorkspaceConflictError(sessionId);
  }
}

export async function isArchivedRuntimeSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  runtime: AgentRuntimeKind,
): Promise<boolean> {
  const row = await db
    .selectFrom("chat_sessions")
    .select("id")
    .where("workspace_key", "=", workspaceKey)
    .where("runtime", "=", runtime)
    .where("session_id", "=", sessionId)
    .where("archived_at", "is not", null)
    .executeTakeFirst();
  return row !== undefined;
}

export async function archiveSdkSessionId(db: Kysely<DB>, workspaceKey: string, threadKey?: string): Promise<void> {
  await db
    .updateTable("chat_sessions")
    .set({ archived_at: CURRENT_TIMESTAMP_TEXT })
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey ?? "")
    .where("runtime", "=", SDK_RUNTIME)
    .where("archived_at", "is", null)
    .execute();
}

export async function archiveRuntimeSessions(db: Kysely<DB>, workspaceKey: string, threadKey?: string): Promise<void> {
  await db
    .updateTable("chat_sessions")
    .set({ archived_at: CURRENT_TIMESTAMP_TEXT })
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey ?? "")
    .where("archived_at", "is", null)
    .execute();
}

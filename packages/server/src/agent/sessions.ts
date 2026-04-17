/**
 * Persists the Claude Agent SDK session ID per workspace (and optionally per thread) in the DB.
 *
 * DMs and group chats use a workspace-level row (thread_key = '').
 * Channel mentions use per-thread rows (thread_key = threadTs) so threads don't
 * bleed into each other. The workspace_key is the directory name under workspaces/:
 * a user ID for DMs, "channel-{channelId}" for Slack channels, or "wa-group-{jid}"
 * for WhatsApp groups.
 *
 * Uses '' (empty string) as the sentinel for "no thread" instead of NULL so the
 * UNIQUE(workspace_key, thread_key) constraint works identically in SQLite and Postgres.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";

export async function getSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  threadKey?: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("chat_sessions")
    .select("session_id")
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey ?? "")
    .executeTakeFirst();
  return row?.session_id;
}

export async function saveSessionId(
  db: Kysely<DB>,
  workspaceKey: string,
  sessionId: string,
  threadKey?: string,
): Promise<void> {
  await db
    .insertInto("chat_sessions")
    .values({ workspace_key: workspaceKey, thread_key: threadKey ?? "", session_id: sessionId })
    .onConflict((oc) =>
      oc.columns(["workspace_key", "thread_key"]).doUpdateSet({
        session_id: sessionId,
      }),
    )
    .execute();
}

export async function deleteSessionId(db: Kysely<DB>, workspaceKey: string, threadKey?: string): Promise<void> {
  await db
    .deleteFrom("chat_sessions")
    .where("workspace_key", "=", workspaceKey)
    .where("thread_key", "=", threadKey ?? "")
    .execute();
}

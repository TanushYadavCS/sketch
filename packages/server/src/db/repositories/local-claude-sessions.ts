import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, LocalClaudeSessionEventsTable, LocalClaudeSessionsTable } from "../schema";

export type LocalClaudeSessionRow = Selectable<LocalClaudeSessionsTable>;
export type LocalClaudeSessionEventRow = Selectable<LocalClaudeSessionEventsTable>;

export type LocalClaudeSessionStatus =
  | "starting"
  | "running"
  | "waiting_for_input"
  | "needs_permission"
  | "completed_turn"
  | "failed"
  | "ended"
  | "killed";

export interface LocalClaudeSessionOrigin {
  platform?: string | null;
  contextType?: string | null;
  deliveryTarget?: string | null;
  threadTs?: string | null;
  workspaceKey?: string | null;
  workspaceDir?: string | null;
  activeQueueKey?: string | null;
  conversationId?: number | null;
  providerThreadId?: string | null;
  agentInstructions?: string | null;
  agentAllowedTools?: string[] | null;
  orgContextEnabled?: boolean | null;
}

function nullableBooleanToNumber(value: boolean | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (value) return 1;
  return 0;
}

function stringifyAllowedTools(value: string[] | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

export function createLocalClaudeSessionRepository(db: Kysely<DB>) {
  return {
    async create(input: {
      id?: string;
      userId: string;
      deviceId: string;
      tmuxSessionName: string;
      title: string;
      cwd?: string | null;
      status?: LocalClaudeSessionStatus;
      eventTokenHash: string;
      origin?: LocalClaudeSessionOrigin;
    }): Promise<LocalClaudeSessionRow> {
      const id = input.id ?? randomUUID();
      await db
        .insertInto("local_claude_sessions")
        .values({
          id,
          user_id: input.userId,
          device_id: input.deviceId,
          tmux_session_name: input.tmuxSessionName,
          title: input.title,
          cwd: input.cwd ?? null,
          status: input.status ?? "starting",
          event_token_hash: input.eventTokenHash,
          origin_platform: input.origin?.platform ?? null,
          origin_context_type: input.origin?.contextType ?? null,
          origin_delivery_target: input.origin?.deliveryTarget ?? null,
          origin_thread_ts: input.origin?.threadTs ?? null,
          origin_workspace_key: input.origin?.workspaceKey ?? null,
          origin_workspace_dir: input.origin?.workspaceDir ?? null,
          origin_active_queue_key: input.origin?.activeQueueKey ?? null,
          origin_conversation_id: input.origin?.conversationId ?? null,
          origin_provider_thread_id: input.origin?.providerThreadId ?? null,
          origin_agent_instructions: input.origin?.agentInstructions ?? null,
          origin_agent_allowed_tools: stringifyAllowedTools(input.origin?.agentAllowedTools),
          origin_org_context_enabled: nullableBooleanToNumber(input.origin?.orgContextEnabled),
        })
        .execute();
      return db.selectFrom("local_claude_sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async findForUser(userId: string, sessionId: string): Promise<LocalClaudeSessionRow | undefined> {
      return db
        .selectFrom("local_claude_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
    },

    async findByEventTokenHash(tokenHash: string): Promise<LocalClaudeSessionRow | undefined> {
      return db
        .selectFrom("local_claude_sessions")
        .selectAll()
        .where("event_token_hash", "=", tokenHash)
        .executeTakeFirst();
    },

    async listForUser(userId: string, limit = 20): Promise<LocalClaudeSessionRow[]> {
      return db
        .selectFrom("local_claude_sessions")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .limit(Math.max(1, Math.min(limit, 100)))
        .execute();
    },

    async updateStatus(
      sessionId: string,
      input: {
        status: LocalClaudeSessionStatus;
        lastEventType?: string | null;
        endedAt?: string | null;
      },
    ): Promise<LocalClaudeSessionRow> {
      const now = new Date().toISOString();
      await db
        .updateTable("local_claude_sessions")
        .set({
          status: input.status,
          updated_at: now,
          last_event_type: input.lastEventType ?? undefined,
          last_event_at: input.lastEventType ? now : undefined,
          ended_at: input.endedAt === undefined ? undefined : input.endedAt,
        })
        .where("id", "=", sessionId)
        .execute();
      return db.selectFrom("local_claude_sessions").selectAll().where("id", "=", sessionId).executeTakeFirstOrThrow();
    },

    async recordEvent(input: {
      sessionId: string;
      eventType: string;
      status: LocalClaudeSessionStatus;
      message?: string | null;
      payload: unknown;
    }): Promise<LocalClaudeSessionEventRow> {
      const id = randomUUID();
      await db
        .insertInto("local_claude_session_events")
        .values({
          id,
          session_id: input.sessionId,
          event_type: input.eventType,
          status: input.status,
          message: input.message ?? null,
          payload: JSON.stringify(input.payload),
        })
        .execute();
      await this.updateStatus(input.sessionId, {
        status: input.status,
        lastEventType: input.eventType,
        endedAt: input.status === "ended" || input.status === "failed" ? new Date().toISOString() : undefined,
      });
      return db.selectFrom("local_claude_session_events").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },
  };
}

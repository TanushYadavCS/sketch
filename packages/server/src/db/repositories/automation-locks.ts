/**
 * Repository for pessimistic whole-automation edit locks — `automation_task_locks` rows.
 *
 * Every mutation is a guarded UPDATE/DELETE/INSERT whose WHERE clause encodes
 * the compare-and-swap condition; callers must verify the outcome by reading
 * the row back instead of trusting affected-row counts (numUpdatedRows
 * semantics differ between SQLite and Postgres). A holder is authorized by
 * the authenticated user and lease generation; the client session records
 * lifecycle attribution. All
 * timestamps are app-generated ISO-8601 UTC strings, so expiry comparisons are
 * plain string comparisons — portable across SQLite and Postgres with no
 * dialect date functions.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../schema";

export const LEGACY_LOCK_SESSION_ID = "legacy";

export interface AutomationTaskLockRow {
  task_id: string;
  holder_user_id: string;
  holder_session_id: string;
  generation: number;
  holder_platform: string;
  holder_surface: string;
  holder_conversation_id: string | null;
  acquired_at: string;
  updated_at: string;
  expires_at: string;
  steal_requester_user_id: string | null;
  steal_requester_session_id: string | null;
  steal_requester_platform: string | null;
  steal_requester_surface: string | null;
  steal_requester_conversation_id: string | null;
  steal_requested_at: string | null;
  steal_expires_at: string | null;
}

export interface LockHolderFields {
  userId: string;
  sessionId?: string;
  platform: string;
  surface: string;
  conversationId: string | null;
}

function sessionIdFor(holder: LockHolderFields): string {
  return holder.sessionId ?? LEGACY_LOCK_SESSION_ID;
}

export function createAutomationLocksRepository(db: Kysely<DB>) {
  return {
    /**
     * FREE->HELD attempt without any expiry check: INSERT ... ON CONFLICT DO
     * NOTHING. The caller reads the row back to decide whether it won (holder
     * is itself), lost to a concurrent holder, or may take over an expired
     * lock.
     */
    async insertIfAbsent(
      holder: LockHolderFields,
      params: { taskId: string; expiresAt: string; now: string },
    ): Promise<void> {
      await db
        .insertInto("automation_task_locks")
        .values({
          task_id: params.taskId,
          holder_user_id: holder.userId,
          holder_session_id: sessionIdFor(holder),
          generation: 1,
          holder_platform: holder.platform,
          holder_surface: holder.surface,
          holder_conversation_id: holder.conversationId,
          acquired_at: params.now,
          updated_at: params.now,
          expires_at: params.expiresAt,
        })
        .onConflict((oc) => oc.column("task_id").doNothing())
        .execute();
    },

    /** Expired-lock takeover: re-arms holder + TTL and clears any pending steal. */
    async takeoverExpired(
      holder: LockHolderFields,
      params: { taskId: string; expiresAt: string; now: string },
    ): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          holder_user_id: holder.userId,
          holder_session_id: sessionIdFor(holder),
          holder_platform: holder.platform,
          holder_surface: holder.surface,
          holder_conversation_id: holder.conversationId,
          updated_at: params.now,
          expires_at: params.expiresAt,
          generation: sql<number>`${sql.ref("generation")} + 1`,
          steal_requester_user_id: null,
          steal_requester_session_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
        })
        .where("task_id", "=", params.taskId)
        .where("expires_at", "<", params.now)
        .execute();
    },

    async adoptSameUserSession(
      holder: LockHolderFields,
      params: {
        taskId: string;
        previousSessionId: string;
        previousGeneration: number;
        expiresAt: string;
        now: string;
      },
    ): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          holder_session_id: sessionIdFor(holder),
          holder_platform: holder.platform,
          holder_surface: holder.surface,
          holder_conversation_id: holder.conversationId,
          acquired_at: params.now,
          updated_at: params.now,
          expires_at: params.expiresAt,
          steal_requester_user_id: null,
          steal_requester_session_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
        })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", holder.userId)
        .where("holder_session_id", "=", params.previousSessionId)
        .where("generation", "=", params.previousGeneration)
        .where("expires_at", ">", params.now)
        .execute();
    },

    /** Holder-scoped renewal. */
    async renew(params: {
      taskId: string;
      userId: string;
      sessionId?: string;
      generation?: number;
      expiresAt: string;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({ updated_at: params.now, expires_at: params.expiresAt })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
        .where("holder_session_id", "=", params.sessionId ?? LEGACY_LOCK_SESSION_ID)
        .where("generation", "=", params.generation ?? 1)
        .execute();
    },

    /** Holder-scoped release; idempotent (no-op when not the holder). */
    async release(params: { taskId: string; userId: string; sessionId?: string; generation?: number }): Promise<void> {
      await db
        .deleteFrom("automation_task_locks")
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
        .where("holder_session_id", "=", params.sessionId ?? LEGACY_LOCK_SESSION_ID)
        .where("generation", "=", params.generation ?? 1)
        .execute();
    },

    /**
     * Steal request CAS: only matches when the lock is held by someone else,
     * is unexpired, and no steal is already pending (CAS on NULL).
     */
    async requestSteal(
      requester: LockHolderFields,
      params: { taskId: string; stealRequestedAt: string; stealExpiresAt: string },
    ): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          steal_requester_user_id: requester.userId,
          steal_requester_session_id: sessionIdFor(requester),
          steal_requester_platform: requester.platform,
          steal_requester_surface: requester.surface,
          steal_requester_conversation_id: requester.conversationId,
          steal_requested_at: params.stealRequestedAt,
          steal_expires_at: params.stealExpiresAt,
        })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "<>", requester.userId)
        .where("expires_at", ">", params.stealRequestedAt)
        .where("steal_requester_user_id", "is", null)
        .execute();
    },

    /** Approve: promotes the pending steal to holder and re-arms the lock TTL. */
    async approveSteal(params: {
      taskId: string;
      approverUserId: string;
      approverSessionId?: string;
      approverGeneration?: number;
      expiresAt: string;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          holder_user_id: sql.ref("steal_requester_user_id"),
          holder_session_id: sql.ref("steal_requester_session_id"),
          holder_platform: sql.ref("steal_requester_platform"),
          holder_surface: sql.ref("steal_requester_surface"),
          holder_conversation_id: sql.ref("steal_requester_conversation_id"),
          generation: sql<number>`${sql.ref("generation")} + 1`,
          steal_requester_user_id: null,
          steal_requester_session_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
          updated_at: params.now,
          expires_at: params.expiresAt,
        })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.approverUserId)
        .where("holder_session_id", "=", params.approverSessionId ?? LEGACY_LOCK_SESSION_ID)
        .where("generation", "=", params.approverGeneration ?? 1)
        .execute();
    },

    /** Holder-scoped steal rejection / expiry cleanup. */
    async clearSteal(params: {
      taskId: string;
      holderUserId: string;
      holderSessionId?: string;
      holderGeneration?: number;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          steal_requester_user_id: null,
          steal_requester_session_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
          updated_at: params.now,
        })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.holderUserId)
        .where("holder_session_id", "=", params.holderSessionId ?? LEGACY_LOCK_SESSION_ID)
        .where("generation", "=", params.holderGeneration ?? 1)
        .execute();
    },

    async getByTaskId(taskId: string): Promise<AutomationTaskLockRow | undefined> {
      return db.selectFrom("automation_task_locks").selectAll().where("task_id", "=", taskId).executeTakeFirst();
    },

    /**
     * Touches and holds an exact live lease row for the caller's transaction.
     * The guarded UPDATE obtains the row lock before the caller writes the
     * automation definition; the read-back is the dialect-neutral match check
     * and does not rely on affected-row counts.
     */
    async touchIfExactHolder(params: {
      taskId: string;
      userId: string;
      sessionId: string;
      generation: number;
      now: string;
    }): Promise<AutomationTaskLockRow | undefined> {
      await db
        .updateTable("automation_task_locks")
        .set({ updated_at: params.now })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
        .where("holder_session_id", "=", params.sessionId)
        .where("generation", "=", params.generation)
        .where("expires_at", ">", params.now)
        .execute();

      const row = await db
        .selectFrom("automation_task_locks")
        .selectAll()
        .where("task_id", "=", params.taskId)
        .executeTakeFirst();
      if (!row) return undefined;
      if (
        row.holder_user_id !== params.userId ||
        row.holder_session_id !== params.sessionId ||
        row.generation !== params.generation ||
        row.expires_at <= params.now
      ) {
        return undefined;
      }
      return row;
    },

    async touchIfUserGeneration(params: {
      taskId: string;
      userId: string;
      generation: number;
      now: string;
    }): Promise<AutomationTaskLockRow | undefined> {
      await db
        .updateTable("automation_task_locks")
        .set({ updated_at: params.now })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
        .where("generation", "=", params.generation)
        .where("expires_at", ">", params.now)
        .execute();

      const row = await db
        .selectFrom("automation_task_locks")
        .selectAll()
        .where("task_id", "=", params.taskId)
        .executeTakeFirst();
      if (!row) return undefined;
      if (
        row.holder_user_id !== params.userId ||
        row.generation !== params.generation ||
        row.expires_at <= params.now
      ) {
        return undefined;
      }
      return row;
    },

    /** Removes every lock row for a task (deleteAutomation's transaction). */
    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("automation_task_locks").where("task_id", "=", taskId).execute();
    },

    /**
     * Hygiene sweep: deletes expired lock rows and clears expired pending
     * steals. Correctness never depends on this — every access re-checks
     * expiry — it only keeps the table from accumulating stale rows.
     */
    async sweepExpired(now: string): Promise<{ deletedLocks: number; clearedSteals: number }> {
      const deleted = await db.deleteFrom("automation_task_locks").where("expires_at", "<", now).executeTakeFirst();
      const cleared = await db
        .updateTable("automation_task_locks")
        .set({
          steal_requester_user_id: null,
          steal_requester_session_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
        })
        .where("steal_requester_user_id", "is not", null)
        .where("steal_expires_at", "<", now)
        .executeTakeFirst();
      return {
        deletedLocks: Number(deleted?.numDeletedRows ?? 0),
        clearedSteals: Number(cleared?.numUpdatedRows ?? 0),
      };
    },
  };
}

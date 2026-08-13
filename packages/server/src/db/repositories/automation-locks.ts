/**
 * Repository for pessimistic whole-automation edit locks — `automation_task_locks` rows.
 *
 * Every mutation is a guarded UPDATE/DELETE/INSERT whose WHERE clause encodes
 * the compare-and-swap condition; callers must verify the outcome by reading
 * the row back instead of trusting affected-row counts (numUpdatedRows
 * semantics differ between SQLite and Postgres). All timestamps are
 * app-generated ISO-8601 UTC strings, so expiry comparisons are plain string
 * comparisons — portable across SQLite and Postgres with no dialect date
 * functions.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../schema";

export interface AutomationTaskLockRow {
  task_id: string;
  holder_user_id: string;
  holder_platform: string;
  holder_surface: string;
  holder_conversation_id: string | null;
  acquired_at: string;
  updated_at: string;
  expires_at: string;
  steal_requester_user_id: string | null;
  steal_requester_platform: string | null;
  steal_requester_surface: string | null;
  steal_requester_conversation_id: string | null;
  steal_requested_at: string | null;
  steal_expires_at: string | null;
}

export interface LockHolderFields {
  userId: string;
  platform: string;
  surface: string;
  conversationId: string | null;
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
          holder_platform: holder.platform,
          holder_surface: holder.surface,
          holder_conversation_id: holder.conversationId,
          updated_at: params.now,
          expires_at: params.expiresAt,
          steal_requester_user_id: null,
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

    /** Holder-scoped renewal. */
    async renew(params: { taskId: string; userId: string; expiresAt: string; now: string }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({ updated_at: params.now, expires_at: params.expiresAt })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
        .execute();
    },

    /** Holder-scoped release; idempotent (no-op when not the holder). */
    async release(params: { taskId: string; userId: string }): Promise<void> {
      await db
        .deleteFrom("automation_task_locks")
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.userId)
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
      expiresAt: string;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          holder_user_id: sql.ref("steal_requester_user_id"),
          holder_platform: sql.ref("steal_requester_platform"),
          holder_surface: sql.ref("steal_requester_surface"),
          holder_conversation_id: sql.ref("steal_requester_conversation_id"),
          steal_requester_user_id: null,
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
        .execute();
    },

    /** Holder-scoped steal rejection / expiry cleanup. */
    async clearSteal(params: { taskId: string; holderUserId: string; now: string }): Promise<void> {
      await db
        .updateTable("automation_task_locks")
        .set({
          steal_requester_user_id: null,
          steal_requester_platform: null,
          steal_requester_surface: null,
          steal_requester_conversation_id: null,
          steal_requested_at: null,
          steal_expires_at: null,
          updated_at: params.now,
        })
        .where("task_id", "=", params.taskId)
        .where("holder_user_id", "=", params.holderUserId)
        .execute();
    },

    async getByTaskId(taskId: string): Promise<AutomationTaskLockRow | undefined> {
      return db.selectFrom("automation_task_locks").selectAll().where("task_id", "=", taskId).executeTakeFirst();
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

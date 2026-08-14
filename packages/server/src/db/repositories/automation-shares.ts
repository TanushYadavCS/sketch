/**
 * Repository for per-person automation grants — `automation_task_shares` rows.
 *
 * Access to an automation is owner OR explicit grant; grants are per
 * (task_id, user_id) and never touch scheduled_tasks rows, so grant writes can
 * never bump the task revision that webhook deliveries fence on.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export type AutomationShareRow = {
  id: string;
  task_id: string;
  user_id: string;
  granted_by_user_id: string;
  granted_at: string;
};

export function createAutomationSharesRepository(db: Kysely<DB>) {
  return {
    /** Idempotent grant — a duplicate (task_id, user_id) is a no-op. */
    async grant(params: { taskId: string; userId: string; grantedByUserId: string }): Promise<void> {
      await db
        .insertInto("automation_task_shares")
        .values({
          id: randomUUID(),
          task_id: params.taskId,
          user_id: params.userId,
          granted_by_user_id: params.grantedByUserId,
        })
        .onConflict((oc) => oc.columns(["task_id", "user_id"]).doNothing())
        .execute();
    },

    /** Removes one grant; returns whether a row was actually deleted. */
    async revoke(params: { taskId: string; userId: string }): Promise<boolean> {
      const result = await db
        .deleteFrom("automation_task_shares")
        .where("task_id", "=", params.taskId)
        .where("user_id", "=", params.userId)
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },

    async listByUserId(userId: string): Promise<AutomationShareRow[]> {
      return db
        .selectFrom("automation_task_shares")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("granted_at", "desc")
        .execute();
    },

    /** Task ids shared with a user, for grant-aware list queries. */
    async listTaskIdsForUser(userId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("automation_task_shares")
        .select("task_id")
        .where("user_id", "=", userId)
        .execute();
      return rows.map((row) => row.task_id);
    },

    /** Single-row existence check for in-transaction access re-checks. */
    async hasGrant(taskId: string, userId: string): Promise<boolean> {
      const row = await db
        .selectFrom("automation_task_shares")
        .select("user_id")
        .where("task_id", "=", taskId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row !== undefined;
    },

    /** Removes every grant for a task (deleteAutomation's transaction). */
    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("automation_task_shares").where("task_id", "=", taskId).execute();
    },
  };
}

/**
 * Repository for the automation_step_content table.
 *
 * Stores prompts and scripts separately from the workflow step structure.
 * Keyed by (task_id, step_id). Supports upsert for idempotent writes.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../schema";

export type StepContentRow = {
  task_id: string;
  step_id: string;
  content_type: string;
  content: string;
  apps: string | null;
  updated_at: string;
};

export function createAutomationStepContentRepository(db: Kysely<DB>) {
  return {
    async upsert(data: {
      taskId: string;
      stepId: string;
      contentType: "prompt" | "script";
      content: string;
      apps?: string[] | null;
    }): Promise<void> {
      const appsJson = data.apps ? JSON.stringify(data.apps) : null;

      // SQLite upsert via INSERT OR REPLACE
      await db
        .insertInto("automation_step_content")
        .values({
          task_id: data.taskId,
          step_id: data.stepId,
          content_type: data.contentType,
          content: data.content,
          apps: appsJson,
          updated_at: sql`CURRENT_TIMESTAMP`,
        })
        .onConflict((oc) =>
          oc.columns(["task_id", "step_id"]).doUpdateSet({
            content_type: data.contentType,
            content: data.content,
            apps: appsJson,
            updated_at: sql`CURRENT_TIMESTAMP`,
          }),
        )
        .execute();
    },

    async getByTask(taskId: string): Promise<StepContentRow[]> {
      return db.selectFrom("automation_step_content").selectAll().where("task_id", "=", taskId).execute();
    },

    async getByStep(taskId: string, stepId: string): Promise<StepContentRow | undefined> {
      return db
        .selectFrom("automation_step_content")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("step_id", "=", stepId)
        .executeTakeFirst();
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("automation_step_content").where("task_id", "=", taskId).execute();
    },

    async deleteOrphanedSteps(taskId: string, keepStepIds: string[]): Promise<void> {
      if (keepStepIds.length === 0) {
        await db.deleteFrom("automation_step_content").where("task_id", "=", taskId).execute();
        return;
      }
      await db
        .deleteFrom("automation_step_content")
        .where("task_id", "=", taskId)
        .where("step_id", "not in", keepStepIds)
        .execute();
    },
  };
}

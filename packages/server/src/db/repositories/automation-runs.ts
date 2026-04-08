/**
 * Repository for the automation_runs table.
 *
 * Tracks per-execution results for all automations (simple and multi-step).
 * Step outputs are stored as JSON, updated incrementally after each step.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { StepOutput } from "../../workflows/types";
import type { DB } from "../schema";

export type AutomationRunRow = {
  id: string;
  task_id: string;
  trigger_data: string | null;
  status: string;
  step_outputs: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

export function createAutomationRunsRepository(db: Kysely<DB>) {
  return {
    async create(data: { taskId: string; triggerData?: unknown }): Promise<string> {
      const id = randomUUID();
      await db
        .insertInto("automation_runs")
        .values({
          id,
          task_id: data.taskId,
          trigger_data: data.triggerData ? JSON.stringify(data.triggerData) : null,
          status: "running",
          step_outputs: "{}",
        })
        .execute();
      return id;
    },

    async update(
      runId: string,
      fields: {
        status?: string;
        stepOutputs?: Record<string, StepOutput>;
        completedAt?: string;
        errorMessage?: string;
      },
    ): Promise<void> {
      const updates: Record<string, string | null> = {};
      if (fields.status !== undefined) updates.status = fields.status;
      if (fields.stepOutputs !== undefined) updates.step_outputs = JSON.stringify(fields.stepOutputs);
      if (fields.completedAt !== undefined) updates.completed_at = fields.completedAt;
      if (fields.errorMessage !== undefined) updates.error_message = fields.errorMessage;

      if (Object.keys(updates).length > 0) {
        await db.updateTable("automation_runs").set(updates).where("id", "=", runId).execute();
      }
    },

    async getById(runId: string): Promise<AutomationRunRow | undefined> {
      return db.selectFrom("automation_runs").selectAll().where("id", "=", runId).executeTakeFirst();
    },

    async getLatest(taskId: string): Promise<AutomationRunRow | undefined> {
      return db
        .selectFrom("automation_runs")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst();
    },

    async list(taskId: string, limit = 20): Promise<AutomationRunRow[]> {
      return db
        .selectFrom("automation_runs")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("started_at", "desc")
        .limit(limit)
        .execute();
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("automation_runs").where("task_id", "=", taskId).execute();
    },
  };
}

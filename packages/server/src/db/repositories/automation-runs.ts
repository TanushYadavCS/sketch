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
    async create(data: { id?: string; taskId: string; triggerData?: unknown }): Promise<string> {
      const id = data.id ?? randomUUID();
      await db
        .insertInto("automation_runs")
        .values({
          id,
          task_id: data.taskId,
          trigger_data: data.triggerData === undefined ? null : JSON.stringify(data.triggerData),
          status: "running",
          step_outputs: "{}",
          started_at: new Date().toISOString(),
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

    async getRunSummaries(taskIds: string[]): Promise<Map<string, { runCount: number; lastRunStatus: string | null }>> {
      const result = new Map<string, { runCount: number; lastRunStatus: string | null }>();
      if (taskIds.length === 0) return result;

      const counts = await db
        .selectFrom("automation_runs")
        .select(({ fn }) => ["task_id", fn.count("id").as("run_count")])
        .where("task_id", "in", taskIds)
        .groupBy("task_id")
        .execute();

      for (const row of counts) {
        result.set(row.task_id, { runCount: Number(row.run_count), lastRunStatus: null });
      }

      const latest = await db
        .selectFrom("automation_runs as r1")
        .select(["r1.task_id", "r1.status"])
        .where("r1.task_id", "in", taskIds)
        .where("r1.started_at", "=", (eb) =>
          eb
            .selectFrom("automation_runs as r2")
            .select((ebi) => ebi.fn.max("r2.started_at").as("max_started"))
            .whereRef("r2.task_id", "=", "r1.task_id"),
        )
        .execute();

      for (const row of latest) {
        const entry = result.get(row.task_id);
        if (entry) entry.lastRunStatus = row.status;
      }

      return result;
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.deleteFrom("automation_runs").where("task_id", "=", taskId).execute();
    },

    /**
     * Marks all runs currently in "running" status as failed with a restart
     * reason. Called at startup to clean up runs that were in-flight when the
     * previous process exited. Workflows can't be safely resumed mid-run
     * because steps have side effects (Slack posts, sheet reads, agent calls)
     * that aren't idempotent — the user can re-trigger or wait for the next
     * schedule if they want the work to happen again.
     */
    async markRunningAsFailed(reason: string): Promise<number> {
      const result = await db
        .updateTable("automation_runs")
        .set({
          status: "failed",
          error_message: reason,
          completed_at: new Date().toISOString(),
        })
        .where("status", "=", "running")
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
  };
}

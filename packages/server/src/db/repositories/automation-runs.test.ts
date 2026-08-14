/**
 * Tests for the automation_runs repository. Focused on crash-recovery semantics
 * (markRunningAsFailed) because that's the bit with user-visible correctness
 * impact — the rest of the CRUD is exercised via scheduler/workflow tests.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createAutomationRunsRepository } from "./automation-runs";
import { createScheduledTaskRepository } from "./scheduled-tasks";

let db: Kysely<DB>;
let runs: ReturnType<typeof createAutomationRunsRepository>;
let tasks: ReturnType<typeof createScheduledTaskRepository>;

beforeEach(async () => {
  db = await createTestDb();
  runs = createAutomationRunsRepository(db);
  tasks = createScheduledTaskRepository(db);
  await tasks.add({
    id: "task-1",
    platform: "slack",
    context_type: "dm",
    delivery_target: "U123",
    thread_ts: null,
    prompt: "do something",
    schedule_type: "interval",
    schedule_value: "3600",
    timezone: "UTC",
    session_mode: "fresh",
    created_by: "U123",
    status: "active",
    next_run_at: null,
  });
});

afterEach(async () => {
  await db.destroy();
});

describe("create", () => {
  it("records the optional triggered_by_user_id on the run", async () => {
    const id = await runs.create({ taskId: "task-1", triggeredByUserId: "user-123" });
    const run = await runs.getById(id);
    expect(run?.triggered_by_user_id).toBe("user-123");

    const unattributed = await runs.create({ taskId: "task-1" });
    const run2 = await runs.getById(unattributed);
    expect(run2?.triggered_by_user_id).toBeNull();
  });

  it("accepts an explicit null trigger attribution", async () => {
    const id = await runs.create({ taskId: "task-1", triggeredByUserId: null });
    const run = await runs.getById(id);
    expect(run?.triggered_by_user_id).toBeNull();
  });
});

describe("markRunningAsFailed", () => {
  it("stores started_at as ISO UTC when creating a run", async () => {
    const id = await runs.create({ taskId: "task-1" });

    const run = await runs.getById(id);

    expect(run?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run?.started_at).toMatch(/Z$/);
  });

  it("marks all running runs as failed and returns the count", async () => {
    const r1 = await runs.create({ taskId: "task-1" });
    const r2 = await runs.create({ taskId: "task-1" });

    const count = await runs.markRunningAsFailed("Interrupted by server restart");

    expect(count).toBe(2);
    const run1 = await runs.getById(r1);
    const run2 = await runs.getById(r2);
    expect(run1?.status).toBe("failed");
    expect(run1?.error_message).toBe("Interrupted by server restart");
    expect(run1?.completed_at).not.toBeNull();
    expect(run2?.status).toBe("failed");
  });

  it("does not touch runs that already completed or failed", async () => {
    const completedId = await runs.create({ taskId: "task-1" });
    await runs.update(completedId, { status: "completed", completedAt: "2026-04-13T08:00:00.000Z" });
    const failedId = await runs.create({ taskId: "task-1" });
    await runs.update(failedId, {
      status: "failed",
      errorMessage: "original failure",
      completedAt: "2026-04-13T08:01:00.000Z",
    });
    const runningId = await runs.create({ taskId: "task-1" });

    const count = await runs.markRunningAsFailed("Interrupted by server restart");

    expect(count).toBe(1);
    const completed = await runs.getById(completedId);
    const failed = await runs.getById(failedId);
    const running = await runs.getById(runningId);
    expect(completed?.status).toBe("completed");
    expect(failed?.status).toBe("failed");
    expect(failed?.error_message).toBe("original failure");
    expect(running?.status).toBe("failed");
    expect(running?.error_message).toBe("Interrupted by server restart");
  });

  it("returns 0 and is a no-op when no runs are in running status", async () => {
    const count = await runs.markRunningAsFailed("Interrupted by server restart");
    expect(count).toBe(0);
  });
});

describe("getRunSummaries", () => {
  async function seedRun(
    taskId: string,
    startedAt: string,
    status: "running" | "completed" | "failed",
  ): Promise<string> {
    const id = await runs.create({ taskId });
    await db.updateTable("automation_runs").set({ started_at: startedAt, status }).where("id", "=", id).execute();
    return id;
  }

  beforeEach(async () => {
    await tasks.add({
      id: "task-2",
      platform: "slack",
      context_type: "dm",
      delivery_target: "U456",
      thread_ts: null,
      prompt: "do another thing",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: "U456",
      status: "active",
      next_run_at: null,
    });
  });

  it("returns an empty map for an empty taskIds list (does not execute SQL)", async () => {
    const result = await runs.getRunSummaries([]);
    expect(result.size).toBe(0);
  });

  it("returns correct counts and last run status per task", async () => {
    await seedRun("task-1", "2026-04-10T10:00:00.000Z", "completed");
    await seedRun("task-1", "2026-04-10T11:00:00.000Z", "failed");
    await seedRun("task-1", "2026-04-10T12:00:00.000Z", "completed");
    await seedRun("task-2", "2026-04-10T10:30:00.000Z", "running");

    const result = await runs.getRunSummaries(["task-1", "task-2"]);

    expect(result.get("task-1")).toEqual({ runCount: 3, lastRunStatus: "completed" });
    expect(result.get("task-2")).toEqual({ runCount: 1, lastRunStatus: "running" });
  });

  it("omits tasks with no runs from the returned map", async () => {
    await seedRun("task-1", "2026-04-10T10:00:00.000Z", "completed");

    const result = await runs.getRunSummaries(["task-1", "task-2"]);

    expect(result.get("task-1")?.runCount).toBe(1);
    expect(result.has("task-2")).toBe(false);
  });

  it("picks the most recent run by started_at, regardless of insert order", async () => {
    await seedRun("task-1", "2026-04-10T12:00:00.000Z", "failed");
    await seedRun("task-1", "2026-04-10T10:00:00.000Z", "completed");
    await seedRun("task-1", "2026-04-10T11:00:00.000Z", "running");

    const result = await runs.getRunSummaries(["task-1"]);

    expect(result.get("task-1")).toEqual({ runCount: 3, lastRunStatus: "failed" });
  });
});

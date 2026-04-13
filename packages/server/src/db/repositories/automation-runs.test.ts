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

describe("markRunningAsFailed", () => {
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

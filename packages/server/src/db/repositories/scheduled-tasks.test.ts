/**
 * Tests for the scheduled_tasks repository.
 *
 * Uses an in-memory SQLite database with all migrations applied via createTestDb(),
 * which includes the 013-scheduled-tasks migration. Each test runs against a fresh
 * database to ensure isolation.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskRepository } from "./scheduled-tasks";

let db: Kysely<DB>;
let repo: ReturnType<typeof createScheduledTaskRepository>;

beforeEach(async () => {
  db = await createTestDb();
  repo = createScheduledTaskRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

const baseTask = {
  platform: "slack" as const,
  context_type: "dm" as const,
  delivery_target: "U123456",
  thread_ts: null,
  prompt: "Check the weekly report",
  schedule_type: "cron" as const,
  schedule_value: "0 9 * * 1",
  timezone: "America/New_York",
  session_mode: "fresh" as const,
  created_by: "U_CREATOR",
  status: "active" as const,
  next_run_at: null,
};

describe("add()", () => {
  it("creates a task and returns it with all fields", async () => {
    const task = await repo.add(baseTask);

    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.platform).toBe("slack");
    expect(task.context_type).toBe("dm");
    expect(task.delivery_target).toBe("U123456");
    expect(task.thread_ts).toBeNull();
    expect(task.prompt).toBe("Check the weekly report");
    expect(task.schedule_type).toBe("cron");
    expect(task.schedule_value).toBe("0 9 * * 1");
    expect(task.timezone).toBe("America/New_York");
    expect(task.session_mode).toBe("fresh");
    expect(task.status).toBe("active");
    expect(task.created_by).toBe("U_CREATOR");
    expect(task.created_at).toBeDefined();
    expect(task.last_run_at).toBeNull();
    expect(task.next_run_at).toBeNull();
  });

  it("uses a caller-supplied id when provided", async () => {
    const task = await repo.add({ ...baseTask, id: "fixed-id-001" });
    expect(task.id).toBe("fixed-id-001");
  });

  it("applies default status of active when not specified", async () => {
    const { status: _omit, ...withoutStatus } = baseTask;
    const task = await repo.add(withoutStatus);
    expect(task.status).toBe("active");
  });

  it("applies default timezone of UTC when not specified", async () => {
    const { timezone: _omit, ...withoutTimezone } = baseTask;
    const task = await repo.add(withoutTimezone);
    expect(task.timezone).toBe("UTC");
  });

  it("applies default session_mode of fresh when not specified", async () => {
    const { session_mode: _omit, ...withoutMode } = baseTask;
    const task = await repo.add(withoutMode);
    expect(task.session_mode).toBe("fresh");
  });
});

describe("getById()", () => {
  it("returns the task when the id exists", async () => {
    const created = await repo.add(baseTask);
    const found = await repo.getById(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.prompt).toBe("Check the weekly report");
  });

  it("returns undefined for an unknown id", async () => {
    const found = await repo.getById("nonexistent-id");
    expect(found).toBeUndefined();
  });
});

describe("listAll()", () => {
  it("returns tasks ordered newest-first", async () => {
    await repo.add({ ...baseTask, id: "task-1", created_by: "U_ONE", prompt: "Earlier task" });
    await repo.add({ ...baseTask, id: "task-2", created_by: "U_TWO", prompt: "Later task" });

    await db
      .updateTable("scheduled_tasks")
      .set({ created_at: "2026-03-13T10:00:00.000Z" })
      .where("id", "=", "task-1")
      .execute();
    await db
      .updateTable("scheduled_tasks")
      .set({ created_at: "2026-03-14T10:00:00.000Z" })
      .where("id", "=", "task-2")
      .execute();

    const results = await repo.listAll();
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("task-2");
    expect(results[1].id).toBe("task-1");
  });
});

describe("listByDeliveryTarget()", () => {
  it("returns only tasks matching the delivery target", async () => {
    await repo.add({ ...baseTask, delivery_target: "U_ALPHA", prompt: "Task A" });
    await repo.add({ ...baseTask, delivery_target: "U_BETA", prompt: "Task B" });
    await repo.add({ ...baseTask, delivery_target: "U_ALPHA", prompt: "Task C" });

    const results = await repo.listByDeliveryTarget("U_ALPHA");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.delivery_target === "U_ALPHA")).toBe(true);
  });

  it("returns an empty array when no tasks match", async () => {
    const results = await repo.listByDeliveryTarget("no-match");
    expect(results).toEqual([]);
  });
});

describe("listByCreatedBy()", () => {
  it("returns only tasks created by the given user", async () => {
    await repo.add({ ...baseTask, created_by: "U_OWNER", prompt: "Mine 1" });
    await repo.add({ ...baseTask, created_by: "U_OTHER", prompt: "Not mine" });
    await repo.add({ ...baseTask, created_by: "U_OWNER", prompt: "Mine 2" });

    const results = await repo.listByCreatedBy("U_OWNER");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.created_by === "U_OWNER")).toBe(true);
  });

  it("returns an empty array when no tasks match", async () => {
    const results = await repo.listByCreatedBy("no-match");
    expect(results).toEqual([]);
  });
});

describe("listActive()", () => {
  it("returns only active tasks", async () => {
    await repo.add({ ...baseTask, status: "active", prompt: "Active 1" });
    const paused = await repo.add({ ...baseTask, status: "paused", prompt: "Paused" });
    await repo.add({ ...baseTask, status: "active", prompt: "Active 2" });

    const results = await repo.listActive();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "active")).toBe(true);
    expect(results.find((r) => r.id === paused.id)).toBeUndefined();
  });

  it("returns an empty array when no active tasks exist", async () => {
    await repo.add({ ...baseTask, status: "paused" });
    const results = await repo.listActive();
    expect(results).toEqual([]);
  });

  it("excludes completed tasks", async () => {
    await repo.add({ ...baseTask, status: "active", prompt: "Still running" });
    const completed = await repo.add({ ...baseTask, status: "active", prompt: "One-shot" });
    await repo.updateStatus(completed.id, "completed");

    const results = await repo.listActive();
    expect(results).toHaveLength(1);
    expect(results[0].prompt).toBe("Still running");
    expect(results.find((r) => r.id === completed.id)).toBeUndefined();
  });
});

describe("update()", () => {
  it("modifies specified fields and returns the updated row", async () => {
    const created = await repo.add(baseTask);
    const updated = await repo.update(created.id, {
      prompt: "Updated prompt",
      schedule_value: "0 10 * * 2",
    });

    expect(updated).toBeDefined();
    expect(updated?.prompt).toBe("Updated prompt");
    expect(updated?.schedule_value).toBe("0 10 * * 2");
    expect(updated?.timezone).toBe("America/New_York");
  });

  it("leaves unspecified fields unchanged", async () => {
    const created = await repo.add(baseTask);
    await repo.update(created.id, { prompt: "Changed" });
    const fetched = await repo.getById(created.id);
    expect(fetched?.schedule_value).toBe("0 9 * * 1");
    expect(fetched?.timezone).toBe("America/New_York");
  });

  it("returns undefined for an unknown id", async () => {
    const result = await repo.update("nonexistent-id", { prompt: "anything" });
    expect(result).toBeUndefined();
  });

  it("sets next_run_at to null explicitly", async () => {
    const created = await repo.add({ ...baseTask, next_run_at: "2025-01-01T09:00:00.000Z" });
    const updated = await repo.update(created.id, { next_run_at: null });
    expect(updated?.next_run_at).toBeNull();
  });

  it("increments revision only when requested", async () => {
    const created = await repo.add(baseTask);
    await repo.update(created.id, { next_run_at: null });
    const unchanged = await repo.getById(created.id);
    expect(unchanged?.revision).toBe(0);

    const updated = await repo.update(created.id, { prompt: "Changed" }, { incrementRevision: true });
    expect(updated?.revision).toBe(1);
  });
});

describe("updateRunTimestamps()", () => {
  it("updates last_run_at and next_run_at", async () => {
    const created = await repo.add(baseTask);
    await repo.updateRunTimestamps(created.id, "2025-01-06T09:00:00.000Z", "2025-01-13T09:00:00.000Z");

    const fetched = await repo.getById(created.id);
    expect(fetched?.last_run_at).toBe("2025-01-06T09:00:00.000Z");
    expect(fetched?.next_run_at).toBe("2025-01-13T09:00:00.000Z");
  });

  it("sets next_run_at to null when task ends", async () => {
    const created = await repo.add({ ...baseTask, next_run_at: "2025-01-06T09:00:00.000Z" });
    await repo.updateRunTimestamps(created.id, "2025-01-06T09:00:00.000Z", null);

    const fetched = await repo.getById(created.id);
    expect(fetched?.next_run_at).toBeNull();
  });
});

describe("updateStatus()", () => {
  it("sets status to paused", async () => {
    const created = await repo.add({ ...baseTask, status: "active" });
    await repo.updateStatus(created.id, "paused");

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe("paused");
  });

  it("sets status back to active", async () => {
    const created = await repo.add({ ...baseTask, status: "paused" });
    await repo.updateStatus(created.id, "active");

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe("active");
  });

  it("sets status to completed", async () => {
    const created = await repo.add({ ...baseTask, status: "active" });
    await repo.updateStatus(created.id, "completed");

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe("completed");
  });

  it("increments revision when requested", async () => {
    const created = await repo.add({ ...baseTask, status: "active" });
    await repo.updateStatus(created.id, "paused", { incrementRevision: true });

    const fetched = await repo.getById(created.id);
    expect(fetched?.revision).toBe(1);
  });
});

describe("remove()", () => {
  it("deletes the task and returns true", async () => {
    const created = await repo.add(baseTask);
    const result = await repo.remove(created.id);
    expect(result).toBe(true);

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeUndefined();
  });

  it("returns false when the id does not exist", async () => {
    const result = await repo.remove("nonexistent-id");
    expect(result).toBe(false);
  });
});

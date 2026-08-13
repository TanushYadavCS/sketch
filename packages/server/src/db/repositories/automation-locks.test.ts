/**
 * Unit tests for the automation_task_locks repository: guarded CAS updates,
 * read-back behavior, expiry sweep, and task-scoped cleanup.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { type LockHolderFields, createAutomationLocksRepository } from "./automation-locks";

let db: Kysely<DB>;
let locks: ReturnType<typeof createAutomationLocksRepository>;

const HOLDER_A: LockHolderFields = { userId: "user-a", platform: "web", surface: "builder", conversationId: null };
const HOLDER_B: LockHolderFields = { userId: "user-b", platform: "slack", surface: "dm", conversationId: "C1" };

async function addUser(id: string): Promise<void> {
  await db.insertInto("users").values({ id, name: id }).execute();
}

beforeEach(async () => {
  db = await createTestDb();
  locks = createAutomationLocksRepository(db);
  await addUser("user-a");
  await addUser("user-b");
});

afterEach(async () => {
  await db.destroy();
});

describe("insertIfAbsent", () => {
  it("inserts a fresh lock row with the holder and TTL", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      task_id: "task-1",
      holder_user_id: "user-a",
      holder_platform: "web",
      holder_surface: "builder",
      holder_conversation_id: null,
      acquired_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
      expires_at: "2026-08-01T10:15:00.000Z",
    });
  });

  it("is a no-op when the task already has a lock row", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.insertIfAbsent(HOLDER_B, {
      taskId: "task-1",
      expiresAt: "2026-08-01T12:00:00.000Z",
      now: "2026-08-01T11:00:00.000Z",
    });

    const rows = await db.selectFrom("automation_task_locks").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holder_user_id: "user-a", expires_at: "2026-08-01T10:15:00.000Z" });
  });
});

describe("takeoverExpired", () => {
  it("re-arms an expired lock with the new holder and clears any pending steal", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T09:59:00.000Z",
      now: "2026-08-01T09:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T09:30:00.000Z",
      stealExpiresAt: "2026-08-01T09:35:00.000Z",
    });

    await locks.takeoverExpired(HOLDER_B, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-b",
      holder_platform: "slack",
      holder_surface: "dm",
      holder_conversation_id: "C1",
      expires_at: "2026-08-01T10:15:00.000Z",
      steal_requester_user_id: null,
      steal_requested_at: null,
      steal_expires_at: null,
    });
  });

  it("leaves an unexpired lock untouched", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.takeoverExpired(HOLDER_B, {
      taskId: "task-1",
      expiresAt: "2026-08-01T11:15:00.000Z",
      now: "2026-08-01T10:05:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-a",
      expires_at: "2026-08-01T10:15:00.000Z",
    });
  });
});

describe("renew and release", () => {
  it("renews only when the caller is the holder", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.renew({
      taskId: "task-1",
      userId: "user-b",
      expiresAt: "2026-08-01T11:00:00.000Z",
      now: "2026-08-01T10:45:00.000Z",
    });
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-a",
      expires_at: "2026-08-01T10:15:00.000Z",
    });

    await locks.renew({
      taskId: "task-1",
      userId: "user-a",
      expiresAt: "2026-08-01T11:00:00.000Z",
      now: "2026-08-01T10:45:00.000Z",
    });
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      expires_at: "2026-08-01T11:00:00.000Z",
      updated_at: "2026-08-01T10:45:00.000Z",
    });
  });

  it("releases only the caller's hold and is idempotent", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.release({ taskId: "task-1", userId: "user-b" });
    await expect(locks.getByTaskId("task-1")).resolves.toBeDefined();

    await locks.release({ taskId: "task-1", userId: "user-a" });
    await expect(locks.getByTaskId("task-1")).resolves.toBeUndefined();

    await locks.release({ taskId: "task-1", userId: "user-a" });
    await expect(locks.getByTaskId("task-1")).resolves.toBeUndefined();
  });
});

describe("requestSteal", () => {
  it("records the steal only when holder differs, lock is unexpired, and no steal is pending", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      steal_requester_user_id: "user-b",
      steal_requester_platform: "slack",
      steal_requested_at: "2026-08-01T10:05:00.000Z",
      steal_expires_at: "2026-08-01T10:10:00.000Z",
    });

    // Second steal request (any requester) is blocked while one is pending.
    await locks.requestSteal(
      { ...HOLDER_B, userId: "user-b" },
      { taskId: "task-1", stealRequestedAt: "2026-08-01T10:06:00.000Z", stealExpiresAt: "2026-08-01T10:11:00.000Z" },
    );
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      steal_requester_user_id: "user-b",
      steal_requested_at: "2026-08-01T10:05:00.000Z",
    });
  });

  it("does not match when the requester is the holder", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.requestSteal(HOLDER_A, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({ steal_requester_user_id: null });
  });

  it("does not match an expired lock", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T09:59:00.000Z",
      now: "2026-08-01T09:00:00.000Z",
    });

    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({ steal_requester_user_id: null });
  });
});

describe("approveSteal and clearSteal", () => {
  it("promotes the pending requester to holder, clears the steal, and re-arms the TTL", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await locks.approveSteal({
      taskId: "task-1",
      approverUserId: "user-a",
      expiresAt: "2026-08-01T10:30:00.000Z",
      now: "2026-08-01T10:15:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-b",
      holder_platform: "slack",
      holder_surface: "dm",
      holder_conversation_id: "C1",
      expires_at: "2026-08-01T10:30:00.000Z",
      updated_at: "2026-08-01T10:15:00.000Z",
      steal_requester_user_id: null,
      steal_requester_platform: null,
      steal_requester_surface: null,
      steal_requester_conversation_id: null,
      steal_requested_at: null,
      steal_expires_at: null,
    });
  });

  it("only lets the current holder approve", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await locks.approveSteal({
      taskId: "task-1",
      approverUserId: "user-b",
      expiresAt: "2026-08-01T10:30:00.000Z",
      now: "2026-08-01T10:15:00.000Z",
    });

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-a",
      steal_requester_user_id: "user-b",
    });
  });

  it("clears a pending steal holder-scoped", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await locks.clearSteal({ taskId: "task-1", holderUserId: "user-b", now: "2026-08-01T10:06:00.000Z" });
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({ steal_requester_user_id: "user-b" });

    await locks.clearSteal({ taskId: "task-1", holderUserId: "user-a", now: "2026-08-01T10:06:00.000Z" });
    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      steal_requester_user_id: null,
      steal_requested_at: null,
      steal_expires_at: null,
      updated_at: "2026-08-01T10:06:00.000Z",
    });
  });
});

describe("sweepExpired and deleteByTaskId", () => {
  it("deletes expired lock rows and clears expired steals", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-expired",
      expiresAt: "2026-08-01T09:59:00.000Z",
      now: "2026-08-01T09:00:00.000Z",
    });
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-live",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-live",
      stealRequestedAt: "2026-08-01T10:01:00.000Z",
      stealExpiresAt: "2026-08-01T10:06:00.000Z",
    });

    const result = await locks.sweepExpired("2026-08-01T10:07:00.000Z");

    expect(result).toEqual({ deletedLocks: 1, clearedSteals: 1 });
    await expect(locks.getByTaskId("task-expired")).resolves.toBeUndefined();
    await expect(locks.getByTaskId("task-live")).resolves.toMatchObject({
      holder_user_id: "user-a",
      steal_requester_user_id: null,
      steal_expires_at: null,
    });
  });

  it("leaves live locks and unexpired steals alone", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "task-1",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });

    await locks.sweepExpired("2026-08-01T10:05:00.000Z");

    await expect(locks.getByTaskId("task-1")).resolves.toMatchObject({
      holder_user_id: "user-a",
      steal_requester_user_id: "user-b",
    });
  });

  it("removes every lock row for a task", async () => {
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "task-1",
      expiresAt: "2026-08-01T10:15:00.000Z",
      now: "2026-08-01T10:00:00.000Z",
    });

    await locks.deleteByTaskId("task-1");

    await expect(locks.getByTaskId("task-1")).resolves.toBeUndefined();
  });
});

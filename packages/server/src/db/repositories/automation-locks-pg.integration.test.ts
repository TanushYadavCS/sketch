/**
 * Cross-dialect integration coverage for automation_task_locks on Postgres
 * (PGlite): CRUD, the steal compare-and-swap chain, expiry takeover and sweep,
 * and the holder-user FK cascade. Mirrors the SQLite repository unit tests so
 * the guarded-CAS semantics are verified against both dialects.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { type LockHolderFields, createAutomationLocksRepository } from "./automation-locks";

const HOLDER_A: LockHolderFields = {
  userId: "pg-lock-user-a",
  platform: "web",
  surface: "builder",
  conversationId: null,
};
const HOLDER_B: LockHolderFields = { userId: "pg-lock-user-b", platform: "slack", surface: "dm", conversationId: "C1" };

describe("automation_task_locks repository on shared Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    for (const id of ["pg-lock-user-a", "pg-lock-user-b", "pg-lock-user-c"]) {
      await db.insertInto("users").values({ id, name: id }).execute();
    }
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("inserts, reads back, renews, and releases lock rows", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "pg-task-1",
      now: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:15:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toMatchObject({
      task_id: "pg-task-1",
      holder_user_id: "pg-lock-user-a",
      holder_platform: "web",
      holder_surface: "builder",
      expires_at: "2026-08-01T10:15:00.000Z",
      steal_requester_user_id: null,
    });

    // A concurrent insert loses to the existing row (ON CONFLICT DO NOTHING).
    await locks.insertIfAbsent(HOLDER_B, {
      taskId: "pg-task-1",
      now: "2026-08-01T11:00:00.000Z",
      expiresAt: "2026-08-01T11:15:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-a",
      expires_at: "2026-08-01T10:15:00.000Z",
    });

    // Non-holder renewal is a no-op; holder renewal advances the TTL.
    await locks.renew({
      taskId: "pg-task-1",
      userId: "pg-lock-user-b",
      expiresAt: "2026-08-01T11:30:00.000Z",
      now: "2026-08-01T11:00:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-a",
      expires_at: "2026-08-01T10:15:00.000Z",
    });
    await locks.renew({
      taskId: "pg-task-1",
      userId: "pg-lock-user-a",
      expiresAt: "2026-08-01T11:30:00.000Z",
      now: "2026-08-01T11:00:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toMatchObject({ expires_at: "2026-08-01T11:30:00.000Z" });

    // Non-holder release is a no-op; holder release clears the row; repeat is idempotent.
    await locks.release({ taskId: "pg-task-1", userId: "pg-lock-user-b" });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toBeDefined();
    await locks.release({ taskId: "pg-task-1", userId: "pg-lock-user-a" });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toBeUndefined();
    await locks.release({ taskId: "pg-task-1", userId: "pg-lock-user-a" });
    await expect(locks.getByTaskId("pg-task-1")).resolves.toBeUndefined();
  });

  it("guards an exact lease touch and rejects its stale generation after takeover", async () => {
    const locks = createAutomationLocksRepository(db);
    const holder = { ...HOLDER_A, sessionId: "pg-tab-a" };
    await locks.insertIfAbsent(holder, {
      taskId: "pg-task-guarded",
      now: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:01:00.000Z",
    });

    await expect(
      locks.touchIfExactHolder({
        taskId: "pg-task-guarded",
        userId: HOLDER_A.userId,
        sessionId: "pg-tab-a",
        generation: 1,
        now: "2026-08-01T10:00:30.000Z",
      }),
    ).resolves.toMatchObject({
      holder_user_id: HOLDER_A.userId,
      holder_session_id: "pg-tab-a",
      generation: 1,
      updated_at: "2026-08-01T10:00:30.000Z",
    });

    await locks.takeoverExpired(
      { ...HOLDER_B, sessionId: "pg-tab-b" },
      {
        taskId: "pg-task-guarded",
        now: "2026-08-01T10:02:00.000Z",
        expiresAt: "2026-08-01T10:17:00.000Z",
      },
    );

    await expect(
      locks.touchIfExactHolder({
        taskId: "pg-task-guarded",
        userId: HOLDER_A.userId,
        sessionId: "pg-tab-a",
        generation: 1,
        now: "2026-08-01T10:02:01.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(locks.getByTaskId("pg-task-guarded")).resolves.toMatchObject({
      holder_user_id: HOLDER_B.userId,
      holder_session_id: "pg-tab-b",
      generation: 2,
    });
  });

  it("runs the steal CAS chain and guards every transition", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "pg-task-steal",
      now: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:15:00.000Z",
    });

    // The steal lands only for an unexpired lock held by someone else.
    await locks.requestSteal(HOLDER_B, {
      taskId: "pg-task-steal",
      stealRequestedAt: "2026-08-01T10:05:00.000Z",
      stealExpiresAt: "2026-08-01T10:10:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      steal_requester_user_id: "pg-lock-user-b",
      steal_requested_at: "2026-08-01T10:05:00.000Z",
    });

    // A second requester while one is pending is a CAS miss.
    await locks.requestSteal(
      { ...HOLDER_B, userId: "pg-lock-user-c" },
      {
        taskId: "pg-task-steal",
        stealRequestedAt: "2026-08-01T10:06:00.000Z",
        stealExpiresAt: "2026-08-01T10:11:00.000Z",
      },
    );
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      steal_requester_user_id: "pg-lock-user-b",
      steal_requested_at: "2026-08-01T10:05:00.000Z",
    });

    // Approve promotes the requester and re-arms the TTL.
    await locks.approveSteal({
      taskId: "pg-task-steal",
      approverUserId: "pg-lock-user-a",
      expiresAt: "2026-08-01T10:30:00.000Z",
      now: "2026-08-01T10:15:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-b",
      holder_platform: "slack",
      holder_surface: "dm",
      holder_conversation_id: "C1",
      expires_at: "2026-08-01T10:30:00.000Z",
      steal_requester_user_id: null,
      steal_requested_at: null,
      steal_expires_at: null,
    });

    // A request from the ex-holder lands against the new holder.
    await locks.requestSteal(HOLDER_A, {
      taskId: "pg-task-steal",
      stealRequestedAt: "2026-08-01T10:20:00.000Z",
      stealExpiresAt: "2026-08-01T10:25:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      steal_requester_user_id: "pg-lock-user-a",
    });

    // Holder-scoped clear rejects the steal; a non-holder clear is a no-op.
    await locks.clearSteal({
      taskId: "pg-task-steal",
      holderUserId: "pg-lock-user-a",
      now: "2026-08-01T10:21:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      steal_requester_user_id: "pg-lock-user-a",
    });
    await locks.clearSteal({
      taskId: "pg-task-steal",
      holderUserId: "pg-lock-user-b",
      holderSessionId: "legacy",
      holderGeneration: 2,
      now: "2026-08-01T10:21:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-steal")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-b",
      steal_requester_user_id: null,
      steal_requested_at: null,
      steal_expires_at: null,
    });
  });

  it("re-arms expired locks via takeover and sweeps stale rows with correct counts", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "pg-task-expired",
      now: "2026-08-01T09:00:00.000Z",
      expiresAt: "2026-08-01T09:59:59.000Z",
    });
    await locks.insertIfAbsent(HOLDER_A, {
      taskId: "pg-task-live",
      now: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:15:00.000Z",
    });
    await locks.requestSteal(HOLDER_B, {
      taskId: "pg-task-live",
      stealRequestedAt: "2026-08-01T10:01:00.000Z",
      stealExpiresAt: "2026-08-01T10:06:00.000Z",
    });

    // Expired takeover re-arms holder + TTL; an unexpired lock is untouched.
    await locks.takeoverExpired(HOLDER_B, {
      taskId: "pg-task-expired",
      now: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:15:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-expired")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-b",
      expires_at: "2026-08-01T10:15:00.000Z",
    });
    await locks.takeoverExpired(HOLDER_B, {
      taskId: "pg-task-live",
      now: "2026-08-01T10:05:00.000Z",
      expiresAt: "2026-08-01T10:20:00.000Z",
    });
    await expect(locks.getByTaskId("pg-task-live")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-a",
      expires_at: "2026-08-01T10:15:00.000Z",
    });

    // Sweep clears only the expired pending steal, then the lapsed lock rows.
    await expect(locks.sweepExpired("2026-08-01T10:07:00.000Z")).resolves.toEqual({
      deletedLocks: 0,
      clearedSteals: 1,
    });
    await expect(locks.getByTaskId("pg-task-live")).resolves.toMatchObject({
      holder_user_id: "pg-lock-user-a",
      steal_requester_user_id: null,
    });
    // Both rows lapsed at 10:15, so the next sweep removes them together.
    await expect(locks.sweepExpired("2026-08-01T10:16:00.000Z")).resolves.toEqual({
      deletedLocks: 2,
      clearedSteals: 0,
    });
    await expect(locks.getByTaskId("pg-task-expired")).resolves.toBeUndefined();
    await expect(locks.getByTaskId("pg-task-live")).resolves.toBeUndefined();

    await locks.deleteByTaskId("pg-task-live");
    await expect(locks.getByTaskId("pg-task-live")).resolves.toBeUndefined();
  });

  it("rejects a lock row for an unknown holder user", async () => {
    const locks = createAutomationLocksRepository(db);
    // The FK violation aborts the transaction, so this stands alone.
    await expect(
      locks.insertIfAbsent(
        { ...HOLDER_A, userId: "pg-lock-ghost" },
        { taskId: "pg-task-ghost", now: "2026-08-01T10:00:00.000Z", expiresAt: "2026-08-01T10:15:00.000Z" },
      ),
    ).rejects.toThrow();
  });

  it("cascades lock rows when the holder user is deleted", async () => {
    const locks = createAutomationLocksRepository(db);
    await db.insertInto("users").values({ id: "pg-lock-transient", name: "Transient" }).execute();
    await locks.insertIfAbsent(
      { ...HOLDER_A, userId: "pg-lock-transient" },
      { taskId: "pg-task-cascade", now: "2026-08-01T10:00:00.000Z", expiresAt: "2026-08-01T10:15:00.000Z" },
    );
    await expect(locks.getByTaskId("pg-task-cascade")).resolves.toMatchObject({
      holder_user_id: "pg-lock-transient",
    });

    await db.deleteFrom("users").where("id", "=", "pg-lock-transient").execute();
    await expect(locks.getByTaskId("pg-task-cascade")).resolves.toBeUndefined();
  });
});

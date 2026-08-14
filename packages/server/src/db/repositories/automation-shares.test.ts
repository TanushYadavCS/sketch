/**
 * Tests for the automation_task_shares repository: idempotent grants, revoke,
 * list-by-user, existence checks, and task-scoped cleanup.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createAutomationSharesRepository } from "./automation-shares";
import { createScheduledTaskRepository } from "./scheduled-tasks";

let db: Kysely<DB>;
let shares: ReturnType<typeof createAutomationSharesRepository>;

async function addUser(id: string): Promise<void> {
  await db.insertInto("users").values({ id, name: id }).execute();
}

async function addTask(id: string, ownerId: string): Promise<void> {
  await createScheduledTaskRepository(db).add({
    id,
    platform: "slack",
    context_type: "dm",
    delivery_target: "U123",
    thread_ts: null,
    prompt: "do something",
    schedule_type: "interval",
    schedule_value: "3600",
    timezone: "UTC",
    session_mode: "fresh",
    created_by: ownerId,
    status: "active",
    next_run_at: null,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  shares = createAutomationSharesRepository(db);
  await addUser("owner-1");
  await addUser("grantee-1");
  await addUser("grantee-2");
  await addTask("task-1", "owner-1");
  await addTask("task-2", "owner-1");
});

afterEach(async () => {
  await db.destroy();
});

describe("grant", () => {
  it("is idempotent for the same (task_id, user_id) pair", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });

    const rows = await db.selectFrom("automation_task_shares").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: "task-1",
      user_id: "grantee-1",
      granted_by_user_id: "owner-1",
    });
    expect(rows[0]?.granted_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("allows the same user to be granted on different tasks", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-2", userId: "grantee-1", grantedByUserId: "owner-1" });

    await expect(shares.listTaskIdsForUser("grantee-1")).resolves.toEqual(expect.arrayContaining(["task-1", "task-2"]));
  });
});

describe("revoke", () => {
  it("removes the grant and reports whether a row existed", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });

    await expect(shares.revoke({ taskId: "task-1", userId: "grantee-1" })).resolves.toBe(true);
    await expect(shares.revoke({ taskId: "task-1", userId: "grantee-1" })).resolves.toBe(false);
    await expect(shares.hasGrant("task-1", "grantee-1")).resolves.toBe(false);
  });

  it("only removes the targeted grant", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-1", userId: "grantee-2", grantedByUserId: "owner-1" });

    await shares.revoke({ taskId: "task-1", userId: "grantee-1" });

    await expect(shares.hasGrant("task-1", "grantee-2")).resolves.toBe(true);
  });
});

describe("list-by-user and existence checks", () => {
  it("returns rows for the user ordered newest first", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-2", userId: "grantee-1", grantedByUserId: "owner-1" });
    await db
      .updateTable("automation_task_shares")
      .set({ granted_at: "2026-08-01 08:00:00" })
      .where("task_id", "=", "task-1")
      .execute();
    await db
      .updateTable("automation_task_shares")
      .set({ granted_at: "2026-08-02 08:00:00" })
      .where("task_id", "=", "task-2")
      .execute();

    const rows = await shares.listByUserId("grantee-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.task_id).toBe("task-2");
    expect(rows[1]?.task_id).toBe("task-1");
  });

  it("hasGrant reflects the current state per task", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });

    await expect(shares.hasGrant("task-1", "grantee-1")).resolves.toBe(true);
    await expect(shares.hasGrant("task-1", "grantee-2")).resolves.toBe(false);
    await expect(shares.hasGrant("task-2", "grantee-1")).resolves.toBe(false);
  });
});

describe("delete cleanup", () => {
  it("removes every grant for a task", async () => {
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-1", userId: "grantee-2", grantedByUserId: "owner-1" });
    await shares.grant({ taskId: "task-2", userId: "grantee-1", grantedByUserId: "owner-1" });

    await shares.deleteByTaskId("task-1");

    await expect(db.selectFrom("automation_task_shares").selectAll().execute()).resolves.toEqual([
      expect.objectContaining({ task_id: "task-2" }),
    ]);
  });

  it("cascades when the granted user is deleted", async () => {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await shares.grant({ taskId: "task-1", userId: "grantee-1", grantedByUserId: "owner-1" });

    await db.deleteFrom("users").where("id", "=", "grantee-1").execute();

    await expect(db.selectFrom("automation_task_shares").selectAll().execute()).resolves.toEqual([]);
  });
});

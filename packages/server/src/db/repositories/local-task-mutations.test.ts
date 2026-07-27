import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createLocalTaskMutationPolicy } from "./local-task-mutations";
import { createTaskActivityRepository } from "./task-activity";

describe("createLocalTaskMutationPolicy sqlite", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "owner", name: "Owner", email: "owner@example.com" }).execute();
    await db
      .insertInto("tasks")
      .values({
        id: "task-1",
        parent_entity_id: null,
        parent_source_ref: null,
        parent_name: null,
        source: "daily-brief",
        external_ref: null,
        title: "Ship notes",
        normalized_title: "ship notes",
        status: "open",
        status_raw: "open",
        status_authority: "local",
        assignee_entity_id: null,
        priority: null,
        due_at: null,
        provenance: "brief",
        source_task_id: "task-1",
        status_changed_at: null,
        completed_at: null,
        valid_from: null,
        valid_to: null,
        created_by_user_id: "owner",
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rolls back the task, activity, and protections when an atomic side effect fails", async () => {
    const policy = createLocalTaskMutationPolicy(db);

    await expect(
      policy.mutateHumanTask({
        taskId: "task-1",
        userId: "missing-user",
        canEditAllLocalTasks: true,
        expectedRevision: 0,
        changes: { status: "done" },
        surface: "web",
        mutationId: "rollback-proof",
      }),
    ).rejects.toThrow();

    const task = await db.selectFrom("tasks").selectAll().where("id", "=", "task-1").executeTakeFirstOrThrow();
    const activity = await db.selectFrom("task_activity_events").selectAll().where("task_id", "=", "task-1").execute();
    const protections = await db
      .selectFrom("task_field_protections")
      .selectAll()
      .where("task_id", "=", "task-1")
      .execute();

    expect(task).toMatchObject({ status: "open", revision: 0 });
    expect(activity).toEqual([]);
    expect(protections).toEqual([]);
  });

  it("returns the canonical activity identifier when an append is replayed", async () => {
    const activity = createTaskActivityRepository(db);
    const input = {
      taskId: "task-1",
      eventKind: "fields_changed" as const,
      actorType: "user" as const,
      actorUserId: "owner",
      surface: "web" as const,
      changes: { title: { before: "Ship notes", after: "Publish notes" } },
      identityParts: ["task-1", "same-edit"],
      occurredAt: "2026-07-27T00:00:00.000Z",
    };

    const first = await activity.append(input);
    const replay = await activity.append(input);
    const rows = await db.selectFrom("task_activity_events").select("id").where("task_id", "=", "task-1").execute();

    expect(first).toEqual({ id: expect.any(String), created: true });
    expect(replay).toEqual({ id: first.id, created: false });
    expect(rows).toEqual([{ id: first.id }]);
  });
});

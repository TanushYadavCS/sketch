import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createLocalTaskMutationPolicy } from "./local-task-mutations";

describe("createLocalTaskMutationPolicy postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
    await db.insertInto("users").values({ id: "pg-owner", name: "PG Owner", email: "pg-owner@example.com" }).execute();
    await db
      .insertInto("tasks")
      .values({
        id: "pg-task",
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
        source_task_id: "pg-task",
        status_changed_at: null,
        completed_at: null,
        valid_from: null,
        valid_to: null,
        created_by_user_id: "pg-owner",
      })
      .execute();
  }, 30000);

  afterAll(async () => {
    await db.destroy();
  });

  it("applies one revision with durable protections and rejects a stale overwrite", async () => {
    const policy = createLocalTaskMutationPolicy(db);
    const applied = await policy.mutateHumanTask({
      taskId: "pg-task",
      userId: "pg-owner",
      expectedRevision: 0,
      changes: { title: "Publish launch notes", priority: "high", dueAt: "2026-08-01" },
      surface: "web",
      mutationId: "pg-edit",
    });
    const conflict = await policy.mutateHumanTask({
      taskId: "pg-task",
      userId: "pg-owner",
      expectedRevision: 0,
      changes: { title: "Overwrite stale title" },
      surface: "web",
      mutationId: "pg-stale-edit",
    });
    const protections = await db
      .selectFrom("task_field_protections")
      .select(["field", "activity_event_id"])
      .where("task_id", "=", "pg-task")
      .orderBy("field")
      .execute();

    expect(applied).toMatchObject({
      status: "applied",
      task: { title: "Publish launch notes", priority: "high", due_at: "2026-08-01", revision: 1 },
    });
    expect(conflict).toMatchObject({ status: "conflict", task: { revision: 1 } });
    expect(protections).toEqual([
      { field: "due_at", activity_event_id: expect.any(String) },
      { field: "priority", activity_event_id: expect.any(String) },
      { field: "title", activity_event_id: expect.any(String) },
    ]);
    expect(new Set(protections.map((protection) => protection.activity_event_id))).toHaveProperty("size", 1);
  });
});

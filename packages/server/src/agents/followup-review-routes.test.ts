import { Hono } from "hono";
import { type Kysely, sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { followupReviewRoutes } from "./routes";
import type { AgentRunService } from "./service";

describe("follow-up review routes", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    await db?.destroy();
    db = null;
  });

  it("applies a completion decision once, accepts the same retry, and rejects the opposite retry", async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "User", email: "user@example.com", auth_role: "member" },
        { id: "user-2", name: "Other", email: "other@example.com", auth_role: "member" },
      ])
      .execute();
    const created = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Ship follow-up actions",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "summary-task-1",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "recommendation-1",
        task_id: created.taskId,
        proposed_status: "done",
        review_code: "DONE1234",
        evidence_fingerprint: "fingerprint-1",
        origin_agent_output_id: null,
        rationale: "The conversation says this shipped.",
        expires_at: "2099-01-01T00:00:00.000Z",
        reviewed_at: null,
        reviewed_by_user_id: null,
        review_surface: null,
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
      })
      .execute();

    const app = reviewApp(db, "user-1");
    const invalid = await app.request("/api/task-completion-recommendations/recommendation-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "INVALID_DECISION" } });

    const unauthorized = await reviewApp(db, "user-2").request(
      "/api/task-completion-recommendations/recommendation-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirm_done" }),
      },
    );
    const missing = await app.request("/api/task-completion-recommendations/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm_done" }),
    });
    expect(unauthorized.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await unauthorized.json()).toEqual(await missing.json());

    const request = (decision: "confirm_done" | "keep_open") =>
      app.request("/api/task-completion-recommendations/recommendation-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });

    const first = await request("confirm_done");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      review: { kind: "completion", id: "recommendation-1", state: "accepted", canReview: false },
      task: { id: created.taskId, status: "done" },
    });

    const retry = await request("confirm_done");
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      review: { state: "accepted" },
      task: { status: "done" },
    });

    const conflict = await request("keep_open");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "REVIEW_ALREADY_DECIDED" } });
    await expect(
      db
        .selectFrom("task_activity_events")
        .select(["event_kind", "actor_type", "actor_user_id", "surface", "changes_json"])
        .where("task_id", "=", created.taskId)
        .orderBy("event_kind")
        .execute(),
    ).resolves.toEqual([
      {
        event_kind: "completion_reviewed",
        actor_type: "user",
        actor_user_id: "user-1",
        surface: "web",
        changes_json: JSON.stringify({ reviewState: { before: "pending", after: "accepted" } }),
      },
      {
        event_kind: "status_changed",
        actor_type: "user",
        actor_user_id: "user-1",
        surface: "web",
        changes_json: JSON.stringify({ status: { before: "open", after: "done" } }),
      },
    ]);
  });

  it("returns REVIEW_STALE when a completion review has expired", async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values({ id: "user-1", name: "User", email: "user@example.com", auth_role: "member" })
      .execute();
    const created = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Expired completion review",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "expired-summary-task",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "expired-recommendation",
        task_id: created.taskId,
        proposed_status: "done",
        review_code: "EXPIRED1",
        evidence_fingerprint: "expired-fingerprint",
        origin_agent_output_id: null,
        rationale: "This recommendation is too old.",
        expires_at: "2026-07-19T00:00:00.000Z",
        reviewed_at: null,
        reviewed_by_user_id: null,
        review_surface: null,
      })
      .execute();

    const response = await reviewApp(db, "user-1").request(
      "/api/task-completion-recommendations/expired-recommendation",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "confirm_done" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "REVIEW_STALE" } });
  });

  it("revalidates completion authority inside the transaction without disclosing the review", async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "User", email: "user@example.com", auth_role: "member" },
        { id: "user-2", name: "Other", email: "other@example.com", auth_role: "member" },
      ])
      .execute();
    const created = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Authority changes during review",
      status: "open",
      statusRaw: "open",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "authority-change-task",
      createdByUserId: "user-1",
    });
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "authority-change-review",
        task_id: created.taskId,
        proposed_status: "done",
        review_code: "AUTH1234",
        evidence_fingerprint: "authority-change",
        origin_agent_output_id: null,
        rationale: "Authority will change before completion.",
        expires_at: "2099-01-01T00:00:00.000Z",
        reviewed_at: null,
        reviewed_by_user_id: null,
        review_surface: null,
      })
      .execute();
    await sql`
      CREATE TRIGGER change_task_owner_during_review
      AFTER UPDATE OF review_state ON task_completion_recommendations
      WHEN NEW.id = 'authority-change-review' AND NEW.review_state = 'accepted'
      BEGIN
        UPDATE tasks SET created_by_user_id = 'user-2' WHERE id = NEW.task_id;
      END
    `.execute(db);

    const app = reviewApp(db, "user-1");
    const response = await app.request("/api/task-completion-recommendations/authority-change-review", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm_done" }),
    });
    const missing = await app.request("/api/task-completion-recommendations/missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "confirm_done" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(await missing.json());
    await expect(db.selectFrom("task_activity_events").select("id").execute()).resolves.toEqual([]);
  });

  it("keeps seed review owner-scoped and makes dismiss retries idempotent", async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "user-1", name: "User", email: "user@example.com", auth_role: "member" },
        { id: "user-2", name: "Other", email: "other@example.com", auth_role: "member" },
      ])
      .execute();
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: "slack",
        kind: "channel",
        provider_conversation_id: "C123",
        display_name: "Launch",
        last_seen_message_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation-summary",
        user_id: "user-1",
        route_id: "route-1",
        source_key: "slack:channel:C123",
        seed_started_at: null,
        seed_reviewed_at: null,
        incremental_success_at: null,
        last_error: null,
      })
      .execute();
    await db
      .insertInto("task_seed_candidates")
      .values({
        id: "candidate-1",
        agent_key: "conversation-summary",
        user_id: "user-1",
        route_id: "route-1",
        source_key: "slack:channel:C123",
        origin_agent_output_id: null,
        origin_agent_output_item_id: null,
        title: "Follow up on launch",
        normalized_title: "follow up on launch",
        proposed_assignee_name: null,
        source_platform: "slack",
        source_conversation_id: conversation.id,
        source_provider_thread_id: null,
        source_anchor_key: `slack:${conversation.id}:root`,
        evidence_fingerprint: "seed-fingerprint-1",
        review_code: "SEED1234",
        accepted_task_id: null,
        reviewed_at: null,
        reviewed_by_user_id: null,
      })
      .execute();

    const foreign = await reviewApp(db, "user-2").request("/api/task-seed-candidates/candidate-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss" }),
    });
    expect(foreign.status).toBe(404);

    const app = reviewApp(db, "user-1");
    const request = (decision: "track" | "dismiss") =>
      app.request("/api/task-seed-candidates/candidate-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    expect((await request("dismiss")).status).toBe(200);
    expect((await request("dismiss")).status).toBe(200);
    const conflict = await request("track");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "REVIEW_ALREADY_DECIDED" } });
  });
});

function reviewApp(db: Kysely<DB>, userId: string) {
  const service = { resolveUserId: vi.fn(async () => userId) } as unknown as AgentRunService;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sub", `auth-${userId}`);
    c.set("email", `${userId}@example.com`);
    c.set("role", "member");
    c.set("adminCanReadAllFiles", false);
    await next();
  });
  app.route("/api", followupReviewRoutes(service, db));
  return app;
}

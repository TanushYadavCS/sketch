import { Hono } from "hono";
import type { Selectable } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { TaskAccessContext } from "../api/task-access";
import { createTaskRepository } from "../db/repositories/tasks";
import type { TasksTable } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { DAILY_BRIEF_AGENT_KEY, dailyBriefDefinition } from "./definitions/daily-brief";
import { MAX_BRIEF_TASK_LINKS, dailyBriefRoutes, hydrateDailyBriefTaskState } from "./routes";
import type { AgentOutputApi, AgentRunService } from "./service";

const ACCESS: TaskAccessContext = {
  userId: "user-1",
  viewer: { email: "user@example.com", isAdmin: false },
  assigneeEntityIds: [],
  canReadAllLocalTasks: false,
  canEditAllLocalTasks: false,
};

function task(overrides: Partial<Selectable<TasksTable>> = {}): Selectable<TasksTable> {
  return {
    id: "task-1",
    parent_entity_id: null,
    parent_source_ref: null,
    parent_name: null,
    source: "summary",
    external_ref: null,
    title: "Current task title",
    normalized_title: "current task title",
    status: "in_progress",
    status_raw: "in_progress",
    status_authority: "local",
    assignee_entity_id: null,
    assignee_name: null,
    proposed_assignee_name: null,
    priority: "high",
    due_at: null,
    provenance: "summary",
    source_task_id: "summary-task-1",
    created_by_user_id: "user-1",
    status_changed_at: "2026-07-17T09:00:00.000Z",
    completed_at: null,
    valid_from: "2026-07-17T08:00:00.000Z",
    valid_to: null,
    milestone_series_key: null,
    source_platform: "slack",
    source_conversation_id: 42,
    source_provider_thread_id: "thread-1",
    source_anchor_key: "slack:42:thread-1",
    origin_agent_output_id: "summary-output-1",
    created_at: "2026-07-17T08:00:00.000Z",
    updated_at: "2026-07-17T09:00:00.000Z",
    ...overrides,
  };
}

function item(id: string, sectionKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sectionKey,
    title: `Snapshot ${id}`,
    summary: `Snapshot summary ${id}`,
    priority: "medium",
    label: "open",
    displayRef: null,
    actionType: null,
    actionLabel: null,
    actionPrompt: null,
    sourceUrl: null,
    structuredPayload: null,
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    taskId: null,
    ...overrides,
  };
}

function output(sections: Record<string, ReturnType<typeof item>[]>, userId = "user-1"): AgentOutputApi {
  return {
    id: "brief-1",
    agentKey: DAILY_BRIEF_AGENT_KEY,
    userId,
    outputDate: "2026-07-17",
    timezone: "UTC",
    status: "completed",
    sourceKey: "",
    sourceLabel: null,
    generatedAt: "2026-07-17T08:00:00.000Z",
    masthead: null,
    sections,
  };
}

describe("hydrateDailyBriefTaskState", () => {
  it("prefers canonical links, loads duplicate ids once, and overlays current task state", async () => {
    const loadVisibleTasks = vi.fn(async () => [task()]);
    const result = await hydrateDailyBriefTaskState({
      output: output({
        todos: [
          item("item-1", "todos", {
            taskId: "task-1",
            structuredPayload: {
              serverOwnedFollowup: true,
              trackingState: "durable",
              taskId: "conflicting-task",
            },
          }),
          item("item-2", "todos", { taskId: "task-1" }),
        ],
      }),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks,
      logger: createTestLogger(),
    });

    expect(loadVisibleTasks).toHaveBeenCalledOnce();
    expect(loadVisibleTasks).toHaveBeenCalledWith(["task-1"], ACCESS);
    expect(result.sections.todos).toEqual([
      expect.objectContaining({
        id: "item-1",
        title: "Snapshot item-1",
        taskId: "task-1",
        task: expect.objectContaining({
          id: "task-1",
          title: "Current task title",
          status: "in_progress",
          canEditStatus: true,
        }),
      }),
      expect.objectContaining({ id: "item-2", taskId: "task-1", task: expect.objectContaining({ id: "task-1" }) }),
    ]);
  });

  it("accepts only strict owner-scoped legacy shapes with live summary provenance", async () => {
    const loadVisibleTasks = vi.fn(async (ids: string[]) =>
      ids.map((id) =>
        task(
          id === "forged-task"
            ? { id, provenance: "brief", source_anchor_key: null }
            : { id, source_task_id: `source-${id}` },
        ),
      ),
    );
    const result = await hydrateDailyBriefTaskState({
      output: output({
        todos: [
          item("durable", "todos", {
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "legacy-durable" },
          }),
          item("ordinary", "todos", { structuredPayload: { taskId: "ordinary-task" } }),
          item("forged", "todos", {
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "forged-task" },
          }),
          item("malformed", "todos", {
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "  " },
          }),
        ],
        looks_resolved: [
          item("resolved", "looks_resolved", {
            structuredPayload: {
              serverOwnedFollowup: true,
              trackingState: "looks_resolved",
              recommendationId: "recommendation-1",
              taskId: "legacy-resolved",
            },
          }),
        ],
        untracked_followups: [
          item("untracked", "untracked_followups", {
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "untracked-task" },
          }),
        ],
      }),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks,
      logger: createTestLogger(),
    });

    expect(loadVisibleTasks).toHaveBeenCalledWith(["legacy-durable", "forged-task", "legacy-resolved"], ACCESS);
    expect(result.sections.todos).toEqual([
      expect.objectContaining({
        id: "durable",
        taskId: "legacy-durable",
        task: expect.objectContaining({ id: "legacy-durable" }),
      }),
      expect.objectContaining({ id: "ordinary", taskId: null, task: null }),
      expect.objectContaining({ id: "forged", taskId: null, task: null }),
      expect.objectContaining({ id: "malformed", taskId: null, task: null }),
    ]);
    expect(result.sections.looks_resolved[0]).toEqual(
      expect.objectContaining({ taskId: "legacy-resolved", task: expect.objectContaining({ id: "legacy-resolved" }) }),
    );
    expect(result.sections.untracked_followups[0]).toEqual(expect.objectContaining({ taskId: null, task: null }));
  });

  it("does not expose canonical or legacy ids when the task is missing, expired, or invisible", async () => {
    const result = await hydrateDailyBriefTaskState({
      output: output({
        todos: [
          item("canonical", "todos", { taskId: "hidden-canonical" }),
          item("legacy", "todos", {
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "hidden-legacy" },
          }),
        ],
      }),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks: vi.fn(async () => []),
      logger: createTestLogger(),
    });

    expect(result.sections.todos).toEqual([
      expect.objectContaining({ id: "canonical", taskId: null, task: null }),
      expect.objectContaining({ id: "legacy", taskId: null, task: null }),
    ]);
  });

  it("rejects legacy fallback when the authenticated reader does not own the brief", async () => {
    const loadVisibleTasks = vi.fn(async () => [task({ id: "legacy-task" })]);
    const result = await hydrateDailyBriefTaskState({
      output: output(
        {
          todos: [
            item("legacy", "todos", {
              structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "legacy-task" },
            }),
          ],
        },
        "another-user",
      ),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks,
      logger: createTestLogger(),
    });

    expect(loadVisibleTasks).not.toHaveBeenCalled();
    expect(result.sections.todos[0]).toEqual(expect.objectContaining({ taskId: null, task: null }));
  });

  it("caps unique candidates and logs count-only hydration classifications", async () => {
    const logger = createTestLogger();
    const debug = vi.spyOn(logger, "debug");
    const loadVisibleTasks = vi.fn(async (ids: string[]) => ids.map((id) => task({ id, source_task_id: id })));
    const todos = Array.from({ length: MAX_BRIEF_TASK_LINKS + 1 }, (_, index) =>
      item(`item-${index}`, "todos", {
        structuredPayload: {
          serverOwnedFollowup: true,
          trackingState: "durable",
          taskId: `legacy-${index}`,
        },
      }),
    );

    const result = await hydrateDailyBriefTaskState({
      output: output({ todos }),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks,
      logger,
    });

    expect(loadVisibleTasks.mock.calls[0]?.[0]).toHaveLength(MAX_BRIEF_TASK_LINKS);
    expect(result.sections.todos[MAX_BRIEF_TASK_LINKS]).toEqual(expect.objectContaining({ taskId: null, task: null }));
    expect(debug).toHaveBeenCalledWith(
      {
        event: "daily_brief_task_hydration",
        outputId: "brief-1",
        canonicalCandidates: 0,
        legacyCandidates: MAX_BRIEF_TASK_LINKS + 1,
        canonicalHydrated: 0,
        legacyHydrated: MAX_BRIEF_TASK_LINKS,
        rejectedLegacyCandidates: 0,
        rejectedLegacyReasons: {},
        overflowCandidates: 1,
      },
      "Daily Brief: hydrated live task links",
    );
  });

  it("logs rejected legacy reason counts without item titles or content", async () => {
    const logger = createTestLogger();
    const debug = vi.spyOn(logger, "debug");
    await hydrateDailyBriefTaskState({
      output: output({
        todos: [
          item("ordinary", "todos", {
            title: "Sensitive ordinary title",
            structuredPayload: { taskId: "ordinary-task" },
          }),
          item("malformed", "todos", {
            title: "Sensitive malformed title",
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: " " },
          }),
          item("missing", "todos", {
            title: "Sensitive missing title",
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "missing-task" },
          }),
        ],
        untracked_followups: [
          item("untracked", "untracked_followups", {
            title: "Sensitive untracked title",
            structuredPayload: { serverOwnedFollowup: true, trackingState: "durable", taskId: "untracked-task" },
          }),
        ],
      }),
      userId: "user-1",
      access: ACCESS,
      loadVisibleTasks: vi.fn(async () => []),
      logger,
    });

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalCandidates: 0,
        legacyCandidates: 1,
        legacyHydrated: 0,
        rejectedLegacyCandidates: 4,
        rejectedLegacyReasons: {
          not_server_owned: 1,
          malformed_task_id: 1,
          invalid_section_shape: 1,
          not_visible_or_missing: 1,
        },
      }),
      "Daily Brief: hydrated live task links",
    );
    expect(JSON.stringify(debug.mock.calls[0]?.[0])).not.toContain("Sensitive");
  });
});

describe("Daily Brief task hydration routes", () => {
  it("includes stored task ids in generic item shaping", () => {
    const apiItem = dailyBriefDefinition.toApiItem({
      id: "item-1",
      agent_output_id: "brief-1",
      task_id: "task-1",
      section_key: "todos",
      title: "Snapshot title",
      summary: "Snapshot summary",
      priority: "medium",
      label: "open",
      display_ref: null,
      action_type: null,
      action_label: null,
      action_prompt: null,
      knowledge_refs_json: "{}",
      source_url: null,
      structured_payload_json: null,
      sort_order: 0,
      created_at: "2026-07-17T08:00:00.000Z",
      knowledgeRefs: { entityIds: [], fileIds: [] },
      structuredPayload: null,
    });

    expect(apiItem.taskId).toBe("task-1");
  });

  it("hydrates current status through both latest and by-id endpoints", async () => {
    const db = await createTestDb();
    try {
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
        title: "Current task title",
        status: "open",
        statusRaw: "action_item",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        priority: "high",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: "route-task",
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
          rationale: "The task appears complete.",
          expires_at: "2026-07-22T00:00:00.000Z",
          reviewed_at: null,
          reviewed_by_user_id: null,
          review_surface: null,
          created_at: "2026-07-17T08:00:00.000Z",
          updated_at: "2026-07-17T08:00:00.000Z",
        })
        .execute();
      const acceptedTask = await createTaskRepository(db).upsertTask({
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: "Accepted reconstructed follow-up",
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: "accepted-seed-task",
        createdByUserId: "user-1",
      });
      const conversation = await db
        .insertInto("conversations")
        .values({
          platform: "slack",
          kind: "channel",
          provider_conversation_id: "C_SEED",
          display_name: "Seed",
          last_seen_message_id: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("task_seed_candidates")
        .values({
          id: "candidate-1",
          agent_key: "conversation-summary",
          user_id: "user-1",
          route_id: "route-1",
          source_key: "slack:channel:C_SEED",
          origin_agent_output_id: null,
          origin_agent_output_item_id: null,
          title: "Accepted reconstructed follow-up",
          normalized_title: "accepted reconstructed follow-up",
          proposed_assignee_name: null,
          source_platform: "slack",
          source_conversation_id: conversation.id,
          source_provider_thread_id: null,
          source_anchor_key: `slack:${conversation.id}:root`,
          evidence_fingerprint: "seed-fingerprint",
          review_code: "SEED1234",
          review_state: "accepted",
          accepted_task_id: acceptedTask.taskId,
          reviewed_at: "2026-07-17T09:00:00.000Z",
          reviewed_by_user_id: "user-1",
        })
        .execute();
      const brief = output({
        todos: [item("route-item", "todos", { taskId: created.taskId })],
        untracked_followups: [
          item("seed-item", "untracked_followups", {
            structuredPayload: {
              serverOwnedFollowup: true,
              trackingState: "untracked",
              candidateId: "candidate-1",
              reviewCode: "SEED1234",
            },
          }),
        ],
        looks_resolved: [
          item("review-item", "looks_resolved", {
            taskId: created.taskId,
            structuredPayload: {
              serverOwnedFollowup: true,
              trackingState: "looks_resolved",
              recommendationId: "recommendation-1",
              reviewCode: "DONE1234",
              taskId: created.taskId,
            },
          }),
        ],
      });
      const service = {
        resolveUserId: vi.fn(async () => "user-1"),
        getLatestForUser: vi.fn(async () => ({
          output: brief,
          running: false,
          outputDate: "2026-07-17",
          timezone: "UTC",
          enabledSections: ["todos"],
        })),
        getByIdForUser: vi.fn(async () => brief),
      } as unknown as AgentRunService;
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("sub", "auth-user");
        c.set("email", "user@example.com");
        c.set("role", "member");
        c.set("adminCanReadAllFiles", false);
        await next();
      });
      app.route("/api/daily-briefs", dailyBriefRoutes(service, db, createTestLogger()));

      const latest = await app.request("/api/daily-briefs");
      expect(latest.status).toBe(200);
      await expect(latest.json()).resolves.toMatchObject({
        brief: {
          sections: {
            todos: [{ taskId: created.taskId, task: { status: "open" } }],
            looks_resolved: [
              {
                review: {
                  kind: "completion",
                  id: "recommendation-1",
                  state: "pending",
                  canReview: true,
                },
              },
            ],
            untracked_followups: [
              {
                taskId: acceptedTask.taskId,
                task: { id: acceptedTask.taskId, status: "open" },
                review: {
                  kind: "seed",
                  id: "candidate-1",
                  state: "accepted",
                  canReview: false,
                  acceptedTaskId: acceptedTask.taskId,
                },
              },
            ],
          },
        },
      });

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("tasks")
          .set({
            status: "done",
            status_raw: "done",
            completed_at: "2026-07-17T10:00:00.000Z",
            updated_at: "2026-07-17T10:00:00.000Z",
          })
          .where("id", "=", created.taskId)
          .execute();
        await trx
          .updateTable("task_completion_recommendations")
          .set({
            review_state: "accepted",
            reviewed_at: "2026-07-17T10:00:00.000Z",
            reviewed_by_user_id: "user-1",
            review_surface: "web",
            updated_at: "2026-07-17T10:00:00.000Z",
          })
          .where("id", "=", "recommendation-1")
          .execute();
      });

      const byId = await app.request("/api/daily-briefs/brief-1");
      expect(byId.status).toBe(200);
      await expect(byId.json()).resolves.toMatchObject({
        brief: {
          sections: {
            todos: [
              {
                title: "Snapshot route-item",
                taskId: created.taskId,
                task: { title: "Current task title", status: "done", completedAt: "2026-07-17T10:00:00.000Z" },
              },
            ],
            looks_resolved: [
              {
                review: {
                  kind: "completion",
                  id: "recommendation-1",
                  state: "accepted",
                  canReview: false,
                },
              },
            ],
            untracked_followups: [
              {
                taskId: acceptedTask.taskId,
                task: { id: acceptedTask.taskId, status: "open" },
                review: {
                  kind: "seed",
                  id: "candidate-1",
                  state: "accepted",
                  canReview: false,
                  acceptedTaskId: acceptedTask.taskId,
                },
              },
            ],
          },
        },
      });
    } finally {
      await db.destroy();
    }
  });
});

import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentRoute, createAgentOutputRepository } from "../../db/repositories/agent-outputs";
import { createTaskDurabilityTransitionRepository } from "../../db/repositories/task-durability-transition";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { handleListFollowups } from "./list-followups";
import type { SketchMcpDeps } from "./types";

describe("handleListFollowups", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        name: "Ashish",
        email: "ashish@example.com",
        email_verified_at: "2026-07-16T10:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-1",
        name: "Ashish",
        source_type: "person",
        subtype: null,
        aliases: null,
        metadata: JSON.stringify({ email: "ashish@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: "2026-07-16T10:00:00.000Z",
        updated_at: "2026-07-16T10:00:00.000Z",
        ai_brief: null,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns durable, reviewable, and transition follow-ups without chat reconstruction", async () => {
    const conversationId = await seedConversation(db);
    await seedSummarizerConfig(db, [route("route-1", "whatsapp:group:goosebumps")]);
    await db
      .insertInto("tasks")
      .values([
        taskRow("task-pending", "Pending follow-up", "open", conversationId),
        taskRow("task-resolved", "Looks fixed", "open", conversationId),
      ])
      .execute();
    await db
      .insertInto("task_completion_recommendations")
      .values({
        id: "recommendation-1",
        task_id: "task-resolved",
        proposed_status: "done",
        review_state: "pending",
        review_code: "R7K2",
        evidence_fingerprint: "fingerprint-1",
        origin_agent_output_id: null,
        rationale: "Completion was reported.",
        delivery_count: 0,
        expires_at: "2099-01-01T00:00:00.000Z",
      })
      .execute();
    const message = await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: "wamid.seed",
        sender_name: "Ashish",
        sender_user_id: "user-1",
        addressed_to_sketch: 0,
        text: "Follow up on the legacy item.",
        is_thread_reply: 0,
        received_at: "2026-07-16T10:00:00.000Z",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const outputs = createAgentOutputRepository(db);
    const running = await outputs.createRunning({
      agentKey: "conversation_summary",
      agentVersion: "test",
      userId: "user-1",
      outputDate: "2026-07-16",
      timezone: "UTC",
      triggerType: "manual",
      sourceKey: "whatsapp:group:goosebumps",
      sourceLabel: "Goosebumps",
    });
    await outputs.completeOutput({
      outputId: running.row.id,
      masthead: { title: "Summary", summary: "Summary" },
      rawPayload: { items: [] },
      items: [
        {
          sectionKey: "action_items",
          title: "Legacy seed follow-up",
          summary: "Ashish owns the follow-up.",
          priority: "medium",
          label: "action_item",
          structuredPayload: { messageIds: [message.id], owner: "Ashish" },
          knowledgeRefs: { entityIds: [], fileIds: [] },
          sortOrder: 0,
        },
      ],
    });
    await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: "conversation_summary",
      userId: "user-1",
      routeId: "route-1",
      sourceKey: "whatsapp:group:goosebumps",
      now: "2026-07-16T10:01:00.000Z",
    });

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "ok",
      mode: "hybrid",
      pending: [{ taskId: "task-pending", title: "Pending follow-up" }],
      looksResolved: [{ taskId: "task-resolved", reviewCode: "R7K2" }],
      untracked: [{ title: "Legacy seed follow-up", reviewCode: expect.any(String) }],
    });
  });

  it("keeps pre-feature reminder semantics when durable task creation is disabled", async () => {
    await seedSummarizerConfig(db, [route("route-1", "whatsapp:group:goosebumps")], {
      createTasks: false,
    });
    await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: "conversation_summary",
      userId: "user-1",
      routeId: "route-1",
      sourceKey: "whatsapp:group:goosebumps",
      now: "2026-07-16T10:01:00.000Z",
    });

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toEqual({
      status: "inactive",
      code: "durability_not_enabled",
      authoritative: false,
      useChatHistory: true,
      message:
        "Durable follow-up tracking is not enabled for any active Summarizer route. Continue using chat history and existing reminder behavior.",
    });
  });

  it("uses bounded recent summaries as hybrid candidates before the first route-state row exists", async () => {
    const sourceKey = "whatsapp:group:goosebumps";
    await seedSummarizerConfig(db, [route("route-1", sourceKey)]);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.before-state");
    const now = Date.now();
    const recentTitles: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const title = `Recent follow-up ${index}`;
      recentTitles.push(title);
      await seedSummaryOutput(db, sourceKey, title, messageId, new Date(now - index * 60_000).toISOString());
    }
    await seedSummaryOutput(
      db,
      sourceKey,
      "Too old to recover",
      messageId,
      new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    );

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "ok",
      mode: "hybrid",
      pending: [],
      looksResolved: [],
    });
    expect(payload.untracked).toHaveLength(10);
    expect(payload.untracked.map((item: { title: string }) => item.title)).toEqual(recentTitles.slice(0, 10));
    expect(payload.untracked).not.toContainEqual(expect.objectContaining({ title: "Too old to recover" }));
    expect(payload.untracked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewCode: null,
          label: "Reconstructed from a recent summary; not yet tracked.",
        }),
      ]),
    );
  });

  it("returns a conservative error when the bounded historical summary page may be incomplete", async () => {
    const sourceKey = "whatsapp:group:goosebumps";
    await seedSummarizerConfig(db, [route("route-1", sourceKey)]);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.history-overflow");
    const now = Date.now();
    for (let index = 0; index < 50; index += 1) {
      await seedSummaryOutput(
        db,
        sourceKey,
        `Historical overflow ${index}`,
        messageId,
        new Date(now - index * 60_000).toISOString(),
      );
    }

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "error",
      code: "reminder_history_overflow",
      authoritative: false,
      mode: "hybrid",
    });
  });

  it("preserves transition review candidates and recent-summary fallback when durable reminder reads fail", async () => {
    const sourceKey = "whatsapp:group:goosebumps";
    await seedSummarizerConfig(db, [route("route-1", sourceKey)]);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.query-error");
    const transitionOutputId = await seedSummaryOutput(db, sourceKey, "Review transition item", messageId);
    await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: "conversation_summary",
      userId: "user-1",
      routeId: "route-1",
      sourceKey,
      now: new Date().toISOString(),
    });
    await seedSummaryOutput(db, sourceKey, "Recent fallback item", messageId);
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-query-error", "Force recommendation query", "open", conversationId),
        origin_agent_output_id: transitionOutputId,
      })
      .execute();
    await db.schema.dropTable("task_completion_recommendations").execute();

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "error",
      code: "durable_query_failed",
      retryable: true,
      mode: "hybrid",
    });
    expect(payload.fallback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Review transition item",
          reviewCode: expect.any(String),
        }),
        expect.objectContaining({
          title: "Recent fallback item",
          reviewCode: null,
        }),
      ]),
    );
    expect(payload.fallback.filter((item: { title: string }) => item.title === "Review transition item")).toHaveLength(
      1,
    );
  });

  it("retains recent-summary fallback when a durable-only reminder query fails", async () => {
    const sourceKey = "whatsapp:group:goosebumps";
    await seedSummarizerConfig(db, [route("route-1", sourceKey)]);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.durable-only-error");
    const outputId = await seedSummaryOutput(db, sourceKey, "Durable-only fallback item", messageId);
    const now = new Date().toISOString();
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-1",
        source_key: sourceKey,
        mode: "durable_only",
        seed_state: "reviewed",
        seed_started_at: now,
        seed_reviewed_at: now,
        incremental_success_at: now,
        last_error: null,
      })
      .execute();
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-durable-only-error", "Force durable-only query failure", "open", conversationId),
        origin_agent_output_id: outputId,
      })
      .execute();
    await db.schema.dropTable("task_completion_recommendations").execute();

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "error",
      code: "durable_query_failed",
      fallback: [
        expect.objectContaining({
          title: "Durable-only fallback item",
          reviewCode: null,
        }),
      ],
    });
  });

  it("filters disabled historical routes from transition, summary, and durable reminder results", async () => {
    const activeSource = "whatsapp:group:goosebumps";
    const disabledSource = "whatsapp:group:archived";
    await seedSummarizerConfig(db, [
      route("route-active", activeSource),
      route("route-disabled", disabledSource, false),
    ]);
    const activeConversationId = await seedConversation(db);
    const disabledConversationId = await seedConversation(db, {
      providerConversationId: "archived",
      displayName: "Archived",
    });
    const activeMessageId = await seedMessage(db, activeConversationId, "wamid.active");
    const disabledMessageId = await seedMessage(db, disabledConversationId, "wamid.disabled");
    const activeOutputId = await seedSummaryOutput(db, activeSource, "Active recent follow-up", activeMessageId);
    const disabledOutputId = await seedSummaryOutput(
      db,
      disabledSource,
      "Disabled recent follow-up",
      disabledMessageId,
    );
    await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: "conversation_summary",
      userId: "user-1",
      routeId: "route-active",
      sourceKey: activeSource,
      now: new Date().toISOString(),
    });
    await createTaskDurabilityTransitionRepository(db).ensureRouteTransition({
      agentKey: "conversation_summary",
      userId: "user-1",
      routeId: "route-disabled",
      sourceKey: disabledSource,
      now: new Date().toISOString(),
    });
    await db
      .insertInto("tasks")
      .values([
        {
          ...taskRow("task-active", "Active durable follow-up", "open", activeConversationId),
          origin_agent_output_id: activeOutputId,
        },
        {
          ...taskRow("task-disabled", "Disabled durable follow-up", "open", disabledConversationId),
          origin_agent_output_id: disabledOutputId,
        },
      ])
      .execute();

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    const serialized = JSON.stringify(payload);

    expect(payload.pending).toEqual([
      expect.objectContaining({ taskId: "task-active", title: "Active durable follow-up" }),
    ]);
    expect(payload.untracked).toEqual([
      expect.objectContaining({ title: "Active recent follow-up", reviewCode: expect.any(String) }),
    ]);
    expect(serialized).not.toContain("Disabled durable follow-up");
    expect(serialized).not.toContain("Disabled recent follow-up");
  });

  it("suppresses same-anchor legacy work already tracked by a combined route", async () => {
    const firstSource = "whatsapp:group:goosebumps";
    const secondSource = "whatsapp:group:leadership";
    const combinedSource = combinedRouteSourceKey([firstSource, secondSource]);
    await seedSummarizerConfig(db, [
      {
        ...route("route-combined", firstSource),
        sources: [firstSource, secondSource],
      },
    ]);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.combined");
    const outputId = await seedSummaryOutput(db, combinedSource, "Send the revised proposal", messageId);
    const now = new Date().toISOString();
    await db
      .insertInto("task_durability_route_state")
      .values({
        agent_key: "conversation_summary",
        user_id: "user-1",
        route_id: "route-combined",
        source_key: combinedSource,
        mode: "hybrid",
        seed_state: "reviewed",
        seed_started_at: now,
        seed_reviewed_at: now,
        incremental_success_at: null,
        last_error: null,
      })
      .execute();
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-combined", "Send the revised proposal", "open", conversationId),
        origin_agent_output_id: outputId,
      })
      .execute();

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.pending).toEqual([
      expect.objectContaining({ taskId: "task-combined", title: "Send the revised proposal" }),
    ]);
    expect(payload.untracked).toEqual([]);
  });

  it.each([
    {
      name: "single to combined",
      activeRoutes: [
        {
          ...route("route-combined", "whatsapp:group:goosebumps"),
          sources: ["whatsapp:group:goosebumps", "whatsapp:group:leadership"],
        },
      ] as AgentRoute[],
      historicalSourceKey: "whatsapp:group:goosebumps",
    },
    {
      name: "combined to single",
      activeRoutes: [route("route-single", "whatsapp:group:goosebumps")] as AgentRoute[],
      historicalSourceKey: combinedRouteSourceKey(["whatsapp:group:goosebumps", "whatsapp:group:leadership"]),
    },
  ])(
    "keeps durable reminders active across $name route topology changes",
    async ({ activeRoutes, historicalSourceKey }) => {
      await seedSummarizerConfig(db, activeRoutes);
      const conversationId = await seedConversation(db);
      const messageId = await seedMessage(db, conversationId, `wamid.${historicalSourceKey}`);
      const outputId = await seedSummaryOutput(db, historicalSourceKey, "Durable topology follow-up", messageId);
      await db
        .insertInto("tasks")
        .values({
          ...taskRow("task-topology", "Durable topology follow-up", "open", conversationId),
          origin_agent_output_id: outputId,
        })
        .execute();

      const result = await handleListFollowups({}, {
        db,
        currentUserId: "user-1",
      } as SketchMcpDeps);
      const payload = JSON.parse(result.content[0]?.text ?? "{}");

      expect(payload).toMatchObject({
        status: "ok",
        pending: [expect.objectContaining({ taskId: "task-topology", title: "Durable topology follow-up" })],
      });
      expect(payload.untracked).toEqual([]);
    },
  );

  it("keeps a DM task active when its route changes from single to combined", async () => {
    const conversationId = await seedConversation(db, {
      providerConversationId: "opaque-whatsapp-dm",
      displayName: "Ashish DM",
      kind: "dm",
    });
    const dmSource = `whatsapp:dm:${conversationId}` as const;
    await seedSummarizerConfig(db, [
      {
        ...route("route-dm-combined", dmSource),
        sources: [dmSource, "whatsapp:group:leadership"],
      },
    ]);
    const messageId = await seedMessage(db, conversationId, "wamid.dm-topology");
    const outputId = await seedSummaryOutput(db, dmSource, "DM topology follow-up", messageId);
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-dm-topology", "DM topology follow-up", "open", conversationId),
        origin_agent_output_id: outputId,
      })
      .execute();

    const result = await handleListFollowups({}, {
      db,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.pending).toEqual([
      expect.objectContaining({ taskId: "task-dm-topology", title: "DM topology follow-up" }),
    ]);
  });

  it("keeps tasks assigned to the user even when the creator's source is outside the user's own routes", async () => {
    await seedSummarizerConfig(db, [route("route-own", "whatsapp:group:goosebumps")]);
    await db.insertInto("users").values({ id: "user-other", name: "Other", email: "other@example.com" }).execute();
    const externalConversationId = await seedConversation(db, {
      providerConversationId: "leadership",
      displayName: "Leadership",
    });
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-assigned-external-route", "Follow up from another route", "open", externalConversationId),
        created_by_user_id: "user-other",
        assignee_entity_id: "person-1",
      })
      .execute();

    const result = await handleListFollowups({}, { db, currentUserId: "user-1" } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.pending).toEqual([
      expect.objectContaining({ taskId: "task-assigned-external-route", title: "Follow up from another route" }),
    ]);
  });

  it("returns cross-owner assigned tasks even when the assignee has no active Summarizer route", async () => {
    await db.insertInto("users").values({ id: "user-other", name: "Other", email: "other@example.com" }).execute();
    const conversationId = await seedConversation(db, {
      providerConversationId: "other-owner-source",
      displayName: "Other owner source",
    });
    await db
      .insertInto("tasks")
      .values({
        ...taskRow("task-assigned-without-route", "Assigned without own route", "open", conversationId),
        created_by_user_id: "user-other",
        assignee_entity_id: "person-1",
      })
      .execute();

    const result = await handleListFollowups({}, { db, currentUserId: "user-1" } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "ok",
      authoritative: true,
      pending: [expect.objectContaining({ taskId: "task-assigned-without-route" })],
    });
  });

  it("keeps historical fallback visible immediately after a single route becomes combined", async () => {
    const memberSource = "whatsapp:group:goosebumps";
    const combinedRoutes = [
      {
        ...route("route-combined-fallback", memberSource),
        sources: [memberSource, "whatsapp:group:leadership"],
      },
    ] as AgentRoute[];
    await seedSummarizerConfig(db, combinedRoutes);
    const conversationId = await seedConversation(db);
    const messageId = await seedMessage(db, conversationId, "wamid.topology-fallback");
    await seedSummaryOutput(db, memberSource, "Historical topology fallback", messageId);

    const result = await handleListFollowups({}, { db, currentUserId: "user-1" } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      status: "ok",
      mode: "hybrid",
      untracked: [expect.objectContaining({ title: "Historical topology fallback" })],
    });
  });

  it("returns an explicit unavailable result without database or user context", async () => {
    await expect(handleListFollowups({}, {} as SketchMcpDeps)).resolves.toEqual({
      content: [{ type: "text", text: "Follow-up tracking is not available in this context." }],
    });
  });

  it("returns a discriminated retryable error when durable reads fail", async () => {
    await db.destroy();
    db = await createTestDb();
    const unavailableDb = db;
    await unavailableDb.destroy();
    db = await createTestDb();

    const result = await handleListFollowups({}, {
      db: unavailableDb,
      currentUserId: "user-1",
    } as SketchMcpDeps);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toEqual({
      status: "error",
      code: "durable_query_failed",
      retryable: true,
      mode: "hybrid",
      authoritative: false,
      fallback: [],
    });
  });
});

function taskRow(id: string, title: string, status: string, conversationId: number) {
  return {
    id,
    parent_entity_id: null,
    parent_source_ref: null,
    parent_name: null,
    source: "summary",
    external_ref: null,
    title,
    normalized_title: title.toLowerCase(),
    status,
    status_raw: status,
    status_authority: "local",
    assignee_entity_id: "person-1",
    assignee_name: "Ashish",
    proposed_assignee_name: null,
    priority: "medium",
    due_at: null,
    provenance: "summary",
    source_task_id: id,
    created_by_user_id: "user-1",
    status_changed_at: "2026-07-16T10:00:00.000Z",
    completed_at: null,
    valid_from: "2026-07-16T10:00:00.000Z",
    valid_to: null,
    milestone_series_key: null,
    source_platform: "whatsapp",
    source_conversation_id: conversationId,
    source_provider_thread_id: null,
    source_anchor_key: `whatsapp:${conversationId}:root`,
    origin_agent_output_id: null,
  };
}

async function seedConversation(
  db: Kysely<DB>,
  options: { providerConversationId?: string; displayName?: string; kind?: "group" | "dm" } = {},
): Promise<number> {
  return (
    await db
      .insertInto("conversations")
      .values({
        platform: "whatsapp",
        kind: options.kind ?? "group",
        provider_conversation_id: options.providerConversationId ?? "goosebumps",
        display_name: options.displayName ?? "Goosebumps",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

function route(id: string, sourceKey: AgentRoute["sources"][number], enabled = true): AgentRoute {
  return {
    id,
    sources: [sourceKey],
    focus: null,
    sections: null,
    maxItemsPerSection: null,
    schedule: null,
    destination: { kind: "off" },
    enabled,
  };
}

function combinedRouteSourceKey(sources: string[]): string {
  const hash = createHash("sha256")
    .update([...sources].sort().join("|"))
    .digest("hex")
    .slice(0, 12);
  return `route:${hash}`;
}

async function seedSummarizerConfig(
  db: Kysely<DB>,
  routes: AgentRoute[],
  options: { createTasks?: boolean; enabled?: boolean } = {},
): Promise<void> {
  await db
    .insertInto("agent_user_configs")
    .values({
      agent_key: "conversation_summary",
      user_id: "user-1",
      enabled: options.enabled === false ? 0 : 1,
      schedule_hour: 8,
      schedule_minute: 0,
      timezone: "UTC",
      max_items_per_section: 5,
      prefs_json: JSON.stringify({
        routes,
        createTasks: options.createTasks ?? true,
      }),
    })
    .execute();
}

async function seedMessage(db: Kysely<DB>, conversationId: number, providerMessageId: string): Promise<number> {
  return (
    await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversationId,
        provider_message_id: providerMessageId,
        sender_name: "Ashish",
        sender_user_id: "user-1",
        addressed_to_sketch: 0,
        text: providerMessageId,
        is_thread_reply: 0,
        received_at: new Date().toISOString(),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function seedSummaryOutput(
  db: Kysely<DB>,
  sourceKey: string,
  title: string,
  messageId: number,
  generatedAt?: string,
): Promise<string> {
  const outputs = createAgentOutputRepository(db);
  const running = await outputs.createRunning({
    agentKey: "conversation_summary",
    agentVersion: "test",
    userId: "user-1",
    outputDate: new Date().toISOString().slice(0, 10),
    periodKey: `${new Date().toISOString()}:${title}`,
    timezone: "UTC",
    triggerType: "manual",
    sourceKey,
    sourceLabel: sourceKey,
  });
  await outputs.completeOutput({
    outputId: running.row.id,
    masthead: { title: "Summary", summary: "Summary" },
    rawPayload: { items: [] },
    items: [
      {
        sectionKey: "action_items",
        title,
        summary: `${title} summary`,
        priority: "medium",
        label: "action_item",
        structuredPayload: { messageIds: [messageId], owner: "Ashish" },
        knowledgeRefs: { entityIds: [], fileIds: [] },
        sortOrder: 0,
      },
    ],
  });
  if (generatedAt) {
    await db
      .updateTable("agent_outputs")
      .set({ generated_at: generatedAt, updated_at: generatedAt })
      .where("id", "=", running.row.id)
      .execute();
  }
  return running.row.id;
}

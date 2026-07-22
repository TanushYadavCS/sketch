import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputItemInput, AgentSourceConfig } from "../../db/repositories/agent-outputs";
import { createConversationFollowupsRepository } from "../../db/repositories/conversation-followups";
import type { DB, UsersTable } from "../../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import {
  CONVERSATION_SUMMARY_AGENT_KEY,
  CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE,
  buildConversationSummaryRuntimeContext,
  conversationSummaryDefinition,
} from "./conversation-summary";

const NOW = new Date("2026-07-01T18:00:00.000Z");

async function seedUser(db: Kysely<DB>): Promise<Selectable<UsersTable>> {
  await db
    .insertInto("users")
    .values({
      id: "user-1",
      name: "Summary User",
      email: "user@example.com",
      email_verified_at: NOW.toISOString(),
    })
    .execute();
  return db.selectFrom("users").selectAll().where("id", "=", "user-1").executeTakeFirstOrThrow();
}

async function seedAssignablePerson(db: Kysely<DB>, id: string, name: string): Promise<void> {
  const email = `${id}@example.com`;
  await db
    .insertInto("users")
    .values({
      id: `user-${id}`,
      name,
      email,
      email_verified_at: NOW.toISOString(),
    })
    .execute();
  await db
    .insertInto("entities")
    .values({
      id: `person-${id}`,
      name,
      source_type: "person",
      subtype: null,
      aliases: JSON.stringify([email]),
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ai_brief: null,
    })
    .execute();
}

async function seedConversation(db: Kysely<DB>): Promise<number> {
  await db
    .insertInto("conversations")
    .values({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: "C_SUMMARY",
      display_name: "summary-room",
    })
    .execute();
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("provider_conversation_id", "=", "C_SUMMARY")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedMessage(
  db: Kysely<DB>,
  conversationId: number,
  params: { id: string; text: string; receivedAt: string; isBot?: boolean },
): Promise<void> {
  await db
    .insertInto("conversation_messages")
    .values({
      conversation_id: conversationId,
      provider_message_id: params.id,
      sender_jid: "U_1",
      sender_name: "Mina",
      sender_user_id: "user-1",
      is_bot: params.isBot ? 1 : 0,
      addressed_to_sketch: 0,
      text: params.text,
      received_at: params.receivedAt,
    })
    .execute();
}

function source(): AgentSourceConfig {
  return {
    platform: "slack",
    targetType: "channel",
    targetId: "C_SUMMARY",
    label: "#summary-room",
  };
}

async function seedProject(db: Kysely<DB>, id: string, name: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}

function outputItem(overrides: Partial<AgentOutputItemInput> = {}): AgentOutputItemInput {
  return {
    sectionKey: "highlights",
    title: "Output item",
    summary: "Output item summary.",
    priority: "medium",
    label: "highlight",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

async function seedAgentOutput(db: Kysely<DB>, id: string, userId: string): Promise<void> {
  await db
    .insertInto("agent_outputs")
    .values({
      id,
      agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
      user_id: userId,
      output_date: "2026-07-01",
      source_key: "slack:channel:C_SUMMARY",
      source_label: "#summary-room",
      timezone: "UTC",
      status: "completed",
      trigger_type: "manual",
      agent_version: "test",
      generated_at: NOW.toISOString(),
    })
    .execute();
}

describe("conversationSummaryDefinition", () => {
  it("is registered as a source-configurable summarizer", () => {
    expect(conversationSummaryDefinition.key).toBe(CONVERSATION_SUMMARY_AGENT_KEY);
    expect(conversationSummaryDefinition.sourceConfig).toMatchObject({
      supportsSlackChannels: true,
      supportsSlackDms: true,
      supportsWhatsAppGroups: true,
      supportsWhatsAppDms: true,
    });
    expect(conversationSummaryDefinition.requiresKnowledgeRefs).toBe(false);
  });

  it("carries parent hints from the same output into promoted action-item tasks", async () => {
    const db = await createTestDb();
    try {
      await seedUser(db);
      await seedAssignablePerson(db, "apeksha", "Apeksha");
      await seedProject(db, "project-x", "Project X");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: "user-1",
        outputId: "summary-output",
        createTasks: true,
        runtimeContext: {},
        items: [
          outputItem({
            sectionKey: "highlights",
            title: "Project X task QA kicked off",
            summary: "Project X is the parent for this QA run. parentEntityId: project-x.",
            label: "highlight",
            structuredPayload: { sourceLabels: ["#summary-room"] },
          }),
          outputItem({
            sectionKey: "action_items",
            title: "Apeksha: prepare Project X onboarding checklist",
            summary: "Apeksha owns the onboarding checklist for Project X.",
            label: "action_item",
            structuredPayload: { sourceLabels: ["#summary-room"], messageIds: [101, 102], owner: "Apeksha" },
          }),
        ],
      });

      const task = await db.selectFrom("tasks").selectAll().where("source", "=", "summary").executeTakeFirstOrThrow();
      const evidence = await db
        .selectFrom("task_evidence")
        .selectAll()
        .where("task_id", "=", task.id)
        .orderBy("ref_id", "asc")
        .execute();

      expect(task).toMatchObject({
        parent_entity_id: "project-x",
        parent_name: "Project X",
        title: "Apeksha: prepare Project X onboarding checklist",
        status: "open",
        status_authority: "local",
      });
      expect(evidence).toEqual([
        { task_id: task.id, kind: "conversation_message", ref_id: "101" },
        { task_id: task.id, kind: "conversation_message", ref_id: "102" },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("does not apply an output-level parent hint when multiple parents are present", async () => {
    const db = await createTestDb();
    try {
      await seedUser(db);
      await seedAssignablePerson(db, "tanush", "Tanush");
      await seedProject(db, "project-x", "Project X");
      await seedProject(db, "project-y", "Project Y");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: "user-1",
        outputId: "multi-parent-output",
        createTasks: true,
        runtimeContext: {},
        items: [
          outputItem({
            sectionKey: "highlights",
            title: "Project X update",
            summary: "Project X parentEntityId: project-x.",
            label: "highlight",
          }),
          outputItem({
            sectionKey: "decisions",
            title: "Project Y update",
            summary: "Project Y parentEntityId: project-y.",
            label: "decision",
          }),
          outputItem({
            sectionKey: "action_items",
            title: "Tanush: follow up on the ambiguous project note",
            summary: "The project was not explicit on this action item.",
            label: "action_item",
            structuredPayload: { sourceLabels: ["#summary-room"], owner: "Tanush" },
          }),
        ],
      });

      const task = await db.selectFrom("tasks").selectAll().where("source", "=", "summary").executeTakeFirstOrThrow();

      expect(task).toMatchObject({
        parent_entity_id: null,
        parent_name: null,
        title: "Tanush: follow up on the ambiguous project note",
      });
    } finally {
      await db.destroy();
    }
  });

  it("promotes extraction-only task candidates as summary tasks", async () => {
    const db = await createTestDb();
    try {
      await seedUser(db);
      await seedAssignablePerson(db, "mina", "Mina");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: "user-1",
        outputId: "summary-output",
        createTasks: true,
        runtimeContext: {},
        items: [
          outputItem({
            sectionKey: "task_candidates",
            title: "Mina: send the launch checklist",
            summary: "Mina committed to send the launch checklist.",
            priority: "high",
            label: "action_item",
            structuredPayload: { sourceLabels: ["#summary-room"], messageIds: [201, 202], owner: "Mina" },
          }),
        ],
      });

      const task = await db.selectFrom("tasks").selectAll().where("source", "=", "summary").executeTakeFirstOrThrow();
      const evidence = await db
        .selectFrom("task_evidence")
        .select(["kind", "ref_id"])
        .where("task_id", "=", task.id)
        .orderBy("ref_id", "asc")
        .execute();

      expect(task).toMatchObject({
        title: "Mina: send the launch checklist",
        priority: "high",
        provenance: "summary",
        status: "open",
        status_authority: "local",
      });
      expect(evidence).toEqual([
        { kind: "conversation_message", ref_id: "201" },
        { kind: "conversation_message", ref_id: "202" },
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("promotes task candidates instead of visible action items when both are present", async () => {
    const db = await createTestDb();
    try {
      await seedUser(db);
      await seedAssignablePerson(db, "vedant", "Vedant");
      await seedAssignablePerson(db, "tanush", "Tanush");
      await seedProject(db, "linkedin-workflow-connect", "Linkedin Workflow Connect");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: "user-1",
        outputId: "summary-output",
        createTasks: true,
        runtimeContext: {},
        items: [
          outputItem({
            sectionKey: "action_items",
            title: "Vedant to integrate Aimfox into the LinkedIn Workflow",
            summary: "Vedant owns the Aimfox integration.",
            label: "action_item",
            structuredPayload: { parentName: "LinkedIn Workflow", messageIds: [301] },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Integrate Aimfox into LinkedIn Workflow",
            summary: "Vedant owns the Aimfox integration.",
            label: "action_item",
            structuredPayload: { messageIds: [301], owner: "Vedant" },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Build LinkedIn scraper using Bright Data",
            summary: "Tanush is working on the scraper.",
            label: "action_item",
            structuredPayload: { messageIds: [302], owner: "Tanush" },
          }),
        ],
      });

      const tasks = await db.selectFrom("tasks").selectAll().orderBy("title", "asc").execute();

      expect(tasks.map((task) => task.title)).toEqual([
        "Build LinkedIn scraper using Bright Data",
        "Integrate Aimfox into LinkedIn Workflow",
      ]);
      expect(tasks).toEqual([
        expect.objectContaining({ parent_entity_id: "linkedin-workflow-connect" }),
        expect.objectContaining({ parent_entity_id: "linkedin-workflow-connect" }),
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("creates a durable task with evidence from a candidate, transitions, and replays without duplicates", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await seedAssignablePerson(db, "mina", "Mina");
      const conversationId = await seedConversation(db);
      await seedMessage(db, conversationId, {
        id: "task-change-message",
        text: "Mina will send the revised proposal.",
        receivedAt: "2026-07-01T17:00:00.000Z",
      });
      const message = await db
        .selectFrom("conversation_messages")
        .select("id")
        .where("provider_message_id", "=", "task-change-message")
        .executeTakeFirstOrThrow();
      const runtimeContext = await buildConversationSummaryRuntimeContext({
        db,
        user,
        outputDate: "2026-07-01",
        timezone: "UTC",
        now: NOW,
        adminCanReadAllFiles: false,
        contentUserEmails: ["user@example.com"],
        agentConfig: {
          enabledSections: {},
          maxItemsPerSection: 5,
          focus: null,
          delivery: null,
          sources: [source()],
          sourceKey: "slack:channel:C_SUMMARY",
          routeId: "summary-route",
          createTasks: true,
        },
      });
      await db
        .insertInto("agent_outputs")
        .values({
          id: "summary-output-diff",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          output_date: "2026-07-01",
          source_key: "slack:channel:C_SUMMARY",
          source_label: "#summary-room",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: "test",
          generated_at: NOW.toISOString(),
        })
        .execute();

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "summary-output-diff",
        createTasks: true,
        runtimeContext,
        items: [
          outputItem({
            sectionKey: "task_candidates",
            title: "Mina: send the revised proposal",
            summary: "Mina committed to send the revised proposal.",
            label: "action_item",
            structuredPayload: {
              messageIds: [message.id, String(message.id), message.id],
              assigneeName: "Mina",
            },
          }),
        ],
      });

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "summary-output-diff",
        createTasks: true,
        runtimeContext,
        items: [
          outputItem({
            sectionKey: "task_candidates",
            title: "Mina: send the revised proposal",
            summary: "Mina committed to send the revised proposal.",
            label: "action_item",
            structuredPayload: {
              messageIds: [message.id],
              assigneeName: "Mina",
            },
          }),
        ],
      });

      const tasks = await db.selectFrom("tasks").selectAll().execute();
      expect(tasks).toHaveLength(1);
      const [task] = tasks;
      expect(task).toMatchObject({
        title: "Mina: send the revised proposal",
        source_platform: "slack",
        source_conversation_id: conversationId,
        source_provider_thread_id: null,
        origin_agent_output_id: "summary-output-diff",
      });
      await expect(db.selectFrom("task_message_evidence").selectAll().execute()).resolves.toEqual([
        expect.objectContaining({
          task_id: task.id,
          conversation_message_id: message.id,
          source_anchor_key: `slack:${conversationId}:root`,
        }),
      ]);
      await expect(
        db
          .selectFrom("task_durability_route_state")
          .select(["mode", "seed_state", "incremental_success_at"])
          .where("route_id", "=", "summary-route")
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        mode: "durable_only",
        seed_state: "reviewed",
        incremental_success_at: expect.any(String),
      });
    } finally {
      await db.destroy();
    }
  });

  it("deduplicates equivalent new inputs while preserving same-message tasks with different owners", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await seedAssignablePerson(db, "mina", "Mina");
      await seedAssignablePerson(db, "tanush", "Tanush");
      const conversationId = await seedConversation(db);
      await seedMessage(db, conversationId, {
        id: "shared-task-message",
        text: "Mina and Tanush each accepted a follow-up.",
        receivedAt: "2026-07-01T17:00:00.000Z",
      });
      const message = await db
        .selectFrom("conversation_messages")
        .select("id")
        .where("provider_message_id", "=", "shared-task-message")
        .executeTakeFirstOrThrow();
      const runtimeContext = await buildConversationSummaryRuntimeContext({
        db,
        user,
        outputDate: "2026-07-01",
        timezone: "UTC",
        now: NOW,
        adminCanReadAllFiles: false,
        contentUserEmails: ["user@example.com"],
        agentConfig: {
          enabledSections: {},
          maxItemsPerSection: 5,
          focus: null,
          delivery: null,
          sources: [source()],
          sourceKey: "slack:channel:C_SUMMARY",
          routeId: "identity-dedup-route",
          createTasks: true,
        },
      });
      await seedAgentOutput(db, "identity-dedup-output", user.id);

      const minaItem = outputItem({
        sectionKey: "task_candidates",
        title: "Send the candidate list",
        summary: "Mina accepted the follow-up.",
        label: "action_item",
        structuredPayload: { messageIds: [message.id], owner: "Mina" },
      });
      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "identity-dedup-output",
        createTasks: true,
        runtimeContext,
        items: [
          outputItem({
            sectionKey: "task_changes",
            title: "Send the candidate list",
            summary: "Mina accepted the follow-up.",
            label: "action_item",
            structuredPayload: { changeKind: "new", messageIds: [message.id], assigneeName: "Mina" },
          }),
          minaItem,
          outputItem({
            ...minaItem,
            structuredPayload: { messageIds: [String(message.id), message.id], assigneeName: "Mina" },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Send the candidate list",
            summary: "Tanush accepted a separate follow-up from the same message.",
            label: "action_item",
            structuredPayload: { messageIds: [message.id], owner: "Tanush" },
          }),
        ],
      });

      const tasks = await db.selectFrom("tasks").select(["title", "assignee_name", "proposed_assignee_name"]).execute();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => task.assignee_name ?? task.proposed_assignee_name).sort()).toEqual(["Mina", "Tanush"]);
      await expect(db.selectFrom("task_message_evidence").selectAll().execute()).resolves.toHaveLength(2);
    } finally {
      await db.destroy();
    }
  });

  it("applies changed and resolved verdicts before replay-deduping candidates and creating new work", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await seedAssignablePerson(db, "mina", "Mina");
      await seedAssignablePerson(db, "tanush", "Tanush");
      const conversationId = await seedConversation(db);
      for (const [id, text] of [
        ["initial-change", "Mina will prepare the launch plan."],
        ["initial-resolve", "Tanush will close the vendor review."],
        ["changed-evidence", "Mina will prepare the revised launch plan by 2026-07-08."],
        ["resolved-evidence", "Tanush finished the vendor review."],
        ["new-evidence", "Mina will send the rollout note."],
      ]) {
        await seedMessage(db, conversationId, { id, text, receivedAt: "2026-07-01T17:00:00.000Z" });
      }
      const messageRows = await db
        .selectFrom("conversation_messages")
        .select(["id", "provider_message_id"])
        .where("conversation_id", "=", conversationId)
        .execute();
      const messageId = new Map(messageRows.map((message) => [message.provider_message_id, message.id]));
      const runtimeContext = await buildConversationSummaryRuntimeContext({
        db,
        user,
        outputDate: "2026-07-01",
        timezone: "UTC",
        now: NOW,
        adminCanReadAllFiles: false,
        contentUserEmails: ["user@example.com"],
        agentConfig: {
          enabledSections: {},
          maxItemsPerSection: 5,
          focus: null,
          delivery: null,
          sources: [source()],
          sourceKey: "slack:channel:C_SUMMARY",
          routeId: "day-n-route",
          createTasks: true,
        },
      });
      await seedAgentOutput(db, "day-n-output", user.id);
      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "day-n-output",
        createTasks: true,
        runtimeContext,
        items: [
          outputItem({
            sectionKey: "task_candidates",
            title: "Prepare the launch plan",
            label: "action_item",
            structuredPayload: { messageIds: [messageId.get("initial-change")], owner: "Mina" },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Close the vendor review",
            label: "action_item",
            structuredPayload: { messageIds: [messageId.get("initial-resolve")], owner: "Tanush" },
          }),
        ],
      });
      const initialTasks = await db.selectFrom("tasks").select(["id", "title"]).execute();
      const taskId = new Map(initialTasks.map((task) => [task.title, task.id]));
      const taskMemory = await createConversationFollowupsRepository(db).loadTaskMemory({
        userId: user.id,
        conversationIds: [conversationId],
      });

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "day-n-output",
        createTasks: true,
        runtimeContext: { ...runtimeContext, taskMemory },
        items: [
          outputItem({
            sectionKey: "task_changes",
            title: "Prepare the revised launch plan",
            label: "action_item",
            structuredPayload: {
              changeKind: "changed",
              matchedTaskId: taskId.get("Prepare the launch plan"),
              messageIds: [messageId.get("changed-evidence")],
              assigneeName: "Mina",
              dueAt: "2026-07-08",
            },
          }),
          outputItem({
            sectionKey: "task_changes",
            title: "Close the vendor review",
            summary: "The vendor review is complete.",
            label: "action_item",
            structuredPayload: {
              changeKind: "resolved",
              matchedTaskId: taskId.get("Close the vendor review"),
              messageIds: [messageId.get("resolved-evidence")],
              rationale: "Tanush reported the review complete.",
              assigneeName: "Tanush",
            },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Prepare the revised launch plan",
            label: "action_item",
            structuredPayload: { messageIds: [messageId.get("changed-evidence")], owner: "Mina" },
          }),
          outputItem({
            sectionKey: "task_candidates",
            title: "Send the rollout note",
            label: "action_item",
            structuredPayload: { messageIds: [messageId.get("new-evidence")], owner: "Mina" },
          }),
        ],
      });

      const tasks = await db.selectFrom("tasks").select(["id", "title", "due_at"]).orderBy("title").execute();
      expect(tasks).toHaveLength(3);
      expect(tasks.map((task) => task.title)).toEqual([
        "Close the vendor review",
        "Prepare the revised launch plan",
        "Send the rollout note",
      ]);
      expect(tasks.find((task) => task.title === "Prepare the revised launch plan")?.due_at).toBe("2026-07-08");
      await expect(db.selectFrom("task_message_evidence").selectAll().execute()).resolves.toHaveLength(5);
      await expect(db.selectFrom("task_completion_recommendations").selectAll().execute()).resolves.toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  it("keeps the durability route hybrid when any emitted task change is malformed or rejected", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await seedAssignablePerson(db, "mina", "Mina");
      const conversationId = await seedConversation(db);
      await seedMessage(db, conversationId, {
        id: "mixed-task-change-message",
        text: "Mina will send the revised proposal.",
        receivedAt: "2026-07-01T17:00:00.000Z",
      });
      const message = await db
        .selectFrom("conversation_messages")
        .select("id")
        .where("provider_message_id", "=", "mixed-task-change-message")
        .executeTakeFirstOrThrow();
      const runtimeContext = await buildConversationSummaryRuntimeContext({
        db,
        user,
        outputDate: "2026-07-01",
        timezone: "UTC",
        now: NOW,
        adminCanReadAllFiles: false,
        contentUserEmails: ["user@example.com"],
        agentConfig: {
          enabledSections: {},
          maxItemsPerSection: 5,
          focus: null,
          delivery: null,
          sources: [source()],
          sourceKey: "slack:channel:C_SUMMARY",
          routeId: "mixed-signal-route",
          createTasks: true,
        },
      });
      await db
        .insertInto("agent_outputs")
        .values({
          id: "mixed-signal-output",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          output_date: "2026-07-01",
          source_key: "slack:channel:C_SUMMARY",
          source_label: "#summary-room",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: "test",
          generated_at: NOW.toISOString(),
        })
        .execute();

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "mixed-signal-output",
        createTasks: true,
        runtimeContext,
        items: [
          outputItem({
            sectionKey: "task_changes",
            title: "Mina: send the revised proposal",
            summary: "Mina committed to send the revised proposal.",
            label: "action_item",
            structuredPayload: {
              changeKind: "new",
              messageIds: [message.id],
              assigneeName: "Mina",
            },
          }),
          outputItem({
            sectionKey: "task_changes",
            title: "Malformed task change",
            summary: "This emitted change is missing evidence.",
            label: "action_item",
            structuredPayload: {
              changeKind: "new",
            },
          }),
          outputItem({
            sectionKey: "task_changes",
            title: "Rejected task change",
            summary: "This emitted change references a task outside memory.",
            label: "action_item",
            structuredPayload: {
              changeKind: "changed",
              matchedTaskId: "not-in-task-memory",
              messageIds: [message.id],
            },
          }),
        ],
      });

      await expect(db.selectFrom("tasks").select("title").execute()).resolves.toEqual([
        { title: "Mina: send the revised proposal" },
      ]);
      await expect(
        db
          .selectFrom("task_durability_route_state")
          .select(["mode", "incremental_success_at"])
          .where("route_id", "=", "mixed-signal-route")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ mode: "hybrid", incremental_success_at: null });
    } finally {
      await db.destroy();
    }
  });

  it.each([
    {
      missingAllowlist: "messages",
      allowedMessageIds: [],
      allowedConversationIds: [41],
    },
    {
      missingAllowlist: "conversations",
      allowedMessageIds: [41],
      allowedConversationIds: [],
    },
  ])(
    "keeps the durability route hybrid when parsed task changes have no allowed $missingAllowlist",
    async ({ missingAllowlist, allowedMessageIds, allowedConversationIds }) => {
      const db = await createTestDb();
      try {
        const user = await seedUser(db);
        const routeId = `missing-${missingAllowlist}-route`;
        await db
          .insertInto("task_durability_route_state")
          .values({
            agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
            user_id: user.id,
            route_id: routeId,
            source_key: "slack:channel:C_SUMMARY",
            mode: "hybrid",
            seed_state: "reviewed",
            seed_started_at: NOW.toISOString(),
            seed_reviewed_at: NOW.toISOString(),
            incremental_success_at: null,
            last_error: null,
          })
          .execute();
        const logger = createTestLogger();
        const warn = vi.spyOn(logger, "warn");

        await conversationSummaryDefinition.onOutputSaved?.({
          db,
          config: createTestConfig(),
          logger,
          userId: user.id,
          outputId: `missing-${missingAllowlist}-output`,
          createTasks: true,
          runtimeContext: {
            durabilityRouteId: routeId,
            durabilitySourceKey: "slack:channel:C_SUMMARY",
            allowedMessageIds,
            allowedConversationIds,
            taskMemory: [],
          },
          items: [
            outputItem({
              sectionKey: "task_changes",
              title: "Mina: send the revised proposal",
              summary: "Mina committed to send the revised proposal.",
              label: "action_item",
              structuredPayload: {
                changeKind: "new",
                messageIds: [41],
                assigneeName: "Mina",
              },
            }),
          ],
        });

        await expect(db.selectFrom("tasks").selectAll().execute()).resolves.toEqual([]);
        await expect(
          db
            .selectFrom("task_durability_route_state")
            .select(["mode", "incremental_success_at"])
            .where("route_id", "=", routeId)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ mode: "hybrid", incremental_success_at: null });
        expect(warn).toHaveBeenCalledWith(
          {
            outputId: `missing-${missingAllowlist}-output`,
            userId: user.id,
            routeId,
          },
          "Summarizer: durability output omitted a valid task diff",
        );
      } finally {
        await db.destroy();
      }
    },
  );

  it("records durability success for a genuine empty output with no task signals", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await db
        .insertInto("task_durability_route_state")
        .values({
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          route_id: "empty-output-route",
          source_key: "slack:channel:C_SUMMARY",
          mode: "hybrid",
          seed_state: "reviewed",
          seed_started_at: NOW.toISOString(),
          seed_reviewed_at: NOW.toISOString(),
          incremental_success_at: null,
          last_error: null,
        })
        .execute();
      const logger = createTestLogger();
      const warn = vi.spyOn(logger, "warn");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger,
        userId: user.id,
        outputId: "empty-output",
        createTasks: true,
        runtimeContext: {
          durabilityRouteId: "empty-output-route",
          durabilitySourceKey: "slack:channel:C_SUMMARY",
          allowedMessageIds: [],
          allowedConversationIds: [],
          taskMemory: [],
        },
        items: [],
      });

      await expect(
        db
          .selectFrom("task_durability_route_state")
          .select(["mode", "incremental_success_at"])
          .where("route_id", "=", "empty-output-route")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        mode: "durable_only",
        incremental_success_at: expect.any(String),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it("records durability success when visible action items produce an empty task diff", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await db
        .insertInto("task_durability_route_state")
        .values({
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          route_id: "visible-only-output-route",
          source_key: "slack:channel:C_SUMMARY",
          mode: "hybrid",
          seed_state: "reviewed",
          seed_started_at: NOW.toISOString(),
          seed_reviewed_at: NOW.toISOString(),
          incremental_success_at: null,
          last_error: null,
        })
        .execute();
      const logger = createTestLogger();
      const warn = vi.spyOn(logger, "warn");

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger,
        userId: user.id,
        outputId: "visible-only-output",
        createTasks: true,
        runtimeContext: {
          durabilityRouteId: "visible-only-output-route",
          durabilitySourceKey: "slack:channel:C_SUMMARY",
          allowedMessageIds: [],
          allowedConversationIds: [],
          taskMemory: [],
        },
        items: [
          outputItem({
            sectionKey: "action_items",
            title: "Keep an eye on the rollout",
            summary: "The rollout may need attention, but nobody owns a concrete follow-up.",
            label: "action_item",
          }),
        ],
      });

      await expect(db.selectFrom("tasks").selectAll().execute()).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("task_durability_route_state")
          .select(["mode", "incremental_success_at"])
          .where("route_id", "=", "visible-only-output-route")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        mode: "durable_only",
        incremental_success_at: expect.any(String),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  });

  it("does not fall back to unanchored legacy promotion for a durability-enabled run", async () => {
    const db = await createTestDb();
    try {
      const user = await seedUser(db);
      await db
        .insertInto("task_durability_route_state")
        .values({
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          route_id: "summary-route",
          source_key: "slack:channel:C_SUMMARY",
          mode: "hybrid",
          seed_state: "reviewed",
          seed_started_at: NOW.toISOString(),
          seed_reviewed_at: NOW.toISOString(),
          incremental_success_at: null,
          last_error: null,
        })
        .execute();

      await conversationSummaryDefinition.onOutputSaved?.({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        userId: user.id,
        outputId: "durability-output-without-diff",
        createTasks: true,
        runtimeContext: {
          durabilityRouteId: "summary-route",
          durabilitySourceKey: "slack:channel:C_SUMMARY",
          allowedMessageIds: [],
          allowedConversationIds: [],
          taskMemory: [],
        },
        items: [
          outputItem({
            sectionKey: "task_candidates",
            title: "Legacy-only candidate",
            summary: "This item has no validated conversation evidence.",
            label: "action_item",
          }),
        ],
      });

      await expect(db.selectFrom("tasks").selectAll().execute()).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("task_durability_route_state")
          .select(["mode", "incremental_success_at"])
          .where("route_id", "=", "summary-route")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ mode: "hybrid", incremental_success_at: null });
    } finally {
      await db.destroy();
    }
  });

  it("instructs the model to emit extraction-only task candidates when task creation is enabled", () => {
    const instructions = conversationSummaryDefinition.buildInstructions();

    expect(instructions).toContain("New tasks belong only in task_candidates");
    expect(instructions).toContain("task_changes: internal extraction-only changed or resolved verdicts");
    expect(instructions).toContain("changeKind ('changed' or 'resolved')");
    expect(instructions).toContain("at least one valid message id in messageIds");
    expect(instructions).toContain("Do not limit task_candidates to maxItemsPerSection");
    expect(instructions).toContain("hypothetical, conditional, speculative, or sizing statements");
    expect(instructions).toContain("If a question is answered later in the same window, emit no task");
    expect(instructions).toContain("carried out, reported on, superseded, completed, or canceled");
    expect(instructions).toContain("Never merge across conversations or Slack root/thread anchors");
    expect(instructions).toContain("person who committed to the work, not the person who asked");
    expect(instructions).toContain("Aim for precision, not coverage");
    expect(instructions).toContain("When in doubt, do not emit it");
    expect(instructions).toContain("Emit a task_candidates item only when ALL of these hold");
    expect(instructions).toContain("waiting on someone else");
    expect(instructions).toContain("depends on an earlier step that has not happened yet");
    expect(instructions).not.toContain("prefer internal `task_changes` items over task_candidates");
    expect(instructions).not.toContain("changeKind ('new', 'changed', or 'resolved')");
    expect(instructions).not.toContain("be exhaustive across distinct");
  });
});

describe("buildConversationSummaryRuntimeContext", () => {
  let db: Kysely<DB>;
  let user: Selectable<UsersTable>;

  beforeEach(async () => {
    db = await createTestDb();
    user = await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("uses a 24 hour first-run window and excludes bot messages", async () => {
    const conversationId = await seedConversation(db);
    await seedMessage(db, conversationId, {
      id: "m-old",
      text: "outside window",
      receivedAt: "2026-06-30T17:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-new",
      text: "Launch decision is ready",
      receivedAt: "2026-07-01T10:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-bot",
      text: "Previous summary",
      receivedAt: "2026-07-01T11:00:00.000Z",
      isBot: true,
    });

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
        sourceKey: "slack:channel:C_SUMMARY",
        deliveryPlatform: "whatsapp",
        createTasks: false,
      },
    });

    expect(context.summaryWindow).toMatchObject({
      mode: "first_run_last_24h",
      start: "2026-06-30T18:00:00.000Z",
      end: "2026-07-01T18:00:00.000Z",
    });
    expect(context.deliveryPlatform).toBe("whatsapp");
    expect(context.summarySources).toEqual([
      expect.objectContaining({
        label: "#summary-room",
        conversationId,
        messageCount: 1,
        messages: [expect.objectContaining({ text: "Launch decision is ready" })],
      }),
    ]);
  });

  it("loads an owned WhatsApp DM by opaque conversation id and keeps task evidence normalized", async () => {
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: "whatsapp",
        kind: "dm",
        provider_conversation_id: "dm:+15551234567",
        display_name: "+15551234567",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await seedMessage(db, conversation.id, {
      id: "dm-task-message",
      text: "Mina will send the revised proposal.",
      receivedAt: "2026-07-01T17:00:00.000Z",
    });
    const message = await db
      .selectFrom("conversation_messages")
      .select("id")
      .where("provider_message_id", "=", "dm-task-message")
      .executeTakeFirstOrThrow();
    const dmSource = {
      platform: "whatsapp",
      targetType: "dm",
      targetId: String(conversation.id),
      label: "WhatsApp DM with Agent User",
    } as unknown as AgentSourceConfig;
    const sourceKey = `whatsapp:dm:${conversation.id}`;
    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [dmSource],
        sourceKey,
        routeId: sourceKey,
        createTasks: true,
      },
    });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "whatsapp-dm-output",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: "2026-07-01",
        source_key: sourceKey,
        source_label: "WhatsApp DM with Agent User",
        timezone: "UTC",
        status: "completed",
        trigger_type: "manual",
        agent_version: "test",
        generated_at: NOW.toISOString(),
      })
      .execute();

    expect(context.summarySources).toEqual([
      expect.objectContaining({
        platform: "whatsapp",
        targetType: "dm",
        targetId: String(conversation.id),
        label: "WhatsApp DM with Agent User",
        conversationId: conversation.id,
        messages: [expect.objectContaining({ id: message.id, text: "Mina will send the revised proposal." })],
      }),
    ]);
    expect(JSON.stringify(context.summarySources)).not.toContain("15551234567");

    await conversationSummaryDefinition.onOutputSaved?.({
      db,
      config: createTestConfig(),
      logger: createTestLogger(),
      userId: user.id,
      outputId: "whatsapp-dm-output",
      createTasks: true,
      runtimeContext: context,
      items: [
        outputItem({
          sectionKey: "task_changes",
          title: "Mina: send the revised proposal",
          summary: "Mina committed to send the revised proposal.",
          label: "action_item",
          structuredPayload: {
            changeKind: "new",
            messageIds: [message.id],
            assigneeName: "Mina",
          },
        }),
      ],
    });

    await expect(db.selectFrom("task_message_evidence").selectAll().executeTakeFirstOrThrow()).resolves.toMatchObject({
      conversation_message_id: message.id,
      source_anchor_key: `whatsapp:${conversation.id}:root`,
    });
  });

  it("keeps the newest capped messages in chronological order when a source is truncated", async () => {
    const conversationId = await seedConversation(db);
    const firstReceivedAt = new Date("2026-07-01T00:00:00.000Z").getTime();
    const totalMessages = CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE + 5;
    for (let index = 0; index < totalMessages; index += 1) {
      await seedMessage(db, conversationId, {
        id: `m-${String(index).padStart(3, "0")}`,
        text: `message ${String(index).padStart(3, "0")}`,
        receivedAt: new Date(firstReceivedAt + index * 60_000).toISOString(),
      });
    }

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
        sourceKey: "slack:channel:C_SUMMARY",
        createTasks: false,
      },
    });

    const [summarySource] = context.summarySources as Array<{
      messageCount: number;
      truncated: boolean;
      messages: Array<{ text: string }>;
    }>;

    expect(summarySource).toMatchObject({
      messageCount: CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE,
      truncated: true,
    });
    expect(summarySource.messages[0]).toMatchObject({ text: "message 005" });
    expect(summarySource.messages.at(-1)).toMatchObject({ text: "message 304" });
  });

  it("uses the previous summary window end as the next window start", async () => {
    const conversationId = await seedConversation(db);
    await db
      .insertInto("agent_outputs")
      .values({
        id: "summary-prev",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: "2026-07-01",
        source_key: "slack:channel:C_SUMMARY",
        source_label: "#summary-room",
        timezone: "UTC",
        status: "completed",
        trigger_type: "scheduled",
        agent_version: "test",
        generated_at: "2026-07-01T12:05:00.000Z",
        raw_payload_json: JSON.stringify({
          summaryWindow: {
            start: "2026-07-01T11:00:00.000Z",
            end: "2026-07-01T12:00:00.000Z",
          },
        }),
      })
      .execute();
    await seedMessage(db, conversationId, {
      id: "m-before",
      text: "already summarized",
      receivedAt: "2026-07-01T11:00:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-during-completion",
      text: "arrived while the prior summary was still writing",
      receivedAt: "2026-07-01T12:03:00.000Z",
    });
    await seedMessage(db, conversationId, {
      id: "m-after",
      text: "later unblocker",
      receivedAt: "2026-07-01T12:30:00.000Z",
    });

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
        sourceKey: "slack:channel:C_SUMMARY",
        createTasks: false,
      },
    });

    expect(context.summaryWindow).toMatchObject({
      mode: "since_last_successful_run",
      start: "2026-07-01T12:00:00.000Z",
      previousOutputId: "summary-prev",
    });
    expect(context.summarySources).toEqual([
      expect.objectContaining({
        messageCount: 2,
        messages: [
          expect.objectContaining({ text: "arrived while the prior summary was still writing" }),
          expect.objectContaining({ text: "later unblocker" }),
        ],
      }),
    ]);
  });

  it("floors a manual weekly run to the frequency period even when a recent watermark exists", async () => {
    const conversationId = await seedConversation(db);
    await db
      .insertInto("agent_outputs")
      .values({
        id: "summary-recent",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: "2026-07-01",
        source_key: "slack:channel:C_SUMMARY",
        source_label: "#summary-room",
        timezone: "UTC",
        status: "completed",
        trigger_type: "manual",
        agent_version: "test",
        generated_at: "2026-07-01T17:05:00.000Z",
        raw_payload_json: JSON.stringify({
          summaryWindow: { start: "2026-07-01T16:00:00.000Z", end: "2026-07-01T17:00:00.000Z" },
        }),
      })
      .execute();
    await seedMessage(db, conversationId, {
      id: "m-earlier-week",
      text: "earlier this week, before the last run",
      receivedAt: "2026-06-28T09:00:00.000Z",
    });

    const context = await buildConversationSummaryRuntimeContext({
      db,
      user,
      outputDate: "2026-07-01",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["user@example.com"],
      agentConfig: {
        enabledSections: {},
        maxItemsPerSection: 5,
        focus: null,
        delivery: null,
        sources: [source()],
        sourceKey: "slack:channel:C_SUMMARY",
        firstRunLookbackHours: 168,
        floorWindowToPeriod: true,
        createTasks: false,
      },
    });

    expect(context.summaryWindow).toMatchObject({
      mode: "floored_to_last_168h",
      start: "2026-06-24T18:00:00.000Z",
      previousOutputId: "summary-recent",
    });
    expect(context.summarySources).toEqual([
      expect.objectContaining({
        messageCount: 1,
        messages: [expect.objectContaining({ text: "earlier this week, before the last run" })],
      }),
    ]);
  });
});

import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputItemInput, AgentSourceConfig } from "../../db/repositories/agent-outputs";
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

describe("conversationSummaryDefinition", () => {
  it("is registered as a source-configurable summarizer", () => {
    expect(conversationSummaryDefinition.key).toBe(CONVERSATION_SUMMARY_AGENT_KEY);
    expect(conversationSummaryDefinition.sourceConfig).toMatchObject({
      supportsSlackChannels: true,
      supportsWhatsAppGroups: true,
    });
    expect(conversationSummaryDefinition.requiresKnowledgeRefs).toBe(false);
    expect(conversationSummaryDefinition.usesContextAuthority).toBe(true);
  });

  it("suppresses only obsolete connection-only items and logs an aggregate count", async () => {
    const db = await createTestDb();
    const connectedApp = {
      key: "integration:gmail",
      names: ["gmail"],
      aliases: ["gmail"],
      source: "integration",
      updatedAt: NOW.toISOString(),
    };
    const items = [
      outputItem({
        sectionKey: "task_candidates",
        title: "Reconnect Gmail",
        summary: "Gmail is not connected.",
        label: "action_item",
      }),
      outputItem({
        title: "Connection correction",
        summary: "The previous summary was stale; Gmail is already connected.",
      }),
      outputItem({
        title: "Gmail is not connected and Acme renewal is at risk",
        summary: "Reconnect Gmail, and ask the account owner to review the renewal.",
      }),
    ];
    const info = vi.fn();
    try {
      const result = await conversationSummaryDefinition.reconcileItems?.({
        db,
        items,
        runtimeContext: {
          contextAuthority: {
            capturedAt: NOW.toISOString(),
            connectors: { status: "absent", apps: [] },
            integrations: { status: "available", apps: [connectedApp] },
            connectedApps: [connectedApp],
          },
        },
        logger: { info } as never,
      });

      expect(result?.map((item) => item.title)).toEqual([
        "Connection correction",
        "Gmail is not connected and Acme renewal is at risk",
      ]);
      expect(info).toHaveBeenCalledWith(
        {
          event: "agent_context_authority_reconciliation",
          agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
          suppressedCount: 1,
        },
        "Agent: context authority reconciliation complete",
      );
      const serializedLogs = JSON.stringify(info.mock.calls);
      expect(serializedLogs).not.toContain("Gmail");
      expect(serializedLogs).not.toContain("Connect");
      expect(serializedLogs).not.toContain("Acme");
    } finally {
      await db.destroy();
    }
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

  it("instructs the model to emit extraction-only task candidates when task creation is enabled", () => {
    const instructions = conversationSummaryDefinition.buildInstructions();

    expect(instructions).toContain("task_candidates");
    expect(instructions).toContain("createTasks");
    expect(instructions).toContain("messageIds");
    expect(instructions).toContain("Do not limit task_candidates to maxItemsPerSection");
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

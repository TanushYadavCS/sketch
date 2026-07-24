import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { SlackBot } from "../slack/bot";
import { createTestDb, createTestLogger } from "../test-utils";
import { WHATSAPP_TEXT_LIMIT } from "../whatsapp/chunking";
import type { WhatsAppCapabilities } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { dailyBriefDefinition } from "./definitions/daily-brief";
import { createAgentOutputDeliveryService } from "./output-delivery";

const textOnlyCapabilities: WhatsAppCapabilities = {
  text: true,
  media: false,
  quotedReply: false,
  templates: false,
  templateProvisioning: "none",
  interactive: false,
  deliveryStatus: false,
  typing: false,
  reactions: false,
  edit: false,
  groups: false,
};

function createMockWhatsApp(overrides: Partial<WhatsAppRuntime> = {}): WhatsAppRuntime {
  return {
    isConnected: false,
    onMessage: vi.fn(),
    getCapabilities: vi.fn(() => ({ templates: true })),
    sendText: vi.fn(),
    sendTemplate: vi.fn(),
    sendFile: vi.fn(),
    startComposing: vi.fn(),
    stopComposing: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    downloadMedia: vi.fn(),
    getGroupMetadata: vi.fn(),
    resolveJidToPhone: vi.fn(),
    ...overrides,
  } as unknown as WhatsAppRuntime;
}

describe("createAgentOutputDeliveryService", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "user-delivery", name: "Delivery User" }).execute();
    await db
      .insertInto("agent_outputs")
      .values({
        id: "output-delivery",
        agent_key: dailyBriefDefinition.key,
        user_id: "user-delivery",
        output_date: "2026-06-26",
        timezone: "UTC",
        status: "completed",
        trigger_type: "scheduled",
        agent_version: dailyBriefDefinition.version,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("sends Slack delivery and records a sent attempt", async () => {
    const slack = {
      postMessage: vi.fn(async () => "123.456"),
      openDmChannel: vi.fn(),
    } as unknown as SlackBot;
    const whatsapp = createMockWhatsApp();
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => slack,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
        mentions: [{ platform: "slack", targetId: "UOWNER", label: "Owner" }],
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start here." },
        sections: {
          todos: [
            {
              id: "item-1",
              sectionKey: "todos",
              title: "Follow up",
              summary: "A customer asked for an update.",
              priority: "high",
              label: "todo",
              displayRef: null,
              actionType: "generic",
              actionLabel: "Plan with Sketch",
              actionPrompt: "Plan it.",
              sourceUrl: null,
              knowledgeRefs: { entityIds: ["entity-1"], fileIds: [] },
              structuredPayload: null,
              sortOrder: 0,
            },
          ],
          customer_updates: [],
          active_projects: [],
        },
      },
    });

    expect(slack.postMessage).toHaveBeenCalledWith("C_DAILY", expect.stringContaining("*Daily Brief | Jun 26*"));
    expect(slack.postMessage).toHaveBeenCalledWith("C_DAILY", expect.stringContaining("Cc: <@UOWNER>"));
    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("sent");
    expect(attempt.message_refs_json).toBe(JSON.stringify(["123.456"]));
    const captured = await db.selectFrom("conversation_messages").select(["text", "provider_message_id"]).execute();
    expect(captured).toHaveLength(1);
    expect(captured[0].provider_message_id).toBe("123.456");
  });

  it("rejects delivery requiring more than ten message chunks before sending", async () => {
    const slack = {
      postMessage: vi.fn(async () => "never-sent"),
      openDmChannel: vi.fn(),
    } as unknown as SlackBot;
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => slack,
      whatsapp: createMockWhatsApp(),
      settingsRepo: createSettingsRepository(db),
    });
    const sections = Array.from({ length: 120 }, (_, index) => ({
      key: `section-${index}`,
      title: `Section ${index}`,
      enabledByDefault: true,
      labels: ["item"],
    }));
    const outputSections = Object.fromEntries(
      sections.map((section) => [
        section.key,
        Array.from({ length: 10 }, (_, index) => ({
          id: `${section.key}-${index}`,
          sectionKey: section.key,
          title: `Title ${"T".repeat(90)}`,
          summary: `Summary ${"S".repeat(250)}`,
          priority: "medium" as const,
          label: "item",
          displayRef: null,
          actionType: "generic",
          actionLabel: null,
          actionPrompt: null,
          sourceUrl: null,
          knowledgeRefs: { entityIds: [], fileIds: [] },
          structuredPayload: null,
          sortOrder: index,
        })),
      ]),
    );

    await expect(
      service.deliver({
        definition: { ...dailyBriefDefinition, sections },
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "channel",
          targetId: "C_DAILY",
          label: "#daily",
        },
        output: {
          id: "output-delivery",
          userId: "user-delivery",
          agentKey: dailyBriefDefinition.key,
          outputDate: "2026-06-26",
          masthead: { title: "Daily Brief", summary: "Start here." },
          sections: outputSections,
        },
      }),
    ).rejects.toThrow("more than 10 message chunks");
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it("counts a looks-resolved recommendation after successful content delivery", async () => {
    const recommendationId = await seedRecommendation(db, "recommendation-delivered");
    const slack = {
      postMessage: vi.fn(async () => "123.789"),
      openDmChannel: vi.fn(),
    } as unknown as SlackBot;
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => slack,
      whatsapp: createMockWhatsApp(),
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
      output: recommendationOutput(recommendationId),
    });

    const recommendation = await db
      .selectFrom("task_completion_recommendations")
      .select("delivery_count")
      .where("id", "=", recommendationId)
      .executeTakeFirstOrThrow();
    const ledger = await db.selectFrom("task_completion_recommendation_deliveries").selectAll().execute();
    expect(recommendation.delivery_count).toBe(1);
    expect(ledger).toHaveLength(1);
  });

  it("counts a recommendation delivered to its internal assignee when another user created the task", async () => {
    await db
      .updateTable("users")
      .set({
        email: "delivery@example.com",
        email_verified_at: "2026-07-16T09:00:00.000Z",
      })
      .where("id", "=", "user-delivery")
      .execute();
    await db.insertInto("users").values({ id: "user-creator", name: "Creator" }).execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-delivery",
        name: "Delivery User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["delivery@example.com"]),
        metadata: JSON.stringify({ email: "delivery@example.com" }),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: "2026-07-16T09:00:00.000Z",
        updated_at: "2026-07-16T09:00:00.000Z",
        ai_brief: null,
      })
      .execute();
    const recommendationId = await seedRecommendation(db, "recommendation-assignee");
    await db
      .updateTable("tasks")
      .set({
        created_by_user_id: "user-creator",
        assignee_entity_id: "person-delivery",
        assignee_name: "Delivery User",
      })
      .where("id", "=", `task-${recommendationId}`)
      .execute();
    const slack = {
      postMessage: vi.fn(async () => "123.790"),
      openDmChannel: vi.fn(),
    } as unknown as SlackBot;
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => slack,
      whatsapp: createMockWhatsApp(),
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
      output: recommendationOutput(recommendationId),
    });

    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select("delivery_count")
        .where("id", "=", recommendationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ delivery_count: 1 });
  });

  it("keeps successful delivery sent while ignoring untrusted or invalid recommendation ids", async () => {
    await db.insertInto("users").values({ id: "user-other", name: "Other User" }).execute();
    const validId = await seedRecommendation(db, "recommendation-valid");
    const staleId = await seedRecommendation(db, "recommendation-stale");
    const foreignId = await seedRecommendation(db, "recommendation-foreign");
    const arbitrarySectionId = await seedRecommendation(db, "recommendation-arbitrary-section");
    const untrustedItemId = await seedRecommendation(db, "recommendation-untrusted-item");
    await db
      .updateTable("task_completion_recommendations")
      .set({ review_state: "confirmed" })
      .where("id", "=", staleId)
      .execute();
    await db
      .updateTable("tasks")
      .set({ created_by_user_id: "user-other" })
      .where("id", "=", `task-${foreignId}`)
      .execute();

    const slack = {
      postMessage: vi.fn(async () => "123.999"),
      openDmChannel: vi.fn(),
    } as unknown as SlackBot;
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => slack,
      whatsapp: createMockWhatsApp(),
      settingsRepo: createSettingsRepository(db),
    });
    const validItem = recommendationItem(validId, "valid-item");

    await expect(
      service.deliver({
        definition: dailyBriefDefinition,
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "channel",
          targetId: "C_DAILY",
          label: "#daily",
        },
        output: {
          ...recommendationOutput(validId),
          sections: {
            looks_resolved: [
              validItem,
              { ...validItem, id: "duplicate-valid-item" },
              recommendationItem(staleId, "stale-item"),
              recommendationItem(foreignId, "foreign-item"),
              recommendationItem("recommendation-does-not-exist", "missing-item"),
              {
                ...recommendationItem(untrustedItemId, "untrusted-item"),
                structuredPayload: { recommendationId: untrustedItemId, serverOwnedFollowup: false },
              },
            ],
            todos: [
              {
                ...recommendationItem(arbitrarySectionId, "arbitrary-section-item"),
                sectionKey: "todos",
                label: "todo",
              },
            ],
          },
        },
      }),
    ).resolves.toBeUndefined();

    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("sent");
    expect(attempt.message_refs_json).toBe(JSON.stringify(["123.999"]));
    const recommendations = await db
      .selectFrom("task_completion_recommendations")
      .select(["id", "delivery_count"])
      .orderBy("id")
      .execute();
    expect(
      Object.fromEntries(recommendations.map((recommendation) => [recommendation.id, recommendation.delivery_count])),
    ).toEqual({
      [arbitrarySectionId]: 0,
      [foreignId]: 0,
      [staleId]: 0,
      [untrustedItemId]: 0,
      [validId]: 1,
    });
    const ledger = await db
      .selectFrom("task_completion_recommendation_deliveries")
      .select("recommendation_id")
      .execute();
    expect(ledger).toEqual([{ recommendation_id: validId }]);
  });

  it("does not count a parked WhatsApp nudge as recommendation content delivery", async () => {
    const recommendationId = await seedRecommendation(db, "recommendation-parked");
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      getCapabilities: vi.fn(() => ({ ...textOnlyCapabilities, templates: true })),
      sendTemplate: vi.fn(async () => ({
        providerMessageId: "wa-nudge-followup",
        providerConversationId: "dm:+15551234567",
        providerTimestamp: "2026-07-16T10:00:00.000Z",
      })),
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: "dm:+15551234567",
        label: "Alice",
      },
      output: recommendationOutput(recommendationId),
    });

    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select("delivery_count")
        .where("id", "=", recommendationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ delivery_count: 0 });
    await expect(db.selectFrom("task_completion_recommendation_deliveries").selectAll().execute()).resolves.toEqual([]);
  });

  it("does not count WhatsApp content when the provider returns no message reference", async () => {
    const recommendationId = await seedRecommendation(db, "recommendation-missing-ref");
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendText: vi.fn(async () => ({
        providerMessageId: "",
        providerConversationId: "120363000000001@g.us",
        providerTimestamp: "2026-07-16T10:00:00.000Z",
      })),
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await expect(
      service.deliver({
        definition: dailyBriefDefinition,
        delivery: {
          enabled: true,
          platform: "whatsapp",
          targetType: "group",
          targetId: "120363000000001@g.us",
          label: "Leadership",
        },
        output: recommendationOutput(recommendationId),
      }),
    ).rejects.toThrow("message reference");

    await expect(
      db
        .selectFrom("task_completion_recommendations")
        .select("delivery_count")
        .where("id", "=", recommendationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ delivery_count: 0 });
    await expect(db.selectFrom("task_completion_recommendation_deliveries").selectAll().execute()).resolves.toEqual([]);
  });

  it("sends compact WhatsApp delivery and records the message ref", async () => {
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendText: vi.fn(async () => ({
        providerMessageId: "wa-message-1",
        providerConversationId: "120363000000001@g.us",
        providerTimestamp: "2024-06-04T07:20:00.000Z",
      })),
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Leadership",
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "x".repeat(8500) },
        sections: {},
      },
    });

    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(whatsapp.sendText).mock.calls) {
      expect(call[0]).toEqual({ kind: "group", groupId: "120363000000001@g.us" });
      expect(call[1].length).toBeLessThanOrEqual(4000);
      expect(call[1]).toContain("...");
    }

    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("sent");
    expect(attempt.message_refs_json).toBe(JSON.stringify(["wa-message-1"]));
    const captured = await db
      .selectFrom("conversation_messages")
      .select(["text", "provider_message_id"])
      .orderBy("provider_message_id")
      .execute();
    expect(captured.map((row) => row.provider_message_id)).toEqual(["wa-message-1"]);
    expect(captured.every((row) => row.text.length <= 4000)).toBe(true);
  });

  it("parks WhatsApp DM deliveries and sends a task nudge when no session window is open", async () => {
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendTemplate: vi.fn(async () => ({
        providerMessageId: "wa-nudge-1",
        providerConversationId: "dm:+15551234567",
        providerTimestamp: "2024-06-04T07:20:00.000Z",
      })),
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: "dm:+15551234567",
        label: "Alice",
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start here." },
        sections: {},
      },
    });

    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+15551234567" },
      expect.objectContaining({
        key: "whatsapp.task_nudge",
        params: { recipientName: "Alice" },
      }),
    );
    const inbox = await db.selectFrom("inbox_messages").selectAll().executeTakeFirstOrThrow();
    expect(inbox).toMatchObject({
      recipient_user_id: "user-delivery",
      sender_user_id: "user-delivery",
      kind: "workflow_output",
      platform: "whatsapp",
    });
    expect(inbox.message).toContain("Daily Brief");
    const captured = await db.selectFrom("conversation_messages").selectAll().execute();
    expect(captured).toHaveLength(0);
    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("sent");
    expect(attempt.message_refs_json).toBe(JSON.stringify(["wa-nudge-1"]));
  });

  it("parks WhatsApp teammate DM deliveries for the teammate recipient", async () => {
    await db
      .insertInto("users")
      .values({ id: "user-teammate", name: "Teammate", whatsapp_number: "+15557654321" })
      .execute();
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendTemplate: vi.fn(async () => ({
        providerMessageId: "wa-teammate-nudge-1",
        providerConversationId: "dm:+15557654321",
        providerTimestamp: "2024-06-04T07:20:00.000Z",
      })),
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: "dm:+15557654321",
        label: "Teammate",
        recipientUserId: "user-teammate",
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start here." },
        sections: {},
      },
    });

    expect(whatsapp.sendTemplate).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+15557654321" },
      expect.objectContaining({
        key: "whatsapp.task_nudge",
        params: { recipientName: "Teammate" },
      }),
    );
    const inbox = await db.selectFrom("inbox_messages").selectAll().executeTakeFirstOrThrow();
    expect(inbox).toMatchObject({
      recipient_user_id: "user-teammate",
      sender_user_id: "user-delivery",
      kind: "workflow_output",
      platform: "whatsapp",
    });
  });

  it("uses the recipient phone when a WhatsApp DM delivery target is an opaque Wati conversation id", async () => {
    await db.updateTable("users").set({ whatsapp_number: "+15551234567" }).where("id", "=", "user-delivery").execute();
    const sendText = vi.fn(async (target: unknown) => ({
      providerMessageId: "wa-dm-opaque-1",
      providerConversationId:
        typeof target === "object" && target && "providerConversationId" in target
          ? String(target.providerConversationId)
          : "dm:+15551234567",
      providerTimestamp: "2024-06-04T07:20:00.000Z",
    }));
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      getCapabilities: vi.fn(() => textOnlyCapabilities),
      sendText,
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: "6a436a0b5a5429ba2f5d8153",
        label: "Alice",
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start here." },
        sections: {},
      },
    });

    expect(sendText).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+15551234567", providerConversationId: "6a436a0b5a5429ba2f5d8153" },
      expect.stringContaining("Daily Brief"),
    );
    const conversation = await db.selectFrom("conversations").selectAll().executeTakeFirstOrThrow();
    expect(conversation.provider_conversation_id).toBe("dm:+15551234567");
  });

  it("chunks in-window WhatsApp DM deliveries and captures each chunk", async () => {
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate(
      { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+15551234567" },
      "Alice",
    );
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "wa-inbound-1",
      senderJid: "+15551234567",
      senderName: "Alice",
      senderUserId: "user-delivery",
      isBot: false,
      addressedToSketch: true,
      text: "latest inbound",
      providerTimestamp: new Date(Date.now() - 1_000).toISOString(),
      receivedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const sendText = vi.fn(async (_target: unknown, _text: string) => ({
      providerMessageId: `wa-dm-${sendText.mock.calls.length}`,
      providerConversationId: "dm:+15551234567",
      providerTimestamp: new Date().toISOString(),
    }));
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendText,
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });
    const makeItem = (sectionKey: string, index: number) => ({
      id: `${sectionKey}-${index}`,
      sectionKey,
      title: `Important ${sectionKey} ${index} ${"T".repeat(140)}`,
      summary: `Detailed update ${sectionKey} ${index} ${"S".repeat(360)}`,
      priority: "high" as const,
      label: "todo",
      displayRef: `REF-${sectionKey}-${index}`,
      actionType: "generic",
      actionLabel: "Plan with Sketch",
      actionPrompt: "Plan it.",
      sourceUrl: null,
      knowledgeRefs: { entityIds: [`entity-${sectionKey}-${index}`], fileIds: [] },
      structuredPayload: null,
      sortOrder: index,
    });
    const sections = Object.fromEntries(
      dailyBriefDefinition.sections.map((section) => [
        section.key,
        Array.from({ length: 4 }, (_, index) => makeItem(section.key, index)),
      ]),
    );

    await service.deliver({
      definition: dailyBriefDefinition,
      delivery: {
        enabled: true,
        platform: "whatsapp",
        targetType: "dm",
        targetId: "dm:+15551234567",
        label: "Alice",
      },
      output: {
        id: "output-delivery",
        userId: "user-delivery",
        agentKey: dailyBriefDefinition.key,
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Executive summary ".repeat(40) },
        sections,
      },
    });

    expect(sendText.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendText.mock.calls) {
      expect(call[0]).toEqual({ kind: "dm", phoneE164: "+15551234567" });
      expect(call[1].length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT);
    }
    const expectedRefs = sendText.mock.calls.map((_, index) => `wa-dm-${index + 1}`);
    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("sent");
    expect(attempt.message_refs_json).toBe(JSON.stringify(expectedRefs));
    const captured = await db
      .selectFrom("conversation_messages")
      .select(["text", "provider_message_id", "is_bot"])
      .where("is_bot", "=", 1)
      .orderBy("provider_message_id")
      .execute();
    expect(captured.map((row) => row.provider_message_id)).toEqual(expectedRefs);
    expect(captured.every((row) => row.text.length <= WHATSAPP_TEXT_LIMIT)).toBe(true);
  });

  it("captures successful WhatsApp DM chunks before propagating a later chunk failure", async () => {
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate(
      { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+15551234567" },
      "Alice",
    );
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "wa-inbound-1",
      senderJid: "+15551234567",
      senderName: "Alice",
      senderUserId: "user-delivery",
      isBot: false,
      addressedToSketch: true,
      text: "latest inbound",
      providerTimestamp: new Date(Date.now() - 1_000).toISOString(),
      receivedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const cause = new Error("second chunk failed");
    const sendText = vi.fn(async (_target: unknown, _text: string) => {
      if (sendText.mock.calls.length === 2) throw cause;
      return {
        providerMessageId: `wa-dm-${sendText.mock.calls.length}`,
        providerConversationId: "dm:+15551234567",
        providerTimestamp: new Date().toISOString(),
      };
    });
    const whatsapp = createMockWhatsApp({
      isConnected: true,
      sendText,
    });
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });
    const deliverySections = Array.from({ length: 7 }, (_, index) => ({
      key: `section_${index}`,
      title: `Section ${index}`,
      enabledByDefault: true,
      labels: ["todo"],
    }));
    const definition = { ...dailyBriefDefinition, sections: deliverySections };
    const makeItem = (sectionKey: string, index: number) => ({
      id: `${sectionKey}-${index}`,
      sectionKey,
      title: `Important ${sectionKey} ${index} ${"T".repeat(140)}`,
      summary: `Detailed update ${sectionKey} ${index} ${"S".repeat(360)}`,
      priority: "high" as const,
      label: "todo",
      displayRef: `REF-${sectionKey}-${index}`,
      actionType: "generic",
      actionLabel: "Plan with Sketch",
      actionPrompt: "Plan it.",
      sourceUrl: null,
      knowledgeRefs: { entityIds: [`entity-${sectionKey}-${index}`], fileIds: [] },
      structuredPayload: null,
      sortOrder: index,
    });
    const sections = Object.fromEntries(
      deliverySections.map((section) => [
        section.key,
        Array.from({ length: 4 }, (_, index) => makeItem(section.key, index)),
      ]),
    );

    await expect(
      service.deliver({
        definition,
        delivery: {
          enabled: true,
          platform: "whatsapp",
          targetType: "dm",
          targetId: "dm:+15551234567",
          label: "Alice",
        },
        output: {
          id: "output-delivery",
          userId: "user-delivery",
          agentKey: dailyBriefDefinition.key,
          outputDate: "2026-06-26",
          masthead: { title: "Daily Brief", summary: "Executive summary ".repeat(40) },
          sections,
        },
      }),
    ).rejects.toBe(cause);

    expect(sendText).toHaveBeenCalledTimes(2);
    const captured = await db
      .selectFrom("conversation_messages")
      .select(["text", "provider_message_id", "is_bot"])
      .where("is_bot", "=", 1)
      .execute();
    expect(captured).toHaveLength(1);
    expect(captured[0].provider_message_id).toBe("wa-dm-1");
    expect(captured[0].text.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT);
    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("failed");
    expect(attempt.error_message).toBe("second chunk failed");
  });

  it("records a failed attempt when the target platform is unavailable", async () => {
    const whatsapp = createMockWhatsApp();
    const service = createAgentOutputDeliveryService({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
      whatsapp,
      settingsRepo: createSettingsRepository(db),
    });

    await expect(
      service.deliver({
        definition: dailyBriefDefinition,
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "channel",
          targetId: "C_DAILY",
          label: "#daily",
        },
        output: {
          id: "output-delivery",
          userId: "user-delivery",
          agentKey: dailyBriefDefinition.key,
          outputDate: "2026-06-26",
          masthead: null,
          sections: {},
        },
      }),
    ).rejects.toThrow("Slack bot is not connected");

    const attempt = await db.selectFrom("agent_output_deliveries").selectAll().executeTakeFirstOrThrow();
    expect(attempt.status).toBe("failed");
    expect(attempt.error_message).toBe("Slack bot is not connected.");
  });
});

async function seedRecommendation(db: Kysely<DB>, id: string): Promise<string> {
  const taskId = `task-${id}`;
  await db
    .insertInto("tasks")
    .values({
      id: taskId,
      parent_entity_id: null,
      parent_source_ref: null,
      parent_name: null,
      source: "summary",
      external_ref: null,
      title: "Send revised proposal",
      normalized_title: "send revised proposal",
      status: "open",
      status_raw: "open",
      status_authority: "local",
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: null,
      priority: "medium",
      due_at: null,
      provenance: "summary",
      source_task_id: taskId,
      created_by_user_id: "user-delivery",
      status_changed_at: "2026-07-16T10:00:00.000Z",
      completed_at: null,
      valid_from: "2026-07-16T10:00:00.000Z",
      valid_to: null,
      milestone_series_key: null,
      source_platform: null,
      source_conversation_id: null,
      source_provider_thread_id: null,
      source_anchor_key: null,
      origin_agent_output_id: null,
    })
    .execute();
  await db
    .insertInto("task_completion_recommendations")
    .values({
      id,
      task_id: taskId,
      proposed_status: "done",
      review_state: "pending",
      review_code: id
        .slice(-8)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "A"),
      evidence_fingerprint: `fingerprint-${id}`,
      origin_agent_output_id: "output-delivery",
      rationale: "Completion was reported.",
      delivery_count: 0,
      expires_at: "2026-07-18T10:00:00.000Z",
    })
    .execute();
  return id;
}

function recommendationOutput(recommendationId: string) {
  return {
    id: "output-delivery",
    userId: "user-delivery",
    agentKey: dailyBriefDefinition.key,
    outputDate: "2026-06-26",
    masthead: { title: "Daily Brief", summary: "Review follow-ups." },
    sections: {
      looks_resolved: [recommendationItem(recommendationId, "looks-resolved-item")],
    },
  };
}

function recommendationItem(recommendationId: string, id: string) {
  return {
    id,
    sectionKey: "looks_resolved",
    title: "Send revised proposal",
    summary: 'Completion was reported. Reply "Confirm done TEST" or "Keep open TEST".',
    priority: "medium" as const,
    label: "looks_resolved",
    displayRef: null,
    actionType: "chat",
    actionLabel: "Review with Sketch",
    actionPrompt: "Review it.",
    sourceUrl: null,
    structuredPayload: { recommendationId, serverOwnedFollowup: true },
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
  };
}

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { SlackBot } from "../slack/bot";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { dailyBriefDefinition } from "./definitions/daily-brief";
import { createAgentOutputDeliveryService } from "./output-delivery";

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

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDeliveryModel,
  type AgentOutputItemInput,
  type AgentRoute,
  type AgentSourceConfig,
  createAgentOutputRepository,
} from "../../db/repositories/agent-outputs";
import { createConversationRepository } from "../../db/repositories/conversations";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import { createWhatsAppGroupRepository } from "../../db/repositories/whatsapp-groups";
import type { DB } from "../../db/schema";
import type { QueueManager } from "../../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import type { WhatsAppBot } from "../../whatsapp/bot";
import { CONVERSATION_SUMMARY_AGENT_KEY, conversationSummaryDefinition } from "../definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION, dailyBriefDefinition } from "../definitions/daily-brief";
import type { AgentOutputDeliveryPublisher } from "../output-delivery";
import { AgentRunService, type AgentRunServiceDeps, scopeKeyForRoute } from "../service";
import {
  NOW,
  OUTPUT_DATE,
  allowSlackDelivery,
  briefItem,
  createPausedQueueManager,
  createService,
  createWritingService,
  emptySummaryPayload,
  perSourceSelfModel,
  runtimeContextFromUserMessage,
  seedEntity,
  seedIndexedFile,
  seedMention,
  seedPersonEntity,
  seedSlackConversationMessage,
  slackSource,
  sourceRoute,
  successfulRunResult,
  whatsappSource,
} from "./test-helpers";

describe("AgentRunService", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  it("fans out per-route summaries with source and content isolated to each route", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    await seedSlackConversationMessage(db, sourceA, {
      messageId: "a-1",
      text: "Alpha launch decision",
      receivedAt: "2026-06-15T07:00:00.000Z",
    });
    await seedSlackConversationMessage(db, sourceB, {
      messageId: "b-1",
      text: "Beta support risk",
      receivedAt: "2026-06-15T07:05:00.000Z",
    });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "previous-beta",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        source_key: "slack:channel:C_B",
        source_label: "#beta",
        timezone: "UTC",
        status: "completed",
        trigger_type: "scheduled",
        agent_version: "test",
        masthead_json: JSON.stringify({ title: "Previous beta", summary: "Previous beta" }),
        raw_payload_json: "{}",
        generated_at: "2026-06-15T07:30:00.000Z",
      })
      .execute();
    await db
      .insertInto("agent_output_items")
      .values({
        id: "previous-beta-item",
        agent_output_id: "previous-beta",
        section_key: "highlights",
        title: "Beta-only previous item",
        summary: "Beta-only previous summary",
        priority: "high",
        label: "highlight",
        display_ref: "#beta",
        action_type: null,
        action_label: null,
        action_prompt: null,
        knowledge_refs_json: JSON.stringify({ entityIds: [], fileIds: [] }),
        source_url: null,
        sort_order: 0,
        created_at: NOW.toISOString(),
      })
      .execute();

    const contexts: Record<string, Record<string, unknown>> = {};
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      const runtimeContext = runtimeContextFromUserMessage(params.userMessage);
      contexts[String(runtimeContext.outputId)] = runtimeContext;
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Summarizer", summary: "Summary" },
        rawPayload: emptySummaryPayload(),
        items: [],
      });
      return successfulRunResult();
    });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery([
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
    ]);
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      outputDelivery,
      ...slackDelivery,
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA, sourceB],
      routes: [
        sourceRoute(sourceA, {
          focus: "Alpha customers",
          sections: { highlights: true, decisions: false, action_items: true, open_questions: false },
          maxItemsPerSection: 2,
        }),
        sourceRoute(sourceB, {
          focus: "Beta support",
          sections: { highlights: false, decisions: true, action_items: false, open_questions: true },
          maxItemsPerSection: 4,
        }),
      ],
    });

    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(rows.map((row) => row.source_key).sort()).toEqual(["slack:channel:C_A", "slack:channel:C_B"]);
    for (const row of rows) {
      const context = contexts[row.id];
      const isAlpha = row.source_key === "slack:channel:C_A";
      expect(context.sources).toEqual([
        expect.objectContaining({
          targetId: isAlpha ? "C_A" : "C_B",
        }),
      ]);
      expect(context.summarySources).toEqual([
        expect.objectContaining({
          targetId: isAlpha ? "C_A" : "C_B",
        }),
      ]);
      expect(context.focus).toBe(isAlpha ? "Alpha customers" : "Beta support");
      expect(context.maxItemsPerSection).toBe(isAlpha ? 2 : 4);
      expect(context.sections).toEqual(isAlpha ? ["highlights", "action_items"] : ["decisions", "open_questions"]);
      expect(context.sameDayPreviousOutput).toBeNull();
      expect(context.previousDayOutput).toBeNull();
      expect(JSON.stringify(context)).not.toContain(isAlpha ? "C_B" : "C_A");
      expect(JSON.stringify(context)).not.toContain(isAlpha ? "Beta-only" : "Alpha launch");
    }
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(2);
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_A" }) }),
    );
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_B" }) }),
    );
  });

  it("reports the source platform for self-delivered WhatsApp summary routes", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const source = whatsappSource("120363000000001@g.us", "Leads");
    await createWhatsAppGroupRepository(db).upsert({
      jid: source.targetId,
      name: "Leads",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const contexts: Record<string, Record<string, unknown>> = {};
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      const runtimeContext = runtimeContextFromUserMessage(params.userMessage);
      contexts[String(runtimeContext.outputId)] = runtimeContext;
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Summarizer", summary: "Summary" },
        rawPayload: emptySummaryPayload(),
        items: [],
      });
      return successfulRunResult();
    });
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      getWhatsApp: () => ({ groupMetadata: vi.fn() }),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [source],
      routes: [sourceRoute(source)],
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    for (const task of tasks) await task();

    expect(contexts[row.id].deliveryPlatform).toBe("whatsapp");
  });

  it("generates one combined route output with isolated source context and member delivery", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const member = await users.create({ name: "Route Member", email: "member@example.com", slackUserId: "U_MEMBER" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const sourceC = slackSource("C_C", "gamma");
    const route: AgentRoute = {
      id: "alpha-beta",
      sources: ["slack:channel:C_A", "slack:channel:C_B"],
      focus: "Combined launch status",
      sections: { highlights: true, decisions: true, action_items: false, open_questions: false },
      maxItemsPerSection: 3,
      schedule: null,
      destination: { kind: "member", platform: "slack", memberUserId: member.id },
      enabled: true,
    };
    await seedSlackConversationMessage(db, sourceA, {
      messageId: "a-combined-1",
      text: "Alpha launch decision",
      receivedAt: "2026-06-15T07:00:00.000Z",
    });
    await seedSlackConversationMessage(db, sourceB, {
      messageId: "b-combined-1",
      text: "Beta support risk",
      receivedAt: "2026-06-15T07:05:00.000Z",
    });
    await seedSlackConversationMessage(db, sourceC, {
      messageId: "c-combined-1",
      text: "Gamma private escalation",
      receivedAt: "2026-06-15T07:10:00.000Z",
    });

    const contexts: Record<string, Record<string, unknown>> = {};
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      const runtimeContext = runtimeContextFromUserMessage(params.userMessage);
      contexts[String(runtimeContext.outputId)] = runtimeContext;
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Summarizer", summary: "Summary" },
        rawPayload: {
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Summarizer", summary: "Summary" },
          items: [],
        },
        items: [],
      });
      return successfulRunResult();
    });
    const outputDelivery = { deliver: vi.fn(async () => {}) } satisfies AgentOutputDeliveryPublisher;
    const isUserInChannel = vi.fn(async (channelId: string, slackUserId: string) => {
      if (slackUserId === "U_AGENT") return ["C_A", "C_B", "C_C"].includes(channelId);
      if (slackUserId === "U_MEMBER") return ["C_A", "C_B"].includes(channelId);
      return false;
    });
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      outputDelivery,
      getSlack: () => ({
        listChannels: vi.fn(async () => [
          { id: "C_A", name: "alpha", type: "public_channel", isMember: true },
          { id: "C_B", name: "beta", type: "public_channel", isMember: true },
          { id: "C_C", name: "gamma", type: "public_channel", isMember: true },
        ]),
        isUserInChannel,
      }),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA, sourceB, sourceC],
      routes: [route],
    });

    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(rows).toHaveLength(1);
    expect(rows[0].source_key).toBe(scopeKeyForRoute(route, [sourceA, sourceB]));
    expect(rows[0].source_key).toMatch(/^route:[a-f0-9]{12}$/);
    const context = contexts[rows[0].id];
    expect(context.sources).toEqual([
      expect.objectContaining({ targetId: "C_A" }),
      expect.objectContaining({ targetId: "C_B" }),
    ]);
    expect(context.summarySources).toEqual([
      expect.objectContaining({ targetId: "C_A" }),
      expect.objectContaining({ targetId: "C_B" }),
    ]);
    expect(JSON.stringify(context)).toContain("Alpha launch decision");
    expect(JSON.stringify(context)).toContain("Beta support risk");
    expect(JSON.stringify(context)).not.toContain("Gamma private escalation");
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "dm",
          targetId: "U_MEMBER",
          label: "Route Member",
        },
      }),
    );
    expect(isUserInChannel).toHaveBeenCalledWith("C_A", "U_MEMBER");
    expect(isUserInChannel).toHaveBeenCalledWith("C_B", "U_MEMBER");
  });

  it("delivers route summaries to Slack channel destinations only when the bot is a member", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    await seedSlackConversationMessage(db, sourceA, {
      messageId: "channel-route-a-1",
      text: "Alpha launch decision",
      receivedAt: "2026-06-15T07:00:00.000Z",
    });
    await seedSlackConversationMessage(db, sourceB, {
      messageId: "channel-route-b-1",
      text: "Beta launch decision",
      receivedAt: "2026-06-15T07:05:00.000Z",
    });
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Summarizer", summary: "Summary" },
        rawPayload: {
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Summarizer", summary: "Summary" },
          items: [],
        },
        items: [],
      });
      return successfulRunResult();
    });
    const outputDelivery = { deliver: vi.fn(async () => {}) } satisfies AgentOutputDeliveryPublisher;
    const listChannels = vi.fn(
      async (): Promise<Array<{ id: string; name: string; type: string; isMember: boolean }>> => [
        { id: "C_A", name: "alpha", type: "public_channel", isMember: true },
        { id: "C_DEST", name: "leadership", type: "private_channel", isMember: true },
      ],
    );
    const isUserInChannel = vi.fn(async (channelId: string, slackUserId: string) => {
      if (channelId === "C_DEST") throw new Error("Channel route destination should not check user membership");
      return channelId === "C_A" && slackUserId === "U_AGENT";
    });
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      outputDelivery,
      getSlack: () => ({ listChannels, isUserInChannel }),
    });

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA],
      routes: [
        sourceRoute(sourceA, {
          destination: {
            kind: "channel",
            platform: "slack",
            targetType: "channel",
            targetId: "C_DEST",
            label: "#spoofed",
          },
        }),
      ],
    });
    const deliveredRows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(deliveredRows).toHaveLength(1);
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "channel",
          targetId: "C_DEST",
          label: "#leadership",
        },
      }),
    );
    expect(isUserInChannel).not.toHaveBeenCalledWith("C_DEST", expect.any(String));

    tasks.length = 0;
    outputDelivery.deliver.mockClear();
    listChannels.mockResolvedValue([
      { id: "C_B", name: "beta", type: "public_channel", isMember: true },
      { id: "C_BLOCKED", name: "blocked", type: "private_channel", isMember: false },
    ]);
    isUserInChannel.mockImplementation(async (channelId: string, slackUserId: string) => {
      return channelId === "C_B" && slackUserId === "U_AGENT";
    });

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceB],
      routes: [
        sourceRoute(sourceB, {
          destination: {
            kind: "channel",
            platform: "slack",
            targetType: "channel",
            targetId: "C_BLOCKED",
            label: null,
          },
        }),
      ],
    });
    const blockedRows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(outputDelivery.deliver).not.toHaveBeenCalled();
    const blockedOutput = await db
      .selectFrom("agent_outputs")
      .select(["status", "error_message"])
      .where("id", "=", blockedRows[0].id)
      .executeTakeFirstOrThrow();
    expect(blockedOutput).toEqual({
      status: "failed",
      error_message: "Slack channel is not available for delivery",
    });
  });
});

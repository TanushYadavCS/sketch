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

  it("guards member delivery by source intersection and lists only eligible route members", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const member = await users.create({
      name: "Eligible Member",
      email: "member@example.com",
      slackUserId: "U_MEMBER",
    });
    const partial = await users.create({
      name: "Partial Member",
      email: "partial@example.com",
      slackUserId: "U_PARTIAL",
    });
    await users.create({ name: "No Slack", email: "noslack@example.com" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const isUserInChannel = vi.fn(async (channelId: string, slackUserId: string) => {
      if (slackUserId === "U_AGENT" || slackUserId === "U_MEMBER") return ["C_A", "C_B"].includes(channelId);
      if (slackUserId === "U_PARTIAL") return channelId === "C_A";
      return false;
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
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      outputDelivery,
      getSlack: () => ({
        listChannels: vi.fn(async () => [
          { id: "C_A", name: "alpha", type: "public_channel", isMember: true },
          { id: "C_B", name: "beta", type: "public_channel", isMember: true },
        ]),
        isUserInChannel,
      }),
    });

    const eligible = await service.listEligibleRouteMembers(user.id, ["slack:channel:C_A", "slack:channel:C_B"]);
    const whatsappEligible = await service.listEligibleRouteMembers(user.id, [
      "slack:channel:C_A",
      "whatsapp:group:120363000000001@g.us",
    ]);
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA, sourceB],
      routes: [
        {
          id: "partial-member-route",
          sources: ["slack:channel:C_A", "slack:channel:C_B"],
          focus: null,
          sections: null,
          maxItemsPerSection: null,
          schedule: null,
          destination: { kind: "member", platform: "slack", memberUserId: partial.id },
          enabled: true,
        },
      ],
    });

    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(eligible).toEqual(
      expect.arrayContaining([{ userId: member.id, name: "Eligible Member", slackUserId: "U_MEMBER" }]),
    );
    expect(eligible).not.toEqual(
      expect.arrayContaining([{ userId: partial.id, name: "Partial Member", slackUserId: "U_PARTIAL" }]),
    );
    expect(eligible.some((candidate) => candidate.name === "No Slack")).toBe(false);
    expect(whatsappEligible).toEqual([]);
    expect(outputDelivery.deliver).not.toHaveBeenCalled();
    const output = await db
      .selectFrom("agent_outputs")
      .select(["status", "error_message"])
      .where("id", "=", rows[0].id)
      .executeTakeFirstOrThrow();
    expect(output).toEqual({
      status: "failed",
      error_message: "Recipient is not a member of every source",
    });
  });

  it("delivers WhatsApp member routes by phone number without Slack membership checks", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Agent User",
      email: "user@example.com",
      whatsappNumber: "+15550000000",
    });
    const member = await users.create({
      name: "WhatsApp Recipient",
      email: "recipient@example.com",
      whatsappNumber: "+15551112222",
    });
    const noNumber = await users.create({ name: "No Number", email: "no-number@example.com" });
    const groupJid = "120363000000001@g.us";
    const source = whatsappSource(groupJid, "Leads");
    await createWhatsAppGroupRepository(db).upsert({
      jid: groupJid,
      name: "Leads",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leads",
          participants: [{ id: "15550000000@s.whatsapp.net" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const isUserInChannel = vi.fn(async () => {
      throw new Error("Slack membership should not be checked");
    });
    const listChannels = vi.fn(async () => []);
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
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      outputDelivery,
      getSlack: () => ({ listChannels, isUserInChannel }),
      getWhatsApp: () => ({ getGroupMetadata }),
    });

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [source],
      routes: [
        sourceRoute(source, {
          destination: { kind: "member", platform: "whatsapp", memberUserId: member.id },
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
          platform: "whatsapp",
          targetType: "dm",
          targetId: "+15551112222",
          label: "WhatsApp Recipient",
          recipientUserId: member.id,
        },
      }),
    );
    expect(isUserInChannel).not.toHaveBeenCalled();

    tasks.length = 0;
    outputDelivery.deliver.mockClear();
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [source],
      routes: [
        sourceRoute(source, {
          destination: { kind: "member", platform: "whatsapp", memberUserId: noNumber.id },
        }),
      ],
    });
    const failedRows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(outputDelivery.deliver).not.toHaveBeenCalled();
    expect(isUserInChannel).not.toHaveBeenCalled();
    const failedOutput = await db
      .selectFrom("agent_outputs")
      .select(["status", "error_message"])
      .where("id", "=", failedRows[0].id)
      .executeTakeFirstOrThrow();
    expect(failedOutput).toEqual({
      status: "failed",
      error_message: "Recipient has no WhatsApp number",
    });
  });

  it("schedules only due routes and treats completed outputs per route", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const sourceC = slackSource("C_C", "gamma");
    const slackDelivery = allowSlackDelivery([
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
      { id: "C_C", name: "gamma" },
    ]);
    const service = createService(db, tasks, slackDelivery);
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      scheduleHour: 9,
      scheduleMinute: 0,
      sources: [sourceA, sourceB, sourceC],
      routes: [
        sourceRoute(sourceA, { schedule: { frequency: "daily", hour: 9, minute: 0 } }),
        sourceRoute(sourceB, { schedule: { frequency: "daily", hour: 18, minute: 0 } }),
        sourceRoute(sourceC, { schedule: null }),
      ],
    });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "completed-c",
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        source_key: "slack:channel:C_C",
        source_label: "#gamma",
        timezone: "UTC",
        status: "completed",
        trigger_type: "scheduled",
        agent_version: "test",
        generated_at: "2026-06-15T09:01:00.000Z",
        created_at: "2026-06-15T09:01:00.000Z",
        updated_at: "2026-06-15T09:01:00.000Z",
      })
      .execute();

    const userRow = await users.findById(user.id);
    const dueAtNine = await service.shouldGenerateForUser(
      conversationSummaryDefinition,
      userRow ?? user,
      new Date("2026-06-15T09:05:00.000Z"),
    );
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: dueAtNine[0]?.outputDate,
      periodKey: dueAtNine[0]?.periodKey,
      triggerType: "scheduled",
      skipIfCompleted: true,
      scopeKeys: dueAtNine[0]?.scopeKeys,
    });
    const dueAtEighteen = await service.shouldGenerateForUser(
      conversationSummaryDefinition,
      userRow ?? user,
      new Date("2026-06-15T18:05:00.000Z"),
    );

    const running = await db
      .selectFrom("agent_outputs")
      .select(["source_key", "status"])
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .orderBy("source_key", "asc")
      .execute();

    expect(dueAtNine).toEqual([{ outputDate: OUTPUT_DATE, periodKey: OUTPUT_DATE, scopeKeys: ["slack:channel:C_A"] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_key).toBe("slack:channel:C_A");
    expect(dueAtEighteen).toEqual([
      { outputDate: OUTPUT_DATE, periodKey: OUTPUT_DATE, scopeKeys: ["slack:channel:C_B"] },
    ]);
    expect(running).toEqual([{ source_key: "slack:channel:C_A", status: "running" }]);
    expect(tasks).toHaveLength(1);
  });
});

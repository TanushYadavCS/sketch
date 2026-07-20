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
import type { NormalizedGroupMetadata } from "../../whatsapp/facade-contract";
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
  dmSource,
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

  it("resolves delivery config to the current user's Slack DM", async () => {
    const users = createUserRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@example.com", slackUserId: "U_ALICE" });
    await users.create({ name: "Bob", email: "bob@example.com", slackUserId: "U_BOB" });
    const service = createService(db, [], {
      getSlack: () => ({
        listChannels: vi.fn(async () => []),
        isUserInChannel: vi.fn(async () => false),
      }),
    });

    await expect(
      createService(db, []).resolveDeliveryConfigForUser(alice.id, {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: "U_ALICE",
        label: "Alice",
      }),
    ).rejects.toThrow("Slack is not connected");

    await expect(
      service.resolveDeliveryConfigForUser(alice.id, {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: "U_BOB",
        label: "Bob",
      }),
    ).rejects.toThrow("current user");

    await expect(
      service.resolveDeliveryConfigForUser(alice.id, {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: "U_ALICE",
        label: "Spoofed",
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "slack",
      targetType: "dm",
      targetId: "U_ALICE",
      label: "Alice <alice@example.com>",
    });
  });

  it("requires current-user membership for Slack channel delivery", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const listChannels = vi.fn(async () => [{ id: "C_DAILY", name: "daily", type: "private_channel", isMember: true }]);
    const isUserInChannel = vi.fn(async () => false);
    const service = createService(db, [], {
      getSlack: () => ({ listChannels, isUserInChannel }),
    });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      }),
    ).rejects.toThrow("not available for this user");
    expect(isUserInChannel).toHaveBeenCalledWith("C_DAILY", "U_AGENT");

    isUserInChannel.mockResolvedValueOnce(true);
    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#spoofed",
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "slack",
      targetType: "channel",
      targetId: "C_DAILY",
      label: "#daily",
    });
  });

  it("resolves Slack delivery mentions to known channel members", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await users.create({ name: "Ada", email: "ada@example.com", slackUserId: "U_ADA" });
    const isUserInChannel = vi.fn(async (_channelId: string, slackUserId: string) => slackUserId !== "U_MISSING");
    const service = createService(db, [], {
      getSlack: () => ({
        listChannels: vi.fn(async () => [{ id: "C_DAILY", name: "daily", type: "private_channel", isMember: true }]),
        isUserInChannel,
      }),
    });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#spoofed",
        mentions: [{ platform: "slack", targetId: "U_ADA", label: "Spoofed Ada" }],
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "slack",
      targetType: "channel",
      targetId: "C_DAILY",
      label: "#daily",
      mentions: [{ platform: "slack", targetId: "U_ADA", label: "Ada <ada@example.com>" }],
    });
    expect(isUserInChannel).toHaveBeenCalledWith("C_DAILY", "U_ADA");

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
        mentions: [{ platform: "slack", targetId: "U_UNKNOWN", label: "Unknown" }],
      }),
    ).rejects.toThrow("Slack mention target is not available");
  });

  it("resolves WhatsApp group delivery only when the current user is a participant", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Agent User",
      email: "user@example.com",
      whatsappNumber: "+15551234567",
    });
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "120363000000001@g.us",
      name: "Leadership",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const groupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ jid: "15551234567@s.whatsapp.net" }],
        }) as NormalizedGroupMetadata,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ groupMetadata }) });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "unknown@g.us",
        label: "Unknown",
      }),
    ).rejects.toThrow("WhatsApp group");

    expect(groupMetadata).not.toHaveBeenCalled();

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Spoofed",
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000001@g.us",
      label: "Leadership",
    });
    expect(groupMetadata).toHaveBeenCalledWith("120363000000001@g.us", { refresh: false });
  });

  it("resolves WhatsApp group delivery when the current user's participant JID is a LID", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Agent User",
      email: "user@example.com",
      whatsappNumber: "+15551234567",
    });
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "120363000000001@g.us",
      name: "Leadership",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const groupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ jid: "86702773280883@lid" }],
        }) as NormalizedGroupMetadata,
    );
    const resolveLid = vi.fn(async (jid: string) =>
      jid === "86702773280883@lid" ? "15551234567@s.whatsapp.net" : null,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ groupMetadata, resolveLid }) });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Spoofed",
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000001@g.us",
      label: "Leadership",
    });
    expect(resolveLid).toHaveBeenCalledWith("86702773280883@lid");
  });

  it("resolves WhatsApp delivery mentions to known group participants", async () => {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Agent User",
      email: "user@example.com",
      whatsappNumber: "+15551234567",
    });
    await users.create({ name: "Ada", email: "ada@example.com", whatsappNumber: "+15557654321" });
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: "120363000000001@g.us",
      name: "Leadership",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const groupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ jid: "15551234567@s.whatsapp.net" }, { jid: "15557654321@s.whatsapp.net" }],
        }) as NormalizedGroupMetadata,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ groupMetadata }) });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Spoofed",
        mentions: [{ platform: "whatsapp", targetId: "+15557654321", label: "Spoofed Ada" }],
      }),
    ).resolves.toEqual({
      enabled: true,
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000001@g.us",
      label: "Leadership",
      mentions: [{ platform: "whatsapp", targetId: "+15557654321", label: "Ada" }],
    });
  });

  it("drops saved conversation sources that fail run-time Slack membership revalidation", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    let currentUserInChannel = true;
    const listChannels = vi.fn(async () => [
      { id: "C_PRIVATE", name: "private-room", type: "private_channel", isMember: true },
    ]);
    const isUserInChannel = vi.fn(async () => currentUserInChannel);
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Summarizer", summary: "No configured sources are currently available." },
        rawPayload: {
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Summarizer", summary: "No configured sources are currently available." },
          items: [],
        },
        items: [],
      });
      return {
        messageSent: true,
        sessionId: "agent-session",
        costUsd: 0,
        auxCostUsd: 0,
        pendingUploads: [],
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 0,
        stopReason: null,
        errorSubtype: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: null,
        isResumedSession: false,
        totalAttachments: 0,
        imageCount: 0,
        nonImageCount: 0,
        mimeTypes: [],
        fileSizes: [],
        promptMode: "text" as const,
        toolCalls: [],
        auxLlmCalls: [],
        sdkCostUsd: 0,
        rawUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        trace: { progressEvents: [], finalText: "Done" },
      };
    });
    const service = new AgentRunService({
      db,
      config: createTestConfig(),
      logger: createTestLogger(),
      users,
      settings: createSettingsRepository(db),
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      runScheduledAgent: runAgent as unknown as AgentRunServiceDeps["runScheduledAgent"],
      queueManager: createPausedQueueManager(tasks),
      getSlack: () => ({ listChannels, isUserInChannel }),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      sources: [
        {
          platform: "slack",
          targetType: "channel",
          targetId: "C_PRIVATE",
          label: "#private-room",
        },
      ],
    });

    currentUserInChannel = false;
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(rows).toEqual([]);
    expect(tasks).toHaveLength(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(isUserInChannel).toHaveBeenCalledWith("C_PRIVATE", "U_AGENT");
  });

  it("delivers self-routed DM summaries back to the configured user identity", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Alice",
      email: "alice@example.com",
      slackUserId: "U_ALICE",
      whatsappNumber: "+15551234567",
    });
    const conversations = createConversationRepository(db);
    const slackDm = await conversations.getOrCreate(
      { platform: "slack", kind: "dm", providerConversationId: "D_ALICE" },
      "Alice",
    );
    const whatsappDm = await conversations.getOrCreate(
      { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+15551234567" },
      "Alice",
    );
    for (const [conversationId, providerMessageId] of [
      [slackDm.id, "slack-dm-message"],
      [whatsappDm.id, "whatsapp-dm-message"],
    ] as const) {
      await conversations.insertMessage({
        conversationId,
        providerMessageId,
        senderJid: providerMessageId,
        senderName: "Alice",
        senderUserId: user.id,
        text: providerMessageId,
        receivedAt: "2026-06-15T07:00:00.000Z",
      });
    }
    const outputDelivery = { deliver: vi.fn(async () => {}) } satisfies AgentOutputDeliveryPublisher;
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
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
      outputDelivery,
      ...allowSlackDelivery([]),
    });
    const sources = [dmSource("slack", slackDm.id), dmSource("whatsapp", whatsappDm.id)];
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources,
      routes: sources.map((source) => sourceRoute(source)),
    });

    await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ platform: "slack", targetType: "dm", targetId: "U_ALICE" }),
      }),
    );
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ platform: "whatsapp", targetType: "dm", targetId: "+15551234567" }),
      }),
    );
  });
});

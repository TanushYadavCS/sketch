import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDeliveryModel,
  type AgentOutputItemInput,
  type AgentRoute,
  type AgentSourceConfig,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import type { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppBot } from "../whatsapp/bot";
import { CONVERSATION_SUMMARY_AGENT_KEY, conversationSummaryDefinition } from "./definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION, dailyBriefDefinition } from "./definitions/daily-brief";
import type { AgentOutputDeliveryPublisher } from "./output-delivery";
import { AgentRunService, type AgentRunServiceDeps, scopeKeyForRoute } from "./service";
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
} from "./service-test-helpers";

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

  it("persists section toggles and focus, and disables the agent when reconfigured", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const service = createService(db, []);

    const updated = await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      enabled: false,
      scheduleHour: 9,
      sections: { customer_updates: false },
      focus: "  Prioritize enterprise accounts  ",
      createTasks: true,
    });

    expect(updated?.enabled).toBe(false);
    expect(updated?.scheduleHour).toBe(9);
    expect(updated?.focus).toBe("Prioritize enterprise accounts");
    expect(updated?.createTasks).toBe(true);
    const customer = updated?.sections.find((s) => s.key === "customer_updates");
    const todos = updated?.sections.find((s) => s.key === "todos");
    expect(customer?.enabled).toBe(false);
    expect(todos?.enabled).toBe(true);

    const reread = await service.getConfigView(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(reread?.enabled).toBe(false);
    expect(reread?.focus).toBe("Prioritize enterprise accounts");
    expect(reread?.createTasks).toBe(true);
    expect(reread?.sections.find((s) => s.key === "customer_updates")?.enabled).toBe(false);

    const latest = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(latest.enabledSections).toContain("todos");
    expect(latest.enabledSections).not.toContain("customer_updates");
  });

  it("defaults agent task creation off and passes the toggle through runtime context", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", emailVerified: true });
    await seedPersonEntity(db, { id: "person-agent-user", name: "Agent User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "brief-file", providerUrl: null });
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      const context = runtimeContextFromUserMessage(params.userMessage);
      const outputDate = typeof context.outputDate === "string" ? context.outputDate : OUTPUT_DATE;
      const timezone = typeof context.timezone === "string" ? context.timezone : "UTC";
      await params.agentOutputWriter.write({
        outputDate,
        timezone,
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {
          outputDate,
          timezone,
          masthead: { title: "Daily Brief", summary: "Summary" },
          items: [],
        },
        items: [
          briefItem({
            structuredPayload: { assigneeName: "Agent User" },
            knowledgeRefs: { entityIds: [], fileIds: ["brief-file"] },
          }),
        ],
      });
      return {
        messageSent: true,
        sessionId: "agent-session",
        costUsd: 0,
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
    });

    const defaultConfig = await service.getConfigView(DAILY_BRIEF_AGENT_KEY, user.id);
    const disabledRow = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!disabledRow) throw new Error("Expected a generated output row");
    await tasks.shift()?.();
    const disabledCount = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();

    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, { createTasks: true });
    const enabledRow = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: "2026-06-16",
      triggerType: "manual",
    });
    if (!enabledRow) throw new Error("Expected a generated output row");
    await tasks.shift()?.();
    const enabledCount = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const contexts = runAgent.mock.calls.map((call) => runtimeContextFromUserMessage(call[0].userMessage));

    expect(defaultConfig?.createTasks).toBe(false);
    expect(disabledCount.count).toBe(0);
    expect(enabledCount.count).toBe(1);
    expect(contexts.map((context) => context.createTasks)).toEqual([false, true]);
  });

  it("promotes Summarizer internal task candidates without persisting them as visible output items", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await users.create({ name: "Mina", email: "mina@example.com", emailVerified: true });
    await seedPersonEntity(db, { id: "person-mina", name: "Mina", email: "mina@example.com" });
    const source = slackSource("C_TASKS", "tasks");
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
        items: [
          {
            sectionKey: "highlights",
            title: "Launch thread moved forward",
            summary: "Mina shared the launch thread status.",
            priority: "medium",
            label: "highlight",
            knowledgeRefs: { entityIds: [], fileIds: [] },
            sortOrder: 0,
          },
          {
            sectionKey: "action_items",
            title: "Disabled visible action item",
            summary: "This visible section is disabled for the route.",
            priority: "medium",
            label: "action_item",
            structuredPayload: { sourceLabels: ["#tasks"], messageIds: [700] },
            knowledgeRefs: { entityIds: [], fileIds: [] },
            sortOrder: 0,
          },
          {
            sectionKey: "task_candidates",
            title: "Mina: send the launch checklist",
            summary: "Mina committed to sending the launch checklist.",
            priority: "high",
            label: "action_item",
            structuredPayload: { sourceLabels: ["#tasks"], messageIds: [701, 702], owner: "Mina" },
            knowledgeRefs: { entityIds: [], fileIds: [] },
            sortOrder: 0,
          },
        ],
      });
      return successfulRunResult();
    });
    const service = createService(db, tasks, {
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
      ...allowSlackDelivery([{ id: "C_TASKS", name: "tasks" }]),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      createTasks: true,
      sources: [source],
      routes: [
        sourceRoute(source, {
          sections: { highlights: true, decisions: false, action_items: false, open_questions: false },
        }),
      ],
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    const visibleItems = await db
      .selectFrom("agent_output_items")
      .select(["section_key", "title"])
      .where("agent_output_id", "=", row.id)
      .orderBy("section_key", "asc")
      .execute();
    const summaryTasks = await db
      .selectFrom("tasks")
      .select(["title", "provenance", "source"])
      .where("created_by_user_id", "=", user.id)
      .execute();
    const evidence = await db.selectFrom("task_evidence").select(["kind", "ref_id"]).orderBy("ref_id", "asc").execute();

    expect(visibleItems).toEqual([{ section_key: "highlights", title: "Launch thread moved forward" }]);
    expect(summaryTasks).toEqual([
      {
        title: "Mina: send the launch checklist",
        provenance: "summary",
        source: "summary",
      },
    ]);
    expect(evidence).toEqual([
      { kind: "conversation_message", ref_id: "701" },
      { kind: "conversation_message", ref_id: "702" },
    ]);
  });

  it("persists delivery config with the other agent preferences", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const service = createService(db, []);

    const updated = await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
    });

    expect(updated?.delivery).toEqual({
      enabled: true,
      platform: "slack",
      targetType: "channel",
      targetId: "C_DAILY",
      label: "#daily",
    });

    const reread = await service.getConfigView(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(reread?.delivery?.targetId).toBe("C_DAILY");
  });

  it("includes source config, sources, and routes on agent summaries", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const source = slackSource("C_A", "alpha");
    const route = sourceRoute(source, {
      focus: "Alpha customers",
      sections: { highlights: true, decisions: false },
      maxItemsPerSection: 2,
      schedule: { frequency: "daily", hour: 10, minute: 15 },
    });
    const service = createService(db, [], allowSlackDelivery([{ id: "C_A", name: "alpha" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      sources: [source],
      routes: [route],
    });

    const summaries = await service.listForUser(user.id);
    const dailyBrief = summaries.find((summary) => summary.key === DAILY_BRIEF_AGENT_KEY);
    const conversationSummary = summaries.find((summary) => summary.key === CONVERSATION_SUMMARY_AGENT_KEY);

    expect(dailyBrief).toMatchObject({
      sourceConfig: null,
      sources: [],
      routes: [],
    });
    expect(conversationSummary).toMatchObject({
      sourceConfig: conversationSummaryDefinition.sourceConfig,
      sources: [source],
      routes: [route],
    });
  });
});

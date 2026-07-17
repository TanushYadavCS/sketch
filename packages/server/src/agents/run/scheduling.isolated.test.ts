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

  it("groups mixed schedule frequencies by period key and deduplicates completed slots", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const contexts: Record<string, unknown>[] = [];
    const users = createUserRepository(db);
    const createdUser = await users.create({
      name: "Agent User",
      email: "user@example.com",
      slackUserId: "U_AGENT",
    });
    const user = await users.update(createdUser.id, { timezone: "UTC" });
    const dailySource = slackSource("C_DAILY", "daily");
    const hourlySource = slackSource("C_HOURLY", "hourly");
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      const context = runtimeContextFromUserMessage(params.userMessage);
      contexts.push(context);
      const item = briefItem({
        sectionKey: "highlights",
        title: "Summary",
        summary: "Summary",
        priority: "medium",
        label: "highlight",
      });
      const payload = {
        outputDate: String(context.outputDate),
        timezone: String(context.timezone),
        masthead: { title: "Conversation Summary", summary: "Summary" },
        items: [
          {
            sectionKey: item.sectionKey,
            title: item.title,
            summary: item.summary,
            priority: item.priority,
            label: item.label,
            knowledgeRefs: {
              entityIds: [],
              fileIds: [],
              relationshipIds: [],
              mentionIds: [],
              sourceRefIds: [],
              factIds: [],
            },
          },
        ],
      };
      await params.agentOutputWriter.write({
        outputDate: payload.outputDate,
        timezone: payload.timezone,
        masthead: payload.masthead,
        rawPayload: payload,
        items: [item],
      });
      return successfulRunResult();
    });
    const service = createService(db, tasks, {
      ...allowSlackDelivery([
        { id: "C_DAILY", name: "daily" },
        { id: "C_HOURLY", name: "hourly" },
      ]),
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [dailySource, hourlySource],
      routes: [
        sourceRoute(dailySource, { schedule: { frequency: "daily", hour: 8, minute: 0 } }),
        sourceRoute(hourlySource, {
          schedule: { frequency: "every_n_hours", hour: 0, minute: 0, intervalHours: 4 },
        }),
      ],
    });
    const userRow = await users.findById(user.id);
    const eight = new Date("2026-07-04T08:00:00.000Z");
    vi.setSystemTime(eight);

    const dueAtEight = await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, eight);
    const rowsAtEight = (
      await Promise.all(
        dueAtEight.map((group) =>
          service.requestGenerationForUser({
            agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
            userId: user.id,
            outputDate: group.outputDate,
            periodKey: group.periodKey,
            triggerType: "scheduled",
            skipIfCompleted: true,
            scopeKeys: group.scopeKeys,
          }),
        ),
      )
    ).flat();
    for (const task of tasks) await task();

    const dailyContext = contexts.find((context) =>
      (context.sources as AgentSourceConfig[] | undefined)?.some((source) => source.targetId === "C_DAILY"),
    );
    const hourlyContext = contexts.find((context) =>
      (context.sources as AgentSourceConfig[] | undefined)?.some((source) => source.targetId === "C_HOURLY"),
    );
    const completedAtEight = await db
      .selectFrom("agent_outputs")
      .select(["output_date", "period_key", "source_key", "status"])
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", user.id)
      .orderBy("period_key", "asc")
      .execute();

    expect(dueAtEight).toEqual([
      { outputDate: "2026-07-04", periodKey: "2026-07-04", scopeKeys: ["slack:channel:C_DAILY"] },
      { outputDate: "2026-07-04", periodKey: "2026-07-04T08", scopeKeys: ["slack:channel:C_HOURLY"] },
    ]);
    expect(rowsAtEight.map((row) => row.period_key).sort()).toEqual(["2026-07-04", "2026-07-04T08"]);
    expect(dailyContext?.summaryWindow).toMatchObject({
      start: "2026-07-03T08:00:00.000Z",
      firstRunFallbackHours: 24,
    });
    expect(hourlyContext?.summaryWindow).toMatchObject({
      start: "2026-07-04T04:00:00.000Z",
      firstRunFallbackHours: 4,
    });
    expect(completedAtEight).toEqual([
      {
        output_date: "2026-07-04",
        period_key: "2026-07-04",
        source_key: "slack:channel:C_DAILY",
        status: "completed",
      },
      {
        output_date: "2026-07-04",
        period_key: "2026-07-04T08",
        source_key: "slack:channel:C_HOURLY",
        status: "completed",
      },
    ]);

    expect(
      await service.shouldGenerateForUser(
        conversationSummaryDefinition,
        userRow ?? user,
        new Date("2026-07-04T08:30:00.000Z"),
      ),
    ).toEqual([]);

    const noon = new Date("2026-07-04T12:00:00.000Z");
    vi.setSystemTime(noon);
    const dueAtNoon = await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, noon);
    const rowsAtNoon = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: dueAtNoon[0]?.outputDate,
      periodKey: dueAtNoon[0]?.periodKey,
      triggerType: "scheduled",
      skipIfCompleted: true,
      scopeKeys: dueAtNoon[0]?.scopeKeys,
    });

    expect(dueAtNoon).toEqual([
      { outputDate: "2026-07-04", periodKey: "2026-07-04T12", scopeKeys: ["slack:channel:C_HOURLY"] },
    ]);
    expect(rowsAtNoon.map((row) => row.period_key)).toEqual(["2026-07-04T12"]);
  });

  it("gates weekly schedules by day of week in the user's timezone", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const contexts: Record<string, unknown>[] = [];
    const users = createUserRepository(db);
    const createdUser = await users.create({
      name: "Agent User",
      email: "user@example.com",
      slackUserId: "U_AGENT",
    });
    const user = await users.update(createdUser.id, { timezone: "America/Los_Angeles" });
    const source = slackSource("C_WEEKLY", "weekly");
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      const context = runtimeContextFromUserMessage(params.userMessage);
      contexts.push(context);
      const item = briefItem({
        sectionKey: "highlights",
        title: "Weekly",
        summary: "Weekly",
        priority: "medium",
        label: "highlight",
      });
      const payload = {
        outputDate: String(context.outputDate),
        timezone: String(context.timezone),
        masthead: { title: "Conversation Summary", summary: "Weekly" },
        items: [
          {
            sectionKey: item.sectionKey,
            title: item.title,
            summary: item.summary,
            priority: item.priority,
            label: item.label,
            knowledgeRefs: {
              entityIds: [],
              fileIds: [],
              relationshipIds: [],
              mentionIds: [],
              sourceRefIds: [],
              factIds: [],
            },
          },
        ],
      };
      await params.agentOutputWriter.write({
        outputDate: payload.outputDate,
        timezone: payload.timezone,
        masthead: payload.masthead,
        rawPayload: payload,
        items: [item],
      });
      return successfulRunResult();
    });
    const service = createService(db, tasks, {
      ...allowSlackDelivery([{ id: "C_WEEKLY", name: "weekly" }]),
      runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [source],
      routes: [sourceRoute(source, { schedule: { frequency: "weekly", hour: 9, minute: 0, daysOfWeek: [1] } })],
    });
    const userRow = await users.findById(user.id);
    const monday = new Date("2026-07-06T16:05:00.000Z");
    vi.setSystemTime(monday);

    const dueOnMonday = await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, monday);
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: dueOnMonday[0]?.outputDate,
      periodKey: dueOnMonday[0]?.periodKey,
      triggerType: "scheduled",
      skipIfCompleted: true,
      scopeKeys: dueOnMonday[0]?.scopeKeys,
    });
    for (const task of tasks) await task();

    const otherLocalNineOClocks = [
      "2026-07-07T16:05:00.000Z",
      "2026-07-08T16:05:00.000Z",
      "2026-07-09T16:05:00.000Z",
      "2026-07-10T16:05:00.000Z",
      "2026-07-11T16:05:00.000Z",
      "2026-07-12T16:05:00.000Z",
    ];

    expect(dueOnMonday).toEqual([
      { outputDate: "2026-07-06", periodKey: "2026-07-06", scopeKeys: ["slack:channel:C_WEEKLY"] },
    ]);
    expect(rows.map((row) => row.period_key)).toEqual(["2026-07-06"]);
    expect(contexts[0]?.summaryWindow).toMatchObject({
      start: "2026-06-29T16:05:00.000Z",
      firstRunFallbackHours: 168,
    });
    for (const value of otherLocalNineOClocks) {
      expect(
        await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, new Date(value)),
      ).toEqual([]);
    }
  });

  it("treats legacy stored route schedules without frequency as daily", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const createdUser = await users.create({
      name: "Agent User",
      email: "user@example.com",
      slackUserId: "U_AGENT",
    });
    const user = await users.update(createdUser.id, { timezone: "UTC" });
    const source = slackSource("C_LEGACY", "legacy");
    await db
      .insertInto("agent_user_configs")
      .values({
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        enabled: 1,
        schedule_hour: 8,
        schedule_minute: 0,
        timezone: "UTC",
        max_items_per_section: 4,
        prefs_json: JSON.stringify({
          sources: [source],
          routes: [
            {
              id: "legacy-route",
              sources: ["slack:channel:C_LEGACY"],
              focus: null,
              sections: null,
              maxItemsPerSection: null,
              schedule: { hour: 8, minute: 0 },
              destination: { kind: "self" },
              enabled: true,
            },
          ],
        }),
      })
      .execute();
    const service = createService(db, tasks, allowSlackDelivery([{ id: "C_LEGACY", name: "legacy" }]));
    const userRow = await users.findById(user.id);
    const now = new Date("2026-07-04T08:05:00.000Z");

    const due = await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, now);
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: due[0]?.outputDate,
      periodKey: due[0]?.periodKey,
      triggerType: "scheduled",
      skipIfCompleted: true,
      scopeKeys: due[0]?.scopeKeys,
    });

    expect(due).toEqual([{ outputDate: "2026-07-04", periodKey: "2026-07-04", scopeKeys: ["slack:channel:C_LEGACY"] }]);
    expect(rows.map((row) => ({ outputDate: row.output_date, periodKey: row.period_key }))).toEqual([
      { outputDate: "2026-07-04", periodKey: "2026-07-04" },
    ]);
    expect(tasks).toHaveLength(1);
  });

  it("generates only the requested route scope when routeIds is provided", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const sourceC = slackSource("C_C", "gamma");
    const combinedRoute: AgentRoute = {
      id: "alpha-beta",
      sources: ["slack:channel:C_A", "slack:channel:C_B"],
      focus: null,
      sections: null,
      maxItemsPerSection: null,
      schedule: null,
      destination: { kind: "off" },
      enabled: true,
    };
    const service = createService(db, tasks, {
      ...allowSlackDelivery([
        { id: "C_A", name: "alpha" },
        { id: "C_B", name: "beta" },
        { id: "C_C", name: "gamma" },
      ]),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA, sourceB, sourceC],
      routes: [combinedRoute, sourceRoute(sourceC)],
    });

    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
      routeIds: ["alpha-beta"],
    });

    const expectedScopeKey = scopeKeyForRoute(combinedRoute, [sourceA, sourceB]);
    const outputs = await db
      .selectFrom("agent_outputs")
      .select(["source_key", "status"])
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .orderBy("source_key", "asc")
      .execute();

    expect(rows.map((row) => row.source_key)).toEqual([expectedScopeKey]);
    expect(outputs).toEqual([{ source_key: expectedScopeKey, status: "running" }]);
    expect(tasks).toHaveLength(1);
  });
});

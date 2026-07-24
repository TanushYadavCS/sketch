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

  it("generates every route scope when routeIds is omitted", async () => {
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
    });

    const expectedScopeKeys = [scopeKeyForRoute(combinedRoute, [sourceA, sourceB]), "slack:channel:C_C"].sort();
    const outputs = await db
      .selectFrom("agent_outputs")
      .select(["source_key", "status"])
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .orderBy("source_key", "asc")
      .execute();

    expect(rows.map((row) => row.source_key).sort()).toEqual(expectedScopeKeys);
    expect(outputs.map((output) => output.source_key).sort()).toEqual(expectedScopeKeys);
    expect(outputs.every((output) => output.status === "running")).toBe(true);
    expect(tasks).toHaveLength(2);
  });

  it("derives deterministic scope keys for source and combined routes", () => {
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const single = sourceRoute(sourceA);
    const combined: AgentRoute = {
      id: "combined-route",
      sources: ["slack:channel:C_A", "slack:channel:C_B"],
      focus: null,
      sections: null,
      maxItemsPerSection: null,
      schedule: null,
      destination: { kind: "off" },
      enabled: true,
    };
    const reversed: AgentRoute = { ...combined, sources: ["slack:channel:C_B", "slack:channel:C_A"] };

    expect(scopeKeyForRoute(single, [sourceA])).toBe("slack:channel:C_A");
    expect(scopeKeyForRoute(reversed, [sourceB, sourceA])).toBe(scopeKeyForRoute(combined, [sourceA, sourceB]));
    expect(scopeKeyForRoute(combined, [sourceA, sourceB])).toMatch(/^route:[a-f0-9]{12}$/);
  });

  it("rejects duplicate combined routes regardless of source order", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const user = await users.create({ name: "Agent User", email: "agent@example.com", slackUserId: "U_AGENT" });
    const service = createService(
      db,
      tasks,
      allowSlackDelivery([
        { id: "C_A", name: "alpha" },
        { id: "C_B", name: "beta" },
      ]),
    );

    await expect(
      service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
        enabled: true,
        sources: [sourceA, sourceB],
        routes: [
          {
            ...sourceRoute(sourceA),
            id: "alpha-beta",
            sources: ["slack:channel:C_A", "slack:channel:C_B"],
            destination: { kind: "off" },
          },
          {
            ...sourceRoute(sourceB),
            id: "beta-alpha",
            sources: ["slack:channel:C_B", "slack:channel:C_A"],
            destination: { kind: "off" },
          },
        ],
      }),
    ).rejects.toThrow("Routes must not duplicate the same output scope");
  });

  it("rejects combined channel route destinations that match a selected source", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const user = await users.create({ name: "Agent User", email: "agent@example.com", slackUserId: "U_AGENT" });
    const service = createService(
      db,
      tasks,
      allowSlackDelivery([
        { id: "C_A", name: "alpha" },
        { id: "C_B", name: "beta" },
      ]),
    );

    await expect(
      service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
        enabled: true,
        sources: [sourceA, sourceB],
        routes: [
          {
            ...sourceRoute(sourceA),
            id: "alpha-beta-to-alpha",
            sources: ["slack:channel:C_A", "slack:channel:C_B"],
            destination: {
              kind: "channel",
              platform: "slack",
              targetType: "channel",
              targetId: "C_A",
              label: "#alpha",
            },
          },
        ],
      }),
    ).rejects.toThrow("Combined routes cannot deliver to one of the selected sources");
  });

  it("synthesizes legacy deliveryModel-only configs into equivalent routes", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const user = await users.create({ name: "Agent User", email: "agent@example.com", slackUserId: "U_AGENT" });
    const contexts: Record<string, Record<string, unknown>> = {};
    const outputDelivery = { deliver: vi.fn(async () => {}) } satisfies AgentOutputDeliveryPublisher;
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
      outputDelivery,
      ...allowSlackDelivery([
        { id: "C_A", name: "alpha" },
        { id: "C_B", name: "beta" },
      ]),
    });
    await db
      .insertInto("agent_user_configs")
      .values({
        agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
        user_id: user.id,
        enabled: 1,
        schedule_hour: 9,
        schedule_minute: 30,
        timezone: "UTC",
        max_items_per_section: 3,
        prefs_json: JSON.stringify({
          sources: [sourceA, sourceB],
          focus: "Customer escalations",
          sections: { highlights: true, decisions: false, action_items: false, open_questions: true },
          deliveryModel: {
            mode: "per_source",
            defaultRoute: "off",
            perSource: {
              "slack:channel:C_A": { kind: "self" },
              "slack:channel:C_B": { kind: "off" },
            },
            combined: null,
          },
        }),
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
      .execute();

    const config = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, user.id);
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    for (const task of tasks) await task();

    expect(config?.routes).toEqual([
      {
        id: "slack:channel:C_A",
        sources: ["slack:channel:C_A"],
        focus: "Customer escalations",
        sections: { highlights: true, decisions: false, action_items: false, open_questions: true },
        maxItemsPerSection: 3,
        schedule: null,
        destination: { kind: "self" },
        enabled: true,
      },
      {
        id: "slack:channel:C_B",
        sources: ["slack:channel:C_B"],
        focus: "Customer escalations",
        sections: { highlights: true, decisions: false, action_items: false, open_questions: true },
        maxItemsPerSection: 3,
        schedule: null,
        destination: { kind: "off" },
        enabled: true,
      },
    ]);
    expect(rows.map((row) => row.source_key).sort()).toEqual(["slack:channel:C_A", "slack:channel:C_B"]);
    for (const row of rows) {
      const context = contexts[row.id];
      expect(context.focus).toBe("Customer escalations");
      expect(context.maxItemsPerSection).toBe(3);
      expect(context.sections).toEqual(["highlights", "open_questions"]);
      expect(context.sources).toEqual([
        expect.objectContaining({ targetId: row.source_key === "slack:channel:C_A" ? "C_A" : "C_B" }),
      ]);
    }
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_A" }) }),
    );
  });

  it("synthesizes combined legacy delivery as an off combined route for Arc 2", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const user = await users.create({ name: "Agent User", email: "combined@example.com", slackUserId: "U_COMBINED" });
    const outputDelivery = { deliver: vi.fn(async () => {}) } satisfies AgentOutputDeliveryPublisher;
    const service = createService(db, tasks, {
      outputDelivery,
      ...allowSlackDelivery([
        { id: "C_A", name: "alpha" },
        { id: "C_B", name: "beta" },
        { id: "C_DEST", name: "leadership" },
      ]),
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      sources: [sourceA, sourceB],
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DEST",
        label: "#leadership",
      },
    });

    const config = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, user.id);
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(config?.routes).toEqual([
      expect.objectContaining({
        sources: ["slack:channel:C_A", "slack:channel:C_B"],
        destination: { kind: "off" },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_key).toMatch(/^route:[a-f0-9]{12}$/);
    expect(outputDelivery.deliver).not.toHaveBeenCalled();
  });

  it("rejects WhatsApp group delivery when the current user is not a participant", async () => {
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
          participants: [{ jid: "15557654321@s.whatsapp.net" }],
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
      }),
    ).rejects.toThrow("WhatsApp group is not available for this user");
  });

  it("delivers scheduled outputs after saving the brief", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-delivery", name: "Delivery Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery();
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-delivery"], fileIds: [] } }),
      outputDelivery,
      undefined,
      slackDelivery,
    );
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DAILY",
        label: "#daily",
      },
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(slackDelivery.isUserInChannel).toHaveBeenCalledWith("C_DAILY", "U_AGENT");
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ targetId: "C_DAILY" }),
        output: expect.objectContaining({ id: row.id, outputDate: OUTPUT_DATE }),
      }),
    );
  });
});

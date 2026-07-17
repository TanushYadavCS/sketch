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

  it("supersedes stale running outputs instead of returning them forever", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("agent_outputs")
      .values({
        id: "stale-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const [replacement] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    const stale = await db.selectFrom("agent_outputs").selectAll().where("id", "=", "stale-output").executeTakeFirst();
    const running = await db
      .selectFrom("agent_outputs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .execute();

    expect(stale?.status).toBe("failed");
    expect(stale?.error_message).toBe("Generation expired after being left running.");
    expect(replacement?.id).not.toBe("stale-output");
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(replacement?.id);
    expect(tasks).toHaveLength(1);
  });

  it("does not report stale running outputs as active on latest reads", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const staleAt = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
    await db
      .insertInto("agent_outputs")
      .values({
        id: "stale-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        timezone: "UTC",
        status: "running",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .execute();

    const service = createService(db, tasks);
    const latest = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, user.id, OUTPUT_DATE);

    expect(latest.running).toBe(false);
    expect(latest.output).toBeNull();
  });

  it("coalesces duplicate running output creation for the same agent, user, and date", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const repo = createAgentOutputRepository(db);

    const first = await repo.createRunning({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      agentVersion: DAILY_BRIEF_AGENT_VERSION,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const second = await repo.createRunning({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      agentVersion: DAILY_BRIEF_AGENT_VERSION,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      triggerType: "manual",
    });
    const running = await db
      .selectFrom("agent_outputs")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .execute();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(running).toHaveLength(1);
  });

  it("rejects stale writer completion after a running output has been superseded", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const repo = createAgentOutputRepository(db);
    await db
      .insertInto("agent_outputs")
      .values({
        id: "superseded-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "manual",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Generation expired after being left running.",
        created_at: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("agent_output_items")
      .values({
        id: "existing-item",
        agent_output_id: "superseded-output",
        section_key: "todos",
        title: "Existing item",
        summary: "Existing summary",
        priority: "high",
        label: "todo",
        display_ref: null,
        action_type: null,
        action_label: null,
        action_prompt: null,
        knowledge_refs_json: JSON.stringify({ entityIds: [], fileIds: [] }),
        source_url: null,
        sort_order: 0,
        created_at: new Date().toISOString(),
      })
      .execute();

    await expect(
      repo.completeOutput({
        outputId: "superseded-output",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {},
        items: [briefItem({ title: "Late stale item" })],
      }),
    ).rejects.toThrow("Agent output generation is no longer running.");

    const output = await db
      .selectFrom("agent_outputs")
      .select(["status", "generated_at"])
      .where("id", "=", "superseded-output")
      .executeTakeFirstOrThrow();
    const items = await db
      .selectFrom("agent_output_items")
      .select(["id", "title"])
      .where("agent_output_id", "=", "superseded-output")
      .execute();

    expect(output.status).toBe("failed");
    expect(output.generated_at).toBeNull();
    expect(items).toEqual([{ id: "existing-item", title: "Existing item" }]);
  });

  it("uses referenced file provider URLs instead of agent-provided source URLs", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "safe-source-file", providerUrl: "https://docs.example.com/source" });
    const service = createWritingService(
      db,
      tasks,
      briefItem({
        sourceUrl: "javascript:alert(1)",
        knowledgeRefs: { entityIds: [], fileIds: ["safe-source-file"] },
      }),
    );

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();
    const output = await service.getByIdForUser(DAILY_BRIEF_AGENT_KEY, row.id, user.id);

    expect(output?.sections.todos[0].sourceUrl).toBe("https://docs.example.com/source");
  });

  it("drops agent-provided source URLs when referenced files have no provider URL", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await seedIndexedFile(db, { id: "source-file-without-url", providerUrl: null });
    const service = createWritingService(
      db,
      tasks,
      briefItem({
        sourceUrl: "https://phishing.example.com/source",
        knowledgeRefs: { entityIds: [], fileIds: ["source-file-without-url"] },
      }),
    );

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();
    const output = await service.getByIdForUser(DAILY_BRIEF_AGENT_KEY, row.id, user.id);

    expect(output?.sections.todos[0].sourceUrl).toBeNull();
  });

  it("passes Daily Brief candidate context into the agent runtime message", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "provider-identity",
        user_id: user.id,
        provider: "google",
        provider_user_id: "google-user",
        provider_email: "provider@example.com",
      })
      .execute();
    await seedEntity(db, { id: "entity-provider-email", name: "Provider Email Project", hotness: 1 });
    await seedIndexedFile(db, {
      id: "file-provider-email",
      providerUrl: null,
      sourceUpdatedAt: NOW.toISOString(),
      restrictedTo: "provider@example.com",
    });
    await seedMention(db, {
      id: "mention-provider-email",
      entityId: "entity-provider-email",
      fileId: "file-provider-email",
    });
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Daily Brief", summary: "Summary" },
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
    });

    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    const userMessage = runAgent.mock.calls[0][0].userMessage;
    expect(userMessage).toContain('"dailyBriefCandidateContext"');
    expect(userMessage).toContain('"entityWindowDays": 7');
    expect(userMessage).toContain('"evidenceWindowDays": 30');
    expect(userMessage).toContain('"Provider Email Project"');
    expect(userMessage).toContain('"sampleFileIds": [');
    expect(userMessage).toContain('"file-provider-email"');
    expect(userMessage).toContain('"hotFallbackEntities": []');
  });

  it("passes saved non-route Daily Brief section and volume preferences into the runtime message", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const contexts: Record<string, Record<string, unknown>> = {};
    const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
      const runtimeContext = runtimeContextFromUserMessage(params.userMessage);
      contexts[String(runtimeContext.outputId)] = runtimeContext;
      if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
      await params.agentOutputWriter.write({
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        masthead: { title: "Daily Brief", summary: "Summary" },
        rawPayload: {
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Daily Brief", summary: "Summary" },
          items: [],
        },
        items: [],
      });
      return successfulRunResult();
    });
    const service = createService(db, tasks, { runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"] });

    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      sections: { customer_updates: false, active_projects: false },
      maxItemsPerSection: 2,
      focus: "  Prioritize urgent work  ",
    });
    const [row] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });
    if (!row) throw new Error("Expected a generated output row");
    await tasks[0]();

    expect(contexts[row.id].sections).toEqual(["meetings", "todos"]);
    expect(contexts[row.id].maxItemsPerSection).toBe(2);
    expect(contexts[row.id].focus).toBe("Prioritize urgent work");
  });

  it.each(["scheduled", "manual"] as const)(
    "captures one fail-open authority snapshot for an opted-in $triggerType run without logging sensitive values",
    async (triggerType) => {
      const tasks: Array<() => Promise<void>> = [];
      const users = createUserRepository(db);
      const user = await users.create({ name: "Agent User", email: "user@example.com" });
      await db
        .insertInto("connector_configs")
        .values({
          id: "authority-connector-sensitive-id",
          connector_type: "google_calendar",
          auth_type: "oauth",
          credentials: "authority-secret-credential",
          sync_status: "active",
          created_by: user.id,
        })
        .execute();
      const contexts: Record<string, unknown>[] = [];
      const runAgent = vi.fn(async (params: Parameters<AgentRunServiceDeps["runAgent"]>[0]) => {
        contexts.push(runtimeContextFromUserMessage(params.userMessage));
        if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
        await params.agentOutputWriter.write({
          outputDate: OUTPUT_DATE,
          timezone: "UTC",
          masthead: { title: "Daily Brief", summary: "Summary" },
          rawPayload: {
            outputDate: OUTPUT_DATE,
            timezone: "UTC",
            masthead: { title: "Daily Brief", summary: "Summary" },
            items: [],
          },
          items: [],
        });
        return successfulRunResult();
      });
      const info = vi.fn();
      const logger = {
        info,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AgentRunServiceDeps["logger"];
      const getIntegrationStatus = vi.fn(async () => {
        throw new Error("provider failure with authority-secret-provider-value");
      });
      const definition = dailyBriefDefinition as typeof dailyBriefDefinition & { usesContextAuthority?: boolean };
      const previousUsesContextAuthority = definition.usesContextAuthority;
      definition.usesContextAuthority = true;
      try {
        const service = createService(db, tasks, {
          runAgent: runAgent as unknown as AgentRunServiceDeps["runAgent"],
          logger,
          getIntegrationStatus,
        } as Partial<AgentRunServiceDeps>);

        const [row] = await service.requestGenerationForUser({
          agentKey: DAILY_BRIEF_AGENT_KEY,
          userId: user.id,
          outputDate: OUTPUT_DATE,
          triggerType,
        });
        if (!row) throw new Error("Expected a generated output row");
        await tasks[0]();
      } finally {
        definition.usesContextAuthority = previousUsesContextAuthority;
      }

      expect(getIntegrationStatus).toHaveBeenCalledTimes(1);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.contextAuthority).toMatchObject({
        connectors: {
          status: "available",
          apps: [expect.objectContaining({ key: "connector:google_calendar" })],
        },
        integrations: { status: "unavailable", apps: [] },
      });
      expect(info).toHaveBeenCalledWith(
        {
          event: "agent_context_authority_snapshot",
          agentKey: DAILY_BRIEF_AGENT_KEY,
          connectorReadStatus: "available",
          integrationReadStatus: "unavailable",
          connectedConnectorCount: 1,
          connectedIntegrationCount: 0,
        },
        "Agent: context authority snapshot captured",
      );
      const serializedLogs = JSON.stringify(info.mock.calls);
      expect(serializedLogs).not.toContain("authority-connector-sensitive-id");
      expect(serializedLogs).not.toContain("authority-secret-credential");
      expect(serializedLogs).not.toContain("authority-secret-provider-value");
      expect(serializedLogs).not.toContain("google_calendar");
    },
  );

  it("suppresses recent failed scheduled attempts during the schedule window", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    await db
      .insertInto("agent_outputs")
      .values({
        id: "failed-scheduled-output",
        agent_key: DAILY_BRIEF_AGENT_KEY,
        user_id: user.id,
        output_date: OUTPUT_DATE,
        period_key: OUTPUT_DATE,
        timezone: "UTC",
        status: "failed",
        trigger_type: "scheduled",
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        error_message: "Agent failed",
        created_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      })
      .execute();

    const service = createService(db, tasks);
    const userRow = await users.findById(user.id);
    const shouldGenerate = await service.shouldGenerateForUser(dailyBriefDefinition, userRow ?? user, NOW);
    const [request] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
      skipIfCompleted: true,
    });

    const rows = await db
      .selectFrom("agent_outputs")
      .select(["id", "status"])
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .execute();

    expect(shouldGenerate).toEqual([]);
    expect(request?.id).toBe("failed-scheduled-output");
    expect(rows).toEqual([{ id: "failed-scheduled-output", status: "failed" }]);
    expect(tasks).toHaveLength(0);
  });
});

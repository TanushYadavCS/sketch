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

const NOW = new Date("2026-06-15T08:05:00.000Z");
const OUTPUT_DATE = "2026-06-15";

function emptySummaryPayload(summary = "Summary") {
  return {
    outputDate: OUTPUT_DATE,
    timezone: "UTC",
    masthead: { title: "Summarizer", summary },
    items: [],
  };
}

function createPausedQueueManager(tasks: Array<() => Promise<void>>): QueueManager {
  return {
    getQueue: () => ({
      enqueue: (task: () => Promise<void>) => {
        tasks.push(task);
        return true;
      },
    }),
  } as unknown as QueueManager;
}

function createService(
  db: Kysely<DB>,
  tasks: Array<() => Promise<void>>,
  overrides: Partial<AgentRunServiceDeps> = {},
): AgentRunService {
  const runAgent = vi.fn(async () => {
    throw new Error("runAgent should not be called by these tests");
  }) as unknown as AgentRunServiceDeps["runAgent"];
  const interactiveRunAgent = overrides.runAgent ?? runAgent;
  const scheduledRunAgent = overrides.runScheduledAgent ?? interactiveRunAgent;
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    queueManager: createPausedQueueManager(tasks),
    ...overrides,
    runAgent: interactiveRunAgent,
    runScheduledAgent: scheduledRunAgent,
  });
}

function createWritingService(
  db: Kysely<DB>,
  tasks: Array<() => Promise<void>>,
  item: AgentOutputItemInput,
  outputDelivery?: AgentOutputDeliveryPublisher,
  afterWrite?: () => Promise<void>,
  overrides: Partial<AgentRunServiceDeps> = {},
): AgentRunService {
  const runAgent = vi.fn(async (params) => {
    if (!params.agentOutputWriter) throw new Error("agentOutputWriter missing");
    await params.agentOutputWriter.write({
      outputDate: OUTPUT_DATE,
      timezone: "UTC",
      masthead: { title: "Daily Brief", summary: "Summary" },
      rawPayload: {},
      items: [item],
    });
    await afterWrite?.();
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
  }) as unknown as AgentRunServiceDeps["runAgent"];
  const interactiveRunAgent = overrides.runAgent ?? runAgent;
  const scheduledRunAgent = overrides.runScheduledAgent ?? interactiveRunAgent;
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    queueManager: createPausedQueueManager(tasks),
    outputDelivery,
    ...overrides,
    runAgent: interactiveRunAgent,
    runScheduledAgent: scheduledRunAgent,
  });
}

function allowSlackDelivery(
  channels: Array<{ id: string; name: string }> = [{ id: "C_DAILY", name: "daily" }],
  isUserInChannel = vi.fn(async () => true),
): Pick<AgentRunServiceDeps, "getSlack"> & {
  isUserInChannel: typeof isUserInChannel;
} {
  return {
    isUserInChannel,
    getSlack: () => ({
      listChannels: vi.fn(async () =>
        channels.map((channel) => ({ ...channel, type: "public_channel", isMember: true })),
      ),
      isUserInChannel,
    }),
  };
}

function slackSource(id: string, name: string): AgentSourceConfig {
  return { platform: "slack", targetType: "channel", targetId: id, label: `#${name}` };
}

function whatsappSource(jid: string, name: string): AgentSourceConfig {
  return { platform: "whatsapp", targetType: "group", targetId: jid, label: name };
}

function perSourceSelfModel(): AgentDeliveryModel {
  return { mode: "per_source", defaultRoute: "self", perSource: {}, combined: null };
}

function sourceRoute(
  source: AgentSourceConfig,
  overrides: Partial<Omit<AgentRoute, "id" | "sources">> = {},
): AgentRoute {
  const sourceKey = `${source.platform}:${source.targetType}:${source.targetId}` as AgentRoute["sources"][number];
  return {
    id: sourceKey,
    sources: [sourceKey],
    focus: null,
    sections: null,
    maxItemsPerSection: null,
    schedule: null,
    destination: { kind: "self" },
    enabled: true,
    ...overrides,
  };
}

function runtimeContextFromUserMessage(userMessage: string): Record<string, unknown> {
  const marker = "Runtime context:\n";
  const markerIndex = userMessage.indexOf(marker);
  if (markerIndex === -1) throw new Error("Runtime context marker missing");
  return JSON.parse(userMessage.slice(markerIndex + marker.length)) as Record<string, unknown>;
}

async function seedSlackConversationMessage(
  db: Kysely<DB>,
  source: AgentSourceConfig,
  params: { messageId: string; text: string; receivedAt: string },
): Promise<void> {
  const conversations = createConversationRepository(db);
  const conversation = await conversations.getOrCreate(
    {
      platform: source.platform,
      kind: "channel",
      providerConversationId: source.targetId,
    },
    source.label,
  );
  await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: params.messageId,
    senderJid: "U_SENDER",
    senderName: "Sender",
    text: params.text,
    receivedAt: params.receivedAt,
  });
}

async function seedIndexedFile(
  db: Kysely<DB>,
  params: { id: string; providerUrl: string | null; sourceUpdatedAt?: string | null; restrictedTo?: string },
): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "agent-owner", name: "Agent Owner" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "agent-connector",
      connector_type: "google-drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "agent-owner",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: "agent-connector",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "document",
      content_category: "document",
      source: "google-drive",
      source_path: null,
      provider_url: params.providerUrl,
      content: "Agent source content",
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: params.sourceUpdatedAt ?? null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();

  if (params.restrictedTo) {
    await db.insertInto("file_access").values({ indexed_file_id: params.id, email: params.restrictedTo }).execute();
  }
}

async function seedEntity(db: Kysely<DB>, params: { id: string; name: string; hotness?: number }): Promise<void> {
  const now = NOW.toISOString();
  await db
    .insertInto("entities")
    .values({
      id: params.id,
      name: params.name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: params.hotness ?? 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedPersonEntity(db: Kysely<DB>, params: { id: string; name: string; email: string }): Promise<void> {
  const now = NOW.toISOString();
  await db
    .insertInto("entities")
    .values({
      id: params.id,
      name: params.name,
      source_type: "person",
      subtype: null,
      aliases: JSON.stringify([params.email]),
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedMention(
  db: Kysely<DB>,
  params: { id: string; entityId: string; fileId: string; mentionedAt?: string },
): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: params.id,
      entity_id: params.entityId,
      indexed_file_id: params.fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: params.mentionedAt ?? NOW.toISOString(),
    })
    .execute();
}

function briefItem(overrides: Partial<AgentOutputItemInput> = {}): AgentOutputItemInput {
  return {
    sectionKey: "todos",
    title: "Follow up with customer",
    summary: "Customer asked for a status update.",
    priority: "high",
    label: "todo",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

function successfulRunResult() {
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
}

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

  it("keeps the legacy config-control resolver scoped to the viewer while admin lists aggregate Summarizer configs", async () => {
    const users = createUserRepository(db);
    const adminA = await users.create({
      name: "Admin A",
      email: "admin-a@example.com",
      slackUserId: "U_ADMIN_A",
      authRole: "admin",
    });
    const adminB = await users.create({
      name: "Admin B",
      email: "admin-b@example.com",
      slackUserId: "U_ADMIN_B",
      authRole: "admin",
    });
    const source = slackSource("C_A", "alpha");
    const route = sourceRoute(source);
    const service = createService(db, [], allowSlackDelivery([{ id: "C_A", name: "alpha" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, adminA.id, {
      sources: [source],
      routes: [route],
    });

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, adminB.id, "admin")).resolves.toBe(
      adminB.id,
    );

    const summaries = await service.listForViewer(adminB.id, "admin");
    expect(summaries.find((summary) => summary.key === CONVERSATION_SUMMARY_AGENT_KEY)).toMatchObject({
      sources: [source],
      routes: [
        expect.objectContaining({
          ...route,
          id: expect.stringMatching(/^org:/),
          owner: expect.objectContaining({ userId: adminA.id, name: "Admin A", authRole: "admin" }),
        }),
      ],
    });
  });

  it("keeps admin Summarizer control on self when no admin config exists", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      authRole: "admin",
    });
    const service = createService(db, []);

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin")).resolves.toBe(
      admin.id,
    );
  });

  it("keeps members and non-Summarizer agents scoped to the viewer", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({ name: "Member", email: "member@example.com", authRole: "member" });
    const source = slackSource("C_A", "alpha");
    const service = createService(db, [], allowSlackDelivery([{ id: "C_A", name: "alpha" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, {
      sources: [source],
      routes: [sourceRoute(source)],
    });

    await expect(service.resolveConfigControlUserId(CONVERSATION_SUMMARY_AGENT_KEY, member.id, "member")).resolves.toBe(
      member.id,
    );
    await expect(service.resolveConfigControlUserId(DAILY_BRIEF_AGENT_KEY, admin.id, "admin")).resolves.toBe(admin.id);
  });

  it("lists org-wide Summarizer configs for admins across member and admin owners", async () => {
    const users = createUserRepository(db);
    const adminA = await users.create({
      name: "Admin A",
      email: "admin-a@example.com",
      slackUserId: "U_ADMIN_A",
      authRole: "admin",
    });
    const adminB = await users.create({
      name: "Admin B",
      email: "admin-b@example.com",
      slackUserId: "U_ADMIN_B",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const adminSource = slackSource("C_ADMIN", "admin-source");
    const memberSource = slackSource("C_MEMBER", "member-source");
    const service = createService(
      db,
      [],
      allowSlackDelivery([
        { id: "C_ADMIN", name: "admin-source" },
        { id: "C_MEMBER", name: "member-source" },
      ]),
    );

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, adminA.id, {
      sources: [adminSource],
      routes: [sourceRoute(adminSource, { focus: "Admin route" })],
    });
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [memberSource],
      routes: [sourceRoute(memberSource, { focus: "Member route" })],
    });

    const summaries = await service.listForViewer(adminB.id, "admin");
    const summary = summaries.find((item) => item.key === CONVERSATION_SUMMARY_AGENT_KEY);

    expect(summary?.sources).toHaveLength(2);
    expect(summary?.sources).toEqual(expect.arrayContaining([adminSource, memberSource]));
    expect(summary?.routes).toHaveLength(2);
    expect(summary?.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^org:/),
          sources: [`slack:channel:${adminSource.targetId}`],
          focus: "Admin route",
          owner: expect.objectContaining({ userId: adminA.id, name: "Admin A", authRole: "admin" }),
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^org:/),
          sources: [`slack:channel:${memberSource.targetId}`],
          focus: "Member route",
          owner: expect.objectContaining({ userId: member.id, name: "Maya Member", authRole: "member" }),
        }),
      ]),
    );
  });

  it("lets admins update a member-owned Summarizer route without moving ownership", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const source = slackSource("C_MEMBER", "member-source");
    const service = createService(db, [], allowSlackDelivery([{ id: "C_MEMBER", name: "member-source" }]));

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [source],
      routes: [sourceRoute(source)],
    });
    const adminView = await service.getConfigViewForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin");
    const disabledRoutes =
      adminView?.routes.map((route) => (route.owner?.userId === member.id ? { ...route, enabled: false } : route)) ??
      [];

    await service.updateConfigForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      routes: disabledRoutes,
    });

    const memberView = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, member.id);
    const adminOwnConfig = await createAgentOutputRepository(db).getConfig(CONVERSATION_SUMMARY_AGENT_KEY, admin.id);
    expect(memberView?.routes).toEqual([
      expect.objectContaining({ id: `slack:channel:${source.targetId}`, enabled: false }),
    ]);
    expect(adminOwnConfig.exists).toBe(false);
  });

  it("stores new unowned routes created from an admin org-wide view under that admin", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      slackUserId: "U_ADMIN",
      authRole: "admin",
    });
    const member = await users.create({
      name: "Maya Member",
      email: "maya@example.com",
      slackUserId: "U_MAYA",
      authRole: "member",
    });
    const memberSource = slackSource("C_MEMBER", "member-source");
    const adminSource = slackSource("C_ADMIN", "admin-source");
    const service = createService(
      db,
      [],
      allowSlackDelivery([
        { id: "C_MEMBER", name: "member-source" },
        { id: "C_ADMIN", name: "admin-source" },
      ]),
    );

    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, member.id, {
      sources: [memberSource],
      routes: [sourceRoute(memberSource)],
    });
    const adminView = await service.getConfigViewForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin");
    const newAdminRoute = sourceRoute(adminSource, { focus: "Admin-created route" });

    await service.updateConfigForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      sources: [memberSource, adminSource],
      routes: [...(adminView?.routes ?? []), newAdminRoute],
    });

    const memberView = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, member.id);
    const adminViewAfterSave = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, admin.id);
    expect(memberView?.routes).toHaveLength(1);
    expect(adminViewAfterSave?.routes).toEqual([
      expect.objectContaining({ id: newAdminRoute.id, focus: "Admin-created route" }),
    ]);
  });

  it("lists org-wide Summarizer outputs for admins", async () => {
    const users = createUserRepository(db);
    const admin = await users.create({ name: "Admin", email: "admin@example.com", authRole: "admin" });
    const member = await users.create({ name: "Maya Member", email: "maya@example.com", authRole: "member" });
    const service = createService(db, []);
    const repo = createAgentOutputRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("agent_outputs")
      .values([
        {
          id: "admin-output",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: admin.id,
          output_date: OUTPUT_DATE,
          period_key: OUTPUT_DATE,
          source_key: "slack:channel:C_ADMIN",
          source_label: "#admin-source",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: conversationSummaryDefinition.version,
          agent_run_id: null,
          masthead_json: JSON.stringify({ title: "Admin", summary: "Admin summary" }),
          raw_payload_json: "{}",
          error_message: null,
          generated_at: "2026-06-15T10:00:00.000Z",
          created_at: now,
          updated_at: now,
        },
        {
          id: "member-output",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: member.id,
          output_date: OUTPUT_DATE,
          period_key: OUTPUT_DATE,
          source_key: "slack:channel:C_MEMBER",
          source_label: "#member-source",
          timezone: "UTC",
          status: "completed",
          trigger_type: "manual",
          agent_version: conversationSummaryDefinition.version,
          agent_run_id: null,
          masthead_json: JSON.stringify({ title: "Member", summary: "Member summary" }),
          raw_payload_json: "{}",
          error_message: null,
          generated_at: "2026-06-15T11:00:00.000Z",
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const outputs = await service.listOutputsForViewer(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, "admin", {
      limit: 10,
    });
    const memberOnlyOutputs = await service.listOutputsForViewer(CONVERSATION_SUMMARY_AGENT_KEY, member.id, "member", {
      limit: 10,
    });

    expect(outputs.outputs.map((output) => output.id)).toEqual(["member-output", "admin-output"]);
    expect(memberOnlyOutputs.outputs.map((output) => output.id)).toEqual(["member-output"]);
    expect(
      (await repo.listCompletedForUser(CONVERSATION_SUMMARY_AGENT_KEY, admin.id, { limit: 10 })).outputs,
    ).toHaveLength(1);
  });

  it("resolves WhatsApp group sources by bot-known group membership without requiring a user WhatsApp number", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const source = whatsappSource("120363000000001@g.us", "Spoofed");
    await createWhatsAppGroupRepository(db).upsert({
      jid: source.targetId,
      name: "Leadership",
      description: null,
      updated_at: "2026-06-27T00:00:00.000Z",
    });
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "86702773280883@lid" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

    const updated = await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      sources: [source],
    });

    expect(updated?.sources).toEqual([
      {
        platform: "whatsapp",
        targetType: "group",
        targetId: "120363000000001@g.us",
        label: "Leadership",
      },
    ]);
    expect(getGroupMetadata).not.toHaveBeenCalled();
  });

  it("rejects WhatsApp group sources that are not known to the bot", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          id: "120363000000404@g.us",
          owner: "15550000000@s.whatsapp.net",
          subject: "Unknown",
          participants: [],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

    await expect(
      service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
        sources: [whatsappSource("120363000000404@g.us", "Unknown")],
      }),
    ).rejects.toThrow("WhatsApp group is not available as a source");
    expect(getGroupMetadata).not.toHaveBeenCalled();
  });

  it("keeps Slack source validation strict to current-user channel membership", async () => {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const isUserInChannel = vi.fn(async () => false);
    const service = createService(db, [], {
      getSlack: () => ({
        listChannels: vi.fn(async () => [
          { id: "C_PRIVATE", name: "private-room", type: "private_channel", isMember: true },
        ]),
        isUserInChannel,
      }),
    });

    await expect(
      service.resolveSourceConfigsForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, [
        slackSource("C_PRIVATE", "private-room"),
      ]),
    ).rejects.toThrow("Slack channel is not available for this user");
    expect(isUserInChannel).toHaveBeenCalledWith("C_PRIVATE", "U_AGENT");
  });

  it("normalizes delivery models with defaultRoute and full-key legacy matching", async () => {
    const users = createUserRepository(db);
    const slackDelivery = allowSlackDelivery([
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
      { id: "U_AGENT", name: "user-like-channel" },
    ]);

    const defaultRouteUser = await users.create({
      name: "Default Route User",
      email: "default-route@example.com",
      slackUserId: "U_DEFAULT",
    });
    const defaultRouteService = createService(db, [], slackDelivery);
    await defaultRouteService.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, defaultRouteUser.id, {
      sources: [slackSource("C_A", "alpha")],
      deliveryModel: perSourceSelfModel(),
    });
    const reconciled = await defaultRouteService.updateConfigForUser(
      CONVERSATION_SUMMARY_AGENT_KEY,
      defaultRouteUser.id,
      {
        sources: [slackSource("C_A", "alpha"), slackSource("C_B", "beta")],
      },
    );

    expect(reconciled?.deliveryModel).toMatchObject({
      mode: "per_source",
      defaultRoute: "self",
      perSource: {
        "slack:channel:C_A": { kind: "self" },
        "slack:channel:C_B": { kind: "self" },
      },
    });

    const fullKeyUser = await users.create({
      name: "Full Key User",
      email: "full-key@example.com",
      slackUserId: "U_AGENT",
    });
    const fullKeyService = createService(db, [], slackDelivery);
    const fullKeyConfig = await fullKeyService.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, fullKeyUser.id, {
      sources: [slackSource("U_AGENT", "user-like-channel")],
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "dm",
        targetId: "U_AGENT",
        label: "Self DM",
      },
    });

    expect(fullKeyConfig?.deliveryModel).toMatchObject({
      mode: "combined",
      combined: { targetType: "dm", targetId: "U_AGENT" },
    });
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
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "15551234567@s.whatsapp.net" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

    await expect(
      service.resolveDeliveryConfigForUser(user.id, {
        enabled: true,
        platform: "whatsapp",
        targetType: "group",
        targetId: "unknown@g.us",
        label: "Unknown",
      }),
    ).rejects.toThrow("WhatsApp group");

    expect(getGroupMetadata).not.toHaveBeenCalled();

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
    expect(getGroupMetadata).toHaveBeenCalledWith("120363000000001@g.us");
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
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "86702773280883@lid" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const resolveJidToPhone = vi.fn(async (jid: string) => (jid === "86702773280883@lid" ? "+15551234567" : null));
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata, resolveJidToPhone }) });

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
    expect(resolveJidToPhone).toHaveBeenCalledWith("86702773280883@lid");
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
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "15551234567@s.whatsapp.net" }, { id: "15557654321@s.whatsapp.net" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

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
      getWhatsApp: () => ({ getGroupMetadata: vi.fn() }),
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
    const getGroupMetadata = vi.fn(
      async () =>
        ({
          subject: "Leadership",
          participants: [{ id: "15557654321@s.whatsapp.net" }],
        }) as Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
    );
    const service = createService(db, [], { getWhatsApp: () => ({ getGroupMetadata }) });

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

  it("routes scheduled generations separately from manual generations", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    await tasks.shift()?.();

    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: "2026-06-16",
      triggerType: "manual",
    });
    await tasks.shift()?.();

    expect(interactiveRunAgent).toHaveBeenCalledTimes(1);
    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
  });

  it("promotes a queued scheduled generation when a manual request coalesces onto it", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("manual");
    expect(tasks).toHaveLength(2);

    await tasks.shift()?.();
    expect(scheduledRunAgent).not.toHaveBeenCalled();
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    await tasks.shift()?.();
    expect(interactiveRunAgent).toHaveBeenCalledTimes(1);
    expect(scheduledRunAgent).not.toHaveBeenCalled();
  });

  it("keeps the scheduled generation when the manual replacement queue is full", async () => {
    const acceptedTasks: Array<() => Promise<void>> = [];
    let enqueueCalls = 0;
    const queueManager = {
      getQueue: () => ({
        enqueue: (task: () => Promise<void>) => {
          enqueueCalls += 1;
          if (enqueueCalls > 1) return false;
          acceptedTasks.push(task);
          return true;
        },
      }),
    } as unknown as QueueManager;
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async () => {
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, [], {
      queueManager,
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(enqueueCalls).toBe(2);
    expect(acceptedTasks).toHaveLength(1);
    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("scheduled");

    await acceptedTasks[0]?.();
    expect(scheduledRunAgent).toHaveBeenCalledTimes(1);
    expect(interactiveRunAgent).not.toHaveBeenCalled();
  });

  it("keeps an admitted scheduled generation instead of duplicating it for a manual request", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    let releaseScheduled!: () => void;
    const scheduledGate = new Promise<void>((resolve) => {
      releaseScheduled = resolve;
    });
    const interactiveRunAgent = vi.fn(async () => {
      throw new Error("interactive test stop");
    }) as unknown as AgentRunServiceDeps["runAgent"];
    const scheduledRunAgent = vi.fn(async (_params, admission) => {
      admission?.onStart?.();
      await scheduledGate;
      throw new Error("scheduled test stop");
    }) as unknown as AgentRunServiceDeps["runScheduledAgent"];
    const service = createService(db, tasks, {
      runAgent: interactiveRunAgent,
      runScheduledAgent: scheduledRunAgent,
    });

    const [scheduled] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
    });
    const runningTask = tasks.shift()?.();
    await vi.waitFor(() => expect(scheduledRunAgent).toHaveBeenCalledTimes(1));

    const [manual] = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "manual",
    });

    expect(manual.id).toBe(scheduled.id);
    expect(manual.trigger_type).toBe("scheduled");
    expect(tasks).toHaveLength(0);
    expect(interactiveRunAgent).not.toHaveBeenCalled();

    releaseScheduled();
    await runningTask;
  });

  it("uses the latest delivery config after a scheduled run completes", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-delivery-latest", name: "Delivery Latest Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery([
      { id: "C_OLD", name: "old" },
      { id: "C_NEW", name: "new" },
    ]);
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-delivery-latest"], fileIds: [] } }),
      outputDelivery,
      async () => {
        await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
          delivery: {
            enabled: true,
            platform: "slack",
            targetType: "channel",
            targetId: "C_NEW",
            label: "#new",
          },
        });
      },
      slackDelivery,
    );
    await service.updateConfigForUser(DAILY_BRIEF_AGENT_KEY, user.id, {
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_OLD",
        label: "#old",
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
    expect(slackDelivery.isUserInChannel).toHaveBeenCalledWith("C_NEW", "U_AGENT");
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ targetId: "C_NEW" }),
      }),
    );
  });

  it("delivers manual outputs when delivery is configured", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-manual", name: "Manual Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {}),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery();
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-manual"], fileIds: [] } }),
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
      triggerType: "manual",
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

  it("keeps the brief completed when scheduled delivery fails", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    await seedEntity(db, { id: "entity-delivery-failure", name: "Delivery Failure Project" });
    const outputDelivery = {
      deliver: vi.fn(async () => {
        throw new Error("Slack unavailable");
      }),
    } satisfies AgentOutputDeliveryPublisher;
    const slackDelivery = allowSlackDelivery();
    const service = createWritingService(
      db,
      tasks,
      briefItem({ knowledgeRefs: { entityIds: ["entity-delivery-failure"], fileIds: [] } }),
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

    const output = await db
      .selectFrom("agent_outputs")
      .select(["status", "error_message"])
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(output.status).toBe("completed");
    expect(output.error_message).toBeNull();
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(1);
  });
});

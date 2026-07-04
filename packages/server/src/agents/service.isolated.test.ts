import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentDeliveryModel,
  type AgentOutputItemInput,
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
import { AgentRunService, type AgentRunServiceDeps } from "./service";

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
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    runAgent,
    queueManager: createPausedQueueManager(tasks),
    ...overrides,
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
  return new AgentRunService({
    db,
    config: createTestConfig(),
    logger: createTestLogger(),
    users: createUserRepository(db),
    settings: createSettingsRepository(db),
    runAgent,
    queueManager: createPausedQueueManager(tasks),
    outputDelivery,
    ...overrides,
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

function perSourceSelfModel(): AgentDeliveryModel {
  return { mode: "per_source", defaultRoute: "self", perSource: {}, combined: null };
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

    expect(shouldGenerate).toBeNull();
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
    });

    expect(updated?.enabled).toBe(false);
    expect(updated?.scheduleHour).toBe(9);
    expect(updated?.focus).toBe("Prioritize enterprise accounts");
    const customer = updated?.sections.find((s) => s.key === "customer_updates");
    const todos = updated?.sections.find((s) => s.key === "todos");
    expect(customer?.enabled).toBe(false);
    expect(todos?.enabled).toBe(true);

    const reread = await service.getConfigView(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(reread?.enabled).toBe(false);
    expect(reread?.focus).toBe("Prioritize enterprise accounts");
    expect(reread?.sections.find((s) => s.key === "customer_updates")?.enabled).toBe(false);

    const latest = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, user.id);
    expect(latest.enabledSections).toContain("todos");
    expect(latest.enabledSections).not.toContain("customer_updates");
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

  it("fans out per-source summaries with serialized context isolated to each source", async () => {
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
      deliveryModel: perSourceSelfModel(),
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
      expect(context.sources).toEqual([
        expect.objectContaining({
          targetId: row.source_key === "slack:channel:C_A" ? "C_A" : "C_B",
        }),
      ]);
      expect(context.summarySources).toEqual([
        expect.objectContaining({
          targetId: row.source_key === "slack:channel:C_A" ? "C_A" : "C_B",
        }),
      ]);
      expect(context.sameDayPreviousOutput).toBeNull();
      expect(context.previousDayOutput).toBeNull();
      expect(JSON.stringify(context)).not.toContain(row.source_key === "slack:channel:C_A" ? "C_B" : "C_A");
      expect(JSON.stringify(context)).not.toContain(row.source_key === "slack:channel:C_A" ? "Beta-only" : "Alpha");
    }
    expect(outputDelivery.deliver).toHaveBeenCalledTimes(2);
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_A" }) }),
    );
    expect(outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_B" }) }),
    );
  });

  it("schedules only incomplete per-source scopes and reruns an aged failed source", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const slackDelivery = allowSlackDelivery([
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
    ]);
    const service = createService(db, tasks, slackDelivery);
    await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
      enabled: true,
      scheduleHour: 8,
      scheduleMinute: 0,
      sources: [sourceA, sourceB],
      deliveryModel: perSourceSelfModel(),
    });
    await db
      .insertInto("agent_outputs")
      .values([
        {
          id: "completed-a",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          output_date: OUTPUT_DATE,
          source_key: "slack:channel:C_A",
          source_label: "#alpha",
          timezone: "UTC",
          status: "completed",
          trigger_type: "scheduled",
          agent_version: "test",
          generated_at: NOW.toISOString(),
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
        {
          id: "aged-failed-b",
          agent_key: CONVERSATION_SUMMARY_AGENT_KEY,
          user_id: user.id,
          output_date: OUTPUT_DATE,
          source_key: "slack:channel:C_B",
          source_label: "#beta",
          timezone: "UTC",
          status: "failed",
          trigger_type: "scheduled",
          agent_version: "test",
          error_message: "Old failure",
          created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ])
      .execute();

    const userRow = await users.findById(user.id);
    const due = await service.shouldGenerateForUser(conversationSummaryDefinition, userRow ?? user, NOW);
    const rows = await service.requestGenerationForUser({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: user.id,
      outputDate: OUTPUT_DATE,
      triggerType: "scheduled",
      skipIfCompleted: true,
    });

    const running = await db
      .selectFrom("agent_outputs")
      .select(["source_key", "status"])
      .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
      .where("user_id", "=", user.id)
      .where("output_date", "=", OUTPUT_DATE)
      .where("status", "=", "running")
      .execute();

    expect(due).toEqual({ outputDate: OUTPUT_DATE });
    expect(rows).toHaveLength(1);
    expect(rows[0].source_key).toBe("slack:channel:C_B");
    expect(running).toEqual([{ source_key: "slack:channel:C_B", status: "running" }]);
    expect(tasks).toHaveLength(1);
  });

  it("preserves legacy delivery semantics without newly posting to added sources", async () => {
    const sourceA = slackSource("C_A", "alpha");
    const sourceB = slackSource("C_B", "beta");
    const channels = [
      { id: "C_A", name: "alpha" },
      { id: "C_B", name: "beta" },
      { id: "C_DEST", name: "leadership" },
    ];

    async function runScenario(
      userIdPrefix: string,
      initialPatch: Parameters<AgentRunService["updateConfigForUser"]>[2],
      nextSources?: AgentSourceConfig[],
    ) {
      const tasks: Array<() => Promise<void>> = [];
      const users = createUserRepository(db);
      const user = await users.create({
        name: `Agent User ${userIdPrefix}`,
        email: `${userIdPrefix}@example.com`,
        slackUserId: `U_${userIdPrefix}`,
      });
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
        ...allowSlackDelivery(channels),
      });
      await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, {
        enabled: true,
        ...initialPatch,
      });
      if (nextSources) {
        await service.updateConfigForUser(CONVERSATION_SUMMARY_AGENT_KEY, user.id, { sources: nextSources });
      }
      const config = await service.getConfigView(CONVERSATION_SUMMARY_AGENT_KEY, user.id);
      const rows = await service.requestGenerationForUser({
        agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        triggerType: "manual",
      });
      for (const task of tasks) await task();
      return { config, rows, outputDelivery };
    }

    const allOff = await runScenario("OFF", { sources: [sourceA], delivery: null }, [sourceA, sourceB]);
    expect(allOff.config?.deliveryModel).toMatchObject({
      mode: "per_source",
      defaultRoute: "off",
      perSource: {
        "slack:channel:C_A": { kind: "off" },
        "slack:channel:C_B": { kind: "off" },
      },
    });
    expect(allOff.rows.map((row) => row.source_key).sort()).toEqual(["slack:channel:C_A", "slack:channel:C_B"]);
    expect(allOff.outputDelivery.deliver).not.toHaveBeenCalled();

    const sourceDelivery = await runScenario("SRC", {
      sources: [sourceA, sourceB],
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_A",
        label: "#alpha",
      },
    });
    expect(sourceDelivery.config?.deliveryModel).toMatchObject({
      mode: "per_source",
      defaultRoute: "off",
      perSource: {
        "slack:channel:C_A": { kind: "self" },
        "slack:channel:C_B": { kind: "off" },
      },
    });
    expect(sourceDelivery.outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(sourceDelivery.outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_A" }) }),
    );

    const combined = await runScenario("COMBINED", {
      sources: [sourceA, sourceB],
      delivery: {
        enabled: true,
        platform: "slack",
        targetType: "channel",
        targetId: "C_DEST",
        label: "#leadership",
      },
    });
    expect(combined.config?.deliveryModel).toMatchObject({
      mode: "combined",
      combined: { targetId: "C_DEST", ackNonDm: true },
    });
    expect(combined.rows).toHaveLength(1);
    expect(combined.rows[0].source_key).toBe("");
    expect(combined.outputDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(combined.outputDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ targetId: "C_DEST" }) }),
    );
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

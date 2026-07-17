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

export {
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
};

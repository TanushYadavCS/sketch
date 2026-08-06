import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkWhatsAppIndexingGroups } from "../connectors/whatsapp-chunker";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { type ConversationMessageInsert, createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { WhatsAppAdapterDeps } from "./adapter";
import { wireWhatsAppHandlers } from "./adapter";
import { encodeWhatsAppBackfillCheckpointKey } from "./backfill-checkpoint";
import type { WhatsAppHistoryBatchMetadata, WhatsAppInboundMessage } from "./provider";
import type { WhatsAppRuntime } from "./runtime";

interface HistoryHarness {
  emitHistory: (messages: WhatsAppInboundMessage[], metadata?: WhatsAppHistoryBatchMetadata) => Promise<unknown>;
  handleHistoryMessages: ReturnType<typeof wireWhatsAppHandlers>["handleHistoryMessages"];
  runAgent: ReturnType<typeof vi.fn>;
}

function recentHistoryTimestamp(minutesAgo: number): string {
  return new Date(Date.now() - 24 * 60 * 60_000 - minutesAgo * 60_000).toISOString();
}

function createMockRuntime(): WhatsAppRuntime & Pick<HistoryHarness, "emitHistory"> {
  let historyHandler:
    | ((messages: WhatsAppInboundMessage[], metadata?: WhatsAppHistoryBatchMetadata) => Promise<unknown>)
    | null = null;

  return {
    isConnected: true,
    shouldHandleInboundMessage: () => true,
    onMessage: vi.fn(),
    onHistoryMessages: vi.fn((handler) => {
      historyHandler = handler as typeof historyHandler;
    }),
    getCapabilities: vi.fn(() => ({
      text: true,
      media: true,
      quotedReply: true,
      templates: false,
      templateProvisioning: "none" as const,
      interactive: false,
      deliveryStatus: false,
      typing: false,
      reactions: false,
      edit: false,
      groups: true,
    })),
    sendText: vi.fn(),
    sendTemplate: vi.fn(),
    sendFile: vi.fn(),
    startComposing: vi.fn(),
    stopComposing: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    downloadMedia: vi.fn(async () => []),
    getGroupMetadata: vi.fn(),
    resolveJidToPhone: vi.fn(),
    async emitHistory(messages, metadata) {
      if (!historyHandler) throw new Error("History handler was not registered");
      return historyHandler(messages, metadata);
    },
  };
}

function groupMessage(input: {
  groupJid: string;
  providerMessageId: string;
  providerTimestamp: string;
  text?: string;
  senderPhoneE164?: string;
  fromMe?: boolean;
  connectionKey?: string | null;
}): WhatsAppInboundMessage {
  const senderPhoneE164 = input.senderPhoneE164 ?? "+15550001000";
  const senderJid = `${senderPhoneE164.replace(/\D/gu, "")}@s.whatsapp.net`;
  return {
    kind: "group",
    providerId: "baileys",
    providerMessageId: input.providerMessageId,
    providerConversationId: input.groupJid,
    canonicalConversationId: `group:${input.groupJid}`,
    providerTimestamp: input.providerTimestamp,
    senderName: "History Sender",
    senderProviderId: senderJid,
    senderPhoneE164,
    target: { kind: "group", groupId: input.groupJid },
    text: input.text ?? input.providerMessageId,
    isMentioned: false,
    rawProviderPayload: {
      key: {
        remoteJid: input.groupJid,
        id: input.providerMessageId,
        fromMe: input.fromMe ?? false,
        participant: senderJid,
      },
      messageTimestamp: Math.floor(Date.parse(input.providerTimestamp) / 1000),
    },
    connectionKey: input.connectionKey ?? null,
  };
}

async function createHarness(
  db: Kysely<DB>,
  dataDir: string,
  overrides: Partial<WhatsAppAdapterDeps["repos"]> = {},
): Promise<HistoryHarness> {
  const runtime = createMockRuntime();
  const runAgent = vi.fn(async () => ({}) as never);
  const handlers = wireWhatsAppHandlers(runtime, {
    db,
    config: createTestConfig({
      DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: join(dataDir, "claude"),
      SKETCH_CONFIG_DIR: join(dataDir, "sketch"),
    }),
    logger: createTestLogger(),
    repos: {
      users: createUserRepository(db),
      settings: createSettingsRepository(db),
      whatsappGroups: createWhatsAppGroupRepository(db),
      conversations: createConversationRepository(db),
      ...overrides,
    },
    queue: new QueueManager(),
    runAgent,
    buildMcpServers: vi.fn(async () => ({})),
    loadIntegrationProvider: vi.fn(async () => null),
    sendDm: vi.fn(async () => ({ channelId: "dm:+15550001000", messageRef: "sent-1" })),
  });
  return Object.assign(runtime, { handleHistoryMessages: handlers.handleHistoryMessages, runAgent });
}

async function listStoredMessages(db: Kysely<DB>, groupJid: string) {
  return db
    .selectFrom("conversation_messages")
    .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
    .select([
      "conversation_messages.provider_message_id",
      "conversation_messages.received_at",
      "conversation_messages.provider_timestamp",
      "conversation_messages.event_key",
      "conversation_messages.source",
      "conversation_messages.effective_at",
      "conversation_messages.connection_key",
      "conversation_messages.attachments",
    ])
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("conversations.provider_conversation_id", "=", groupJid)
    .orderBy("conversation_messages.provider_message_id", "asc")
    .execute();
}

async function seedEnabledGroup(db: Kysely<DB>, groupJid: string) {
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: "Backfill Test Group",
    description: null,
    tool_progress: null,
    reasoning_text: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
  const group = await groups.setIndexEnabled(groupJid, true, { sliceGapMinutes: 5 });
  if (!group) throw new Error("Failed to enable WhatsApp test group");
  return group;
}

function runBackfillCheckpointSuite(label: string, getDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;
    let dataDir!: string;

    beforeEach(async () => {
      db = await getDb();
      dataDir = await mkdtemp(join(tmpdir(), "sketch-whatsapp-backfill-"));
    }, 30000);

    afterEach(async () => {
      await db.destroy();
      await rm(dataDir, { recursive: true, force: true });
    });

    it("replays after a simulated crash without duplicate rows", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const batch1 = [
        groupMessage({
          groupJid,
          providerMessageId: "history-001",
          providerTimestamp: recentHistoryTimestamp(0),
        }),
        groupMessage({
          groupJid,
          providerMessageId: "history-002",
          providerTimestamp: recentHistoryTimestamp(1),
        }),
      ];
      const batch2 = [
        batch1[1],
        groupMessage({
          groupJid,
          providerMessageId: "history-003",
          providerTimestamp: recentHistoryTimestamp(2),
        }),
      ];
      const conversations = createConversationRepository(db);
      let insertAttempts = 0;
      const crashingConversations = {
        ...conversations,
        async insertMessage(data: ConversationMessageInsert) {
          insertAttempts += 1;
          if (insertAttempts === 2) {
            throw new Error("simulated process kill after partial durable write");
          }
          return conversations.insertMessage(data);
        },
      };

      const crashedProcess = await createHarness(db, dataDir, { conversations: crashingConversations });

      await expect(crashedProcess.emitHistory(batch1, { progress: 40 })).rejects.toThrow(
        "simulated process kill after partial durable write",
      );
      await expect(listStoredMessages(db, groupJid)).resolves.toHaveLength(1);

      const checkpoints = createConversationSlicesRepository(db);
      const failedCheckpoint = await checkpoints.getBackfillCheckpoint(groupJid);
      expect(failedCheckpoint).toMatchObject({
        status: "failed",
        last_fetched_key: encodeWhatsAppBackfillCheckpointKey(batch1[0]),
      });

      const restartedProcess = await createHarness(db, dataDir);
      await expect(restartedProcess.emitHistory(batch1, { progress: 60 })).resolves.toMatchObject({
        persisted: 1,
        skippedDup: 1,
      });
      await expect(restartedProcess.emitHistory(batch2, { progress: 100 })).resolves.toMatchObject({
        persisted: 1,
        skippedDup: 1,
      });

      const rows = await listStoredMessages(db, groupJid);
      expect(rows.map((row) => row.provider_message_id)).toEqual(["history-001", "history-002", "history-003"]);
      const completeCheckpoint = await checkpoints.getBackfillCheckpoint(groupJid);
      expect(completeCheckpoint).toMatchObject({
        status: "complete",
        last_fetched_key: encodeWhatsAppBackfillCheckpointKey(batch2[1]),
      });

      await expect(restartedProcess.emitHistory([batch2[1]], { progress: 100 })).resolves.toMatchObject({
        persisted: 0,
        skippedDup: 1,
      });
      await expect(listStoredMessages(db, groupJid)).resolves.toHaveLength(3);
    });

    it("keeps backfilled conversation rows out of the live chunker", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const group = await seedEnabledGroup(db, groupJid);
      const harness = await createHarness(db, dataDir);

      await expect(
        harness.emitHistory(
          [
            groupMessage({
              groupJid,
              providerMessageId: "chunk-newer",
              providerTimestamp: recentHistoryTimestamp(0),
            }),
            groupMessage({
              groupJid,
              providerMessageId: "chunk-older",
              providerTimestamp: recentHistoryTimestamp(1),
            }),
          ],
          { progress: 100 },
        ),
      ).resolves.toMatchObject({ persisted: 2, skippedDup: 0 });

      const summary = await chunkWhatsAppIndexingGroups({
        db,
        groups: [group],
        logger: createTestLogger(),
        now: new Date(),
      });
      const slices = await db.selectFrom("conversation_slices").selectAll().orderBy("started_at", "asc").execute();

      expect(summary.slicesCreated).toBe(0);
      expect(summary.messagesProcessed).toBe(0);
      expect(slices).toHaveLength(0);
    });

    it("persists valid history with event identity, provenance, connection key, and idempotent redelivery", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const harness = await createHarness(db, dataDir);
      const first = groupMessage({
        groupJid,
        providerMessageId: "history-event-key",
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        connectionKey: "000000000007:000000000019",
      });
      const redelivery = groupMessage({
        groupJid,
        providerMessageId: "history-event-key",
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        senderPhoneE164: "+15550002000",
        connectionKey: "000000000007:000000000019",
      });
      const captureMetadataForMessage = () => ({
        eventKey: "event-history-event-key",
        connectionKey: "000000000007:000000000019",
      });

      await expect(
        harness.handleHistoryMessages([first], { progress: 100 }, { captureMetadataForMessage }),
      ).resolves.toMatchObject({ persisted: 1, skippedDup: 0 });
      await expect(
        harness.handleHistoryMessages([redelivery], { progress: 100 }, { captureMetadataForMessage }),
      ).resolves.toMatchObject({ persisted: 0, skippedDup: 1 });

      const rows = await listStoredMessages(db, groupJid);
      expect(rows).toEqual([
        expect.objectContaining({
          provider_message_id: "history-event-key",
          event_key: "event-history-event-key",
          source: "history",
          effective_at: "2026-07-17T09:00:00.000Z",
          connection_key: "000000000007:000000000019",
          attachments: null,
        }),
      ]);
    });

    it("skips history without a provider id or genuine provider timestamp without advancing coverage", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const harness = await createHarness(db, dataDir);
      const missingId = groupMessage({
        groupJid,
        providerMessageId: "",
        providerTimestamp: "2026-07-17T09:00:00.000Z",
      });
      const missingTimestamp = groupMessage({
        groupJid,
        providerMessageId: "missing-timestamp",
        providerTimestamp: "invalid",
      });

      await expect(harness.emitHistory([missingId, missingTimestamp], { progress: 100 })).resolves.toEqual({
        persisted: 0,
        skippedOld: 0,
        skippedDup: 0,
      });
      await expect(listStoredMessages(db, groupJid)).resolves.toEqual([]);
      await expect(createConversationSlicesRepository(db).getBackfillCheckpoint(groupJid)).resolves.toBeUndefined();
    });

    it("stores fromMe group history without dispatching it", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const harness = await createHarness(db, dataDir);
      const fromMe = groupMessage({
        groupJid,
        providerMessageId: "history-from-me",
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        fromMe: true,
      });

      await expect(harness.emitHistory([fromMe], { progress: 100 })).resolves.toMatchObject({ persisted: 1 });
      await expect(listStoredMessages(db, groupJid)).resolves.toEqual([
        expect.objectContaining({ provider_message_id: "history-from-me", source: "history" }),
      ]);
      expect(harness.runAgent).not.toHaveBeenCalled();
    });
  });
}

runBackfillCheckpointSuite("WhatsApp backfill checkpoints sqlite", createTestDb);
runBackfillCheckpointSuite("WhatsApp backfill checkpoints postgres", createTestPgDb);

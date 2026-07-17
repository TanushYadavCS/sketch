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
}

function createMockRuntime(): WhatsAppRuntime & HistoryHarness {
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
      key: { remoteJid: input.groupJid, id: input.providerMessageId, fromMe: false, participant: senderJid },
      messageTimestamp: Math.floor(Date.parse(input.providerTimestamp) / 1000),
    },
  };
}

async function createHarness(
  db: Kysely<DB>,
  dataDir: string,
  overrides: Partial<WhatsAppAdapterDeps["repos"]> = {},
): Promise<HistoryHarness> {
  const runtime = createMockRuntime();
  wireWhatsAppHandlers(runtime, {
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
    runAgent: vi.fn(async () => ({}) as never),
    buildMcpServers: vi.fn(async () => ({})),
    loadIntegrationProvider: vi.fn(async () => null),
    sendDm: vi.fn(async () => ({ channelId: "dm:+15550001000", messageRef: "sent-1" })),
  });
  return runtime;
}

async function listStoredMessages(db: Kysely<DB>, groupJid: string) {
  return db
    .selectFrom("conversation_messages")
    .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
    .select([
      "conversation_messages.provider_message_id",
      "conversation_messages.received_at",
      "conversation_messages.provider_timestamp",
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
          providerTimestamp: "2026-07-07T09:05:00.000Z",
        }),
        groupMessage({
          groupJid,
          providerMessageId: "history-002",
          providerTimestamp: "2026-07-07T09:04:00.000Z",
        }),
      ];
      const batch2 = [
        batch1[1],
        groupMessage({
          groupJid,
          providerMessageId: "history-003",
          providerTimestamp: "2026-07-07T09:03:00.000Z",
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

    it("feeds backfilled conversation rows into the next enabled-group chunker sync", async () => {
      const groupJid = `${randomUUID()}@g.us`;
      const group = await seedEnabledGroup(db, groupJid);
      const harness = await createHarness(db, dataDir);

      await expect(
        harness.emitHistory(
          [
            groupMessage({
              groupJid,
              providerMessageId: "chunk-newer",
              providerTimestamp: "2026-07-07T09:10:00.000Z",
            }),
            groupMessage({
              groupJid,
              providerMessageId: "chunk-older",
              providerTimestamp: "2026-07-07T09:00:00.000Z",
            }),
          ],
          { progress: 100 },
        ),
      ).resolves.toMatchObject({ persisted: 2, skippedDup: 0 });

      const summary = await chunkWhatsAppIndexingGroups({
        db,
        groups: [group],
        logger: createTestLogger(),
        now: new Date("2026-07-07T09:20:00.000Z"),
      });
      const slices = await db.selectFrom("conversation_slices").selectAll().orderBy("started_at", "asc").execute();

      expect(summary.slicesCreated).toBe(2);
      expect(slices).toHaveLength(2);
      expect(slices.map((slice) => slice.started_at)).toEqual(["2026-07-07T09:00:00.000Z", "2026-07-07T09:10:00.000Z"]);
      expect(slices.map((slice) => slice.message_count)).toEqual([1, 1]);
    });
  });
}

runBackfillCheckpointSuite("WhatsApp backfill checkpoints sqlite", createTestDb);
runBackfillCheckpointSuite("WhatsApp backfill checkpoints postgres", createTestPgDb);

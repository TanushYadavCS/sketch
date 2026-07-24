import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
import { type WhatsAppGroupIndexingConfig, createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import type { Attachment } from "../files";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import { runConnectorSync } from "./sync";
import { chunkWhatsAppIndexingGroups } from "./whatsapp-chunker";

interface SeededGroup {
  group: WhatsAppGroupIndexingConfig;
  conversationId: number;
}

function createLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

async function seedEnabledGroup(
  db: Kysely<DB>,
  overrides: {
    sliceGapMinutes?: number | null;
    sliceMaxAgeMinutes?: number | null;
    sliceMaxMessages?: number | null;
  } = {},
): Promise<SeededGroup> {
  const groupJid = `${randomUUID()}@g.us`;
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: groupJid,
    name: "Chunk Test Group",
    description: null,
    tool_progress: null,
    reasoning_text: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
  const group = await groups.setIndexEnabled(groupJid, true, overrides);
  if (!group) throw new Error("Failed to seed WhatsApp group");

  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });

  return { group, conversationId: conversation.id };
}

async function insertMessage(
  db: Kysely<DB>,
  conversationId: number,
  input: {
    providerMessageId: string;
    effectiveAt: string;
    text?: string;
    providerTimestamp?: string | null;
    receivedAt?: string;
    isBot?: boolean;
    attachments?: Attachment[];
    source?: "live" | "history";
  },
): Promise<number> {
  const inserted = await createConversationRepository(db).insertMessage({
    conversationId,
    providerMessageId: input.providerMessageId,
    senderJid: `${input.providerMessageId}@s.whatsapp.net`,
    senderName: "Sender",
    text: input.text ?? input.providerMessageId,
    providerTimestamp: input.providerTimestamp === undefined ? input.effectiveAt : input.providerTimestamp,
    receivedAt: input.receivedAt ?? input.effectiveAt,
    isBot: input.isBot ?? false,
    attachments: input.attachments,
    source: input.source,
  });

  return inserted.row.id;
}

async function listSlices(db: Kysely<DB>) {
  return db
    .selectFrom("conversation_slices")
    .selectAll()
    .orderBy("started_at", "asc")
    .orderBy("first_message_id", "asc")
    .execute();
}

async function listSlicesForConversation(db: Kysely<DB>, conversationId: number) {
  return db
    .selectFrom("conversation_slices")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("started_at", "asc")
    .orderBy("first_message_id", "asc")
    .execute();
}

async function seedWhatsAppConnector(db: Kysely<DB>) {
  const ownerId = `owner-${randomUUID()}`;
  await createUserRepository(db).create({
    id: ownerId,
    name: "WhatsApp Sync Owner",
    email: `${ownerId}@example.com`,
  });
  return createConnectorRepository(db).createConfig({
    connectorType: "whatsapp",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: "{}",
    createdBy: ownerId,
  });
}

async function runChunker(
  db: Kysely<DB>,
  group: WhatsAppGroupIndexingConfig,
  options: {
    now?: Date;
    logger?: Logger;
    onConversationClaimed?: (conversationId: number) => Promise<void>;
  } = {},
) {
  return chunkWhatsAppIndexingGroups({
    db,
    groups: [group],
    logger: options.logger ?? createLogger(),
    now: options.now ?? new Date("2026-07-07T10:00:00.000Z"),
    onConversationClaimed: options.onConversationClaimed,
  });
}

function runConnectorSyncSuite(label: string, getDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await getDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("passes app-level WhatsApp slice gap config through sync into chunking without a group override", async () => {
      const connectorConfig = await seedWhatsAppConnector(db);
      const defaultSeeded = await seedEnabledGroup(db);
      const defaultFirstId = await insertMessage(db, defaultSeeded.conversationId, {
        providerMessageId: "default-m-1",
        effectiveAt: "2025-01-01T09:00:00.000Z",
      });
      const defaultSecondId = await insertMessage(db, defaultSeeded.conversationId, {
        providerMessageId: "default-m-2",
        effectiveAt: "2025-01-01T09:06:00.000Z",
      });

      await runConnectorSync(db, connectorConfig.id, createTestLogger());

      const defaultSlices = await listSlicesForConversation(db, defaultSeeded.conversationId);
      expect(defaultSeeded.group).toMatchObject({
        sliceGapMinutes: null,
        sliceMaxAgeMinutes: null,
        sliceMaxMessages: null,
      });
      expect(defaultSlices).toHaveLength(1);
      expect(defaultSlices[0]).toMatchObject({
        first_message_id: defaultFirstId,
        last_message_id: defaultSecondId,
        message_count: 2,
        flush_reason: "gap",
      });

      const configuredSeeded = await seedEnabledGroup(db);
      const configuredFirstId = await insertMessage(db, configuredSeeded.conversationId, {
        providerMessageId: "configured-m-1",
        effectiveAt: "2025-01-01T09:00:00.000Z",
      });
      const configuredSecondId = await insertMessage(db, configuredSeeded.conversationId, {
        providerMessageId: "configured-m-2",
        effectiveAt: "2025-01-01T09:06:00.000Z",
      });

      await runConnectorSync(db, connectorConfig.id, createTestLogger(), {
        WHATSAPP_SLICE_GAP_MINUTES: 5,
        WHATSAPP_SLICE_MAX_AGE_MINUTES: 120,
        WHATSAPP_SLICE_MAX_MESSAGES: 50,
      });

      const configuredSlices = await listSlicesForConversation(db, configuredSeeded.conversationId);
      expect(configuredSeeded.group).toMatchObject({
        sliceGapMinutes: null,
        sliceMaxAgeMinutes: null,
        sliceMaxMessages: null,
      });
      expect(configuredSlices).toHaveLength(2);
      expect(configuredSlices[0]).toMatchObject({
        first_message_id: configuredFirstId,
        last_message_id: configuredFirstId,
        message_count: 1,
        flush_reason: "gap",
      });
      expect(configuredSlices[1]).toMatchObject({
        first_message_id: configuredSecondId,
        last_message_id: configuredSecondId,
        message_count: 1,
        flush_reason: "gap",
      });
    });
  });
}

function runChunkerSuite(label: string, getDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await getDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("is idempotent across reruns over the same data", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-2",
        effectiveAt: "2026-07-07T09:30:00.000Z",
      });

      const first = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });
      const second = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });
      const slices = await listSlices(db);

      expect(first.slicesCreated).toBe(1);
      expect(second.slicesCreated).toBe(0);
      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({
        message_count: 1,
        flush_reason: "gap",
        salience_verdict: null,
        indexed_file_id: null,
      });
    });

    it("skips slice creation when a group is disabled after the sync snapshot", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });

      const result = await runChunker(db, seeded.group, {
        now: new Date("2026-07-07T09:30:00.000Z"),
        onConversationClaimed: async () => {
          await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.group.jid, false);
        },
      });
      const slices = await listSlices(db);
      const cursor = await db
        .selectFrom("conversation_slice_cursors")
        .selectAll()
        .where("conversation_id", "=", seeded.conversationId)
        .executeTakeFirstOrThrow();

      expect(result.slicesCreated).toBe(0);
      expect(slices).toHaveLength(0);
      expect(cursor.claim_token).toBeNull();
    });

    it("prevents overlapping runs from creating duplicate slices", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });

      let releaseClaim!: () => void;
      let claimed!: () => void;
      const claimedPromise = new Promise<void>((resolve) => {
        claimed = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });

      const firstRun = runChunker(db, seeded.group, {
        now: new Date("2026-07-07T09:30:00.000Z"),
        onConversationClaimed: async () => {
          claimed();
          await releasePromise;
        },
      });
      await claimedPromise;
      const second = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:30:00.000Z") });
      releaseClaim();
      const first = await firstRun;
      const slices = await listSlices(db);
      const cursor = await db
        .selectFrom("conversation_slice_cursors")
        .selectAll()
        .where("conversation_id", "=", seeded.conversationId)
        .executeTakeFirstOrThrow();

      expect(first.slicesCreated).toBe(1);
      expect(second.slicesCreated).toBe(0);
      expect(slices).toHaveLength(1);
      expect(cursor.claim_token).toBeNull();
      expect(cursor.last_message_id).toBe(slices[0]?.last_message_id);
    });

    it("orders by provider timestamp when present and falls back to received_at", async () => {
      const seeded = await seedEnabledGroup(db);
      const firstId = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "live-captured",
        effectiveAt: "2026-07-07T09:00:00.000Z",
        providerTimestamp: "2026-07-07T09:00:00.000Z",
        receivedAt: "2026-07-07T10:00:00.000Z",
      });
      const secondId = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "received-fallback",
        effectiveAt: "2026-07-07T09:05:00.000Z",
        providerTimestamp: null,
        receivedAt: "2026-07-07T09:05:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "tail",
        effectiveAt: "2026-07-07T09:40:00.000Z",
      });

      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:41:00.000Z") });
      const slices = await listSlices(db);

      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({
        started_at: "2026-07-07T09:00:00.000Z",
        ended_at: "2026-07-07T09:05:00.000Z",
        denoised_message_ids: JSON.stringify([firstId, secondId]),
      });
    });

    it("falls back to received_at for pre-existing invalid provider timestamps", async () => {
      const seeded = await seedEnabledGroup(db);
      const firstId = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "bad-provider-time",
        effectiveAt: "2026-07-07T09:00:00.000Z",
        providerTimestamp: "2099-01-01T00:00:00.000Z",
        receivedAt: "2026-07-07T09:00:00.000Z",
      });
      const secondId = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "received-after-bad",
        effectiveAt: "2026-07-07T09:05:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "tail",
        effectiveAt: "2026-07-07T09:40:00.000Z",
      });

      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:41:00.000Z") });
      const slices = await listSlices(db);

      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({
        started_at: "2026-07-07T09:00:00.000Z",
        ended_at: "2026-07-07T09:05:00.000Z",
        denoised_message_ids: JSON.stringify([firstId, secondId]),
      });
    });

    it("counts and logs late arrivals behind the composite cursor", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "tail",
        effectiveAt: "2026-07-07T09:30:00.000Z",
      });
      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "late",
        effectiveAt: "2026-07-07T08:55:00.000Z",
      });
      const logger = createLogger();

      const result = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z"), logger });

      expect(result.lateArrivals).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        { conversationId: seeded.conversationId, lateArrivals: 1 },
        "late_arrival_skipped",
      );
    });

    it("excludes history rows from both live reads and late-arrival accounting", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "live-cursor",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:30:00.000Z") });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "history-behind-cursor",
        effectiveAt: "2026-07-07T08:55:00.000Z",
        source: "history",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "history-after-cursor",
        effectiveAt: "2026-07-07T09:10:00.000Z",
        source: "history",
      });

      const result = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });

      expect(result.messagesProcessed).toBe(0);
      expect(result.lateArrivals).toBe(0);
      expect(result.slicesCreated).toBe(0);
      await expect(listSlices(db)).resolves.toHaveLength(1);
    });

    it("bounds incremental scans by received_at while preserving cursor filtering", async () => {
      const seeded = await seedEnabledGroup(db);
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "cursor-message",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:30:00.000Z") });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "inside-bound-late",
        effectiveAt: "2026-07-07T08:59:00.000Z",
        providerTimestamp: "2026-07-07T08:59:00.000Z",
        receivedAt: "2026-07-05T09:00:00.001Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "outside-bound-newer-effective",
        effectiveAt: "2026-07-07T09:10:00.000Z",
        providerTimestamp: "2026-07-07T09:10:00.000Z",
        receivedAt: "2026-07-05T08:59:59.999Z",
      });

      const result = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });
      const slices = await listSlices(db);

      expect(result.lateArrivals).toBe(1);
      expect(result.messagesProcessed).toBe(0);
      expect(result.slicesCreated).toBe(0);
      expect(slices).toHaveLength(1);
    });

    it("respects per-group gap overrides", async () => {
      const seeded = await seedEnabledGroup(db, { sliceGapMinutes: 5 });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-2",
        effectiveAt: "2026-07-07T09:06:00.000Z",
      });

      const result = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:07:00.000Z") });
      const slices = await listSlices(db);

      expect(result.slicesCreated).toBe(1);
      expect(slices).toHaveLength(1);
      expect(slices[0]?.flush_reason).toBe("gap");
    });

    it("logs per-conversation summary counters without message content", async () => {
      const seeded = await seedEnabledGroup(db, { sliceMaxMessages: 2 });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "m-2",
        effectiveAt: "2026-07-07T09:01:00.000Z",
      });
      const logger = createLogger();

      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:02:00.000Z"), logger });

      expect(logger.info).toHaveBeenCalledWith(
        {
          conversationId: seeded.conversationId,
          slicesCreated: 1,
          messagesProcessed: 2,
          lateArrivals: 0,
          maxAgeFlushes: 0,
          maxSizeFlushes: 1,
        },
        "Completed WhatsApp conversation chunking",
      );
    });

    it("persists denoised message ids while first and last ids cover the contiguous drill range", async () => {
      const seeded = await seedEnabledGroup(db);
      const keptStart = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "kept-start",
        effectiveAt: "2026-07-07T09:00:00.000Z",
        text: "real start",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "bot",
        effectiveAt: "2026-07-07T09:01:00.000Z",
        text: "bot echo",
        isBot: true,
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "emoji",
        effectiveAt: "2026-07-07T09:02:00.000Z",
        text: "👍",
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "media",
        effectiveAt: "2026-07-07T09:03:00.000Z",
        text: "",
        attachments: [
          { originalName: "photo.jpg", mimeType: "image/jpeg", localPath: "/tmp/photo.jpg", sizeBytes: 10 },
        ],
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "control",
        effectiveAt: "2026-07-07T09:04:00.000Z",
        text: "/toolprogress off",
      });
      const keptEnd = await insertMessage(db, seeded.conversationId, {
        providerMessageId: "kept-end",
        effectiveAt: "2026-07-07T09:05:00.000Z",
        text: "real end",
      });

      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:40:00.000Z") });
      const slices = await listSlices(db);

      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({
        first_message_id: keptStart,
        last_message_id: keptEnd,
        message_count: 2,
        denoised_message_ids: JSON.stringify([keptStart, keptEnd]),
        flush_reason: "gap",
      });
    });
  });
}

runChunkerSuite("chunkWhatsAppIndexingGroups sqlite", createTestDb);
runChunkerSuite("chunkWhatsAppIndexingGroups postgres", createTestPgDb);
runConnectorSyncSuite("runConnectorSync WhatsApp chunker knobs sqlite", createTestDb);
runConnectorSyncSuite("runConnectorSync WhatsApp chunker knobs postgres", createTestPgDb);

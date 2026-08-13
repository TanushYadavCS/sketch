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

async function generateWholeBoundary(prompt: string): Promise<string> {
  const count = [...prompt.matchAll(/^\d+\. \[/gmu)].length;
  if (count <= 1) return JSON.stringify({ segments: [{ start: 1, end: 1, threads: ["topic"] }] });
  return JSON.stringify({
    segments: [
      { start: 1, end: count - 1, threads: ["topic-a"] },
      { start: count, end: count, threads: ["topic-b"] },
    ],
  });
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
    chunkMinMessages?: number | null;
    chunkWindowMessages?: number | null;
    chunkWindowTokens?: number | null;
    chunkTargetMessages?: number | null;
    chunkMaxMessages?: number | null;
    chunkMaxTokens?: number | null;
    chunkTickMinutes?: number | null;
    chunkIdleCloseHours?: number | null;
    chunkBurstThresholdMessages?: number | null;
    chunkGroupWorkerPool?: number | null;
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
  const group = await groups.setIndexEnabled(groupJid, true, {
    chunkMinMessages: 1,
    ...overrides,
  });
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
    llmGenerate?: (
      prompt: string,
      opts: { model: string | null; reasoningEffort: "low" | "medium" | "high"; maxTokens?: number; label?: string },
    ) => Promise<string>;
  } = {},
) {
  return chunkWhatsAppIndexingGroups({
    db,
    groups: [group],
    logger: options.logger ?? createLogger(),
    now: options.now ?? new Date("2026-07-07T10:00:00.000Z"),
    onConversationClaimed: options.onConversationClaimed,
    llmGenerate: options.llmGenerate ?? generateWholeBoundary,
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

    it("does not invoke deterministic slice settings when no LLM boundary generator is configured", async () => {
      const connectorConfig = await seedWhatsAppConnector(db);
      const defaultSeeded = await seedEnabledGroup(db);
      await insertMessage(db, defaultSeeded.conversationId, {
        providerMessageId: "default-m-1",
        effectiveAt: "2025-01-01T09:00:00.000Z",
      });
      await insertMessage(db, defaultSeeded.conversationId, {
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
      expect(defaultSlices).toEqual([]);

      const configuredSeeded = await seedEnabledGroup(db);
      await insertMessage(db, configuredSeeded.conversationId, {
        providerMessageId: "configured-m-1",
        effectiveAt: "2025-01-01T09:00:00.000Z",
      });
      await insertMessage(db, configuredSeeded.conversationId, {
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
      expect(configuredSlices).toEqual([]);
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

      const logger = createLogger();
      const first = await runChunker(db, seeded.group, {
        now: new Date("2026-07-07T09:31:00.000Z"),
        logger,
      });
      const second = await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:31:00.000Z") });
      const slices = await listSlices(db);

      expect(logger.warn).not.toHaveBeenCalled();

      expect(first).toEqual({
        conversationsProcessed: 1,
        slicesCreated: 1,
        lateArrivals: 0,
        messagesProcessed: 2,
        maxAgeFlushes: 0,
        maxSizeFlushes: 0,
      });
      expect(second.slicesCreated).toBe(0);
      expect(slices).toHaveLength(2);
      expect(slices[0]).toMatchObject({
        status: "closed",
        message_count: 1,
        flush_reason: "llm_boundary",
        salience_verdict: "kept",
        indexed_file_id: null,
      });
      expect(slices[1]).toMatchObject({ status: "open", message_count: 1, flush_reason: "llm_boundary" });
    });

    it("gates recent ticks, honors the burst override, and drains multiple FIFO windows", async () => {
      const seeded = await seedEnabledGroup(db, {
        chunkWindowMessages: 4,
        chunkTickMinutes: 30,
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "tick-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      const calls: string[] = [];
      const generate = async (prompt: string): Promise<string> => {
        calls.push(prompt);
        return generateWholeBoundary(prompt);
      };

      await runChunker(db, seeded.group, {
        now: new Date("2026-07-07T09:30:00.000Z"),
        llmGenerate: generate,
      });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "tick-2",
        effectiveAt: "2026-07-07T09:31:00.000Z",
      });
      await db
        .updateTable("whatsapp_groups")
        .set({ chunk_last_llm_attempt_at: "2026-07-07T09:30:00.000Z" })
        .where("jid", "=", seeded.group.jid)
        .execute();
      const recentGroup = await createWhatsAppGroupRepository(db).getIndexingConfig(seeded.group.jid);
      if (!recentGroup) throw new Error("expected recent WhatsApp group config");

      await runChunker(db, recentGroup, {
        now: new Date("2026-07-07T09:31:00.000Z"),
        llmGenerate: generate,
      });
      expect(calls).toHaveLength(1);

      await createWhatsAppGroupRepository(db).setIndexEnabled(seeded.group.jid, true, {
        chunkBurstThresholdMessages: 1,
      });
      const burstGroup = await createWhatsAppGroupRepository(db).getIndexingConfig(seeded.group.jid);
      if (!burstGroup) throw new Error("expected burst WhatsApp group config");
      await runChunker(db, burstGroup, {
        now: new Date("2026-07-07T09:32:00.000Z"),
        llmGenerate: generate,
      });
      expect(calls).toHaveLength(2);

      const drain = await seedEnabledGroup(db, {
        chunkWindowMessages: 2,
        chunkTargetMessages: 2,
        chunkMaxMessages: 2,
      });
      const drainIds: number[] = [];
      for (let index = 1; index <= 5; index += 1) {
        drainIds.push(
          await insertMessage(db, drain.conversationId, {
            providerMessageId: `drain-${index}`,
            effectiveAt: `2026-07-07T09:0${index}:00.000Z`,
          }),
        );
      }
      const drainCalls: string[] = [];
      const drainResult = await runChunker(db, drain.group, {
        now: new Date("2026-07-07T10:00:00.000Z"),
        llmGenerate: async (prompt) => {
          drainCalls.push(prompt);
          return generateWholeBoundary(prompt);
        },
      });
      const drainCursor = await db
        .selectFrom("conversation_slice_cursors")
        .select(["last_message_id"])
        .where("conversation_id", "=", drain.conversationId)
        .executeTakeFirstOrThrow();

      expect(drainCalls.length).toBeGreaterThanOrEqual(3);
      expect(drainResult.messagesProcessed).toBe(5);
      expect(drainCursor.last_message_id).toBe(drainIds[4]);
    });

    it("closes an idle live tail before the empty-pending return", async () => {
      const seeded = await seedEnabledGroup(db, { chunkIdleCloseHours: 96 });
      await insertMessage(db, seeded.conversationId, {
        providerMessageId: "idle-live",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await runChunker(db, seeded.group, { now: new Date("2026-07-07T09:30:00.000Z") });
      await db
        .updateTable("whatsapp_groups")
        .set({ chunk_last_llm_attempt_at: "2026-07-12T09:59:00.000Z" })
        .where("jid", "=", seeded.group.jid)
        .execute();
      const freshGroup = await createWhatsAppGroupRepository(db).getIndexingConfig(seeded.group.jid);
      if (!freshGroup) throw new Error("expected idle WhatsApp group config");

      await runChunker(db, freshGroup, { now: new Date("2026-07-12T10:00:00.000Z") });
      const slices = await listSlicesForConversation(db, seeded.conversationId);

      expect(slices).toHaveLength(1);
      expect(slices[0]).toMatchObject({ status: "closed", salience_verdict: "kept" });
    });

    it("bounds concurrent group LLM calls by the configured worker pool", async () => {
      const first = await seedEnabledGroup(db, { chunkGroupWorkerPool: 1 });
      const second = await seedEnabledGroup(db, { chunkGroupWorkerPool: 1 });
      await insertMessage(db, first.conversationId, {
        providerMessageId: "pool-1",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      await insertMessage(db, second.conversationId, {
        providerMessageId: "pool-2",
        effectiveAt: "2026-07-07T09:00:00.000Z",
      });
      let active = 0;
      let maximum = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = chunkWhatsAppIndexingGroups({
        db,
        groups: [first.group, second.group],
        logger: createLogger(),
        now: new Date("2026-07-07T09:30:00.000Z"),
        llmGenerate: async (prompt) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await gate;
          active -= 1;
          return generateWholeBoundary(prompt);
        },
      });
      await vi.waitFor(() => expect(active).toBe(1));
      release();
      await run;

      expect(maximum).toBe(1);
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

      expect(first.slicesCreated).toBe(0);
      expect(second.slicesCreated).toBe(0);
      expect(slices).toHaveLength(1);
      expect(slices[0]?.status).toBe("open");
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

      expect(slices).toHaveLength(2);
      expect(slices[0]).toMatchObject({
        started_at: "2026-07-07T09:00:00.000Z",
        ended_at: "2026-07-07T09:05:00.000Z",
        denoised_message_ids: JSON.stringify([firstId, secondId]),
      });
      expect(slices[1]).toMatchObject({ denoised_message_ids: JSON.stringify([3]), status: "open" });
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

      expect(slices).toHaveLength(2);
      expect(slices[0]).toMatchObject({
        started_at: "2026-07-07T09:00:00.000Z",
        ended_at: "2026-07-07T09:05:00.000Z",
        denoised_message_ids: JSON.stringify([firstId, secondId]),
      });
      expect(slices[1]).toMatchObject({ denoised_message_ids: JSON.stringify([3]), status: "open" });
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

    it("reconciles history rows at the open-tail seam without counting older history as late", async () => {
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

      expect(result.messagesProcessed).toBe(1);
      expect(result.lateArrivals).toBe(0);
      expect(result.slicesCreated).toBe(1);
      const slices = await listSlices(db);
      expect(slices).toHaveLength(2);
      expect(slices.flatMap((slice) => JSON.parse(slice.denoised_message_ids ?? "[]"))).toEqual([1, 3]);
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

    it("uses LLM boundaries even when legacy gap overrides are present", async () => {
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
      expect(slices).toHaveLength(2);
      expect(slices[0]?.flush_reason).toBe("llm_boundary");
      expect(slices[0]?.salience_verdict).toBe("kept");
    });

    it("logs the LLM chunker summary without message content", async () => {
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
          conversationsProcessed: 1,
          slicesCreated: 1,
          lateArrivals: 0,
          messagesProcessed: 2,
          maxAgeFlushes: 0,
          maxSizeFlushes: 0,
        },
        "Completed WhatsApp chunker run",
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

      expect(slices).toHaveLength(2);
      expect(slices[0]).toMatchObject({
        first_message_id: keptStart,
        last_message_id: keptStart,
        message_count: 1,
        denoised_message_ids: JSON.stringify([keptStart]),
        flush_reason: "llm_boundary",
        salience_verdict: "kept",
      });
      expect(slices[1]).toMatchObject({
        first_message_id: keptEnd,
        last_message_id: keptEnd,
        message_count: 1,
        denoised_message_ids: JSON.stringify([keptEnd]),
        flush_reason: "llm_boundary",
        salience_verdict: "kept",
      });
    });
  });
}

runChunkerSuite("chunkWhatsAppIndexingGroups sqlite", createTestDb);
runChunkerSuite("chunkWhatsAppIndexingGroups postgres", createTestPgDb);
runConnectorSyncSuite("runConnectorSync WhatsApp chunker knobs sqlite", createTestDb);
runConnectorSyncSuite("runConnectorSync WhatsApp chunker knobs postgres", createTestPgDb);

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import { type WhatsAppGroupIndexingConfig, createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import type { WhatsAppAdapterHandlers } from "../whatsapp/adapter";
import { WhatsAppBackfillWorker } from "../whatsapp/backfill-worker";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";
import { chunkWhatsAppIndexingGroups } from "./whatsapp-chunker";

const NOW = new Date("2026-07-17T12:00:00.000Z");

function logger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

async function seedGraphChat(
  db: Kysely<DB>,
  input: {
    groupJid: string;
    rangeId?: string;
    rangeStatus?: "pending" | "materializing" | "complete" | "exhausted";
    lowerBoundAt?: string;
    upperBoundAt?: string;
    graphLastServedAt?: string | null;
  },
): Promise<{ group: WhatsAppGroupIndexingConfig; conversationId: number; rangeId: string }> {
  const groups = createWhatsAppGroupRepository(db);
  await groups.upsert({
    jid: input.groupJid,
    name: input.groupJid,
    description: null,
    tool_progress: null,
    reasoning_text: null,
    updated_at: "2026-07-17T11:00:00.000Z",
  });
  const group = await groups.setIndexEnabled(input.groupJid, true);
  if (!group) throw new Error("failed to enable test group");
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: input.groupJid,
  });
  await db
    .insertInto("whatsapp_backfill_checkpoints")
    .values({
      group_jid: input.groupJid,
      last_fetched_key: null,
      status: "in_progress",
      graph_last_served_at: input.graphLastServedAt ?? null,
    })
    .onConflict((oc) => oc.column("group_jid").doNothing())
    .execute();
  const rangeId = input.rangeId ?? `range-${input.groupJid}`;
  await db
    .insertInto("whatsapp_backfill_ranges")
    .values({
      id: rangeId,
      group_jid: input.groupJid,
      range_key: `gap:${rangeId}`,
      kind: "gap",
      connection_key: "000000000001:000000000001",
      status: input.rangeStatus ?? "complete",
      lower_bound_at: input.lowerBoundAt ?? "2026-07-01T00:00:00.000Z",
      upper_bound_at: input.upperBoundAt ?? "2026-07-02T00:00:00.000Z",
      terminal_status: ["complete", "exhausted"].includes(input.rangeStatus ?? "complete")
        ? (input.rangeStatus ?? "complete")
        : null,
    })
    .execute();
  return { group, conversationId: conversation.id, rangeId };
}

async function insertHistory(
  db: Kysely<DB>,
  conversationId: number,
  rangeId: string,
  providerMessageId: string,
  effectiveAt: string,
  text = providerMessageId,
): Promise<number> {
  const result = await createConversationRepository(db).insertMessage({
    conversationId,
    providerMessageId,
    senderJid: `${providerMessageId}@s.whatsapp.net`,
    senderName: "History Sender",
    text,
    providerTimestamp: effectiveAt,
    receivedAt: effectiveAt,
    source: "history",
    backfillRangeId: rangeId,
  });
  return result.row.id;
}

async function runAdmission(
  db: Kysely<DB>,
  groups: WhatsAppGroupIndexingConfig[],
  overrides: Parameters<typeof chunkWhatsAppIndexingGroups>[0] = { db, groups, logger: logger() },
) {
  return chunkWhatsAppIndexingGroups({
    db,
    groups,
    logger: overrides.logger,
    now: NOW,
    backfillGraphKnobs: {
      pageMessages: 500,
      cycleMessages: 1500,
      pendingSlicesMax: 10_000,
      pendingFilesMax: 10_000,
      openFactsMax: 10_000,
      ...overrides.backfillGraphKnobs,
    },
    onBackfillConversationClaimed: overrides.onBackfillConversationClaimed,
    onBackfillSlicesInserted: overrides.onBackfillSlicesInserted,
  });
}

function createBackfillWorker(db: Kysely<DB>): WhatsAppBackfillWorker {
  const facade: WhatsAppSocketFacade = {
    send: async () => null,
    sendComposing: async () => undefined,
    react: async () => ({ ok: true }),
    downloadMedia: async () => null,
    groupMetadata: async () => null,
    syncAllGroups: async () => ({ synced: 0 }),
    resolveLid: async () => null,
    fetchMessageHistory: async () => "request-session",
    pairing: {
      startQr: async () => undefined,
      status: async () => ({ connected: true, phoneNumber: "+15551234567", lid: "86702773280883@lid" }),
      cancel: async () => undefined,
      logout: async () => undefined,
    },
    shutdown: async () => undefined,
    health: async () => ({
      socketState: "connected",
      queueDepth: 0,
      insertFailures: 0,
      uptime: 1,
      scriptHash: "test",
      contractVersion: "1.2",
    }),
  };
  const handlers: WhatsAppAdapterHandlers = {
    captureQueuedMessage: async () => null,
    dispatchCapturedMessage: async () => true,
    handleHistoryMessages: async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }),
  };
  return new WhatsAppBackfillWorker({
    db,
    config: { WHATSAPP_HISTORY_LOOKBACK_DAYS: 30 },
    logger: logger(),
    facade,
    handlers,
    shouldHandleInboundMessage: () => true,
    now: () => NOW.getTime(),
  });
}

function runPortableSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("pages equal timestamps by persisted effective_at and id while concurrent live inserts do not shift the cursor", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "keyset@g.us" });
      const first = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "history-1",
        "2026-07-01T09:00:00.000Z",
      );
      const second = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "history-2",
        "2026-07-01T09:00:00.000Z",
      );
      const third = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "history-3",
        "2026-07-01T09:00:00.000Z",
      );
      let liveId = 0;

      await runAdmission(db, [seeded.group], {
        db,
        groups: [seeded.group],
        logger: logger(),
        backfillGraphKnobs: { pageMessages: 2, cycleMessages: 2 },
        onBackfillConversationClaimed: async () => {
          liveId = (
            await createConversationRepository(db).insertMessage({
              conversationId: seeded.conversationId,
              providerMessageId: "interleaved-live",
              senderName: "Live Sender",
              text: "live",
              providerTimestamp: "2026-07-01T09:00:00.000Z",
              receivedAt: "2026-07-17T11:59:00.000Z",
              source: "live",
            })
          ).row.id;
        },
      });

      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_effective_at", "graph_cursor_message_id", "graph_completed_at"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        graph_cursor_effective_at: "2026-07-01T09:00:00.000Z",
        graph_cursor_message_id: second,
        graph_completed_at: null,
      });

      await runAdmission(db, [seeded.group]);
      const slices = await db
        .selectFrom("conversation_slices")
        .select("denoised_message_ids")
        .where("conversation_id", "=", seeded.conversationId)
        .execute();
      const memberships = slices.flatMap((slice) => JSON.parse(slice.denoised_message_ids ?? "[]") as number[]);
      expect(memberships.sort((a, b) => a - b)).toEqual([first, second, third, liveId].sort((a, b) => a - b));
      expect(new Set(memberships).size).toBe(4);
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_message_id", "graph_completed_at"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_cursor_message_id: third, graph_completed_at: NOW.toISOString() });
    });

    it("closes a graph read page at the token bound before the message-count bound", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "token-page@g.us" });
      const first = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "token-history-1",
        "2026-07-01T09:00:00.000Z",
        "a".repeat(40),
      );
      const second = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "token-history-2",
        "2026-07-01T09:01:00.000Z",
        "b".repeat(40),
      );
      const third = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "token-history-3",
        "2026-07-01T09:02:00.000Z",
        "c".repeat(40),
      );

      const testLogger = logger();
      await runAdmission(db, [seeded.group], {
        db,
        groups: [seeded.group],
        logger: testLogger,
        backfillGraphKnobs: { pageMessages: 500, pageTokens: 20, cycleMessages: 500 },
      });
      expect(testLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messagesRead: 2 }),
        "Completed WhatsApp backfill graph admission run",
      );
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_message_id", "graph_completed_at"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_cursor_message_id: second, graph_completed_at: null });

      await runAdmission(db, [seeded.group]);
      const memberships = (
        await db
          .selectFrom("conversation_slices")
          .select("denoised_message_ids")
          .where("conversation_id", "=", seeded.conversationId)
          .execute()
      ).flatMap((slice) => JSON.parse(slice.denoised_message_ids ?? "[]") as number[]);
      expect(memberships.sort((left, right) => left - right)).toEqual([first, second, third]);
    });

    it("routes a cursor-behind orphan into a fresh supplemental range", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "supplemental@g.us" });
      await db
        .updateTable("whatsapp_backfill_ranges")
        .set({
          graph_cursor_effective_at: "2026-07-01T10:00:00.000Z",
          graph_cursor_message_id: 999,
        })
        .where("id", "=", seeded.rangeId)
        .execute();
      const orphan = await createConversationRepository(db).insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "portable-late-history",
        senderJid: "sender@s.whatsapp.net",
        senderName: "History Sender",
        text: "late",
        providerTimestamp: "2026-07-01T09:00:00.000Z",
        receivedAt: "2026-07-01T09:00:00.000Z",
        source: "history",
        connectionKey: "000000000001:000000000001",
      });

      const result = await createWhatsAppBackfillRangeRepository(db).reconcileUnownedConnection({
        groupJid: seeded.group.jid,
        connectionKey: "000000000001:000000000001",
        now: NOW.toISOString(),
      });

      expect(result).toEqual({ adopted: 1, supplementalCreated: true });
      const stored = await db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("id", "=", orphan.row.id)
        .executeTakeFirstOrThrow();
      expect(stored.backfill_range_id).not.toBe(seeded.rangeId);
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["parent_range_id", "graph_cursor_effective_at", "graph_cursor_message_id"])
          .where("id", "=", stored.backfill_range_id as string)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        parent_range_id: seeded.rangeId,
        graph_cursor_effective_at: null,
        graph_cursor_message_id: null,
      });
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_effective_at", "graph_cursor_message_id"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        graph_cursor_effective_at: "2026-07-01T10:00:00.000Z",
        graph_cursor_message_id: 999,
      });
    });

    it("recovers the READ COMMITTED adoption interleaving without stranding stamped history", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "adoption-race@g.us" });
      const admittedId = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "admitted-before-race",
        "2026-07-01T09:00:00.000Z",
      );
      const stranded = await createConversationRepository(db).insertMessage({
        conversationId: seeded.conversationId,
        providerMessageId: "adopted-during-stage-transaction",
        senderJid: "sender@s.whatsapp.net",
        senderName: "History Sender",
        text: "must be recovered",
        providerTimestamp: "2026-07-01T08:00:00.000Z",
        receivedAt: "2026-07-01T08:00:00.000Z",
        source: "history",
        connectionKey: "000000000001:000000000001",
      });
      const stageSnapshot = await db
        .transaction()
        .execute((trx) =>
          trx
            .selectFrom("conversation_messages")
            .select("id")
            .where("backfill_range_id", "=", seeded.rangeId)
            .orderBy("effective_at", "asc")
            .orderBy("id", "asc")
            .execute(),
        );
      expect(stageSnapshot).toEqual([{ id: admittedId }]);

      await db.transaction().execute(async (trx) => {
        const ranges = createWhatsAppBackfillRangeRepository(trx);
        const range = await ranges.getById(seeded.rangeId);
        if (!range) throw new Error("missing race range");
        await expect(ranges.adoptRange(range)).resolves.toBe(1);
      });
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("conversation_slices")
          .values({
            id: "adoption-race-slice",
            conversation_id: seeded.conversationId,
            first_message_id: admittedId,
            last_message_id: admittedId,
            started_at: "2026-07-01T09:00:00.000Z",
            ended_at: "2026-07-01T09:00:00.000Z",
            message_count: 1,
            denoised_message_ids: JSON.stringify([admittedId]),
            flush_reason: "gap",
            roster_snapshot: "[]",
          })
          .execute();
        await trx
          .updateTable("whatsapp_backfill_ranges")
          .set({
            graph_cursor_effective_at: "2026-07-01T09:00:00.000Z",
            graph_cursor_message_id: admittedId,
            graph_completed_at: NOW.toISOString(),
          })
          .where("id", "=", seeded.rangeId)
          .execute();
        await trx
          .updateTable("whatsapp_backfill_checkpoints")
          .set({
            live_start_effective_at: "2026-07-01T09:00:00.000Z",
            live_start_message_id: admittedId,
          })
          .where("group_jid", "=", seeded.group.jid)
          .execute();
      });

      await createBackfillWorker(db).adoptPassiveHistory([seeded.group.jid]);

      const repaired = await db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("id", "=", stranded.row.id)
        .executeTakeFirstOrThrow();
      expect(repaired.backfill_range_id).not.toBe(seeded.rangeId);
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["parent_range_id", "graph_completed_at"])
          .where("id", "=", repaired.backfill_range_id as string)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ parent_range_id: seeded.rangeId, graph_completed_at: null });
    });

    it("rolls back slice insertion and resumes the same page after a mid-page crash", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "crash@g.us" });
      await insertHistory(db, seeded.conversationId, seeded.rangeId, "history-1", "2026-07-01T09:00:00.000Z");
      await insertHistory(db, seeded.conversationId, seeded.rangeId, "history-2", "2026-07-01T09:01:00.000Z");

      await expect(
        runAdmission(db, [seeded.group], {
          db,
          groups: [seeded.group],
          logger: logger(),
          onBackfillSlicesInserted: async () => {
            throw new Error("simulated crash");
          },
        }),
      ).rejects.toThrow("simulated crash");
      await expect(db.selectFrom("conversation_slices").select("id").execute()).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_effective_at", "graph_cursor_message_id"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_cursor_effective_at: null, graph_cursor_message_id: null });

      await runAdmission(db, [seeded.group]);
      await expect(db.selectFrom("conversation_slices").select("id").execute()).resolves.toHaveLength(1);
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select("graph_completed_at")
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_completed_at: NOW.toISOString() });
    });

    it("admits only terminal fully materialized ranges and preserves oldest-range order", async () => {
      const older = await seedGraphChat(db, {
        groupJid: "terminal@g.us",
        rangeId: "older-pending",
        rangeStatus: "materializing",
        lowerBoundAt: "2026-06-01T00:00:00.000Z",
        upperBoundAt: "2026-06-02T00:00:00.000Z",
      });
      await db
        .insertInto("whatsapp_backfill_ranges")
        .values({
          id: "newer-terminal",
          group_jid: older.group.jid,
          range_key: "gap:newer-terminal",
          kind: "gap",
          connection_key: "000000000001:000000000002",
          status: "complete",
          terminal_status: "complete",
          lower_bound_at: "2026-07-01T00:00:00.000Z",
          upper_bound_at: "2026-07-02T00:00:00.000Z",
        })
        .execute();
      const olderMessageId = await insertHistory(
        db,
        older.conversationId,
        older.rangeId,
        "older",
        "2026-06-01T09:00:00.000Z",
      );
      await insertHistory(db, older.conversationId, "newer-terminal", "newer", "2026-07-01T09:00:00.000Z");

      await runAdmission(db, [older.group]);
      await expect(db.selectFrom("conversation_slices").select("id").execute()).resolves.toEqual([]);

      await db
        .updateTable("whatsapp_backfill_ranges")
        .set({ status: "complete", terminal_status: "complete" })
        .where("id", "=", older.rangeId)
        .execute();
      await runAdmission(db, [older.group]);
      const firstSlice = await db
        .selectFrom("conversation_slices")
        .select("denoised_message_ids")
        .executeTakeFirstOrThrow();
      expect(firstSlice.denoised_message_ids).toBe(JSON.stringify([olderMessageId]));
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select("graph_completed_at")
          .where("id", "=", "newer-terminal")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_completed_at: null });
    });

    it("halts the chat on conflicting slice membership without advancing the range cursor", async () => {
      const seeded = await seedGraphChat(db, { groupJid: "conflict@g.us" });
      const first = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "history-1",
        "2026-07-01T09:00:00.000Z",
      );
      const second = await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        "history-2",
        "2026-07-01T09:01:00.000Z",
      );
      await db
        .insertInto("conversation_slices")
        .values({
          id: "conflicting-slice",
          conversation_id: seeded.conversationId,
          first_message_id: first,
          last_message_id: second,
          started_at: "2026-07-01T09:00:00.000Z",
          ended_at: "2026-07-01T09:01:00.000Z",
          message_count: 1,
          denoised_message_ids: JSON.stringify([first]),
          flush_reason: "gap",
          roster_snapshot: "[]",
        })
        .execute();
      const testLogger = logger();

      await runAdmission(db, [seeded.group], { db, groups: [seeded.group], logger: testLogger });

      await expect(
        db
          .selectFrom("whatsapp_backfill_checkpoints")
          .select(["graph_halted_at", "graph_halt_reason"])
          .where("group_jid", "=", seeded.group.jid)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        graph_halted_at: NOW.toISOString(),
        graph_halt_reason: expect.stringContaining("membership conflict"),
      });
      await expect(
        db
          .selectFrom("whatsapp_backfill_ranges")
          .select(["graph_cursor_effective_at", "graph_cursor_message_id"])
          .where("id", "=", seeded.rangeId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ graph_cursor_effective_at: null, graph_cursor_message_id: null });
      expect(testLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ groupJid: seeded.group.jid, rangeId: seeded.rangeId }),
        "Halted WhatsApp backfill graph admission after invariant failure",
      );
    });
  });
}

runPortableSuite("WhatsApp backfill graph admission SQLite", createTestDb);
runPortableSuite("WhatsApp backfill graph admission Postgres", createTestPgDb);

describe("WhatsApp backfill graph admission scheduling", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns before checking pipeline pressure when there is no graph candidate", async () => {
    const testLogger = logger();

    await runAdmission(db, [], {
      db,
      groups: [],
      logger: testLogger,
      backfillGraphKnobs: { pendingSlicesMax: -1 },
    });

    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Skipped WhatsApp backfill graph admission under pipeline backpressure",
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chatsServed: 0, skippedForPressure: false }),
      "Completed WhatsApp backfill graph admission run",
    );
  });

  it("uses deterministic least-recently-served selection, a global budget, and between-chat backpressure", async () => {
    const a = await seedGraphChat(db, { groupJid: "a@g.us", graphLastServedAt: null });
    const b = await seedGraphChat(db, {
      groupJid: "b@g.us",
      graphLastServedAt: "2026-07-17T09:00:00.000Z",
    });
    const c = await seedGraphChat(db, {
      groupJid: "c@g.us",
      graphLastServedAt: "2026-07-17T10:00:00.000Z",
    });
    for (const seeded of [a, b, c]) {
      await insertHistory(
        db,
        seeded.conversationId,
        seeded.rangeId,
        `history-${seeded.group.jid}`,
        "2026-07-01T09:00:00.000Z",
      );
    }

    await runAdmission(db, [c.group, b.group, a.group], {
      db,
      groups: [c.group, b.group, a.group],
      logger: logger(),
      backfillGraphKnobs: { pageMessages: 1, cycleMessages: 2 },
    });
    const served = await db
      .selectFrom("whatsapp_backfill_checkpoints")
      .select(["group_jid", "graph_last_served_at"])
      .orderBy("group_jid", "asc")
      .execute();
    expect(served).toEqual([
      { group_jid: "a@g.us", graph_last_served_at: NOW.toISOString() },
      { group_jid: "b@g.us", graph_last_served_at: NOW.toISOString() },
      { group_jid: "c@g.us", graph_last_served_at: "2026-07-17T10:00:00.000Z" },
    ]);

    const testLogger = logger();
    await runAdmission(db, [c.group], {
      db,
      groups: [c.group],
      logger: testLogger,
      backfillGraphKnobs: { pendingSlicesMax: 0 },
    });
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select("graph_completed_at")
        .where("id", "=", c.rangeId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ graph_completed_at: null });
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ pendingSlices: 2, pendingSlicesMax: 0 }),
      "Skipped WhatsApp backfill graph admission under pipeline backpressure",
    );
  });

  it.each([
    {
      label: "pending enrichment files",
      threshold: { pendingFilesMax: 0 },
      seed: async (db: Kysely<DB>) => {
        await db
          .insertInto("connector_configs")
          .values({
            id: "pressure-connector",
            connector_type: "test",
            auth_type: "system",
            credentials: "{}",
            created_by: "admin",
          })
          .execute();
        await db
          .insertInto("indexed_files")
          .values({
            id: "pending-enrichment-file",
            connector_config_id: "pressure-connector",
            provider_file_id: "pending-enrichment-file",
            file_name: "pending-enrichment-file",
            file_type: "document",
            content_category: "document",
            source: "test",
            content_hash: "pending-enrichment-file",
            is_archived: 0,
            embedding_status: "pending",
            summary_status: "done",
            synced_at: NOW.toISOString(),
          })
          .execute();
      },
      expected: { pendingFiles: 1, pendingFilesMax: 0 },
    },
    {
      label: "open materialization facts",
      threshold: { openFactsMax: 0 },
      seed: async (db: Kysely<DB>) => {
        await db
          .insertInto("indexed_file_facts")
          .values({
            id: "open-materialization-fact",
            fact_key: "open-materialization-fact",
            source: "test",
            fact_type: "test",
            relation: "test",
            raw: "{}",
          })
          .execute();
      },
      expected: { openFacts: 1, openFactsMax: 0 },
    },
  ])("skips admission when $label exceed the configured threshold", async ({ threshold, seed, expected }) => {
    const seeded = await seedGraphChat(db, { groupJid: "pressure@g.us" });
    await insertHistory(db, seeded.conversationId, seeded.rangeId, "pressure-history", "2026-07-01T09:00:00.000Z");
    await seed(db);
    const testLogger = logger();

    await runAdmission(db, [seeded.group], {
      db,
      groups: [seeded.group],
      logger: testLogger,
      backfillGraphKnobs: threshold,
    });

    await expect(db.selectFrom("conversation_slices").select("id").execute()).resolves.toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.objectContaining(expected),
      "Skipped WhatsApp backfill graph admission under pipeline backpressure",
    );
  });
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppAdapterHandlers } from "./adapter";
import { WHATSAPP_BACKFILL_SWEEP_MS, WhatsAppBackfillWorker } from "./backfill-worker";
import type { WhatsAppHistoryBatchEnvelope, WhatsAppMessageEnvelope, WhatsAppSocketFacade } from "./facade-contract";
import type { WhatsAppInboundMessage } from "./provider";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const KEY_1 = "000000000001:000000000001";
const KEY_2 = "000000000001:000000000002";
const KEY_3 = "000000000001:000000000003";
const KEY_4 = "000000000001:000000000004";
const KEY_5 = "000000000001:000000000005";

function facade(fetchMessageHistory: WhatsAppSocketFacade["fetchMessageHistory"]): WhatsAppSocketFacade {
  return {
    send: async () => null,
    sendComposing: async () => undefined,
    react: async () => ({ ok: true }),
    downloadMedia: async () => null,
    groupMetadata: async () => null,
    syncAllGroups: async () => ({ synced: 0 }),
    resolveLid: async () => null,
    fetchMessageHistory,
    pairing: {
      startQr: async () => undefined,
      status: async () => ({ connected: true, phoneNumber: "+15551234567" }),
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
}

function messageEnvelope(input: {
  id: string;
  timestamp: string;
  text?: string;
  connectionKey?: string;
  fromMe?: boolean;
}): WhatsAppMessageEnvelope {
  const fromMe = input.fromMe ?? false;
  return {
    version: "1.0",
    kind: "history_message",
    providerTimestamp: input.timestamp,
    providerConversationId: "group@g.us",
    providerMessageId: input.id,
    eventKey: `event-${input.id}-${fromMe ? "out" : "in"}`,
    connectionKey: input.connectionKey ?? KEY_3,
    fromMe,
    message: {
      type: "group",
      text: input.text ?? input.id,
      jid: "group@g.us",
      messageId: input.id,
      pushName: "Sender",
      senderJid: "15551234567@s.whatsapp.net",
      senderPhone: "+15551234567",
      isMentioned: false,
      rawProviderPayload: {
        key: { remoteJid: "group@g.us", id: input.id, fromMe },
        messageTimestamp: Date.parse(input.timestamp) / 1_000,
      },
      stagedMediaRef: null,
      mediaStagingError: null,
    },
  };
}

function historyEnvelope(input: {
  batchId: string;
  requestSessionId: string;
  messages: WhatsAppMessageEnvelope[];
}): WhatsAppHistoryBatchEnvelope {
  return {
    version: "1.0",
    kind: "history_batch",
    providerTimestamp: input.messages[0]?.providerTimestamp ?? "2026-07-17T12:00:00.000Z",
    connectionKey: KEY_3,
    batch: {
      batchId: input.batchId,
      chunkIndex: 0,
      chunkCount: 1,
      syncType: 6,
      progress: null,
      isLatest: null,
      peerDataRequestSessionId: input.requestSessionId,
    },
    messages: input.messages,
  };
}

async function seedGroup(db: Kysely<DB>) {
  await db
    .insertInto("whatsapp_groups")
    .values({ jid: "group@g.us", name: "Group", description: null, updated_at: "2026-07-17T12:00:00.000Z" })
    .execute();
  return createConversationRepository(db).getOrCreate(
    { platform: "whatsapp", kind: "group", providerConversationId: "group@g.us" },
    "Group",
  );
}

async function seedLease(db: Kysely<DB>, generation = 1) {
  await db
    .insertInto("whatsapp_session_lease")
    .values({
      id: "default",
      owner_kind: "gateway",
      owner_token: `owner-${generation}`,
      generation,
      gateway_http_token: "secret",
      host_id: "host",
      boot_id: "boot",
      pid: 10,
      pid_start_time: "10",
      script_hash: "hash",
      contract_version: "1.2",
      heartbeat_at: "2026-07-17T12:00:00.000Z",
      acquired_at: "2026-07-17T12:00:00.000Z",
      last_live_at: "2026-07-17T11:59:00.000Z",
      disconnected_at: "2026-07-17T11:30:00.000Z",
    })
    .execute();
}

function noOpHandlers(
  handleHistoryMessages: WhatsAppAdapterHandlers["handleHistoryMessages"] = async () => ({
    persisted: 0,
    skippedOld: 0,
    skippedDup: 0,
  }),
): WhatsAppAdapterHandlers {
  return {
    captureQueuedMessage: async () => null,
    dispatchCapturedMessage: async () => true,
    handleHistoryMessages,
  };
}

function worker(
  db: Kysely<DB>,
  input: {
    now?: () => number;
    fetch?: WhatsAppSocketFacade["fetchMessageHistory"];
    handlers?: WhatsAppAdapterHandlers;
    onRequestAccepted?: () => Promise<void> | void;
    onMaterializationBatchYield?: () => Promise<void>;
    tickMs?: number;
  } = {},
) {
  return new WhatsAppBackfillWorker({
    db,
    config: { WHATSAPP_HISTORY_LOOKBACK_DAYS: 30 },
    logger: createTestLogger(),
    facade: facade(input.fetch ?? (async () => "request-default")),
    handlers: input.handlers ?? noOpHandlers(),
    shouldHandleInboundMessage: () => true,
    now: input.now ?? (() => NOW),
    sleep: async () => undefined,
    onRequestAccepted: input.onRequestAccepted,
    onMaterializationBatchYield: input.onMaterializationBatchYield,
    tickMs: input.tickMs,
  });
}

describe("WhatsAppBackfillWorker", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adopts NULL history by the initial boundary and exact gap connection key", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-anchor",
      eventKey: "event-live-anchor",
      senderName: "Live Sender",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    for (const [id, connectionKey] of [
      ["history-1", KEY_1],
      ["history-2", KEY_2],
      ["history-3", KEY_3],
    ] as const) {
      await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: id,
        eventKey: `event-${id}`,
        senderName: "History Sender",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        source: "history",
        connectionKey,
      });
    }
    const ranges = createWhatsAppBackfillRangeRepository(db);
    const initial = await ranges.ensureInitialRange({
      groupJid: "group@g.us",
      connectionKey: KEY_2,
      liveStartEffectiveAt: live.row.effectiveAt,
      liveStartMessageId: live.row.id,
      lowerBoundAt: "2026-06-17T12:00:00.000Z",
      now: "2026-07-17T12:00:00.000Z",
    });
    expect(initial.created).toBe(true);
    expect(initial.adopted).toBe(2);
    const gap = await ranges.ensureGapRange({
      groupJid: "group@g.us",
      connectionKey: KEY_3,
      lowerBoundAt: "2026-07-17T09:00:00.000Z",
      upperBoundAt: "2026-07-17T12:00:00.000Z",
      now: "2026-07-17T12:00:00.000Z",
    });
    expect(gap.created).toBe(true);
    expect(gap.adopted).toBe(1);
    const rows = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "backfill_range_id"])
      .where("source", "=", "history")
      .orderBy("provider_message_id")
      .execute();
    expect(rows).toEqual([
      { provider_message_id: "history-1", backfill_range_id: initial.row.id },
      { provider_message_id: "history-2", backfill_range_id: initial.row.id },
      { provider_message_id: "history-3", backfill_range_id: gap.row.id },
    ]);
  });

  it("bootstraps an initial range for an enabled group whose history never saw a live message", async () => {
    const conversation = await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    for (const [id, connectionKey, providerTimestamp] of [
      ["history-older-higher-key", KEY_3, "2026-07-17T09:00:00.000Z"],
      ["history-newest-lower-key", KEY_1, "2026-07-17T10:00:00.000Z"],
    ] as const) {
      await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: id,
        eventKey: `event-${id}`,
        senderName: "History Sender",
        providerTimestamp,
        source: "history",
        connectionKey,
      });
    }

    await worker(db).reconcile(true);

    const initial = await db
      .selectFrom("whatsapp_backfill_ranges")
      .select(["id", "connection_key", "upper_bound_at"])
      .where("group_jid", "=", "group@g.us")
      .where("kind", "=", "initial")
      .executeTakeFirstOrThrow();
    expect(initial.connection_key).toBe(KEY_3);
    /**
     * Strictly past the newest stranded row so materialization keeps the siblings
     * that share its second, which `timestamp >= upper_bound_at` would drop.
     */
    expect(initial.upper_bound_at).toBe("2026-07-17T10:00:00.001Z");
    const rows = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "backfill_range_id"])
      .where("source", "=", "history")
      .orderBy("provider_message_id")
      .execute();
    expect(rows).toEqual([
      { provider_message_id: "history-newest-lower-key", backfill_range_id: initial.id },
      { provider_message_id: "history-older-higher-key", backfill_range_id: initial.id },
    ]);
    const checkpoint = await db
      .selectFrom("whatsapp_backfill_checkpoints")
      .select(["live_start_effective_at", "live_start_message_id"])
      .where("group_jid", "=", "group@g.us")
      .executeTakeFirstOrThrow();
    expect(checkpoint).toEqual({ live_start_effective_at: null, live_start_message_id: null });
  });

  it("repairs downtime for an enabled group that has never seen a live message", async () => {
    await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await seedLease(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await db
      .insertInto("whatsapp_connection_transitions")
      .values({
        connection_key: KEY_3,
        lease_generation: 1,
        socket_generation: 3,
        disconnected_at: "2026-07-17T10:30:00.000Z",
        connected_at: "2026-07-17T10:45:00.000Z",
      })
      .execute();

    await worker(db).reconcile(true);

    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select(["range_key", "lower_bound_at", "upper_bound_at"])
        .where("group_jid", "=", "group@g.us")
        .execute(),
    ).resolves.toEqual([
      {
        range_key: `gap:${KEY_3}`,
        lower_bound_at: "2026-07-17T10:30:00.000Z",
        upper_bound_at: "2026-07-17T10:45:00.000Z",
      },
    ]);
  });

  it("does not repair downtime for a disabled group", async () => {
    await seedGroup(db);
    await seedLease(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await db
      .insertInto("whatsapp_connection_transitions")
      .values({
        connection_key: KEY_3,
        lease_generation: 1,
        socket_generation: 3,
        disconnected_at: "2026-07-17T10:30:00.000Z",
        connected_at: "2026-07-17T10:45:00.000Z",
      })
      .execute();

    await worker(db).reconcile(true);

    await expect(
      db.selectFrom("whatsapp_backfill_ranges").select("id").where("group_jid", "=", "group@g.us").execute(),
    ).resolves.toEqual([]);
  });

  it("rescues later history on a newer connection key for a bootstrapped group with no live start", async () => {
    const conversation = await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-bootstrap",
      eventKey: "event-history-bootstrap",
      senderName: "History Sender",
      providerTimestamp: "2026-07-17T09:00:00.000Z",
      source: "history",
      connectionKey: KEY_1,
    });

    await worker(db).reconcile(true);

    const straggler = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-straggler",
      eventKey: "event-history-straggler",
      senderName: "History Sender",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });

    await worker(db).reconcile(true);

    const rescued = await db
      .selectFrom("conversation_messages")
      .select("backfill_range_id")
      .where("id", "=", straggler.row.id)
      .executeTakeFirstOrThrow();
    expect(rescued.backfill_range_id).not.toBeNull();
    const checkpoint = await db
      .selectFrom("whatsapp_backfill_checkpoints")
      .select("live_start_message_id")
      .where("group_jid", "=", "group@g.us")
      .executeTakeFirstOrThrow();
    expect(checkpoint.live_start_message_id).toBeNull();
  });

  it("leaves a disabled group without a live start out of the orphan rescue sweep", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-disabled-orphan",
      eventKey: "event-history-disabled-orphan",
      senderName: "History Sender",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "history",
      connectionKey: KEY_1,
    });

    await worker(db).reconcile(true);

    await expect(
      db.selectFrom("whatsapp_backfill_ranges").select("id").where("group_jid", "=", "group@g.us").execute(),
    ).resolves.toEqual([]);
  });

  it("skips bootstrapping when every stranded row lacks a connection key", async () => {
    const conversation = await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-null-key",
      eventKey: "event-history-null-key",
      senderName: "History Sender",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "history",
      connectionKey: null,
    });

    await worker(db).reconcile(true);

    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select("id")
        .where("group_jid", "=", "group@g.us")
        .where("kind", "=", "initial")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("leaves history stranded when the group is not enabled for indexing", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "complete",
        live_start_effective_at: null,
        live_start_message_id: null,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-disabled",
      eventKey: "event-history-disabled",
      senderName: "History Sender",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "history",
      connectionKey: KEY_1,
    });

    await worker(db).reconcile(true);

    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select("id")
        .where("group_jid", "=", "group@g.us")
        .where("kind", "=", "initial")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("creates a gap on an accepted connected transition and sweep-recovers an orphaned key", async () => {
    const conversation = await seedGroup(db);
    await seedLease(db);
    const conversations = createConversationRepository(db);
    const topUp = worker(db);
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "awaiting-history",
      eventKey: "event-awaiting-history",
      senderName: "History",
      providerTimestamp: "2026-07-17T10:45:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });
    await topUp.reconcile(true);
    await expect(db.selectFrom("whatsapp_backfill_ranges").select("id").execute()).resolves.toEqual([]);

    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live",
      eventKey: "event-live",
      senderName: "Live",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "gap-anchor",
      eventKey: "event-gap-anchor",
      senderName: "History",
      providerTimestamp: "2026-07-17T11:45:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });
    await topUp.handleConnected({ leaseGeneration: 1, socketGeneration: 3 });
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select(["kind", "connection_key", "lower_bound_at"])
        .where("range_key", "=", `gap:${KEY_3}`)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      kind: "gap",
      connection_key: KEY_3,
      lower_bound_at: "2026-07-17T11:30:00.000Z",
    });

    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "orphan-anchor",
      eventKey: "event-orphan-anchor",
      senderName: "History",
      providerTimestamp: "2026-07-17T11:50:00.000Z",
      source: "history",
      connectionKey: KEY_4,
    });
    await topUp.reconcile(true);
    const orphanRange = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("range_key", "=", `gap:${KEY_4}`)
      .executeTakeFirstOrThrow();
    expect(orphanRange.kind).toBe("gap");
    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "orphan-anchor")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: orphanRange.id });
  });

  it("reconciles every durable connected transition after notification loss", async () => {
    const conversation = await seedGroup(db);
    await seedLease(db);
    const live = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "durable-live",
      eventKey: "event-durable-live",
      senderName: "Live",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await db
      .insertInto("whatsapp_connection_transitions")
      .values([
        {
          connection_key: KEY_3,
          lease_generation: 1,
          socket_generation: 3,
          disconnected_at: "2026-07-17T10:30:00.000Z",
          connected_at: "2026-07-17T10:45:00.000Z",
        },
        {
          connection_key: KEY_4,
          lease_generation: 1,
          socket_generation: 4,
          disconnected_at: "2026-07-17T11:00:00.000Z",
          connected_at: "2026-07-17T11:15:00.000Z",
        },
      ])
      .execute();

    const topUp = worker(db);
    await topUp.reconcile(true);
    await topUp.reconcile(true);

    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select(["range_key", "lower_bound_at", "upper_bound_at"])
        .where("range_key", "in", [`gap:${KEY_3}`, `gap:${KEY_4}`])
        .orderBy("range_key")
        .execute(),
    ).resolves.toEqual([
      {
        range_key: `gap:${KEY_3}`,
        lower_bound_at: "2026-07-17T10:30:00.000Z",
        upper_bound_at: "2026-07-17T10:45:00.000Z",
      },
      {
        range_key: `gap:${KEY_4}`,
        lower_bound_at: "2026-07-17T11:00:00.000Z",
        upper_bound_at: "2026-07-17T11:15:00.000Z",
      },
    ]);
    await expect(db.selectFrom("whatsapp_connection_transitions").select("reconciled_at").execute()).resolves.toEqual([
      { reconciled_at: expect.any(String) },
      { reconciled_at: expect.any(String) },
    ]);
  });

  it("reconciles on startup, connected transitions, and sweep cadence but not a plain drain", async () => {
    const conversation = await seedGroup(db);
    await seedLease(db);
    const conversations = createConversationRepository(db);
    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "cadence-live",
      eventKey: "event-cadence-live",
      senderName: "Live",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "startup-orphan",
      eventKey: "event-startup-orphan",
      senderName: "History",
      providerTimestamp: "2026-07-17T10:30:00.000Z",
      source: "history",
      connectionKey: KEY_1,
    });
    let clock = NOW;
    const topUp = worker(db, { now: () => clock, tickMs: 60_000 });

    topUp.start();
    await vi.waitFor(async () => {
      const row = await db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "startup-orphan")
        .executeTakeFirstOrThrow();
      expect(row.backfill_range_id).not.toBeNull();
    });
    await topUp.stop();

    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "connected-orphan",
      eventKey: "event-connected-orphan",
      senderName: "History",
      providerTimestamp: "2026-07-17T11:30:00.000Z",
      source: "history",
      connectionKey: KEY_4,
    });
    await topUp.runOnce();
    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "connected-orphan")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: null });

    await topUp.handleConnected({ leaseGeneration: 1, socketGeneration: 3 });
    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "connected-orphan")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: expect.any(String) });

    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "between-sweeps-orphan",
      eventKey: "event-between-sweeps-orphan",
      senderName: "History",
      providerTimestamp: "2026-07-17T11:45:00.000Z",
      source: "history",
      connectionKey: KEY_5,
    });
    await topUp.runOnce();
    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "between-sweeps-orphan")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: null });

    clock += WHATSAPP_BACKFILL_SWEEP_MS;
    await topUp.runOnce();
    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("provider_message_id", "=", "between-sweeps-orphan")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: expect.any(String) });
  });

  it("matches correlation, materializes out-of-order pages ascending, dedups, and stamps the range", async () => {
    const conversation = await seedGroup(db);
    await seedLease(db);
    const conversations = createConversationRepository(db);
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "middle",
      eventKey: "event-middle-in",
      senderName: "Promoted",
      providerTimestamp: "2026-07-17T10:00:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });
    const ranges = createWhatsAppBackfillRangeRepository(db);
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-materialize",
        group_jid: "group@g.us",
        range_key: `gap:${KEY_3}`,
        kind: "gap",
        connection_key: KEY_3,
        status: "in_flight",
        lower_bound_at: "2026-07-17T09:30:00.000Z",
        upper_bound_at: "2026-07-17T11:30:00.000Z",
        cursor_remote_jid: "group@g.us",
        cursor_message_id: "anchor",
        cursor_from_me: 0,
        cursor_provider_timestamp: "2026-07-17T11:00:00.000Z",
        attempts: 1,
        claim_token: "claim",
        claimed_at: "2026-07-17T11:00:00.000Z",
        request_session_id: "request-materialize",
        request_lease_generation: 1,
        requested_at: "2026-07-17T11:00:00.000Z",
        response_deadline_at: "2026-07-17T11:01:00.000Z",
      })
      .execute();
    const newest = messageEnvelope({ id: "newest", timestamp: "2026-07-17T10:30:00.000Z" });
    const oldest = messageEnvelope({ id: "oldest", timestamp: "2026-07-17T09:00:00.000Z" });
    const middle = messageEnvelope({ id: "middle", timestamp: "2026-07-17T10:00:00.000Z" });
    for (const [id, envelope] of [
      [1, historyEnvelope({ batchId: "batch-new", requestSessionId: "request-materialize", messages: [newest] })],
      [
        2,
        historyEnvelope({ batchId: "batch-old", requestSessionId: "request-materialize", messages: [oldest, middle] }),
      ],
    ] as const) {
      await db
        .insertInto("whatsapp_inbound_events")
        .values({
          kind: "history_batch",
          origin: "gateway",
          envelope: JSON.stringify(envelope),
          batch_id: `batch-${id}`,
          chunk_index: 0,
          chunk_count: 1,
          request_session_id: "request-materialize",
          backfill_range_id: "range-materialize",
          status: "consumed",
          consumed_at: "2026-07-17T11:00:01.000Z",
        })
        .execute();
    }
    const order: string[] = [];
    const handlers = noOpHandlers(async (messages, _metadata, options) => {
      for (const message of messages) {
        const metadata = options?.captureMetadataForMessage?.(message);
        order.push(message.providerMessageId);
        await conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: message.providerMessageId,
          eventKey: metadata?.eventKey,
          senderName: message.senderName,
          providerTimestamp: message.providerTimestamp,
          providerFromMe: metadata?.fromMe,
          source: "history",
          connectionKey: metadata?.connectionKey,
          backfillRangeId: options?.range?.id,
        });
      }
      return { persisted: messages.length, skippedOld: 0, skippedDup: 0 };
    });
    const topUp = worker(db, { handlers });
    expect(await topUp.handleOnDemandResponse("request-materialize")).toBe(true);
    await topUp.runOnce();
    expect(order).toEqual(["middle", "newest"]);
    const stored = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "backfill_range_id", "effective_at"])
      .where("provider_message_id", "in", ["middle", "newest"])
      .orderBy("effective_at")
      .execute();
    expect(stored).toEqual([
      {
        provider_message_id: "middle",
        backfill_range_id: "range-materialize",
        effective_at: "2026-07-17T10:00:00.000Z",
      },
      {
        provider_message_id: "newest",
        backfill_range_id: "range-materialize",
        effective_at: "2026-07-17T10:30:00.000Z",
      },
    ]);
    await expect(ranges.getById("range-materialize")).resolves.toMatchObject({ status: "complete" });
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("id")
        .where("backfill_range_id", "=", "range-materialize")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("finalizes a materialized range and deletes staging in one rollback-safe transaction", async () => {
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-atomic-finalize",
        group_jid: "group@g.us",
        range_key: "gap:atomic-finalize",
        kind: "gap",
        connection_key: KEY_3,
        status: "materializing",
        terminal_status: "complete",
        lower_bound_at: "2026-07-17T09:00:00.000Z",
        upper_bound_at: "2026-07-17T10:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("whatsapp_inbound_events")
      .values({
        kind: "history_batch",
        origin: "gateway",
        envelope: JSON.stringify(historyEnvelope({ batchId: "atomic", requestSessionId: "atomic", messages: [] })),
        backfill_range_id: "range-atomic-finalize",
      })
      .execute();

    await expect(
      db.transaction().execute(async (trx) => {
        await createWhatsAppBackfillRangeRepository(trx).finalizeMaterialized(
          "range-atomic-finalize",
          "2026-07-17T12:00:00.000Z",
        );
        throw new Error("simulated commit failure");
      }),
    ).rejects.toThrow("simulated commit failure");
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select("status")
        .where("id", "=", "range-atomic-finalize")
        .executeTakeFirst(),
    ).resolves.toEqual({ status: "materializing" });
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("id")
        .where("backfill_range_id", "=", "range-atomic-finalize")
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it("moves passive history behind an advanced cursor into chained supplemental ranges", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "supplemental-live",
      eventKey: "event-supplemental-live",
      senderName: "Live",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-advanced",
        group_jid: "group@g.us",
        range_key: `gap:${KEY_3}`,
        kind: "gap",
        connection_key: KEY_3,
        status: "complete",
        terminal_status: "complete",
        lower_bound_at: "2026-07-17T09:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
        graph_cursor_effective_at: "2026-07-17T10:00:00.000Z",
        graph_cursor_message_id: 999,
      })
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "late-behind-cursor",
      eventKey: "event-late-behind-cursor",
      senderName: "History",
      providerTimestamp: "2026-07-17T09:30:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });

    const topUp = worker(db);
    await topUp.adoptPassiveHistory(["group@g.us"]);
    const first = await db
      .selectFrom("conversation_messages")
      .select("backfill_range_id")
      .where("provider_message_id", "=", "late-behind-cursor")
      .executeTakeFirstOrThrow();
    expect(first.backfill_range_id).not.toBe("range-advanced");
    const supplemental = await db
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("id", "=", first.backfill_range_id as string)
      .executeTakeFirstOrThrow();
    expect(supplemental).toMatchObject({
      status: "complete",
      parent_range_id: "range-advanced",
      graph_cursor_effective_at: null,
      graph_cursor_message_id: null,
      graph_completed_at: null,
    });

    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({ graph_completed_at: "2026-07-17T12:00:00.000Z" })
      .where("id", "=", supplemental.id)
      .execute();
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "late-after-completion",
      eventKey: "event-late-after-completion",
      senderName: "History",
      providerTimestamp: "2026-07-17T09:45:00.000Z",
      source: "history",
      connectionKey: KEY_3,
    });
    await topUp.adoptPassiveHistory(["group@g.us"]);
    const second = await db
      .selectFrom("conversation_messages")
      .select("backfill_range_id")
      .where("provider_message_id", "=", "late-after-completion")
      .executeTakeFirstOrThrow();
    expect(second.backfill_range_id).not.toBe(supplemental.id);
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select("parent_range_id")
        .where("id", "=", second.backfill_range_id as string)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parent_range_id: supplemental.id });
  });

  it("recovers stamped history stranded behind a completed graph cursor through a supplemental range", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "stranded-live",
      eventKey: "event-stranded-live",
      senderName: "Live",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-graph-completed",
        group_jid: "group@g.us",
        range_key: `gap:${KEY_3}`,
        kind: "gap",
        connection_key: KEY_3,
        status: "complete",
        terminal_status: "complete",
        lower_bound_at: "2026-07-17T09:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
      })
      .execute();
    const stranded = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "stamped-behind-completed-cursor",
      eventKey: "event-stamped-behind-completed-cursor",
      senderName: "History",
      text: "recover me",
      providerTimestamp: "2026-07-17T09:30:00.000Z",
      source: "history",
      connectionKey: KEY_3,
      backfillRangeId: "range-graph-completed",
    });
    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        graph_cursor_effective_at: "2026-07-17T10:00:00.000Z",
        graph_cursor_message_id: stranded.row.id,
        graph_completed_at: "2026-07-17T10:01:00.000Z",
      })
      .where("id", "=", "range-graph-completed")
      .execute();

    await worker(db).reconcile(true);

    const repaired = await db
      .selectFrom("conversation_messages")
      .select("backfill_range_id")
      .where("id", "=", stranded.row.id)
      .executeTakeFirstOrThrow();
    expect(repaired.backfill_range_id).not.toBe("range-graph-completed");
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .select(["parent_range_id", "graph_completed_at"])
        .where("id", "=", repaired.backfill_range_id as string)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parent_range_id: "range-graph-completed", graph_completed_at: null });
  });

  it("treats a completed range row inside an open LLM tail as covered", async () => {
    const conversation = await seedGroup(db);
    const conversations = createConversationRepository(db);
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        last_fetched_key: null,
        status: "in_progress",
        live_start_effective_at: "2026-07-17T11:00:00.000Z",
        live_start_message_id: 1,
      })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-open-tail",
        group_jid: "group@g.us",
        range_key: `gap:${KEY_3}`,
        kind: "gap",
        connection_key: KEY_3,
        status: "complete",
        terminal_status: "complete",
        lower_bound_at: "2026-07-17T09:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
        graph_cursor_effective_at: "2026-07-17T10:00:00.000Z",
        graph_cursor_message_id: 1,
        graph_completed_at: "2026-07-17T10:01:00.000Z",
      })
      .execute();
    const tail = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "open-tail-history",
      eventKey: "event-open-tail-history",
      senderName: "History",
      text: "covered by the open tail",
      providerTimestamp: "2026-07-17T09:30:00.000Z",
      source: "history",
      connectionKey: KEY_3,
      backfillRangeId: "range-open-tail",
    });
    await db
      .insertInto("conversation_slices")
      .values({
        id: "open-tail-slice",
        conversation_id: conversation.id,
        first_message_id: tail.row.id,
        last_message_id: tail.row.id,
        started_at: "2026-07-17T09:30:00.000Z",
        ended_at: "2026-07-17T09:30:00.000Z",
        message_count: 1,
        denoised_message_ids: JSON.stringify([tail.row.id]),
        flush_reason: "llm_boundary",
        roster_snapshot: "[]",
        salience_verdict: "kept",
        status: "open",
      })
      .execute();

    await worker(db).reconcile(true);

    await expect(
      db
        .selectFrom("conversation_messages")
        .select("backfill_range_id")
        .where("id", "=", tail.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ backfill_range_id: "range-open-tail" });
  });

  it("corrects a legacy manual outgoing anchor from a device-suffixed account JID", async () => {
    const conversation = await seedGroup(db);
    const message = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "manual-outgoing-anchor",
      senderJid: "15551234567:12@s.whatsapp.net",
      senderName: "Self",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      providerFromMe: false,
      source: "live",
      connectionKey: KEY_2,
    });

    const range = await createWhatsAppBackfillRangeRepository(db).ensureInitialRange({
      groupJid: "group@g.us",
      connectionKey: KEY_2,
      liveStartEffectiveAt: message.row.effectiveAt,
      liveStartMessageId: message.row.id,
      lowerBoundAt: "2026-06-17T12:00:00.000Z",
      now: "2026-07-17T12:00:00.000Z",
      accountJid: "15551234567@s.whatsapp.net",
    });

    expect(range.row.cursor_from_me).toBe(1);
  });

  it("corrects a legacy manual outgoing anchor from the runtime account LID", async () => {
    const conversation = await seedGroup(db);
    const message = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "manual-outgoing-lid-anchor",
      senderJid: "86702773280883@lid",
      senderName: "Self",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      providerFromMe: false,
      source: "live",
      connectionKey: KEY_2,
    });

    const range = await createWhatsAppBackfillRangeRepository(db).ensureInitialRange({
      groupJid: "group@g.us",
      connectionKey: KEY_2,
      liveStartEffectiveAt: message.row.effectiveAt,
      liveStartMessageId: message.row.id,
      lowerBoundAt: "2026-06-17T12:00:00.000Z",
      now: "2026-07-17T12:00:00.000Z",
      accountJid: "15551234567@s.whatsapp.net",
      accountLid: "86702773280883@lid",
    });

    expect(range.row.cursor_from_me).toBe(1);
  });

  it("does not mark another group participant as the account anchor", async () => {
    const conversation = await seedGroup(db);
    const message = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "participant-anchor",
      senderJid: "15557654321@s.whatsapp.net",
      senderName: "Participant",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      providerFromMe: false,
      source: "live",
      connectionKey: KEY_2,
    });

    const range = await createWhatsAppBackfillRangeRepository(db).ensureInitialRange({
      groupJid: "group@g.us",
      connectionKey: KEY_2,
      liveStartEffectiveAt: message.row.effectiveAt,
      liveStartMessageId: message.row.id,
      lowerBoundAt: "2026-06-17T12:00:00.000Z",
      now: "2026-07-17T12:00:00.000Z",
      accountJid: "15551234567@s.whatsapp.net",
      accountLid: "86702773280883@lid",
    });

    expect(range.row.cursor_from_me).toBe(0);
  });

  it("retries deadline expiry, exhausts after the bound, and re-arms on connected", async () => {
    const conversation = await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await seedLease(db);
    const conversations = createConversationRepository(db);
    const live = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "anchor",
      eventKey: "event-anchor",
      senderName: "Live",
      providerTimestamp: "2026-07-17T11:00:00.000Z",
      source: "live",
      connectionKey: KEY_2,
    });
    await db
      .insertInto("whatsapp_backfill_checkpoints")
      .values({
        group_jid: "group@g.us",
        status: "in_progress",
        last_fetched_key: null,
        live_start_effective_at: live.row.effectiveAt,
        live_start_message_id: live.row.id,
      })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-timeout",
        group_jid: "group@g.us",
        range_key: "initial",
        kind: "initial",
        connection_key: KEY_2,
        status: "in_flight",
        lower_bound_at: "2026-06-17T12:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
        cursor_remote_jid: "group@g.us",
        cursor_message_id: "anchor",
        cursor_from_me: 0,
        cursor_provider_timestamp: "2026-07-17T11:00:00.000Z",
        attempts: 1,
        request_session_id: "request-timeout-1",
        request_lease_generation: 1,
        requested_at: "2026-07-17T11:00:00.000Z",
        response_deadline_at: "2026-07-17T11:01:00.000Z",
      })
      .execute();
    const fetch = vi.fn(async () => "request-timeout-2");
    let clock = NOW;
    const topUp = worker(db, { fetch, now: () => clock });
    await topUp.runOnce();
    clock += 1_000;
    await topUp.runOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", "range-timeout").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "in_flight", attempts: 2, request_session_id: "request-timeout-2" });

    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({ attempts: 3, response_deadline_at: "2026-07-17T11:59:00.000Z" })
      .where("id", "=", "range-timeout")
      .execute();
    await topUp.runOnce();
    await expect(
      db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", "range-timeout").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "exhausted", terminal_status: "exhausted" });

    await db
      .updateTable("whatsapp_backfill_ranges")
      .set({
        graph_cursor_effective_at: "2026-07-17T10:30:00.000Z",
        graph_cursor_message_id: 42,
        graph_completed_at: "2026-07-17T11:30:00.000Z",
      })
      .where("id", "=", "range-timeout")
      .execute();
    await topUp.handleConnected({ leaseGeneration: 1, socketGeneration: 3 });
    await expect(
      db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", "range-timeout").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "exhausted",
      terminal_status: "exhausted",
      graph_cursor_effective_at: "2026-07-17T10:30:00.000Z",
      graph_cursor_message_id: 42,
      graph_completed_at: "2026-07-17T11:30:00.000Z",
    });
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .selectAll()
        .where("range_key", "=", "continuation:range-timeout")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      terminal_status: null,
      parent_range_id: "range-timeout",
      graph_cursor_effective_at: null,
      graph_cursor_message_id: null,
      graph_completed_at: null,
      cursor_message_id: "anchor",
    });
  });

  it("reclaims a stale request after gateway respawn without charging the accepted-attempt budget", async () => {
    await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await seedLease(db, 2);
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-respawn",
        group_jid: "group@g.us",
        range_key: "initial",
        kind: "initial",
        connection_key: KEY_2,
        status: "in_flight",
        lower_bound_at: "2026-06-17T12:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
        cursor_remote_jid: "group@g.us",
        cursor_message_id: "anchor",
        cursor_from_me: 0,
        cursor_provider_timestamp: "2026-07-17T11:00:00.000Z",
        attempts: 1,
        request_session_id: "request-old-child",
        request_lease_generation: 1,
        requested_at: "2026-07-17T11:59:30.000Z",
        response_deadline_at: "2026-07-17T12:00:30.000Z",
      })
      .execute();
    const fetch = vi.fn(async () => "request-new-child");
    let clock = NOW;
    const topUp = worker(db, { fetch, now: () => clock });
    await topUp.runOnce();
    clock += 1_000;
    await topUp.runOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", "range-respawn").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "in_flight",
      attempts: 1,
      request_session_id: "request-new-child",
      request_lease_generation: 2,
    });
  });

  it("reclaims a stale pre-request claim before issuing the serialized fetch", async () => {
    await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await seedLease(db);
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values({
        id: "range-stale-claim",
        group_jid: "group@g.us",
        range_key: "initial",
        kind: "initial",
        connection_key: KEY_2,
        status: "claimed",
        lower_bound_at: "2026-06-17T12:00:00.000Z",
        upper_bound_at: "2026-07-17T11:00:00.000Z",
        cursor_remote_jid: "group@g.us",
        cursor_message_id: "anchor",
        cursor_from_me: 0,
        cursor_provider_timestamp: "2026-07-17T11:00:00.000Z",
        claim_token: "claim-from-dead-process",
        claimed_at: "2026-07-17T11:57:00.000Z",
      })
      .execute();
    const fetch = vi.fn(async () => "request-after-stale-claim");
    let clock = NOW;
    const topUp = worker(db, { fetch, now: () => clock });
    await topUp.runOnce();
    clock += 1_000;
    await topUp.runOnce();

    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      db
        .selectFrom("whatsapp_backfill_ranges")
        .selectAll()
        .where("id", "=", "range-stale-claim")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "in_flight",
      attempts: 1,
      request_session_id: "request-after-stale-claim",
    });
  });

  it("selects least-recently-served and never issues concurrent history fetches", async () => {
    const conversation = await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await seedLease(db);
    const conversations = createConversationRepository(db);
    for (const [index, key] of [KEY_2, KEY_3].entries()) {
      const anchor = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: `anchor-${index}`,
        eventKey: `event-anchor-${index}`,
        senderName: "Live",
        providerTimestamp: `2026-07-17T1${index}:00:00.000Z`,
        source: index === 0 ? "live" : "history",
        connectionKey: key,
      });
      await db
        .insertInto("whatsapp_backfill_ranges")
        .values({
          id: `range-${index}`,
          group_jid: "group@g.us",
          range_key: index === 0 ? "initial" : `gap:${key}`,
          kind: index === 0 ? "initial" : "gap",
          connection_key: key,
          status: "pending",
          lower_bound_at: "2026-06-17T12:00:00.000Z",
          upper_bound_at: "2026-07-17T12:00:00.000Z",
          cursor_remote_jid: "group@g.us",
          cursor_message_id: anchor.row.providerMessageId,
          cursor_from_me: 0,
          cursor_provider_timestamp: anchor.row.providerTimestamp,
          next_retry_at: "2026-07-17T11:00:00.000Z",
          last_served_at: index === 0 ? "2026-07-17T11:50:00.000Z" : "2026-07-17T11:40:00.000Z",
        })
        .execute();
    }
    let resolveFetch!: (value: string) => void;
    const fetch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const topUp = worker(db, { fetch });
    topUp.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        oldestMessageKey: expect.objectContaining({ id: "anchor-1" }),
        oldestMessageTimestamp: Date.parse("2026-07-17T11:00:00.000Z"),
      }),
    );
    void topUp.wake();
    void topUp.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch("request-serialized");
    await vi.waitFor(async () => {
      const inFlight = await db
        .selectFrom("whatsapp_backfill_ranges")
        .select("id")
        .where("status", "=", "in_flight")
        .execute();
      expect(inFlight).toHaveLength(1);
    });
    await topUp.stop();
  });

  it("does not claim backfill ranges for disabled groups", async () => {
    await seedGroup(db);
    await db.updateTable("whatsapp_groups").set({ index_enabled: 1 }).where("jid", "=", "group@g.us").execute();
    await db
      .insertInto("whatsapp_groups")
      .values({
        jid: "disabled@g.us",
        name: "Disabled",
        description: null,
        updated_at: "2026-07-17T12:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("whatsapp_backfill_ranges")
      .values([
        {
          id: "range-disabled",
          group_jid: "disabled@g.us",
          range_key: "initial",
          kind: "initial",
          connection_key: KEY_2,
          status: "pending",
          lower_bound_at: "2026-06-17T12:00:00.000Z",
          upper_bound_at: "2026-07-17T12:00:00.000Z",
          created_at: "2026-07-17T10:00:00.000Z",
        },
        {
          id: "range-enabled",
          group_jid: "group@g.us",
          range_key: "initial",
          kind: "initial",
          connection_key: KEY_2,
          status: "pending",
          lower_bound_at: "2026-06-17T12:00:00.000Z",
          upper_bound_at: "2026-07-17T12:00:00.000Z",
          created_at: "2026-07-17T11:00:00.000Z",
        },
      ])
      .execute();

    const ranges = createWhatsAppBackfillRangeRepository(db);
    await expect(ranges.claimNext("claim-enabled", "2026-07-17T12:00:00.000Z")).resolves.toMatchObject({
      id: "range-enabled",
      status: "claimed",
    });
    await expect(ranges.getById("range-disabled")).resolves.toMatchObject({ status: "pending" });
  });
});

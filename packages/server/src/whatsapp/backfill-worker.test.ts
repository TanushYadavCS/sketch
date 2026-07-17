import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppAdapterHandlers } from "./adapter";
import { WhatsAppBackfillWorker } from "./backfill-worker";
import type { WhatsAppHistoryBatchEnvelope, WhatsAppMessageEnvelope, WhatsAppSocketFacade } from "./facade-contract";
import type { WhatsAppInboundMessage } from "./provider";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const KEY_1 = "000000000001:000000000001";
const KEY_2 = "000000000001:000000000002";
const KEY_3 = "000000000001:000000000003";
const KEY_4 = "000000000001:000000000004";

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
      contractVersion: "1.1",
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
      contract_version: "1.1",
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
  });

  it("retries deadline expiry, exhausts after the bound, and re-arms on connected", async () => {
    const conversation = await seedGroup(db);
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

    await topUp.handleConnected({ leaseGeneration: 1, socketGeneration: 3 });
    await expect(
      db.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", "range-timeout").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "pending", attempts: 0, terminal_status: null });
  });

  it("reclaims a stale request after gateway respawn without charging the accepted-attempt budget", async () => {
    await seedGroup(db);
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
      expect.objectContaining({ oldestMessageKey: expect.objectContaining({ id: "anchor-1" }) }),
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
});

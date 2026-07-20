import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../db/migrate";
import {
  createWhatsAppEventKey,
  type createWhatsAppInboundEventsRepository,
} from "../../db/repositories/whatsapp-inbound-events";
import { createWhatsAppSessionLeaseRepository } from "../../db/repositories/whatsapp-session-lease";
import type { DB } from "../../db/schema";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppGroupMessage, WhatsAppHistoryBatchMetadata, WhatsAppMessage } from "../bot";
import { WhatsAppGatewayCapture } from "./capture";

type CaptureInternals = {
  events: ReturnType<typeof createWhatsAppInboundEventsRepository>;
};

function groupMessage(id: string, timestamp: string, fromMe = false): WhatsAppGroupMessage {
  const groupJid = "120363000000001@g.us";
  return {
    type: "group",
    text: `message-${id}`,
    jid: groupJid,
    messageId: id,
    pushName: "Alice",
    rawMessage: {
      key: {
        remoteJid: groupJid,
        id,
        fromMe,
        participant: "15551234567@s.whatsapp.net",
      },
      messageTimestamp: Math.floor(Date.parse(timestamp) / 1000),
      message: { conversation: `message-${id}` },
      pushName: "Alice",
    },
    isMentioned: true,
    senderJid: "15551234567@s.whatsapp.net",
    senderPhone: "+15551234567",
  };
}

class FakeBaileysBuffer {
  private buffering = false;
  private readonly buffered = new Map<string, WhatsAppMessage>();

  constructor(
    private readonly capture: WhatsAppGatewayCapture,
    private readonly metadata: WhatsAppHistoryBatchMetadata = {
      socketGeneration: 1,
      syncType: 1,
      progress: 100,
      isLatest: true,
    },
  ) {}

  connect(): void {
    this.buffering = true;
  }

  async upsert(message: WhatsAppMessage): Promise<void> {
    if (this.buffering) {
      this.buffered.set(this.key(message), message);
      return;
    }
    await this.capture.captureMessage(message);
  }

  async flushHistory(messages: WhatsAppMessage[]): Promise<void> {
    const consolidated = new Map<string, WhatsAppMessage>();
    for (const message of messages) consolidated.set(this.key(message), message);
    for (const message of this.buffered.values()) consolidated.set(this.key(message), message);
    this.buffered.clear();
    this.buffering = false;
    await this.capture.captureHistory([...consolidated.values()], this.metadata);
  }

  private key(message: WhatsAppMessage): string {
    const raw = message.rawMessage.key ?? {};
    return `${raw.remoteJid}\u001f${raw.id}\u001f${String(raw.fromMe)}`;
  }
}

describe("WhatsApp gateway Baileys absorption capture", () => {
  let directory: string;
  let db: Kysely<DB>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sketch-wa-capture-"));
    const raw = new Database(join(directory, "capture.db"));
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
    await runMigrations(db, { quiet: true });
  });

  afterEach(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it("captures an absorbed reconnect message once through history_message and deduplicates live/history overlap", async () => {
    const lease = createWhatsAppSessionLeaseRepository(db);
    const acquired = await lease.acquire({
      ownerKind: "gateway",
      ownerToken: "owner-a",
      gatewayHttpToken: "http-token",
      hostId: "host-a",
      bootId: "boot-a",
      pid: 1,
      pidStartTime: "1",
      scriptHash: "hash",
      contractVersion: "1.0",
    });
    const fence = { ownerToken: "owner-a", generation: acquired.lease?.generation ?? 0 };
    await lease.heartbeat("owner-a", { markLive: true });
    await lease.markDisconnected(fence);

    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });
    const socket = new FakeBaileysBuffer(capture);
    const absorbed = groupMessage("absorbed", new Date().toISOString());
    socket.connect();
    await socket.upsert(absorbed);
    await socket.flushHistory([absorbed]);

    const absorbedKey = createWhatsAppEventKey(absorbed.jid, absorbed.messageId, false);
    const absorbedRows = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["kind", "event_key"])
      .where("event_key", "=", absorbedKey)
      .execute();
    expect(absorbedRows).toEqual([{ kind: "history_message", event_key: absorbedKey }]);

    await socket.upsert(absorbed);
    expect(
      await db.selectFrom("whatsapp_inbound_events").select("id").where("event_key", "=", absorbedKey).execute(),
    ).toHaveLength(1);

    const live = groupMessage("live-before-flush", new Date().toISOString());
    await socket.upsert(live);
    await socket.flushHistory([live]);
    const liveKey = createWhatsAppEventKey(live.jid, live.messageId, false);
    const liveRows = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["kind", "event_key"])
      .where("event_key", "=", liveKey)
      .execute();
    expect(liveRows).toEqual([{ kind: "message", event_key: liveKey }]);
  });

  it("captures append then notify overlap once as promoted reconnect history", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
      leaseGeneration: 4,
    });
    const appendFirst = groupMessage("append-first", new Date().toISOString());
    const notifyFirst = groupMessage("notify-first", new Date().toISOString());

    await capture.captureMessage(appendFirst, { socketGeneration: 2, upsertType: "append" });
    await capture.captureMessage(appendFirst, { socketGeneration: 2, upsertType: "notify" });
    await capture.captureMessage(notifyFirst, { socketGeneration: 2, upsertType: "notify" });
    await capture.captureMessage(notifyFirst, { socketGeneration: 2, upsertType: "append" });

    await expect(
      db.selectFrom("whatsapp_inbound_events").select(["kind", "provider_message_id"]).orderBy("id", "asc").execute(),
    ).resolves.toEqual([
      { kind: "history_message", provider_message_id: "append-first" },
      { kind: "message", provider_message_id: "notify-first" },
    ]);
  });

  it("stages media for promoted reconnect append messages", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });
    const media = groupMessage("append-media", new Date().toISOString());
    media.mediaType = "imageMessage";

    await capture.captureMessage(media, { socketGeneration: 2, upsertType: "append" });

    const row = await db.selectFrom("whatsapp_inbound_events").select(["kind", "envelope"]).executeTakeFirstOrThrow();
    const envelope = JSON.parse(row.envelope) as {
      message: { stagedMediaRef: unknown; mediaStagingError: string | null };
    };
    expect(row.kind).toBe("history_message");
    expect(envelope.message).toMatchObject({
      stagedMediaRef: null,
      mediaStagingError: "WhatsApp socket unavailable for media staging",
    });
  });

  it("does not promote offline append traffic during a fresh pairing generation", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });

    await capture.captureMessage(groupMessage("initial-append", new Date().toISOString()), {
      socketGeneration: 1,
      upsertType: "append",
    });

    await expect(db.selectFrom("whatsapp_inbound_events").select("id").execute()).resolves.toEqual([]);
  });

  it("emits initial-sync history sets as batch rows without history_message rows", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });
    const socket = new FakeBaileysBuffer(capture);
    socket.connect();
    for (let index = 0; index < 101; index += 1) {
      await socket.upsert(groupMessage(`old-initial-${index}`, "2020-01-01T00:00:00.000Z"));
    }
    await socket.flushHistory([]);

    const rows = await db.selectFrom("whatsapp_inbound_events").select(["kind", "envelope"]).orderBy("id").execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "history_batch")).toBe(true);
    expect(
      rows.reduce((total, row) => total + (JSON.parse(row.envelope) as { messages: unknown[] }).messages.length, 0),
    ).toBe(101);
    expect(
      rows.every(
        (row) =>
          (JSON.parse(row.envelope) as { messages: unknown[] }).messages.length <= 100 &&
          Buffer.byteLength(row.envelope, "utf8") <= 200 * 1024,
      ),
    ).toBe(true);
  });

  it("round-trips the lease and socket generations through live and history envelopes", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
      leaseGeneration: 7,
    });

    await capture.captureMessage(groupMessage("live-key", "2026-07-17T09:00:00.000Z"), {
      socketGeneration: 19,
    });
    await capture.captureHistory([groupMessage("history-key", "2026-07-17T08:59:00.000Z")], {
      socketGeneration: 20,
      syncType: 1,
    });

    const rows = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["kind", "envelope"])
      .orderBy("id", "asc")
      .execute();
    expect(JSON.parse(rows[0]?.envelope ?? "{}")).toMatchObject({
      kind: "message",
      connectionKey: "000000000007:000000000019",
    });
    expect(JSON.parse(rows[1]?.envelope ?? "{}")).toMatchObject({
      kind: "history_batch",
      connectionKey: "000000000007:000000000020",
      messages: [{ connectionKey: "000000000007:000000000020" }],
    });
  });

  it("persists the on-demand request session on empty durable history batches", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
      leaseGeneration: 7,
    });

    await capture.captureHistory([], {
      socketGeneration: 20,
      syncType: 6,
      peerDataRequestSessionId: "request-session-empty",
    });

    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["request_session_id", "envelope"])
      .executeTakeFirstOrThrow();
    expect(row.request_session_id).toBe("request-session-empty");
    expect(JSON.parse(row.envelope)).toMatchObject({
      batch: { peerDataRequestSessionId: "request-session-empty" },
      messages: [],
    });
  });

  it("treats history after a logout-released lease and re-pair as a fresh initial-sync generation", async () => {
    const lease = createWhatsAppSessionLeaseRepository(db);
    const acquired = await lease.acquire({
      ownerKind: "gateway",
      ownerToken: "owner-before-logout",
      gatewayHttpToken: "http-token",
      hostId: "host-before-logout",
      bootId: "boot-before-logout",
      pid: 3,
      pidStartTime: "3",
      scriptHash: "hash",
      contractVersion: "1.0",
    });
    const fence = { ownerToken: "owner-before-logout", generation: acquired.lease?.generation ?? 0 };
    await lease.heartbeat("owner-before-logout", { markLive: true });
    await lease.markDisconnected(fence);
    await lease.releaseAfterLogout(fence);
    const reacquired = await lease.acquire({
      ownerKind: "gateway",
      ownerToken: "owner-after-logout",
      gatewayHttpToken: "http-token",
      hostId: "host-after-logout",
      bootId: "boot-after-logout",
      pid: 4,
      pidStartTime: "4",
      scriptHash: "hash",
      contractVersion: "1.0",
    });
    const isInitialSyncGeneration = reacquired.lease?.last_live_at == null;
    expect(isInitialSyncGeneration).toBe(true);
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => isInitialSyncGeneration,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });

    await capture.captureHistory([groupMessage("old-after-repair", new Date().toISOString())]);

    const rows = await db.selectFrom("whatsapp_inbound_events").select("kind").execute();
    expect(rows).toEqual([{ kind: "history_batch" }]);
  });

  it("captures reconnect outbound messages in history batches without promoting them for dispatch", async () => {
    const lease = createWhatsAppSessionLeaseRepository(db);
    const acquired = await lease.acquire({
      ownerKind: "gateway",
      ownerToken: "owner-outbound",
      gatewayHttpToken: "http-token",
      hostId: "host-outbound",
      bootId: "boot-outbound",
      pid: 2,
      pidStartTime: "2",
      scriptHash: "hash",
      contractVersion: "1.0",
    });
    const fence = { ownerToken: "owner-outbound", generation: acquired.lease?.generation ?? 0 };
    await lease.heartbeat("owner-outbound", { markLive: true });
    await lease.markDisconnected(fence);
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });

    await capture.captureHistory([groupMessage("outbound-replay", new Date().toISOString(), true)]);

    const rows = await db.selectFrom("whatsapp_inbound_events").select(["kind", "envelope"]).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("history_batch");
    expect(
      (JSON.parse(rows[0]?.envelope ?? "{}") as { messages: Array<{ fromMe: boolean }> }).messages[0]?.fromMe,
    ).toBe(true);
  });

  it("never promotes ON_DEMAND history while preserving ordinary reconnect promotion", async () => {
    const lease = createWhatsAppSessionLeaseRepository(db);
    const acquired = await lease.acquire({
      ownerKind: "gateway",
      ownerToken: "owner-on-demand",
      gatewayHttpToken: "http-token",
      hostId: "host-on-demand",
      bootId: "boot-on-demand",
      pid: 5,
      pidStartTime: "5",
      scriptHash: "hash",
      contractVersion: "1.0",
    });
    const fence = { ownerToken: "owner-on-demand", generation: acquired.lease?.generation ?? 0 };
    await lease.heartbeat("owner-on-demand", { markLive: true });
    await lease.markDisconnected(fence);
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
      leaseGeneration: fence.generation,
    });

    await capture.captureHistory([groupMessage("on-demand", new Date().toISOString())], {
      socketGeneration: 2,
      syncType: 6,
    });
    await capture.captureHistory([groupMessage("reconnect", new Date().toISOString())], {
      socketGeneration: 2,
      syncType: 1,
    });

    const rows = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["kind", "provider_message_id"])
      .orderBy("id", "asc")
      .execute();
    expect(rows.filter((row) => row.provider_message_id === "on-demand")).toEqual([]);
    expect(rows.filter((row) => row.provider_message_id === "reconnect")).toEqual([
      { kind: "history_message", provider_message_id: "reconnect" },
    ]);
    expect(rows.filter((row) => row.kind === "history_batch")).toHaveLength(2);
  });

  it("does not stage history media and excludes messages without durable provider identity", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => {
        throw new Error("history media staging must stay disabled");
      },
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
      leaseGeneration: 3,
    });
    const media = groupMessage("captioned-media", "2026-07-17T09:00:00.000Z");
    media.mediaType = "imageMessage";
    const noId = groupMessage("temporary-id", "2026-07-17T09:00:00.000Z");
    noId.messageId = "";
    if (noId.rawMessage.key) noId.rawMessage.key.id = null;
    const noTimestamp = groupMessage("no-timestamp", "2026-07-17T09:00:00.000Z");
    noTimestamp.rawMessage.messageTimestamp = null;

    await capture.captureHistory([media, noId, noTimestamp], { socketGeneration: 4, syncType: 1 });

    const row = await db.selectFrom("whatsapp_inbound_events").select("envelope").executeTakeFirstOrThrow();
    const envelope = JSON.parse(row.envelope) as {
      messages: Array<{ providerMessageId: string; message: { stagedMediaRef: unknown; mediaStagingError: unknown } }>;
    };
    expect(envelope.messages).toEqual([
      expect.objectContaining({
        providerMessageId: "captioned-media",
        message: expect.objectContaining({ stagedMediaRef: null, mediaStagingError: null }),
      }),
    ]);
  });

  it("dead-letters an indivisible history message that remains over 200KB after compaction", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const capture = new WhatsAppGatewayCapture({
      db,
      logger,
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure: () => undefined,
    });
    const oversized = groupMessage("oversized", "2020-01-01T00:00:00.000Z");
    oversized.text = "x".repeat(210 * 1024);
    if (oversized.rawMessage.message) oversized.rawMessage.message.conversation = oversized.text;
    await capture.captureHistory([oversized]);

    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["kind", "status", "last_error"])
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ kind: "history_batch", status: "dead" });
    expect(row.last_error).toMatch(/200KB|256KB/u);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ chunkIndex: 0 }),
      "WhatsApp history chunk was dead-lettered at insert; history indexing has a gap",
    );
  });

  it("escalates a live-message insert failure after recording it", async () => {
    const onPersistFailure = vi.fn();
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure,
    });
    const events = (capture as unknown as CaptureInternals).events;
    const failure = new Error("insert unavailable");
    vi.spyOn(events, "insert").mockRejectedValue(failure);

    await expect(
      capture.captureMessage(groupMessage("insert-failure", new Date().toISOString())),
    ).resolves.toBeUndefined();

    expect(capture.insertFailures).toBe(1);
    expect(onPersistFailure).toHaveBeenCalledTimes(1);
    expect(onPersistFailure).toHaveBeenCalledWith(failure);
  });

  it("escalates a history transaction failure after recording it", async () => {
    const onPersistFailure = vi.fn();
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
      onPersistFailure,
    });
    const events = (capture as unknown as CaptureInternals).events;
    const failure = new Error("transaction unavailable");
    vi.spyOn(events, "insertManyAtomic").mockRejectedValue(failure);

    await expect(
      capture.captureHistory([groupMessage("history-insert-failure", new Date().toISOString())]),
    ).resolves.toEqual({ persisted: 0, skippedOld: 0, skippedDup: 0 });

    expect(capture.insertFailures).toBe(1);
    expect(onPersistFailure).toHaveBeenCalledTimes(1);
    expect(onPersistFailure).toHaveBeenCalledWith(failure);
  });

  it("escalates a pre-insert dedup lookup failure without rejecting", async () => {
    const onPersistFailure = vi.fn();
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure,
    });
    const events = (capture as unknown as CaptureInternals).events;
    const failure = new Error("dedup lookup unavailable");
    vi.spyOn(events, "findByEventKey").mockRejectedValue(failure);
    const insert = vi.spyOn(events, "insert");

    await expect(
      capture.captureMessage(groupMessage("lookup-failure", new Date().toISOString())),
    ).resolves.toBeUndefined();

    expect(insert).not.toHaveBeenCalled();
    expect(capture.insertFailures).toBe(1);
    expect(onPersistFailure).toHaveBeenCalledTimes(1);
    expect(onPersistFailure).toHaveBeenCalledWith(failure);
  });

  it("does not escalate a live-message dedup hit", async () => {
    const onPersistFailure = vi.fn();
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => false,
      wake: async () => undefined,
      onPersistFailure,
    });
    const events = (capture as unknown as CaptureInternals).events;
    const insert = vi.spyOn(events, "insert");
    const message = groupMessage("dedup-hit", new Date().toISOString());

    await capture.captureMessage(message);
    await capture.captureMessage(message);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(capture.insertFailures).toBe(0);
    expect(onPersistFailure).not.toHaveBeenCalled();
  });
});

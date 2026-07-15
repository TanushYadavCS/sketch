import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../db/migrate";
import { createWhatsAppEventKey } from "../../db/repositories/whatsapp-inbound-events";
import { createWhatsAppSessionLeaseRepository } from "../../db/repositories/whatsapp-session-lease";
import type { DB } from "../../db/schema";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppGroupMessage, WhatsAppHistoryBatchMetadata, WhatsAppMessage } from "../bot";
import { WhatsAppGatewayCapture } from "./capture";

function groupMessage(id: string, timestamp: string): WhatsAppGroupMessage {
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
        fromMe: false,
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
    private readonly metadata: WhatsAppHistoryBatchMetadata = { syncType: 1, progress: 100, isLatest: true },
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

  it("dead-letters an indivisible history message that remains over 200KB after compaction", async () => {
    const capture = new WhatsAppGatewayCapture({
      db,
      logger: createTestLogger(),
      stagingDir: join(directory, "staging"),
      maxFileBytes: 1024,
      getSocket: () => null,
      rememberMessage: () => undefined,
      isInitialSyncGeneration: () => true,
      wake: async () => undefined,
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
  });
});

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationRepository } from "./conversations";
import {
  createWhatsAppEventKey,
  createWhatsAppInboundEventsRepository,
  withBoundedSqliteRetry,
} from "./whatsapp-inbound-events";

describe("WhatsApp inbound events repository on SQLite", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("migrates the planned queue columns and indexes", async () => {
    const columns = await sql<{ name: string }>`PRAGMA table_info(whatsapp_inbound_events)`.execute(db);
    expect(columns.rows.map((row) => row.name)).toEqual([
      "id",
      "kind",
      "origin",
      "event_key",
      "provider_message_id",
      "batch_id",
      "chunk_index",
      "chunk_count",
      "envelope",
      "received_at",
      "attempts",
      "status",
      "claim_token",
      "claimed_at",
      "next_attempt_at",
      "consumed_at",
      "last_error",
      "created_at",
    ]);
    const indexes = await sql<{ name: string }>`PRAGMA index_list(whatsapp_inbound_events)`.execute(db);
    expect(indexes.rows.map((row) => row.name).sort()).toEqual([
      "whatsapp_inbound_events_batch_id_idx",
      "whatsapp_inbound_events_event_key_uidx",
      "whatsapp_inbound_events_provider_message_id_idx",
      "whatsapp_inbound_events_status_id_idx",
    ]);
    const statusIndex = await sql<{ name: string }>`
      PRAGMA index_info(whatsapp_inbound_events_status_id_idx)
    `.execute(db);
    const providerIndex = await sql<{ name: string }>`
      PRAGMA index_info(whatsapp_inbound_events_provider_message_id_idx)
    `.execute(db);
    const batchIndex = await sql<{ name: string }>`
      PRAGMA index_info(whatsapp_inbound_events_batch_id_idx)
    `.execute(db);
    expect(statusIndex.rows.map((row) => row.name)).toEqual(["status", "id"]);
    expect(providerIndex.rows.map((row) => row.name)).toEqual(["provider_message_id"]);
    expect(batchIndex.rows.map((row) => row.name)).toEqual(["batch_id"]);
  });

  it("uses the canonical conversation, provider id, and fromMe identity and deduplicates inserts", async () => {
    const expected = createHash("sha256").update("group@g.us\x1fmessage-1\x1ffalse").digest("hex");
    const eventKey = createWhatsAppEventKey("group@g.us", "message-1", false);
    const repo = createWhatsAppInboundEventsRepository(db);

    const first = await repo.insert({
      origin: "gateway",
      kind: "message",
      eventKey,
      providerMessageId: "message-1",
      envelope: JSON.stringify({ senderJid: "1555@s.whatsapp.net" }),
    });
    const replay = await repo.insert({
      origin: "gateway",
      kind: "history_message",
      eventKey,
      providerMessageId: "message-1",
      envelope: JSON.stringify({ senderJid: "1555@lid" }),
    });

    expect(eventKey).toBe(expected);
    expect(createWhatsAppEventKey("group@g.us", "", false)).toBeNull();
    expect(first.inserted).toBe(true);
    expect(replay).toEqual({ row: first.row, inserted: false });

    const missingIdFirst = await repo.insert({
      origin: "gateway",
      kind: "message",
      eventKey: createWhatsAppEventKey("group@g.us", "", false),
      providerMessageId: "",
      envelope: "{}",
    });
    const missingIdSecond = await repo.insert({
      origin: "gateway",
      kind: "message",
      eventKey: null,
      providerMessageId: "",
      envelope: "{}",
    });
    expect(missingIdFirst.row.event_key).toBeNull();
    expect(missingIdSecond.inserted).toBe(true);
    expect(missingIdSecond.row.id).not.toBe(missingIdFirst.row.id);
  });

  it("claims only eligible rows, orders the batch by provider time, and rejects a zombie token", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const late = await repo.insert({
      origin: "gateway",
      kind: "message",
      providerMessageId: "late",
      envelope: JSON.stringify({ providerTimestamp: "2026-07-15T10:00:00.000Z" }),
    });
    const early = await repo.insert({
      origin: "gateway",
      kind: "message",
      providerMessageId: "early",
      envelope: JSON.stringify({ providerTimestamp: "2026-07-15T09:00:00.000Z" }),
    });
    const delayed = await repo.insert({
      origin: "gateway",
      kind: "message",
      providerMessageId: "delayed",
      envelope: "{}",
    });
    const capturedReady = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    const dispatched = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "captured", next_attempt_at: "2999-01-01T00:00:00.000Z" })
      .where("id", "=", delayed.row.id)
      .execute();
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "captured", next_attempt_at: sql`CURRENT_TIMESTAMP` })
      .where("id", "=", capturedReady.row.id)
      .execute();
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "dispatched", claimed_at: sql`datetime(CURRENT_TIMESTAMP, '-121 seconds')` })
      .where("id", "=", dispatched.row.id)
      .execute();

    const claimed = await repo.claim("first-token");
    expect(claimed.map((row) => row.id)).toEqual([early.row.id, late.row.id, capturedReady.row.id]);
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ claimed_at: sql`datetime(CURRENT_TIMESTAMP, '-121 seconds')` })
      .where("id", "=", early.row.id)
      .execute();
    const reclaimed = await repo.claim("second-token");
    expect(reclaimed.map((row) => row.id)).toContain(early.row.id);
    expect(reclaimed.map((row) => row.id)).not.toContain(dispatched.row.id);
    await expect(repo.markCaptured(early.row.id, "first-token")).resolves.toBe(false);
    await expect(repo.markCaptured(early.row.id, "second-token")).resolves.toBe(true);
    await expect(repo.markConsumed(early.row.id, "first-token")).resolves.toBe(false);
    await expect(repo.revertToCaptured(early.row.id, "first-token", "zombie")).resolves.toBe(false);
    await expect(repo.markDead(early.row.id, "first-token", "zombie")).resolves.toBe(false);
  });

  it("dispatches durably, consumes at run start, compensates sheds, and dead-letters after five attempts", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    const [claimed] = await repo.claim("claim-1");
    expect(claimed?.attempts).toBe(1);
    await expect(repo.markCaptured(inserted.row.id, "claim-1")).resolves.toBe(true);
    await expect(repo.markDispatched(inserted.row.id, "claim-1")).resolves.toBe(true);
    await expect(repo.consumeDispatched(inserted.row.id, "zombie-token")).resolves.toBe(false);
    await expect(repo.claim("post-dispatch-token")).resolves.toEqual([]);
    await expect(
      db.selectFrom("whatsapp_inbound_events").select("status").where("id", "=", inserted.row.id).executeTakeFirst(),
    ).resolves.toEqual({ status: "dispatched" });
    await expect(repo.revertToCaptured(inserted.row.id, "claim-1", "shed")).resolves.toBe(true);
    const requeued = await db
      .selectFrom("whatsapp_inbound_events")
      .selectAll()
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(requeued).toMatchObject({ status: "captured", attempts: 1, last_error: "shed" });
    const delay = await sql<{ seconds: number }>`
      SELECT ROUND((julianday(next_attempt_at) - julianday(CURRENT_TIMESTAMP)) * 86400) AS seconds
      FROM whatsapp_inbound_events WHERE id = ${inserted.row.id}
    `.execute(db);
    expect(Number(delay.rows[0]?.seconds)).toBe(60);

    await db
      .updateTable("whatsapp_inbound_events")
      .set({ next_attempt_at: sql`CURRENT_TIMESTAMP` })
      .where("id", "=", inserted.row.id)
      .execute();
    await expect(repo.claim("claim-2")).resolves.toHaveLength(1);
    await expect(repo.markCaptured(inserted.row.id, "claim-2")).resolves.toBe(true);
    await expect(repo.markDispatched(inserted.row.id, "claim-2")).resolves.toBe(true);
    await expect(repo.consumeDispatched(inserted.row.id, "claim-2")).resolves.toBe(true);
    await expect(repo.revertToCaptured(inserted.row.id, "claim-2", "late shed")).resolves.toBe(false);
    await expect(repo.claim("post-consume-token")).resolves.toEqual([]);
    await expect(
      db.selectFrom("whatsapp_inbound_events").select("status").where("id", "=", inserted.row.id).executeTakeFirst(),
    ).resolves.toEqual({ status: "consumed" });

    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "pending", attempts: 5, next_attempt_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", inserted.row.id)
      .execute();
    await repo.claim("claim-6");
    const dead = await db
      .selectFrom("whatsapp_inbound_events")
      .selectAll()
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(dead).toMatchObject({ status: "dead", attempts: 5, last_error: "shed" });
  });

  it("resets dispatched rows for boot recovery and reclaims them immediately", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    await repo.claim("old-process-token");
    await repo.markCaptured(inserted.row.id, "old-process-token");
    await repo.markDispatched(inserted.row.id, "old-process-token");

    await expect(repo.claim("stale-sweep-token")).resolves.toEqual([]);
    await expect(repo.resetDispatched()).resolves.toBe(1);
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["status", "claim_token", "claimed_at"])
        .where("id", "=", inserted.row.id)
        .executeTakeFirst(),
    ).resolves.toEqual({ status: "captured", claim_token: null, claimed_at: null });
    await expect(repo.claim("new-process-token")).resolves.toMatchObject([
      { id: inserted.row.id, status: "processing", claim_token: "new-process-token", attempts: 2 },
    ]);
    await expect(repo.markCaptured(inserted.row.id, "new-process-token")).resolves.toBe(true);
    await expect(repo.markDispatched(inserted.row.id, "new-process-token")).resolves.toBe(true);
  });

  it("commits conversation, message, and captured status together and reclaims a captured crash", async () => {
    const eventKey = createWhatsAppEventKey("group@g.us", "transactional", false);
    const queueRepo = createWhatsAppInboundEventsRepository(db);
    const inserted = await queueRepo.insert({
      origin: "gateway",
      kind: "message",
      eventKey,
      providerMessageId: "transactional",
      envelope: "{}",
    });
    await queueRepo.claim("capture-token");

    await expect(
      db.transaction().execute(async (trx) => {
        const conversations = createConversationRepository(trx);
        const transactionalQueue = createWhatsAppInboundEventsRepository(trx);
        const conversation = await conversations.getOrCreate({
          platform: "whatsapp",
          kind: "group",
          providerConversationId: "group@g.us",
        });
        await conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: "transactional",
          eventKey,
          senderName: "Alice",
        });
        await transactionalQueue.markCaptured(inserted.row.id, "capture-token");
        throw new Error("rollback capture");
      }),
    ).rejects.toThrow("rollback capture");
    await expect(db.selectFrom("conversation_messages").select("id").execute()).resolves.toEqual([]);
    await expect(
      db.selectFrom("whatsapp_inbound_events").select("status").where("id", "=", inserted.row.id).executeTakeFirst(),
    ).resolves.toEqual({ status: "processing" });

    await db.transaction().execute(async (trx) => {
      const conversations = createConversationRepository(trx);
      const transactionalQueue = createWhatsAppInboundEventsRepository(trx);
      const conversation = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "transactional",
        eventKey,
        senderName: "Alice",
      });
      await transactionalQueue.markCaptured(inserted.row.id, "capture-token");
    });
    await expect(queueRepo.claim("reclaim-token")).resolves.toMatchObject([
      { id: inserted.row.id, status: "processing", attempts: 2 },
    ]);
  });

  it("claims at most 25 rows per pass and dead-letters oversized envelopes at insert", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    for (let index = 0; index < 30; index += 1) {
      await repo.insert({ origin: "gateway", kind: "message", envelope: JSON.stringify({ index }) });
    }
    await expect(repo.claim("batch-25")).resolves.toHaveLength(25);
    await expect(repo.claim("batch-5")).resolves.toHaveLength(5);

    const oversized = await repo.insert({
      origin: "gateway",
      kind: "message",
      envelope: "x".repeat(256 * 1024 + 1),
    });
    expect(oversized.row).toMatchObject({ status: "dead", last_error: "serialized envelope exceeds 256KB" });
  });

  it("keeps concurrent claim passes disjoint", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    for (let index = 0; index < 30; index += 1) {
      await repo.insert({ origin: "gateway", kind: "message", envelope: JSON.stringify({ index }) });
    }

    const [pollClaim, wakeClaim] = await Promise.all([repo.claim("poll-token"), repo.claim("wake-token")]);
    expect(pollClaim).toHaveLength(25);
    expect(wakeClaim).toHaveLength(5);
    expect(new Set([...pollClaim, ...wakeClaim].map((row) => row.id)).size).toBe(30);
  });

  it("shares a transaction executor with conversation capture and returns an existing durable message", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const eventKey = createWhatsAppEventKey("group@g.us", "transactional-message", false);
    const inserted = await repo.insert({
      origin: "gateway",
      kind: "message",
      eventKey,
      providerMessageId: "transactional-message",
      envelope: "{}",
    });
    await repo.claim("transaction-token");

    const captured = await db.transaction().execute(async (trx) => {
      const conversations = createConversationRepository(trx);
      const queue = createWhatsAppInboundEventsRepository(trx);
      const conversation = await conversations.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      const message = await conversations.captureOrGet({
        conversationId: conversation.id,
        providerMessageId: "transactional-message",
        eventKey,
        senderJid: "1555@s.whatsapp.net",
        senderName: "Alice",
      });
      expect(await queue.markCaptured(inserted.row.id, "transaction-token")).toBe(true);
      return message;
    });
    const replay = await createConversationRepository(db).captureOrGet({
      conversationId: captured.conversationId,
      providerMessageId: "transactional-message",
      eventKey,
      senderJid: "1555@lid",
      senderName: "Alice",
    });
    expect(replay.id).toBe(captured.id);
  });

  it("opens the history completion barrier only when every chunk is consumed or dead", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    await expect(repo.isBatchComplete("missing-batch")).resolves.toBe(true);
    const first = await repo.insert({
      origin: "gateway",
      kind: "history_batch",
      envelope: "{}",
      batchId: "batch-1",
      chunkIndex: 0,
      chunkCount: 2,
    });
    const second = await repo.insert({
      origin: "gateway",
      kind: "history_batch",
      envelope: "{}",
      batchId: "batch-1",
      chunkIndex: 1,
      chunkCount: 2,
    });
    await repo.claim("batch-token");
    await repo.markCaptured(first.row.id, "batch-token");
    await repo.markCaptured(second.row.id, "batch-token");

    await expect(repo.markConsumedAndCheckBatch(first.row.id, "batch-token")).resolves.toEqual({
      transitioned: true,
      batchComplete: false,
    });
    await repo.markDead(second.row.id, "batch-token", "x".repeat(2048));
    const deadError = await db
      .selectFrom("whatsapp_inbound_events")
      .select("last_error")
      .where("id", "=", second.row.id)
      .executeTakeFirstOrThrow();
    expect(deadError.last_error).toHaveLength(1024);
    await expect(repo.isBatchComplete("batch-1")).resolves.toBe(true);
  });

  it("sweeps only expired terminal rows in portable 500-row batches", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    for (const status of ["pending", "processing", "captured", "dispatched", "consumed", "dead"] as const) {
      const inserted = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
      await db
        .updateTable("whatsapp_inbound_events")
        .set({
          status,
          consumed_at: status === "consumed" ? "2000-01-01T00:00:00.000Z" : null,
          next_attempt_at: status === "dead" ? "2000-01-01T00:00:00.000Z" : sql`CURRENT_TIMESTAMP`,
        })
        .where("id", "=", inserted.row.id)
        .execute();
    }

    await expect(repo.sweep()).resolves.toEqual({ consumed: 1, dead: 1 });
    const statuses = await db.selectFrom("whatsapp_inbound_events").select("status").orderBy("id").execute();
    expect(statuses.map((row) => row.status)).toEqual(["pending", "processing", "captured", "dispatched"]);
  });

  it("retries SQLite contention with bounded attempts", async () => {
    let attempts = 0;
    let clock = 0;
    const result = await withBoundedSqliteRetry(
      db,
      async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        return "ok";
      },
      {
        now: () => clock,
        random: () => 0,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);

    let cappedAttempts = 0;
    let cappedClock = 0;
    await expect(
      withBoundedSqliteRetry(
        db,
        async () => {
          cappedAttempts += 1;
          throw Object.assign(new Error("still busy"), { code: "SQLITE_LOCKED" });
        },
        {
          maxAttempts: 99,
          now: () => cappedClock,
          random: () => 0,
          sleep: async (milliseconds) => {
            cappedClock += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("still busy");
    expect(cappedAttempts).toBe(5);

    let budgetAttempts = 0;
    let budgetClock = 0;
    await expect(
      withBoundedSqliteRetry(
        db,
        async () => {
          budgetAttempts += 1;
          throw Object.assign(new Error("budget busy"), { code: "SQLITE_BUSY" });
        },
        {
          budgetMs: 100,
          now: () => budgetClock,
          random: () => 0,
          sleep: async (milliseconds) => {
            budgetClock += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("budget busy");
    expect(budgetAttempts).toBe(2);
    expect(budgetClock).toBe(100);

    let nonContentionAttempts = 0;
    await expect(
      withBoundedSqliteRetry(db, async () => {
        nonContentionAttempts += 1;
        throw Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT" });
      }),
    ).rejects.toThrow("constraint");
    expect(nonContentionAttempts).toBe(1);
  });
});

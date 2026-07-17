import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createWhatsAppEventKey, createWhatsAppInboundEventsRepository } from "./whatsapp-inbound-events";

describe("WhatsApp inbound events repository on Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("deduplicates canonical keys and enforces claim, stale-reclaim, and token-conditional transitions", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const eventKey = createWhatsAppEventKey("group@g.us", "pg-message", false);
    const first = await repo.insert({
      origin: "gateway",
      kind: "message",
      eventKey,
      providerMessageId: "pg-message",
      envelope: "{}",
    });
    const duplicate = await repo.insert({
      origin: "gateway",
      kind: "history_message",
      eventKey,
      providerMessageId: "pg-message",
      envelope: "{}",
    });
    expect(duplicate).toEqual({ row: first.row, inserted: false });

    await expect(repo.claim("pg-token-1")).resolves.toHaveLength(1);
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ claimed_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", first.row.id)
      .execute();
    await expect(repo.claim("pg-token-2")).resolves.toHaveLength(1);
    await expect(repo.markCaptured(first.row.id, "pg-token-1")).resolves.toBe(false);
    await expect(repo.markCaptured(first.row.id, "pg-token-2")).resolves.toBe(true);
    await expect(repo.markDispatched(first.row.id, "pg-token-2")).resolves.toBe(true);
    await expect(repo.claim("pg-stale-sweep-token")).resolves.toEqual([]);
    await expect(repo.revertToCaptured(first.row.id, "pg-token-2", "shed")).resolves.toBe(true);
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ next_attempt_at: sql`CURRENT_TIMESTAMP` })
      .where("id", "=", first.row.id)
      .execute();
    await expect(repo.claim("pg-token-3")).resolves.toHaveLength(1);
    await expect(repo.markCaptured(first.row.id, "pg-token-3")).resolves.toBe(true);
    await expect(repo.markDispatched(first.row.id, "pg-token-3")).resolves.toBe(true);
    await expect(repo.consumeDispatched(first.row.id, "pg-token-3")).resolves.toBe(true);
    await expect(repo.revertToCaptured(first.row.id, "pg-token-3", "late shed")).resolves.toBe(false);
  });

  it("resets dispatched rows for boot recovery and reclaims them without stale sweeping", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    await repo.claim("pg-old-process-token");
    await repo.markCaptured(inserted.row.id, "pg-old-process-token");
    await repo.markDispatched(inserted.row.id, "pg-old-process-token");
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ claimed_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", inserted.row.id)
      .execute();

    await expect(repo.claim("pg-stale-token")).resolves.toEqual([]);
    await expect(repo.resetDispatched()).resolves.toBe(1);
    await expect(repo.claim("pg-new-process-token")).resolves.toMatchObject([
      { id: inserted.row.id, status: "processing", claim_token: "pg-new-process-token", attempts: 2 },
    ]);
    await expect(repo.markCaptured(inserted.row.id, "pg-new-process-token")).resolves.toBe(true);
    await expect(repo.markDispatched(inserted.row.id, "pg-new-process-token")).resolves.toBe(true);
  });

  it("dead-letters the sixth claim, treats dead chunks as terminal, and sweeps only expired terminal rows", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const first = await repo.insert({
      origin: "gateway",
      kind: "history_batch",
      batchId: "pg-batch",
      chunkIndex: 0,
      chunkCount: 2,
      envelope: "{}",
    });
    const second = await repo.insert({
      origin: "gateway",
      kind: "history_batch",
      batchId: "pg-batch",
      chunkIndex: 1,
      chunkCount: 2,
      envelope: "{}",
    });
    await repo.claim("pg-batch-token");
    await repo.markCaptured(first.row.id, "pg-batch-token");
    await repo.markCaptured(second.row.id, "pg-batch-token");
    await expect(repo.markConsumedAndCheckBatch(first.row.id, "pg-batch-token")).resolves.toEqual({
      transitioned: true,
      batchComplete: false,
    });
    await repo.markDead(second.row.id, "pg-batch-token", "gap");
    await expect(repo.isBatchComplete("pg-batch")).resolves.toBe(true);

    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "pending", attempts: 5, last_error: "fifth failure" })
      .where("id", "=", second.row.id)
      .execute();
    await repo.claim("pg-sixth-token");
    await expect(
      db.selectFrom("whatsapp_inbound_events").selectAll().where("id", "=", second.row.id).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "dead", attempts: 5, last_error: "fifth failure" });

    await db
      .updateTable("whatsapp_inbound_events")
      .set({ consumed_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", first.row.id)
      .execute();
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", second.row.id)
      .execute();
    const dispatched = await repo.insert({ origin: "gateway", kind: "message", envelope: "{}" });
    await db
      .updateTable("whatsapp_inbound_events")
      .set({ status: "dispatched", claimed_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", dispatched.row.id)
      .execute();
    await expect(repo.sweep()).resolves.toEqual({ consumed: 1, dead: 1 });
    await expect(
      db.selectFrom("whatsapp_inbound_events").select("status").where("id", "=", dispatched.row.id).executeTakeFirst(),
    ).resolves.toEqual({ status: "dispatched" });
  });
});

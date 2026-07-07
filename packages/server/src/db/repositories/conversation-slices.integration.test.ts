import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationSlicesRepository } from "./conversation-slices";
import { createConversationRepository } from "./conversations";

function runRepositorySuite(label: string, getDb: () => Promise<Kysely<DB>>, opts: { shared?: boolean } = {}) {
  describe(label, () => {
    let db!: Kysely<DB>;

    if (opts.shared) {
      beforeAll(async () => {
        db = await getDb();
      }, 30000);
    }

    beforeEach(async () => {
      if (opts.shared) {
        await sql`BEGIN`.execute(db);
      } else {
        db = await getDb();
      }
    }, 30000);

    afterEach(async () => {
      if (opts.shared) {
        await sql`ROLLBACK`.execute(db);
      } else {
        await db.destroy();
      }
    });

    it("inserts a conversation slice once per conversation and first message", async () => {
      const { conversationId, firstMessageId, lastMessageId } = await seedConversationWindow(db);
      const repo = createConversationSlicesRepository(db);

      const first = await repo.insertIfAbsent({
        conversationId,
        firstMessageId,
        lastMessageId,
        startedAt: "2026-07-07T09:00:00.000Z",
        endedAt: "2026-07-07T09:05:00.000Z",
        messageCount: 2,
        flushReason: "gap",
        rosterSnapshot: JSON.stringify([{ name: "Asha" }]),
      });
      const second = await repo.insertIfAbsent({
        conversationId,
        firstMessageId,
        lastMessageId,
        startedAt: "2026-07-07T09:00:00.000Z",
        endedAt: "2026-07-07T09:05:00.000Z",
        messageCount: 2,
        flushReason: "max_size",
        rosterSnapshot: JSON.stringify([{ name: "Changed" }]),
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      expect(second.row.flush_reason).toBe("gap");
      await expect(countRows(db, "conversation_slices")).resolves.toBe(1);
    });

    it("updates salience verdict only while it is pending", async () => {
      const { conversationId, firstMessageId, lastMessageId } = await seedConversationWindow(db);
      const repo = createConversationSlicesRepository(db);
      const { row } = await repo.insertIfAbsent({
        conversationId,
        firstMessageId,
        lastMessageId,
        startedAt: "2026-07-07T09:00:00.000Z",
        endedAt: "2026-07-07T09:05:00.000Z",
        messageCount: 2,
        flushReason: "max_age",
        rosterSnapshot: "[]",
      });

      const kept = await repo.updateSalienceVerdictIfPending(row.id, {
        verdict: "kept",
        signals: JSON.stringify({ decisions: 1 }),
      });
      const dropped = await repo.updateSalienceVerdictIfPending(row.id, {
        verdict: "dropped",
        signals: JSON.stringify({ banter: true }),
      });
      const stored = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();

      expect(kept?.salience_verdict).toBe("kept");
      expect(dropped).toBeUndefined();
      expect(stored.salience_verdict).toBe("kept");
      expect(stored.salience_signals).toBe(JSON.stringify({ decisions: 1 }));
    });

    it("gets and advances the composite slice cursor without regressing", async () => {
      const { conversationId } = await seedConversationWindow(db);
      const repo = createConversationSlicesRepository(db);

      await expect(repo.getCursor(conversationId)).resolves.toBeUndefined();

      const first = await repo.advanceCursor({
        conversationId,
        lastEffectiveAt: "2026-07-07T09:05:00.000Z",
        lastMessageId: 10,
      });
      const regressed = await repo.advanceCursor({
        conversationId,
        lastEffectiveAt: "2026-07-07T09:04:00.000Z",
        lastMessageId: 99,
      });
      const advanced = await repo.advanceCursor({
        conversationId,
        lastEffectiveAt: "2026-07-07T09:05:00.000Z",
        lastMessageId: 11,
      });

      expect(first.last_effective_at).toBe("2026-07-07T09:05:00.000Z");
      expect(regressed.last_message_id).toBe(10);
      expect(advanced.last_message_id).toBe(11);
    });

    it("upserts backfill checkpoint transitions by group", async () => {
      const repo = createConversationSlicesRepository(db);

      const first = await repo.setBackfillCheckpoint({
        groupJid: "123@g.us",
        lastFetchedKey: "key-1",
        status: "in_progress",
      });
      const complete = await repo.setBackfillCheckpoint({
        groupJid: "123@g.us",
        lastFetchedKey: "key-2",
        status: "complete",
      });

      expect(first.status).toBe("in_progress");
      expect(complete).toMatchObject({ group_jid: "123@g.us", last_fetched_key: "key-2", status: "complete" });
      await expect(countRows(db, "whatsapp_backfill_checkpoints")).resolves.toBe(1);
    });
  });
}

async function seedConversationWindow(db: Kysely<DB>) {
  const conversations = createConversationRepository(db);
  const groupJid = `${randomUUID()}@g.us`;
  const conversation = await conversations.getOrCreate({
    platform: "whatsapp",
    kind: "group",
    providerConversationId: groupJid,
  });
  const first = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${groupJid}:1`,
    senderJid: "15551234567@s.whatsapp.net",
    senderName: "Asha",
    text: "first",
    receivedAt: "2026-07-07T09:00:00.000Z",
  });
  const last = await conversations.insertMessage({
    conversationId: conversation.id,
    providerMessageId: `${groupJid}:2`,
    senderJid: "15557654321@s.whatsapp.net",
    senderName: "Rahul",
    text: "last",
    receivedAt: "2026-07-07T09:05:00.000Z",
  });
  return { conversationId: conversation.id, firstMessageId: first.row.id, lastMessageId: last.row.id };
}

async function countRows(db: Kysely<DB>, table: "conversation_slices" | "whatsapp_backfill_checkpoints") {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

runRepositorySuite("createConversationSlicesRepository sqlite", createTestDb);
runRepositorySuite("createConversationSlicesRepository postgres", getSharedPgDb, { shared: true });

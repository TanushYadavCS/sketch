import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConversationRepository } from "./conversations";

/**
 * The Postgres arm runs against the worker-shared PGlite instance with per-test
 * BEGIN/ROLLBACK isolation (`shared: true`) instead of booting a fresh ~1.3 GB
 * PGlite per test. The repository is data-only (no nested `.transaction()`), so
 * it satisfies getSharedPgDb's contract. The SQLite arm keeps the cheap
 * per-test template clone.
 */
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

    it("deduplicates provider messages by conversation, provider id, sender, and bot side", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });

      const first = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "hello",
        addressedToSketch: false,
      });
      const second = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "hello again",
        addressedToSketch: false,
      });
      const botSide = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-1",
        senderJid: "bot",
        senderName: "Sketch",
        text: "reply",
        isBot: true,
      });

      expect(first.inserted).toBe(true);
      expect(first.row.senderName).toBe("Alice");
      expect(first.row.providerMessageId).toBe("MSG-1");
      expect(first.row.addressedToSketch).toBe(false);
      expect(second.inserted).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      expect(botSide.inserted).toBe(true);
      expect(botSide.row.isBot).toBe(true);
      expect(botSide.row.id).not.toBe(first.row.id);
    });

    it("returns backlog by durable row bounds and excludes bot messages by default", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });

      const old = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "old",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "old",
      });
      const missed = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "missed",
        senderJid: "222@s.whatsapp.net",
        senderName: "Bob",
        text: "missed",
      });
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "bot",
        senderJid: "bot",
        senderName: "Sketch",
        text: "bot reply",
        isBot: true,
      });
      const trigger = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "trigger",
        senderJid: "333@s.whatsapp.net",
        senderName: "Carol",
        text: "@Sketch respond",
        addressedToSketch: true,
      });

      await repo.updateWatermark(conversation.id, old.row.id);
      const backlog = await repo.listBacklog({
        conversationId: conversation.id,
        afterMessageId: old.row.id,
        beforeMessageId: trigger.row.id,
      });

      expect(backlog.messages.map((m) => m.id)).toEqual([missed.row.id]);
      expect(backlog.hasMore).toBe(false);
    });

    it("pages history with limit plus one and optional bot inclusion", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "111@s.whatsapp.net",
      });

      const user1 = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "one",
      });
      const bot = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "b1",
        senderJid: "bot",
        senderName: "Sketch",
        text: "two",
        isBot: true,
      });
      const user2 = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u2",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "three",
      });

      const withoutBot = await repo.listMessages(conversation.id, { limit: 10 });
      const withBot = await repo.listMessages(conversation.id, { limit: 2, includeBotMessages: true });

      expect(withoutBot.messages.map((m) => m.id)).toEqual([user1.row.id, user2.row.id]);
      expect(withBot.messages.map((m) => m.id)).toEqual([user1.row.id, bot.row.id]);
      expect(withBot.hasMore).toBe(true);
      expect(withBot.nextCursor).toBe(bot.row.id);
    });

    it("advances the watermark to the current max message id", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "111@s.whatsapp.net",
      });
      const message = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "one",
      });

      const updated = await repo.advanceWatermarkToCurrentMax(conversation.id);

      expect(updated.last_seen_message_id).toBe(message.row.id);
    });

    it("filters backlog by Slack thread id and stores thread metadata", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });

      const threadA = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "2",
        senderJid: "S1",
        senderName: "Alice",
        text: "thread a",
        providerThreadId: "1",
        providerParentMessageId: "1",
        isThreadReply: true,
      });
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "3",
        senderJid: "S2",
        senderName: "Bob",
        text: "thread b",
        providerThreadId: "9",
        providerParentMessageId: "9",
        isThreadReply: true,
      });
      const trigger = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "4",
        senderJid: "S1",
        senderName: "Alice",
        text: "@Sketch help",
        addressedToSketch: true,
        providerThreadId: "1",
        providerParentMessageId: "1",
        isThreadReply: true,
      });

      const backlog = await repo.listBacklog({
        conversationId: conversation.id,
        beforeMessageId: trigger.row.id,
        providerThreadId: "1",
      });

      expect(backlog.messages.map((m) => m.id)).toEqual([threadA.row.id]);
      expect(backlog.messages[0].providerThreadId).toBe("1");
      expect(backlog.messages[0].providerParentMessageId).toBe("1");
      expect(backlog.messages[0].isThreadReply).toBe(true);
    });

    it("stores independent scoped cursors", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });

      await repo.updateCursor({
        conversationId: conversation.id,
        scopeType: "slack_thread",
        scopeKey: "1",
        messageId: 10,
      });
      await repo.updateCursor({
        conversationId: conversation.id,
        scopeType: "slack_thread",
        scopeKey: "2",
        messageId: 20,
      });

      const threadA = await repo.getCursor({
        conversationId: conversation.id,
        scopeType: "slack_thread",
        scopeKey: "1",
      });
      const threadB = await repo.getCursor({
        conversationId: conversation.id,
        scopeType: "slack_thread",
        scopeKey: "2",
      });

      expect(threadA?.last_seen_message_id).toBe(10);
      expect(threadB?.last_seen_message_id).toBe(20);
    });
  });
}

runRepositorySuite("createConversationRepository sqlite", createTestDb);
runRepositorySuite("createConversationRepository postgres", getSharedPgDb, { shared: true });

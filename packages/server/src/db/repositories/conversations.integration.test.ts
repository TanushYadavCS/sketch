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

    it("finds the latest non-bot inbound WhatsApp DM for a recipient", async () => {
      const repo = createConversationRepository(db);
      await db.insertInto("users").values({ id: "user-window", name: "Window User" }).execute();
      const dm = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "dm:+15551234567",
      });
      const group = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });

      await repo.insertMessage({
        conversationId: dm.id,
        providerMessageId: "user-match",
        senderJid: "legacy-sender",
        senderName: "Alice",
        senderUserId: "user-window",
        text: "user match",
        receivedAt: "2026-07-03T08:00:00.000Z",
      });
      await repo.insertMessage({
        conversationId: dm.id,
        providerMessageId: "phone-match",
        senderJid: "15551234567@s.whatsapp.net",
        senderName: "Alice",
        text: "phone match",
        receivedAt: "2026-07-03T09:00:00.000Z",
      });
      await repo.insertMessage({
        conversationId: dm.id,
        providerMessageId: "bot-latest",
        senderJid: "bot",
        senderName: "Sketch",
        isBot: true,
        text: "bot",
        receivedAt: "2026-07-03T10:00:00.000Z",
      });
      await repo.insertMessage({
        conversationId: group.id,
        providerMessageId: "group-latest",
        senderJid: "15551234567@s.whatsapp.net",
        senderName: "Alice",
        text: "group",
        receivedAt: "2026-07-03T11:00:00.000Z",
      });

      const withPhone = await repo.findLatestInboundWhatsAppDmFromRecipient({
        recipientUserId: "user-window",
        phoneE164: "+15551234567",
      });
      const byUserOnly = await repo.findLatestInboundWhatsAppDmFromRecipient({ recipientUserId: "user-window" });

      expect(withPhone?.providerMessageId).toBe("phone-match");
      expect(byUserOnly?.providerMessageId).toBe("user-match");
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

    it("deduplicates WhatsApp captures by event key across PN and LID sender forms", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      const eventKey = "canonical-event-key";
      const pn = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-EVENT",
        eventKey,
        senderJid: "15551234567@s.whatsapp.net",
        senderName: "Alice",
      });
      const lid = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-EVENT",
        eventKey,
        senderJid: "987654321@lid",
        senderName: "Alice",
      });

      expect(pn.inserted).toBe(true);
      expect(lid.inserted).toBe(false);
      expect(lid.row.id).toBe(pn.row.id);
      await expect(
        repo.captureOrGet({
          conversationId: conversation.id,
          providerMessageId: "MSG-EVENT",
          eventKey,
          senderJid: "another-sender@lid",
          senderName: "Alice",
        }),
      ).resolves.toMatchObject({ id: pn.row.id, eventKey });
      await expect(repo.findMessageByEventKey(eventKey)).resolves.toMatchObject({ id: pn.row.id, eventKey });
    });

    it("reconciles a legacy bot reply when fresh history replays it as from-me", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      const botReply = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "OUTBOUND-1",
        senderJid: "bot",
        senderName: "Sketch",
        text: "reply",
        isBot: true,
        source: "live",
      });

      const replay = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "OUTBOUND-1",
        eventKey: "outbound-event-key",
        senderJid: "",
        senderName: "Unknown",
        text: "reply",
        providerFromMe: true,
        source: "history",
        backfillRangeId: "initial-range",
      });

      expect(replay.inserted).toBe(false);
      expect(replay.row).toMatchObject({
        id: botReply.row.id,
        eventKey: "outbound-event-key",
        isBot: true,
        providerFromMe: true,
        source: "live",
        backfillRangeId: "initial-range",
      });
      await expect(
        db
          .selectFrom("conversation_messages")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("conversation_id", "=", conversation.id)
          .where("provider_message_id", "=", "OUTBOUND-1")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ count: 1 });
    });

    it("finds the latest message by provider message id within a conversation", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      const otherConversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "other-group@g.us",
      });
      await repo.insertMessage({
        conversationId: otherConversation.id,
        providerMessageId: "MSG-1",
        senderJid: "222@s.whatsapp.net",
        senderName: "Other",
        text: "wrong conversation",
      });
      const first = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "human side",
      });
      const botSide = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "MSG-1",
        senderJid: "bot",
        senderName: "Sketch",
        text: "bot side",
        isBot: true,
      });

      const found = await repo.findMessageByProviderMessageId(conversation.id, "MSG-1");
      const missing = await repo.findMessageByProviderMessageId(conversation.id, "missing");

      expect(found?.id).toBe(botSide.row.id);
      expect(found?.text).toBe("bot side");
      expect(found?.id).not.toBe(first.row.id);
      expect(missing).toBeUndefined();
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

    it.each([
      ["WhatsApp DM", "whatsapp", "dm", "dm:+15550000001"],
      ["WhatsApp group", "whatsapp", "group", "busy-group@g.us"],
      ["Slack DM", "slack", "dm", "D-busy"],
    ])("returns the newest backlog tail in chronological order for %s", async (_label, platform, kind, providerId) => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform,
        kind,
        providerConversationId: providerId,
      });
      const watermark = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "watermark",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "already seen",
      });
      const missedIds: number[] = [];
      for (let index = 1; index <= 17; index += 1) {
        const message = await repo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `missed-${index}`,
          senderJid: "222@s.whatsapp.net",
          senderName: "Bob",
          text: `missed ${index}`,
        });
        missedIds.push(message.row.id);
      }
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

      const backlog = await repo.listBacklog({
        conversationId: conversation.id,
        afterMessageId: watermark.row.id,
        beforeMessageId: trigger.row.id,
        limit: 10,
      });

      const expected = missedIds.slice(-10);
      expect(backlog.messages.map((message) => message.id)).toEqual(expected);
      expect(backlog.hasMore).toBe(true);
      expect(backlog.nextCursor).toBe(expected[0]);
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

    it("searches messages by text and sender name within the current conversation", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "group@g.us",
      });
      const otherConversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "group",
        providerConversationId: "other@g.us",
      });

      const match = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "We decided the launch budget is approved",
      });
      await repo.insertMessage({
        conversationId: otherConversation.id,
        providerMessageId: "u2",
        senderJid: "222@s.whatsapp.net",
        senderName: "Bob",
        text: "launch budget in a different group",
      });
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u3",
        senderJid: "333@s.whatsapp.net",
        senderName: "Carol",
        text: "unrelated notes",
      });

      const byText = await repo.searchMessages(conversation.id, { query: "launch budget" });
      const bySender = await repo.searchMessages(conversation.id, { query: "Alice" });

      expect(byText.messages.map((m) => m.id)).toContain(match.row.id);
      expect(byText.messages.every((m) => m.conversationId === conversation.id)).toBe(true);
      expect(bySender.messages.map((m) => m.id)).toContain(match.row.id);
      expect(byText.hasMore).toBe(false);
      expect(typeof byText.messages[0].rank).toBe("number");
    });

    it("searches with bot exclusion by default and optional bot inclusion", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });

      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u1",
        senderJid: "U1",
        senderName: "Alice",
        text: "deployment notes",
      });
      const bot = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "b1",
        senderJid: "bot",
        senderName: "Sketch",
        text: "deployment answer from Sketch",
        isBot: true,
      });

      const withoutBot = await repo.searchMessages(conversation.id, { query: "Sketch deployment" });
      const withBot = await repo.searchMessages(conversation.id, {
        query: "Sketch deployment",
        includeBotMessages: true,
      });

      expect(withoutBot.messages.map((m) => m.id)).not.toContain(bot.row.id);
      expect(withBot.messages.map((m) => m.id)).toContain(bot.row.id);
    });

    it("searches with row-id bounds and Slack current-thread filtering", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });

      const older = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1",
        senderJid: "U1",
        senderName: "Alice",
        text: "demo plan older",
        providerThreadId: "thread-a",
      });
      const currentThread = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "2",
        senderJid: "U2",
        senderName: "Bob",
        text: "demo plan current thread",
        providerThreadId: "thread-a",
        providerParentMessageId: "thread-a",
        isThreadReply: true,
      });
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "3",
        senderJid: "U3",
        senderName: "Carol",
        text: "demo plan other thread",
        providerThreadId: "thread-b",
      });

      const result = await repo.searchMessages(conversation.id, {
        query: "demo plan",
        afterMessageId: older.row.id,
        providerThreadId: "thread-a",
      });

      expect(result.messages.map((m) => m.id)).toEqual([currentThread.row.id]);
      expect(result.messages[0].providerThreadId).toBe("thread-a");
    });

    it("searches ambient top-level Slack channel messages with conversation scope", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });

      const topLevel = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1",
        senderJid: "U1",
        senderName: "Alice",
        text: "passive top-level roadmap note",
        providerThreadId: "1",
      });

      const result = await repo.searchMessages(conversation.id, { query: "roadmap" });

      expect(result.messages.map((m) => m.id)).toContain(topLevel.row.id);
      expect(result.messages[0].providerThreadId).toBe("1");
    });

    it("returns empty results for no matches and handles special query characters safely", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "111@s.whatsapp.net",
      });
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "u1",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        text: "planning notes café mañana 北京",
      });

      const noMatch = await repo.searchMessages(conversation.id, { query: "xyzzyquux" });
      const special = await repo.searchMessages(conversation.id, { query: "planning & notes (planning) -- notes:" });
      const safeQueries = ["planning OR", "planning AND", "NOT planning", "planning OR notes"];
      const unicodeQueries = ["café", "mañana", "北京"];

      expect(noMatch.messages).toHaveLength(0);
      expect(special.messages.length).toBeGreaterThan(0);
      for (const query of safeQueries) {
        await expect(repo.searchMessages(conversation.id, { query })).resolves.toBeDefined();
      }
      for (const query of unicodeQueries) {
        const result = await repo.searchMessages(conversation.id, { query });
        expect(result.messages.length).toBeGreaterThan(0);
      }
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

    it("merges legacy conversation rows into an existing canonical provider id", async () => {
      const repo = createConversationRepository(db);
      const legacy = await repo.getOrCreate({
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "wati-conversation-1",
      });
      const canonicalRef = {
        platform: "whatsapp",
        kind: "dm",
        providerConversationId: "dm:+1234567890",
      };
      const canonical = await repo.getOrCreate(canonicalRef);
      const legacyMessage = await repo.insertMessage({
        conversationId: legacy.id,
        providerMessageId: "legacy-1",
        eventKey: "legacy-event-key",
        senderJid: "1234567890",
        senderName: "Alice",
        text: "old context",
      });
      await repo.insertMessage({
        conversationId: legacy.id,
        providerMessageId: "duplicate",
        eventKey: "legacy-duplicate-event-key",
        senderJid: "1234567890",
        senderName: "Alice",
        text: "legacy duplicate",
      });
      const canonicalMessage = await repo.insertMessage({
        conversationId: canonical.id,
        providerMessageId: "canonical-1",
        senderJid: "1234567890",
        senderName: "Alice",
        text: "new context",
      });
      await repo.insertMessage({
        conversationId: canonical.id,
        providerMessageId: "duplicate",
        senderJid: "1234567890",
        senderName: "Alice",
        text: "canonical duplicate",
      });
      await repo.updateWatermark(legacy.id, legacyMessage.row.id);
      await repo.updateWatermark(canonical.id, canonicalMessage.row.id);
      await repo.updateCursor({
        conversationId: legacy.id,
        scopeType: "whatsapp_dm",
        scopeKey: "default",
        messageId: legacyMessage.row.id,
      });
      await repo.updateCursor({
        conversationId: canonical.id,
        scopeType: "whatsapp_dm",
        scopeKey: "default",
        messageId: canonicalMessage.row.id,
      });

      const claimed = await repo.claimProviderConversationId(legacy.id, canonicalRef, "Alice");

      expect(claimed.id).toBe(canonical.id);
      expect(claimed.provider_conversation_id).toBe("dm:+1234567890");
      expect(claimed.last_seen_message_id).toBe(legacyMessage.row.id);
      const legacyRow = await db.selectFrom("conversations").selectAll().where("id", "=", legacy.id).executeTakeFirst();
      expect(legacyRow).toBeUndefined();
      const messages = await repo.listMessages(canonical.id, { includeBotMessages: true });
      expect(messages.messages.map((message) => message.providerMessageId).sort()).toEqual([
        "canonical-1",
        "duplicate",
        "legacy-1",
      ]);
      expect(messages.messages.every((message) => message.conversationId === canonical.id)).toBe(true);
      expect(messages.messages.find((message) => message.providerMessageId === "legacy-1")?.eventKey).toBe(
        "legacy-event-key",
      );
      const cursor = await repo.getCursor({
        conversationId: canonical.id,
        scopeType: "whatsapp_dm",
        scopeKey: "default",
      });
      expect(cursor?.last_seen_message_id).toBe(legacyMessage.row.id);
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

    it("returns the newest top-level Slack backlog without replies from other threads", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-top-level",
      });
      const rootIds: number[] = [];
      for (let index = 1; index <= 17; index += 1) {
        const providerThreadId = `root-${index}`;
        const root = await repo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: providerThreadId,
          senderJid: "S1",
          senderName: "Alice",
          text: `root ${index}`,
          providerThreadId,
        });
        rootIds.push(root.row.id);
        await repo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `reply-${index}`,
          senderJid: "S2",
          senderName: "Bob",
          text: `reply ${index}`,
          providerThreadId,
          providerParentMessageId: providerThreadId,
          isThreadReply: true,
        });
      }
      const trigger = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "trigger",
        senderJid: "S1",
        senderName: "Alice",
        text: "@Sketch help",
        addressedToSketch: true,
        providerThreadId: "trigger",
      });

      const backlog = await repo.listBacklog({
        conversationId: conversation.id,
        beforeMessageId: trigger.row.id,
        limit: 10,
        isThreadReply: false,
      });

      const expected = rootIds.slice(-10);
      expect(backlog.messages.map((message) => message.id)).toEqual(expected);
      expect(backlog.messages.every((message) => !message.isThreadReply)).toBe(true);
      expect(backlog.hasMore).toBe(true);
      expect(backlog.nextCursor).toBe(expected[0]);
    });

    it("returns the newest backlog tail from the active Slack thread", async () => {
      const repo = createConversationRepository(db);
      const conversation = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-thread-tail",
      });
      const targetIds: number[] = [];
      for (let index = 1; index <= 17; index += 1) {
        const target = await repo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `target-${index}`,
          senderJid: "S1",
          senderName: "Alice",
          text: `target reply ${index}`,
          providerThreadId: "target-root",
          providerParentMessageId: "target-root",
          isThreadReply: true,
        });
        targetIds.push(target.row.id);
        await repo.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `other-${index}`,
          senderJid: "S2",
          senderName: "Bob",
          text: `other reply ${index}`,
          providerThreadId: "other-root",
          providerParentMessageId: "other-root",
          isThreadReply: true,
        });
      }
      const trigger = await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "thread-trigger",
        senderJid: "S1",
        senderName: "Alice",
        text: "@Sketch help",
        addressedToSketch: true,
        providerThreadId: "target-root",
        providerParentMessageId: "target-root",
        isThreadReply: true,
      });

      const backlog = await repo.listBacklog({
        conversationId: conversation.id,
        beforeMessageId: trigger.row.id,
        limit: 10,
        providerThreadId: "target-root",
      });

      const expected = targetIds.slice(-10);
      expect(backlog.messages.map((message) => message.id)).toEqual(expected);
      expect(backlog.messages.every((message) => message.providerThreadId === "target-root")).toBe(true);
      expect(backlog.hasMore).toBe(true);
      expect(backlog.nextCursor).toBe(expected[0]);
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

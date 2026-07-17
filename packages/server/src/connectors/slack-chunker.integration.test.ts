import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { SLACK_CHANNEL_STREAM_KEY, SLACK_ROUTER_STREAM_KEY, chunkSlackConversations } from "./slack-chunker";

const logger = pino({ level: "silent" });
const T0 = Date.parse("2026-07-10T09:00:00.000Z");

function iso(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;
    let conversationId!: number;
    let seq = 0;

    beforeEach(async () => {
      db = await createDb();
      seq = 0;
      const conversations = createConversationRepository(db);
      const row = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-chunker",
      });
      conversationId = row.id;
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    async function seed(minutes: number, overrides: { threadTs?: string; text?: string } = {}): Promise<number> {
      seq += 1;
      const repo = createConversationRepository(db);
      const stored = await repo.insertMessage({
        conversationId,
        providerMessageId: `${1000 + seq}.${seq}`,
        senderJid: "U0USER",
        senderName: "Priya",
        text: overrides.text ?? `message ${seq}`,
        providerThreadId: overrides.threadTs ?? `${1000 + seq}.${seq}`,
        providerParentMessageId: overrides.threadTs ?? null,
        isThreadReply: Boolean(overrides.threadTs),
        providerTimestamp: iso(minutes),
        receivedAt: iso(minutes),
      });
      return stored.row.id;
    }

    it("slices channel and thread streams independently and re-runs are idempotent", async () => {
      const rootTs = "999.9";
      await db
        .insertInto("conversation_messages")
        .values({
          conversation_id: conversationId,
          provider_message_id: rootTs,
          sender_jid: "U0USER",
          sender_name: "Priya",
          text: "root message",
          provider_thread_id: rootTs,
          is_thread_reply: 0,
          provider_timestamp: iso(0),
          received_at: iso(0),
        })
        .execute();
      await seed(5);
      for (let reply = 0; reply < 3; reply += 1) {
        await seed(10 + reply, { threadTs: rootTs });
      }

      const now = new Date(T0 + (12 + 8 * 60 + 1) * 60_000);
      const first = await chunkSlackConversations({ db, logger, now });
      expect(first.slicesCreated).toBe(2);

      const slices = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .orderBy("first_message_id", "asc")
        .execute();
      expect(slices).toHaveLength(2);
      const channelSlice = slices.find((slice) => slice.provider_thread_id === null);
      const threadSlice = slices.find((slice) => slice.provider_thread_id === rootTs);
      expect(channelSlice?.message_count).toBe(2);
      expect(threadSlice?.message_count).toBe(3);
      expect(JSON.parse(channelSlice?.denoised_message_ids ?? "[]")).toHaveLength(2);

      const second = await chunkSlackConversations({ db, logger, now });
      expect(second.slicesCreated).toBe(0);
      const after = await db
        .selectFrom("conversation_slices")
        .select(({ fn }) => [fn.countAll().as("count")])
        .where("conversation_id", "=", conversationId)
        .executeTakeFirstOrThrow();
      expect(Number(after.count)).toBe(2);
    });

    it("handles a thread created days after its root without touching the closed channel slice", async () => {
      await seed(0, { text: "root that will get a late thread" });
      const rootProviderTs = `${1000 + seq}.${seq}`;
      await seed(3);

      const firstRun = await chunkSlackConversations({ db, logger, now: new Date(T0 + 60 * 60_000) });
      expect(firstRun.slicesCreated).toBe(1);
      const channelSlice = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .executeTakeFirstOrThrow();

      const threeDays = 3 * 24 * 60;
      await seed(threeDays, { threadTs: rootProviderTs });
      await seed(threeDays + 2, { threadTs: rootProviderTs });

      const secondRun = await chunkSlackConversations({
        db,
        logger,
        now: new Date(T0 + (threeDays + 2 + 8 * 60 + 1) * 60_000),
      });
      expect(secondRun.slicesCreated).toBe(1);

      const slices = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .orderBy("first_message_id", "asc")
        .execute();
      expect(slices).toHaveLength(2);
      expect(slices[0]?.id).toBe(channelSlice.id);
      expect(slices[0]?.last_message_id).toBe(channelSlice.last_message_id);
      const threadSlice = slices[1];
      expect(threadSlice?.provider_thread_id).toBe(rootProviderTs);
      expect(Date.parse(threadSlice?.started_at ?? "")).toBeGreaterThanOrEqual(T0 + threeDays * 60_000);
    });

    it("a busy open thread does not stall the channel stream", async () => {
      await seed(0, { text: "root" });
      const rootProviderTs = `${1000 + seq}.${seq}`;
      await seed(2);
      const nowMinutes = 500;
      for (let reply = 0; reply < 4; reply += 1) {
        await seed(nowMinutes - 30 + reply * 10, { threadTs: rootProviderTs });
      }

      const run = await chunkSlackConversations({ db, logger, now: new Date(T0 + nowMinutes * 60_000) });
      expect(run.slicesCreated).toBe(1);

      const slices = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .execute();
      expect(slices).toHaveLength(1);
      expect(slices[0]?.provider_thread_id).toBeNull();

      const cursors = await createConversationSlicesRepository(db).listStreamCursors(conversationId);
      const channelCursor = cursors.find((cursor) => cursor.stream_key === SLACK_CHANNEL_STREAM_KEY);
      const threadCursor = cursors.find((cursor) => cursor.stream_key === rootProviderTs);
      const router = cursors.find((cursor) => cursor.stream_key === SLACK_ROUTER_STREAM_KEY);
      expect(channelCursor?.last_message_id).not.toBeNull();
      expect(threadCursor?.last_message_id).toBeNull();
      expect(router?.last_message_id).not.toBeNull();
      expect(channelCursor?.claim_token).toBeNull();
    });

    it("skips DM conversations entirely", async () => {
      const conversations = createConversationRepository(db);
      const dm = await conversations.getOrCreate({
        platform: "slack",
        kind: "dm",
        providerConversationId: "D-user",
      });
      await createConversationRepository(db).insertMessage({
        conversationId: dm.id,
        providerMessageId: "2000.1",
        senderJid: "U0USER",
        senderName: "Dev",
        text: "dm message",
        providerTimestamp: iso(0),
        receivedAt: iso(0),
      });

      await chunkSlackConversations({ db, logger, now: new Date(T0 + 600 * 60_000) });
      const dmSlices = await db
        .selectFrom("conversation_slices")
        .select(({ fn }) => [fn.countAll().as("count")])
        .where("conversation_id", "=", dm.id)
        .executeTakeFirstOrThrow();
      expect(Number(dmSlices.count)).toBe(0);
    });
  });
}

runSuite("Slack chunker SQLite", createTestDb);
runSuite("Slack chunker Postgres", createTestPgDb);

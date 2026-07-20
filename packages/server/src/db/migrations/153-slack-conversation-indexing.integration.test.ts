import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createConversationSlicesRepository } from "../repositories/conversation-slices";
import { createConversationRepository } from "../repositories/conversations";
import type { DB } from "../schema";
import * as migration from "./153-slack-conversation-indexing";

async function seedConversation(db: Kysely<DB>): Promise<number> {
  const conversations = createConversationRepository(db);
  const row = await conversations.getOrCreate({
    platform: "slack",
    kind: "channel",
    providerConversationId: "C-migration-150",
  });
  return row.id;
}

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("round-trips provider_thread_id on slices (null for channel-stream, set for thread)", async () => {
      const conversationId = await seedConversation(db);
      const slices = createConversationSlicesRepository(db);

      const channelSlice = await slices.insertIfAbsent({
        conversationId,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T00:05:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
      expect(channelSlice.row.provider_thread_id).toBeNull();

      const threadSlice = await slices.insertIfAbsent({
        conversationId,
        firstMessageId: 3,
        lastMessageId: 4,
        startedAt: "2026-07-17T01:00:00.000Z",
        endedAt: "2026-07-17T01:05:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [3, 4],
        flushReason: "gap",
        rosterSnapshot: "[]",
        providerThreadId: "1721001.500",
      });
      expect(threadSlice.row.provider_thread_id).toBe("1721001.500");
    });

    it("enforces one stream cursor per (conversation, stream_key) and supports claim lifecycle", async () => {
      const conversationId = await seedConversation(db);
      const slices = createConversationSlicesRepository(db);

      await slices.ensureStreamCursorsAndAdvanceRouter({
        conversationId,
        routerStreamKey: "::router",
        streamKeys: ["channel", "1721001.500"],
        routerHighWaterMessageId: 42,
      });
      await slices.ensureStreamCursorsAndAdvanceRouter({
        conversationId,
        routerStreamKey: "::router",
        streamKeys: ["channel"],
        routerHighWaterMessageId: 40,
      });

      const cursors = await slices.listStreamCursors(conversationId);
      expect(cursors).toHaveLength(3);
      const router = cursors.find((cursor) => cursor.stream_key === "::router");
      expect(router?.last_message_id).toBe(42);

      const claim = {
        conversationId,
        streamKey: "channel",
        claimToken: "token-a",
        now: "2026-07-17T02:00:00.000Z",
        staleBefore: "2026-07-17T01:00:00.000Z",
      };
      await expect(slices.claimStreamCursorIfPending(claim)).resolves.toBe(true);
      await expect(slices.claimStreamCursorIfPending({ ...claim, claimToken: "token-b" })).resolves.toBe(false);

      const advanced = await slices.advanceStreamCursorIfClaimed({
        conversationId,
        streamKey: "channel",
        lastMessageId: 10,
        claimToken: "token-a",
      });
      expect(advanced?.last_message_id).toBe(10);
      await expect(
        slices.advanceStreamCursorIfClaimed({
          conversationId,
          streamKey: "channel",
          lastMessageId: 5,
          claimToken: "token-a",
        }),
      ).resolves.toBeUndefined();

      await expect(
        slices.releaseStreamCursorClaim({ conversationId, streamKey: "channel", claimToken: "token-a" }),
      ).resolves.toBe(true);
      await expect(slices.claimStreamCursorIfPending({ ...claim, claimToken: "token-b" })).resolves.toBe(true);
    });

    it("down-migration drops the stream cursor table and thread column", async () => {
      await migration.down(db as unknown as Kysely<unknown>);
      const tables = await db.introspection.getTables();
      const names = tables.map((table) => table.name);
      expect(names).not.toContain("conversation_slice_stream_cursors");
      const sliceTable = tables.find((table) => table.name === "conversation_slices");
      expect(sliceTable?.columns.map((column) => column.name)).not.toContain("provider_thread_id");
      await migration.up(db as unknown as Kysely<unknown>);
    });
  });
}

runMigrationSuite("150 Slack conversation indexing migration SQLite", createTestDb);
runMigrationSuite("150 Slack conversation indexing migration Postgres", createTestPgDb);

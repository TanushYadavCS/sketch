import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessPrincipalInput } from "../../connectors/types";
import { createConnectorRepository } from "../../db/repositories/connectors";
import { createConversationSlicesRepository } from "../../db/repositories/conversation-slices";
import { createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { SLACK_CHANNEL_HISTORY_DENIED_TEXT, handleSlackChannelHistory } from "./slack-channel-history";
import type { SketchMcpDeps } from "./types";

function depsFor(db: Kysely<DB>, principals: AccessPrincipalInput[]): SketchMcpDeps {
  return { db, publicMcp: { userPrincipals: principals } } as unknown as SketchMcpDeps;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;
    let conversationId!: number;
    let sliceId!: string;
    const rootTs = "3000.1";

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("users")
        .values({ id: "user-admin", name: "Roopak", email: "roopak@example.com", role: "admin" })
        .execute();

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      conversationId = conversation.id;

      await conversations.insertMessage({
        conversationId,
        providerMessageId: rootTs,
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "root message",
        providerThreadId: rootTs,
        isThreadReply: false,
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const reply = await conversations.insertMessage({
        conversationId,
        providerMessageId: "3000.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "reply mentioning <@U0TEAM>",
        providerThreadId: rootTs,
        providerParentMessageId: rootTs,
        isThreadReply: true,
        providerTimestamp: "2026-07-17T09:05:00.000Z",
        receivedAt: "2026-07-17T09:05:00.000Z",
      });

      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId,
        firstMessageId: reply.row.id,
        lastMessageId: reply.row.id,
        startedAt: "2026-07-17T09:05:00.000Z",
        endedAt: "2026-07-17T09:05:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [reply.row.id],
        flushReason: "gap",
        rosterSnapshot: JSON.stringify({
          channelId: "C1",
          channelName: "general",
          participants: [
            { slackUserId: "U0TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
          ],
        }),
        salienceVerdict: "kept",
        providerThreadId: rootTs,
      });
      sliceId = slice.row.id;

      const connectorRepo = createConnectorRepository(db);
      const config = await connectorRepo.createConfig({
        connectorType: "slack",
        authType: "system",
        credentials: JSON.stringify({ type: "system" }),
        createdBy: "user-admin",
      });
      const scopeId = await connectorRepo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        members: ["roopak@example.com"],
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-1",
          connector_config_id: config.id,
          provider_file_id: sliceId,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: scopeId,
          synced_at: "2026-07-17T09:10:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-1" })
        .where("id", "=", sliceId)
        .execute();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("returns the thread's raw messages including the root, with mentions resolved", async () => {
      const result = await handleSlackChannelHistory({ sliceId }, depsFor(db, ["roopak@example.com"]));
      const payload = JSON.parse(resultText(result));
      expect(payload.anchor.sliceId).toBe(sliceId);
      expect(payload.anchor.threadTs).toBe(rootTs);
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0].text).toBe("root message");
      expect(payload.messages[1].text).toBe("reply mentioning @Roopak");
      expect(payload.messages[1].sender).toBe("Roopak");
    });

    it("includes messages whose delivery lagged days behind their Slack timestamp", async () => {
      await createConversationRepository(db).insertMessage({
        conversationId,
        providerMessageId: "3000.3",
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "lagged delivery",
        providerThreadId: rootTs,
        providerParentMessageId: rootTs,
        isThreadReply: true,
        providerTimestamp: "2026-07-17T09:06:00.000Z",
        receivedAt: "2026-07-19T12:00:00.000Z",
      });

      const result = await handleSlackChannelHistory({ sliceId }, depsFor(db, ["roopak@example.com"]));
      const payload = JSON.parse(resultText(result));
      expect(payload.messages.map((message: { text: string }) => message.text)).toEqual([
        "root message",
        "reply mentioning @Roopak",
        "lagged delivery",
      ]);
    });

    it("denies a caller whose email is not in the channel scope", async () => {
      const result = await handleSlackChannelHistory({ sliceId }, depsFor(db, ["outsider@example.com"]));
      expect(resultText(result)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("does not let a per-file Slack grant bypass current channel membership", async () => {
      await db
        .insertInto("file_access")
        .values({ indexed_file_id: "file-1", principal_type: "email", principal_value: "departed@example.com" })
        .execute();

      const result = await handleSlackChannelHistory({ sliceId }, depsFor(db, ["departed@example.com"]));
      expect(resultText(result)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("denies when no caller emails resolve", async () => {
      const result = await handleSlackChannelHistory({ sliceId }, depsFor(db, []));
      expect(resultText(result)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("authorizes a Slack user whose account has no email", async () => {
      await db.updateTable("users").set({ email: null }).where("id", "=", "user-admin").execute();
      const scopeId = (
        await db
          .selectFrom("indexed_files")
          .select("access_scope_id")
          .where("id", "=", "file-1")
          .executeTakeFirstOrThrow()
      ).access_scope_id as string;
      await db.deleteFrom("access_scope_members").where("access_scope_id", "=", scopeId).execute();
      await db
        .insertInto("access_scope_members")
        .values({ access_scope_id: scopeId, principal_type: "slack_user", principal_value: "U0TEAM" })
        .execute();

      const result = await handleSlackChannelHistory(
        { sliceId },
        depsFor(db, [{ type: "slack_user", value: "U0TEAM" }]),
      );
      expect(resultText(result)).not.toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("denies a guessed slice id and an unlinked (archived) slice", async () => {
      const guessed = await handleSlackChannelHistory(
        { sliceId: "not-a-real-slice" },
        depsFor(db, ["roopak@example.com"]),
      );
      expect(resultText(guessed)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);

      await db.updateTable("indexed_files").set({ is_archived: 1 }).where("id", "=", "file-1").execute();
      const archived = await handleSlackChannelHistory({ sliceId }, depsFor(db, ["roopak@example.com"]));
      expect(resultText(archived)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("denies a window request against a channel with no authorized kept slices", async () => {
      const other = await createConversationRepository(db).getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-OTHER",
      });
      const result = await handleSlackChannelHistory(
        {
          channelRef: `conversation:${other.id}`,
          startedAt: "2026-07-17T09:00:00.000Z",
          endedAt: "2026-07-17T10:00:00.000Z",
        },
        depsFor(db, ["roopak@example.com"]),
      );
      expect(resultText(result)).toBe(SLACK_CHANNEL_HISTORY_DENIED_TEXT);
    });

    it("includes a late thread's root even when it predates the reply window by days", async () => {
      const conversations = createConversationRepository(db);
      const lateRootTs = "2000.1";
      await conversations.insertMessage({
        conversationId,
        providerMessageId: lateRootTs,
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "ancient root",
        providerThreadId: lateRootTs,
        isThreadReply: false,
        providerTimestamp: "2026-07-10T09:00:00.000Z",
        receivedAt: "2026-07-10T09:00:00.000Z",
      });
      const lateReply = await conversations.insertMessage({
        conversationId,
        providerMessageId: "2000.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "reply three days later",
        providerThreadId: lateRootTs,
        providerParentMessageId: lateRootTs,
        isThreadReply: true,
        providerTimestamp: "2026-07-13T09:00:00.000Z",
        receivedAt: "2026-07-13T09:00:00.000Z",
      });
      const lateSlice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId,
        firstMessageId: lateReply.row.id,
        lastMessageId: lateReply.row.id,
        startedAt: "2026-07-13T09:00:00.000Z",
        endedAt: "2026-07-13T09:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [lateReply.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
        providerThreadId: lateRootTs,
      });
      const connectorRepo = createConnectorRepository(db);
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const scopeId = await connectorRepo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        members: ["roopak@example.com"],
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-late",
          connector_config_id: config.id,
          provider_file_id: lateSlice.row.id,
          file_name: "Slack: #general late thread",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: scopeId,
          synced_at: "2026-07-13T10:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-late" })
        .where("id", "=", lateSlice.row.id)
        .execute();

      const result = await handleSlackChannelHistory(
        { sliceId: lateSlice.row.id },
        depsFor(db, ["roopak@example.com"]),
      );
      const payload = JSON.parse(resultText(result));
      expect(payload.messages[0].text).toBe("ancient root");
      expect(payload.messages[1].text).toBe("reply three days later");
    });

    it("window form reads the top-level flow even when a thread slice anchors authorization", async () => {
      const result = await handleSlackChannelHistory(
        {
          channelRef: `conversation:${conversationId}`,
          startedAt: "2026-07-17T09:00:00.000Z",
          endedAt: "2026-07-17T09:30:00.000Z",
        },
        depsFor(db, ["roopak@example.com"]),
      );
      const payload = JSON.parse(resultText(result));
      expect(payload.messages.map((message: { text: string }) => message.text)).toEqual(["root message"]);
    });

    it("rejects malformed input and cross-window page tokens", async () => {
      const missing = await handleSlackChannelHistory({}, depsFor(db, ["roopak@example.com"]));
      expect(resultText(missing)).toContain("Provide either");

      const forged = Buffer.from(
        JSON.stringify({
          conversationId: conversationId + 1,
          windowStart: "2026-07-17T08:35:00.000Z",
          windowEnd: "2026-07-17T09:35:00.000Z",
          receivedAt: "2026-07-17T09:00:00.000Z",
          messageId: 1,
        }),
        "utf8",
      ).toString("base64url");
      const result = await handleSlackChannelHistory(
        { sliceId, pageToken: forged },
        depsFor(db, ["roopak@example.com"]),
      );
      expect(resultText(result)).toBe("Invalid pageToken.");
    });
  });
}

runSuite("SlackChannelHistory SQLite", createTestDb);
runSuite("SlackChannelHistory Postgres", createTestPgDb);

import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import { createTestDb, createTestPgDb } from "../test-utils";
import { ensureSlackConnectorConfig } from "./slack-provisioning";
import {
  archiveAllSlackChannelFiles,
  emitSlackSyncedItems,
  processSlackSalience,
  reconcileSlackChannelAcls,
} from "./slack-salience";

const logger = pino({ level: "silent" });

function fakeFacade(overrides: Partial<SlackIndexingFacade> = {}): SlackIndexingFacade {
  return {
    isConfigured: async () => true,
    listMemberChannels: async () => [{ id: "C1", name: "general" }],
    listChannelMembers: async () => ["U0TEAM"],
    getUserInfo: async () => ({ name: "priya", realName: "Priya", email: "priya@example.com", isBot: false }),
    ...overrides,
  };
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("users")
        .values({
          id: "user-admin",
          name: "Roopak",
          email: "roopak@example.com",
          auth_role: "admin",
          slack_user_id: "U0TEAM",
        })
        .execute();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("ensures exactly one slack connector config across repeated calls", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      await Promise.all([ensureSlackConnectorConfig({ db, logger }), ensureSlackConnectorConfig({ db, logger })]);

      const rows = await db
        .selectFrom("connector_configs")
        .select(["id", "auth_type", "sync_status", "created_by"])
        .where("connector_type", "=", "slack")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.auth_type).toBe("system");
      expect(rows[0]?.sync_status).toBe("pending");
      expect(rows[0]?.created_by).toBe("user-admin");
    });

    it("skips provisioning until an admin user exists", async () => {
      await db.updateTable("users").set({ auth_role: "member" }).where("id", "=", "user-admin").execute();
      await ensureSlackConnectorConfig({ db, logger });
      const rows = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .execute();
      expect(rows).toHaveLength(0);

      await db.updateTable("users").set({ auth_role: "admin" }).where("id", "=", "user-admin").execute();
      await ensureSlackConnectorConfig({ db, logger });
      const after = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .execute();
      expect(after).toHaveLength(1);
    });

    it("the provisioned config is discoverable by the sync scheduler", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const configs = await createConnectorRepository(db).findSyncableConfigs({ staleAfterMs: 60_000 });
      expect(configs.some((config) => config.connector_type === "slack")).toBe(true);
    });

    it("salience fails closed on a slice without explicit membership", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 5,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T01:00:00.000Z",
        messageCount: 3,
        denoisedMessageIds: null,
        flushReason: "gap",
        rosterSnapshot: "[]",
      });

      const generator = {
        generateJSON: async () => ({ salient: true, signals: [], entities: [] }),
      } as unknown as Parameters<typeof processSlackSalience>[0]["generator"];

      const summary = await processSlackSalience({ db, logger, facade: fakeFacade(), generator });
      expect(summary.failures).toBe(1);
      expect(summary.judged).toBe(0);

      const slice = await db
        .selectFrom("conversation_slices")
        .select(["salience_verdict", "salience_claim_token", "salience_claimed_at"])
        .where("conversation_id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(slice.salience_verdict).toBeNull();
      expect(slice.salience_claim_token).not.toBeNull();
      expect(slice.salience_claimed_at).not.toBeNull();
    });

    it("dead-letters slices from channels the bot can no longer access", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C_GONE",
      });
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });

      const facade = fakeFacade({
        listChannelMembers: async () => {
          throw Object.assign(new Error("An API error occurred: channel_not_found"), {
            data: { error: "channel_not_found" },
          });
        },
      });
      const generator = {
        generateJSON: async () => {
          throw new Error("generator must not be called for an inaccessible channel");
        },
      } as unknown as Parameters<typeof processSlackSalience>[0]["generator"];

      const summary = await processSlackSalience({ db, logger, facade, generator });
      expect(summary.dropped).toBe(1);
      expect(summary.failures).toBe(0);

      const slice = await db
        .selectFrom("conversation_slices")
        .select(["salience_verdict", "salience_signals"])
        .where("conversation_id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(slice.salience_verdict).toBe("dropped");
      expect(slice.salience_signals).toContain("channel_inaccessible");
    });

    it("failed slices back off and stop monopolizing the salience batch", async () => {
      const conversations = createConversationRepository(db);
      const failing = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C_FAILING",
      });
      const healthy = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C_HEALTHY",
      });
      const slices = createConversationSlicesRepository(db);
      await slices.insertIfAbsent({
        conversationId: failing.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
      await slices.insertIfAbsent({
        conversationId: healthy.id,
        firstMessageId: 3,
        lastMessageId: 4,
        startedAt: "2026-07-17T02:00:00.000Z",
        endedAt: "2026-07-17T03:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [3, 4],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
      await db
        .insertInto("conversation_messages")
        .values(
          [3, 4].map((id) => ({
            id,
            conversation_id: healthy.id,
            provider_message_id: `msg-${id}`,
            sender_jid: "U0TEAM",
            sender_name: "Roopak",
            is_bot: 0,
            addressed_to_sketch: 0,
            text: `message ${id}`,
            received_at: "2026-07-17T02:30:00.000Z",
            provider_timestamp: "2026-07-17T02:30:00.000Z",
          })),
        )
        .execute();

      const facade = fakeFacade({
        listChannelMembers: async (channelId: string) => {
          if (channelId === "C_FAILING") throw new Error("transient Slack outage");
          return ["U0TEAM"];
        },
      });
      const generator = {
        generateJSON: async () => ({ salient: true, signals: ["decision"], entities: [] }),
      } as unknown as Parameters<typeof processSlackSalience>[0]["generator"];

      const first = await processSlackSalience({ db, logger, facade, generator, batchLimit: 1 });
      expect(first.failures).toBe(1);
      expect(first.judged).toBe(0);

      const second = await processSlackSalience({ db, logger, facade, generator, batchLimit: 1 });
      expect(second.judged).toBe(1);
      expect(second.kept).toBe(1);

      const verdicts = await db
        .selectFrom("conversation_slices")
        .select(["conversation_id", "salience_verdict"])
        .orderBy("conversation_id")
        .execute();
      expect(verdicts.find((v) => v.conversation_id === failing.id)?.salience_verdict).toBeNull();
      expect(verdicts.find((v) => v.conversation_id === healthy.id)?.salience_verdict).toBe("kept");
    });

    it("rename refresh unlinks kept slices so they re-emit under the new channel name", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_RENAMED" },
        "old-name",
      );
      const slices = createConversationSlicesRepository(db);
      const inserted = await slices.insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
      await db
        .insertInto("connector_configs")
        .values({
          id: "slack-config-rename",
          connector_type: "slack",
          auth_type: "system",
          credentials: "{}",
          created_by: "user-admin",
        })
        .execute();
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-old-name",
          connector_config_id: "slack-config-rename",
          provider_file_id: "slack://slice/rename-test",
          file_name: "Slack: #old-name",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          content_hash: "hash-rename",
          is_archived: 0,
          synced_at: new Date().toISOString(),
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ salience_verdict: "kept", indexed_file_id: "file-old-name" })
        .where("id", "=", inserted.row.id)
        .execute();

      const { refreshSlackChannelName } = await import("./slack-salience");
      const refreshed = await refreshSlackChannelName({
        db,
        logger,
        channelId: "C_RENAMED",
        channelName: "new-name",
      });
      expect(refreshed).toBe(true);

      const row = await db
        .selectFrom("conversations")
        .select("display_name")
        .where("id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(row.display_name).toBe("new-name");
      const slice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow();
      expect(slice.indexed_file_id).toBeNull();

      const unchanged = await refreshSlackChannelName({
        db,
        logger,
        channelId: "C_RENAMED",
        channelName: "new-name",
      });
      expect(unchanged).toBe(false);
    });

    it("migration 151 reclassifies mpdm-named channel conversations as mpim", async () => {
      const conversations = createConversationRepository(db);
      const mpim = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "G_LEGACY" },
        "mpdm-roopak--himanshu-1",
      );
      const channel = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_REAL" },
        "general",
      );

      const migration = await import("../db/migrations/151-reclassify-mpim-conversations");
      await migration.up(db as unknown as Kysely<unknown>);

      const kinds = await db
        .selectFrom("conversations")
        .select(["id", "kind"])
        .where("id", "in", [mpim.id, channel.id])
        .execute();
      expect(kinds.find((row) => row.id === mpim.id)?.kind).toBe("mpim");
      expect(kinds.find((row) => row.id === channel.id)?.kind).toBe("channel");
    });

    it("reactivates a disabled singleton so indexing survives owner removal", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const created = await db
        .selectFrom("connector_configs")
        .select(["id"])
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      await createConnectorRepository(db).archiveConnectorsForOwner("user-admin");

      await ensureSlackConnectorConfig({ db, logger });

      const row = await db
        .selectFrom("connector_configs")
        .select(["id", "sync_status", "created_by", "error_message"])
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      expect(row.id).toBe(created.id);
      expect(row.sync_status).toBe("pending");
      expect(row.created_by).toBe("user-admin");
      expect(row.error_message).toBeNull();
    });

    it("resolves the identity ladder: teammate, then CRM entity by email, then display name", async () => {
      await db
        .insertInto("entities")
        .values({
          id: "entity-1",
          name: "Asha Mehta",
          source_type: "crm",
          status: "active",
          hotness: 0,
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:00.000Z",
        })
        .execute();
      await db
        .insertInto("entity_contact_points")
        .values({
          id: "cp-1",
          entity_id: "entity-1",
          kind: "email",
          value: "asha@client.com",
          source: "crm",
        })
        .execute();

      const facade = fakeFacade({
        listChannelMembers: async () => ["U0TEAM", "U0CRM", "U0EXT"],
        getUserInfo: async (userId: string) =>
          userId === "U0CRM"
            ? { name: "asha", realName: "Asha M", email: "Asha@Client.com", isBot: false }
            : { name: "guest", realName: "Guest Person", email: null, isBot: false },
      });

      const { resolveSlackChannelRoster } = await import("../slack/identity-resolution");
      const roster = await resolveSlackChannelRoster({
        db,
        facade,
        channelId: "C1",
        channelName: "general",
        logger,
      });

      expect(roster.participants).toEqual([
        { slackUserId: "U0TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
        { slackUserId: "U0CRM", displayName: "Asha Mehta", kind: "entity", email: "Asha@Client.com" },
        { slackUserId: "U0EXT", displayName: "Guest Person", kind: "external", email: null },
      ]);
    });

    it("excludes bot members from the roster, including a bot with a stray users row", async () => {
      await db
        .insertInto("users")
        .values({
          id: "user-bot",
          name: "sketchdev",
          auth_role: "member",
          slack_user_id: "U0BOT",
        })
        .execute();

      const facade = fakeFacade({
        listChannelMembers: async () => ["U0TEAM", "U0BOT", "U0EXTBOT"],
        getUserInfo: async (userId: string) =>
          userId === "U0TEAM"
            ? { name: "roopak", realName: "Roopak", email: "roopak@example.com", isBot: false }
            : { name: "botsy", realName: "Botsy", email: null, isBot: true },
      });

      const { resolveSlackChannelRoster } = await import("../slack/identity-resolution");
      const roster = await resolveSlackChannelRoster({
        db,
        facade,
        channelId: "C1",
        channelName: "general",
        logger,
      });

      expect(roster.participants).toEqual([
        { slackUserId: "U0TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
      ]);
    });

    it("renders the thread root header and resolves mention tokens into the salience prompt", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const rootTs = "1700.1";
      await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: rootTs,
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "Kicking off the pricing thread",
        providerThreadId: rootTs,
        isThreadReply: false,
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const reply = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1700.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "Agreed <@U0TEAM>, let's finalize by Friday",
        providerThreadId: rootTs,
        providerParentMessageId: rootTs,
        isThreadReply: true,
        providerTimestamp: "2026-07-17T09:05:00.000Z",
        receivedAt: "2026-07-17T09:05:00.000Z",
      });

      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: reply.row.id,
        lastMessageId: reply.row.id,
        startedAt: "2026-07-17T09:05:00.000Z",
        endedAt: "2026-07-17T09:05:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [reply.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        providerThreadId: rootTs,
      });

      const prompts: string[] = [];
      const generator = {
        generateJSON: async (prompt: string) => {
          prompts.push(prompt);
          return { salient: false, signals: [], entities: [] };
        },
      } as unknown as Parameters<typeof processSlackSalience>[0]["generator"];

      const summary = await processSlackSalience({ db, logger, facade: fakeFacade(), generator });
      expect(summary.judged).toBe(1);
      expect(prompts[0]).toContain("Thread root by Guest: Kicking off the pricing thread");
      expect(prompts[0]).toContain("@Roopak, let's finalize by Friday");
      expect(prompts[0]).not.toContain("<@U0TEAM>");
    });

    it("emission with no teammate member archives the linked file and emits nothing", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1800.1",
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "external-only chatter",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-no-teammate",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          synced_at: "2026-07-17T10:05:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-no-teammate" })
        .where("id", "=", slice.row.id)
        .execute();

      const facade = fakeFacade({ listChannelMembers: async () => ["U0EXT"] });
      let skipped = 0;
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade,
        onSkippedNoScope: () => {
          skipped += 1;
        },
      })) {
        items.push(item);
      }

      expect(items).toHaveLength(0);
      expect(skipped).toBe(1);
      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived"])
        .where("id", "=", "file-no-teammate")
        .executeTakeFirstOrThrow();
      expect(file.is_archived).toBe(1);
      const unlinked = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(unlinked.indexed_file_id).toBeNull();
    });

    it("reconciles ACLs: refreshes visible-channel membership, archives invisible channels", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const repo = createConnectorRepository(db);

      const visibleScope = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        memberEmails: ["roopak@example.com", "departed@example.com"],
      });
      const goneScope = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C-GONE",
        label: "#gone",
        memberEmails: ["roopak@example.com"],
      });

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-GONE",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-gone",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #gone",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: goneScope,
          synced_at: "2026-07-01T02:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-gone" })
        .where("id", "=", slice.row.id)
        .execute();

      const summary = await reconcileSlackChannelAcls({
        db,
        logger,
        facade: fakeFacade(),
        connectorConfigId: config.id,
      });
      expect(summary.scopesRefreshed).toBe(1);
      expect(summary.scopesArchived).toBe(1);
      expect(summary.filesArchived).toBe(1);

      const members = await db
        .selectFrom("access_scope_members")
        .select("email")
        .where("access_scope_id", "=", visibleScope)
        .execute();
      expect(members.map((row) => row.email)).toEqual(["roopak@example.com"]);

      const goneFile = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", "file-gone")
        .executeTakeFirstOrThrow();
      expect(goneFile.is_archived).toBe(1);
      expect(goneFile.access_scope_id).toBeNull();

      const goneSlice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(goneSlice.indexed_file_id).toBeNull();
    });

    it("archives all channel files on disconnect so stale ACLs stop granting reads", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const repo = createConnectorRepository(db);
      const scopeId = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        memberEmails: ["roopak@example.com"],
      });

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-live",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: scopeId,
          synced_at: "2026-07-01T02:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-live" })
        .where("id", "=", slice.row.id)
        .execute();

      const archived = await archiveAllSlackChannelFiles({ db, logger, connectorConfigId: config.id });
      expect(archived).toBe(1);

      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", "file-live")
        .executeTakeFirstOrThrow();
      expect(file.is_archived).toBe(1);
      expect(file.access_scope_id).toBeNull();

      const clearedSlice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(clearedSlice.indexed_file_id).toBeNull();

      expect(await archiveAllSlackChannelFiles({ db, logger, connectorConfigId: config.id })).toBe(0);
    });
  });
}

runSuite("Slack indexing provisioning + ACL SQLite", createTestDb);
runSuite("Slack indexing provisioning + ACL Postgres", createTestPgDb);

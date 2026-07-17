import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationRepository } from "../db/repositories/conversations";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import { createTestDb, createTestPgDb } from "../test-utils";
import { ensureSlackConnectorConfig } from "./slack-provisioning";
import { processSlackSalience, reconcileSlackChannelAcls } from "./slack-salience";

const logger = pino({ level: "silent" });

function fakeFacade(overrides: Partial<SlackIndexingFacade> = {}): SlackIndexingFacade {
  return {
    listMemberChannels: async () => [{ id: "C1", name: "general" }],
    listChannelMembers: async () => ["U-TEAM"],
    getUserInfo: async () => ({ name: "priya", realName: "Priya", email: "priya@example.com" }),
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
          role: "admin",
          slack_user_id: "U-TEAM",
        })
        .execute();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("ensures exactly one slack connector config across repeated calls", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      await Promise.all([
        ensureSlackConnectorConfig({ db, logger }),
        ensureSlackConnectorConfig({ db, logger }),
      ]);

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

    it("skips provisioning when no users exist yet", async () => {
      await db.deleteFrom("users").where("id", "=", "user-admin").execute();
      await ensureSlackConnectorConfig({ db, logger });
      const rows = await db.selectFrom("connector_configs").select("id").where("connector_type", "=", "slack").execute();
      expect(rows).toHaveLength(0);
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
        .select(["salience_verdict", "salience_claim_token"])
        .where("conversation_id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(slice.salience_verdict).toBeNull();
      expect(slice.salience_claim_token).toBeNull();
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
        listChannelMembers: async () => ["U-TEAM", "U-CRM", "U-EXT"],
        getUserInfo: async (userId: string) =>
          userId === "U-CRM"
            ? { name: "asha", realName: "Asha M", email: "Asha@Client.com" }
            : { name: "guest", realName: "Guest Person", email: null },
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
        { slackUserId: "U-TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
        { slackUserId: "U-CRM", displayName: "Asha Mehta", kind: "entity", email: "Asha@Client.com" },
        { slackUserId: "U-EXT", displayName: "Guest Person", kind: "external", email: null },
      ]);
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
  });
}

runSuite("Slack indexing provisioning + ACL SQLite", createTestDb);
runSuite("Slack indexing provisioning + ACL Postgres", createTestPgDb);

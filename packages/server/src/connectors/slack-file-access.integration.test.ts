import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { backfillSlackFileAccess } from "./slack-salience";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("connector_configs")
        .values({
          id: "slack-config",
          connector_type: "slack",
          auth_type: "system",
          credentials: "{}",
          created_by: "admin",
        })
        .execute();
      await db
        .insertInto("connector_configs")
        .values({
          id: "other-config",
          connector_type: "google_drive",
          auth_type: "oauth",
          credentials: "{}",
          created_by: "admin",
        })
        .execute();
      await db
        .insertInto("access_scopes")
        .values({
          id: "slack-scope",
          connector_config_id: "slack-config",
          scope_type: "slack_channel",
          provider_scope_id: "C-HISTORY",
          label: "#history",
        })
        .execute();
      await db
        .insertInto("access_scope_members")
        .values([
          { access_scope_id: "slack-scope", email: "current@example.com" },
          { access_scope_id: "slack-scope", email: "new@example.com" },
        ])
        .execute();
      await db
        .insertInto("indexed_files")
        .values([
          {
            id: "slack-history",
            connector_config_id: "slack-config",
            provider_file_id: "slice-1",
            file_name: "Slack: #history",
            file_type: "slack_conversation_slice",
            content_category: "document",
            source: "slack",
            synced_at: "2026-08-05T10:00:00.000Z",
            access_scope_id: "slack-scope",
          },
          {
            id: "other-file",
            connector_config_id: "other-config",
            provider_file_id: "drive-1",
            file_name: "Drive file",
            file_type: "document",
            content_category: "document",
            source: "google_drive",
            synced_at: "2026-08-05T10:00:00.000Z",
            access_scope_id: "slack-scope",
          },
        ])
        .execute();
      await db
        .insertInto("file_access")
        .values({ indexed_file_id: "slack-history", email: "grandfathered@example.com" })
        .execute();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("backfills historical Slack grants into the real visibility path without revoking old grants", async () => {
      await expect(backfillSlackFileAccess({ db, grandfatheringEnabled: true })).resolves.toBe(2);

      const grants = await db
        .selectFrom("file_access")
        .select("email")
        .where("indexed_file_id", "=", "slack-history")
        .orderBy("email", "asc")
        .execute();
      expect(grants.map((row) => row.email)).toEqual([
        "current@example.com",
        "grandfathered@example.com",
        "new@example.com",
      ]);
      await expect(
        db.selectFrom("file_access").select("indexed_file_id").where("indexed_file_id", "=", "other-file").execute(),
      ).resolves.toHaveLength(0);

      const repo = createConnectorRepository(db);
      const visibleToDeparted = await repo.listAllFiles({
        limit: 20,
        offset: 0,
        connectorType: "slack",
        viewer: { email: "grandfathered@example.com", isAdmin: false },
      });
      expect(visibleToDeparted.map((row) => row.id)).toEqual(["slack-history"]);

      const visibleToNewMember = await repo.listAllFiles({
        limit: 20,
        offset: 0,
        connectorType: "slack",
        viewer: { email: "new@example.com", isAdmin: false },
      });
      expect(visibleToNewMember.map((row) => row.id)).toEqual(["slack-history"]);

      await expect(backfillSlackFileAccess({ db, grandfatheringEnabled: true })).resolves.toBe(0);
      await expect(db.selectFrom("slack_file_access_backfill").selectAll().execute()).resolves.toEqual([
        expect.objectContaining({ id: "default", completed_at: expect.any(String) }),
      ]);
    });

    it("does not create the marker or grants when grandfathering is disabled", async () => {
      await expect(backfillSlackFileAccess({ db, grandfatheringEnabled: false })).resolves.toBe(0);
      await expect(db.selectFrom("file_access").selectAll().execute()).resolves.toEqual([
        { indexed_file_id: "slack-history", email: "grandfathered@example.com" },
      ]);
      await expect(db.selectFrom("slack_file_access_backfill").selectAll().execute()).resolves.toHaveLength(0);
    });

    it("does not create grandfathered grants when entity sync is disabled", async () => {
      await expect(
        backfillSlackFileAccess({ db, grandfatheringEnabled: true, entitySyncEnabled: false }),
      ).resolves.toBe(0);
      await expect(db.selectFrom("slack_file_access_backfill").selectAll().execute()).resolves.toHaveLength(0);
      await expect(
        db.selectFrom("file_access").selectAll().where("indexed_file_id", "=", "slack-history").execute(),
      ).resolves.toEqual([{ indexed_file_id: "slack-history", email: "grandfathered@example.com" }]);
    });

    it("prefers the capture roster over current scope membership", async () => {
      const conversation = await createConversationRepository(db).getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C-HISTORY" },
        "history",
      );
      const message = await createConversationRepository(db).insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1.1",
        senderJid: "U-CAPTURED",
        senderName: "Captured",
        text: "captured",
        providerTimestamp: "2026-08-01T00:00:00.000Z",
        receivedAt: "2026-08-01T00:00:00.000Z",
      });
      await db
        .insertInto("conversation_slices")
        .values({
          id: "slice-1",
          conversation_id: conversation.id,
          first_message_id: message.row.id,
          last_message_id: message.row.id,
          started_at: "2026-08-01T00:00:00.000Z",
          ended_at: "2026-08-01T00:00:00.000Z",
          message_count: 1,
          denoised_message_ids: JSON.stringify([message.row.id]),
          flush_reason: "gap",
          roster_snapshot: JSON.stringify({
            channelId: "C-HISTORY",
            channelName: "history",
            participants: [
              {
                slackUserId: "U-CAPTURED",
                displayName: "Captured",
                kind: "teammate",
                email: "captured@example.com",
              },
            ],
          }),
          salience_verdict: "kept",
          salience_signals: null,
          salience_claim_token: null,
          salience_claimed_at: null,
          indexed_file_id: "slack-history",
          provider_thread_id: null,
        })
        .execute();

      await expect(backfillSlackFileAccess({ db, grandfatheringEnabled: true })).resolves.toBe(1);
      await expect(
        db
          .selectFrom("file_access")
          .select("email")
          .where("indexed_file_id", "=", "slack-history")
          .orderBy("email", "asc")
          .execute(),
      ).resolves.toEqual([{ email: "captured@example.com" }, { email: "grandfathered@example.com" }]);
    });
  });
}

runSuite("Slack historical file access SQLite", createTestDb);
runSuite("Slack historical file access Postgres", createTestPgDb);

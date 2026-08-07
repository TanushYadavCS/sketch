import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { filterAccessibleFileIds, getFileContent, searchFiles } from "./search";

const CURRENT_EMAIL = "current@example.com";
const DEPARTED_EMAIL = "departed@example.com";
const OUTSIDER_EMAIL = "outsider@example.com";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db.insertInto("users").values({ id: "admin", name: "Admin", email: "admin@example.com" }).execute();
      await db
        .insertInto("connector_configs")
        .values([
          {
            id: "chat-config",
            connector_type: "slack",
            auth_type: "system",
            credentials: "{}",
            created_by: "admin",
          },
          {
            id: "drive-config",
            connector_type: "google_drive",
            auth_type: "oauth",
            credentials: "{}",
            created_by: "admin",
          },
        ])
        .execute();
      await db
        .insertInto("access_scopes")
        .values({
          id: "chat-scope",
          connector_config_id: "chat-config",
          scope_type: "slack_channel",
          provider_scope_id: "C-REVOCATION",
          label: "#revocation",
        })
        .execute();
      await db
        .insertInto("access_scope_members")
        .values({ access_scope_id: "chat-scope", email: CURRENT_EMAIL })
        .execute();

      const files = [
        {
          id: "chat-stamped",
          connector_config_id: "chat-config",
          source: "slack",
          access_scope_id: "chat-scope",
          share_with_everyone: 0,
        },
        {
          id: "chat-current",
          connector_config_id: "chat-config",
          source: "whatsapp",
          access_scope_id: "chat-scope",
          share_with_everyone: 0,
        },
        {
          id: "chat-manual",
          connector_config_id: "chat-config",
          source: "slack",
          access_scope_id: "chat-scope",
          share_with_everyone: 0,
        },
        {
          id: "chat-org",
          connector_config_id: "chat-config",
          source: "whatsapp",
          access_scope_id: "chat-scope",
          share_with_everyone: 1,
        },
        {
          id: "chat-entity",
          connector_config_id: "chat-config",
          source: "slack",
          access_scope_id: "chat-scope",
          share_with_everyone: 0,
        },
        {
          id: "chat-no-scope",
          connector_config_id: "chat-config",
          source: "slack",
          access_scope_id: null,
          share_with_everyone: 0,
        },
        {
          id: "drive-stamped",
          connector_config_id: "drive-config",
          source: "google_drive",
          access_scope_id: null,
          share_with_everyone: 0,
        },
      ];
      await db
        .insertInto("indexed_files")
        .values(
          files.map((file) => ({
            ...file,
            provider_file_id: file.id,
            file_name: `${file.id} revocation token`,
            file_type: "text",
            content_category: "document" as const,
            content: "revocation token",
            source_path: null,
            provider_url: null,
            source_updated_at: "2026-08-06T00:00:00.000Z",
            synced_at: "2026-08-06T00:00:00.000Z",
          })),
        )
        .execute();
      await db
        .insertInto("connector_files")
        .values(files.map((file) => ({ connector_config_id: file.connector_config_id, indexed_file_id: file.id })))
        .execute();
      await db
        .insertInto("file_access")
        .values([
          { indexed_file_id: "chat-stamped", email: DEPARTED_EMAIL },
          { indexed_file_id: "drive-stamped", email: DEPARTED_EMAIL },
        ])
        .execute();
      await db
        .insertInto("file_share_emails")
        .values({ indexed_file_id: "chat-manual", email: OUTSIDER_EMAIL, granted_by_user_id: "admin" })
        .execute();
      await db
        .insertInto("entities")
        .values({
          id: "shared-entity",
          name: "Shared entity",
          source_type: "test",
          subtype: null,
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: "2026-08-06T00:00:00.000Z",
          updated_at: "2026-08-06T00:00:00.000Z",
        })
        .execute();
      await db
        .insertInto("entity_mentions")
        .values({
          id: "shared-entity-mention",
          entity_id: "shared-entity",
          indexed_file_id: "chat-entity",
          chunk_index: null,
          context_snippet: null,
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: "2026-08-06T00:00:00.000Z",
        })
        .execute();
      await db
        .insertInto("entity_share_emails")
        .values({ entity_id: "shared-entity", email: OUTSIDER_EMAIL, granted_by_user_id: "admin" })
        .execute();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("revokes a stamped chat-source file when current membership is gone", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: DEPARTED_EMAIL, isAdmin: false },
      });

      expect(files.map((file) => file.id)).not.toContain("chat-stamped");
      expect(await filterAccessibleFileIds(db, ["chat-stamped"], [DEPARTED_EMAIL])).toEqual(new Set());
      expect(await getFileContent(db, "chat-stamped", [DEPARTED_EMAIL])).toBeNull();
    });

    it("allows a current chat member without a file_access stamp", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: CURRENT_EMAIL, isAdmin: false },
      });

      expect(files.map((file) => file.id)).toContain("chat-current");
      expect(await filterAccessibleFileIds(db, ["chat-current"], [CURRENT_EMAIL])).toEqual(new Set(["chat-current"]));
      expect(await getFileContent(db, "chat-current", [CURRENT_EMAIL])).not.toBeNull();
    });

    it("keeps manual, org-wide, and entity shares open for chat-source files", async () => {
      for (const fileId of ["chat-manual", "chat-org", "chat-entity"]) {
        expect(await getFileContent(db, fileId, [OUTSIDER_EMAIL])).not.toBeNull();
      }
    });

    it("keeps non-chat file_access visibility unchanged", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: DEPARTED_EMAIL, isAdmin: false },
      });

      expect(files.map((file) => file.id)).toContain("drive-stamped");
      expect(await filterAccessibleFileIds(db, ["drive-stamped"], [DEPARTED_EMAIL])).toEqual(
        new Set(["drive-stamped"]),
      );
      expect(await getFileContent(db, "drive-stamped", [DEPARTED_EMAIL])).not.toBeNull();
    });

    it("fails closed for an unscoped chat file while retaining admin and manual access", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: OUTSIDER_EMAIL, isAdmin: false },
      });

      expect(files.map((file) => file.id)).not.toContain("chat-no-scope");
      expect(await filterAccessibleFileIds(db, ["chat-no-scope"], [OUTSIDER_EMAIL])).toEqual(new Set());
      expect(await getFileContent(db, "chat-no-scope", [OUTSIDER_EMAIL])).toBeNull();
      await db
        .insertInto("file_share_emails")
        .values({ indexed_file_id: "chat-no-scope", email: OUTSIDER_EMAIL, granted_by_user_id: "admin" })
        .execute();
      expect(await getFileContent(db, "chat-no-scope", [OUTSIDER_EMAIL])).not.toBeNull();

      const adminFiles = await repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: "admin@example.com", isAdmin: true },
      });
      expect(adminFiles.map((file) => file.id)).toContain("chat-no-scope");
    });

    it("applies chat-source revocation to raw search visibility", async () => {
      const departed = await searchFiles(db, "revocation", { userEmails: [DEPARTED_EMAIL] });
      const current = await searchFiles(db, "revocation", { userEmails: [CURRENT_EMAIL] });

      expect(departed.map((file) => file.id)).not.toContain("chat-stamped");
      expect(departed.map((file) => file.id)).toContain("drive-stamped");
      expect(current.map((file) => file.id)).toContain("chat-current");

      const outsider = await searchFiles(db, "revocation", { userEmails: [OUTSIDER_EMAIL] });
      expect(outsider.map((file) => file.id)).toEqual(
        expect.arrayContaining(["chat-manual", "chat-org", "chat-entity"]),
      );
    });

    it("restores pre-stack access doors when Slack entity sync is disabled", async () => {
      const repo = createConnectorRepository(db);
      const viewer = { email: DEPARTED_EMAIL, isAdmin: false, slackEntitySyncEnabled: false };
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer });

      expect(files.map((file) => file.id)).toEqual(expect.arrayContaining(["chat-stamped", "chat-no-scope"]));
      expect(await filterAccessibleFileIds(db, ["chat-stamped", "chat-no-scope"], [DEPARTED_EMAIL], false)).toEqual(
        new Set(["chat-stamped", "chat-no-scope"]),
      );
      expect(await getFileContent(db, "chat-stamped", [DEPARTED_EMAIL], false)).not.toBeNull();
      expect(await getFileContent(db, "chat-no-scope", [DEPARTED_EMAIL], false)).not.toBeNull();

      const results = await searchFiles(db, "revocation", {
        userEmails: [DEPARTED_EMAIL],
        slackEntitySyncEnabled: false,
      });
      expect(results.map((file) => file.id)).toEqual(expect.arrayContaining(["chat-stamped", "chat-no-scope"]));
    });
  });
}

runSuite("Chat source visibility SQLite", createTestDb);
runSuite("Chat source visibility Postgres", createTestPgDb);

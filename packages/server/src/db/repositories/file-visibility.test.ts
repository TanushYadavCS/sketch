/**
 * RBAC tests for the file-visibility predicate applied by listAllFiles,
 * countAllFiles, and countFilesByConnector. The predicate must stay in
 * lockstep with the agent-side `filterAccessibleFileIds` helper — both
 * encode the same 3-tier model (unrestricted / scope-member / per-file share).
 *
 * The chip-count parity test (last describe block) is the regression
 * that kept us honest: it's tempting to fix the chip and forget the list,
 * which would silently desync the UI.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileAccessFilterSql, filterAccessibleFileIds, getFileContent } from "../../connectors/search";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { type FileViewer, createConnectorRepository } from "./connectors";
import { createEntityRepository } from "./entities";

describe("file-visibility predicate (RBAC for file list/count)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "u-admin",
      })
      .execute();
    await db
      .insertInto("access_scopes")
      .values([
        { id: "scope-a", connector_config_id: "cfg", scope_type: "drive", provider_scope_id: "drive-a" },
        { id: "scope-b", connector_config_id: "cfg", scope_type: "drive", provider_scope_id: "drive-b" },
      ])
      .execute();
    await db
      .insertInto("access_scope_members")
      .values([
        { access_scope_id: "scope-a", principal_type: "email", principal_value: "alice@example.com" },
        { access_scope_id: "scope-b", principal_type: "email", principal_value: "bob@example.com" },
      ])
      .execute();
    await db.insertInto("users").values({ id: "lid-user", name: "LID User", email: null }).execute();

    const baseFile = {
      connector_config_id: "cfg",
      file_name: "f",
      file_type: "doc",
      content_category: "document" as const,
      source: "google_drive",
      provider_file_id: "",
      content_hash: "h",
      is_archived: 0 as const,
      synced_at: new Date().toISOString(),
    };
    await db
      .insertInto("indexed_files")
      .values([
        { id: "f-unrestricted", ...baseFile, provider_file_id: "p1" },
        { id: "f-scope-a", ...baseFile, provider_file_id: "p2", access_scope_id: "scope-a" },
        { id: "f-scope-b", ...baseFile, provider_file_id: "p3", access_scope_id: "scope-b" },
        { id: "f-per-file-charlie", ...baseFile, provider_file_id: "p4" },
      ])
      .execute();
    await db
      .insertInto("file_access")
      .values({
        indexed_file_id: "f-per-file-charlie",
        principal_type: "email",
        principal_value: "charlie@example.com",
      })
      .execute();
    await db
      .insertInto("connector_files")
      .values([
        { connector_config_id: "cfg", indexed_file_id: "f-unrestricted" },
        { connector_config_id: "cfg", indexed_file_id: "f-scope-a" },
        { connector_config_id: "cfg", indexed_file_id: "f-scope-b" },
        { connector_config_id: "cfg", indexed_file_id: "f-per-file-charlie" },
      ])
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  const member = (email: string): FileViewer => ({ email, isAdmin: false });
  const adminViewer: FileViewer = { email: "admin@example.com", isAdmin: true };
  const nullEmail: FileViewer = { email: null, isAdmin: false };

  describe("listAllFiles", () => {
    it("admin sees every file", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: adminViewer });
      expect(files.map((f) => f.id).sort()).toEqual(["f-per-file-charlie", "f-scope-a", "f-scope-b", "f-unrestricted"]);
    });

    it("alice sees unrestricted + scope-a only", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("alice@example.com") });
      expect(files.map((f) => f.id).sort()).toEqual(["f-scope-a", "f-unrestricted"]);
    });

    it("bob sees unrestricted + scope-b only", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("bob@example.com") });
      expect(files.map((f) => f.id).sort()).toEqual(["f-scope-b", "f-unrestricted"]);
    });

    it("charlie sees unrestricted + their per-file share", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("charlie@example.com") });
      expect(files.map((f) => f.id).sort()).toEqual(["f-per-file-charlie", "f-unrestricted"]);
    });

    it("stranger with no scope/share sees only unrestricted", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("stranger@example.com") });
      expect(files.map((f) => f.id)).toEqual(["f-unrestricted"]);
    });

    it("null caller email behaves like a stranger (no scope/share matches)", async () => {
      const repo = createConnectorRepository(db);
      const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: nullEmail });
      expect(files.map((f) => f.id)).toEqual(["f-unrestricted"]);
    });
  });

  describe("countAllFiles parity with listAllFiles", () => {
    it("count agrees with list length for every viewer", async () => {
      const repo = createConnectorRepository(db);
      for (const viewer of [
        adminViewer,
        member("alice@example.com"),
        member("bob@example.com"),
        member("charlie@example.com"),
        member("stranger@example.com"),
        nullEmail,
      ]) {
        const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer });
        const total = await repo.countAllFiles({ viewer });
        expect({ viewer: viewer.email, total }).toEqual({ viewer: viewer.email, total: files.length });
      }
    });
  });

  describe("countEnrichedFiles filter parity", () => {
    it("matches the raw status filter instead of counting enriched files", async () => {
      await db
        .updateTable("indexed_files")
        .set({ embedding_status: "done", summary_status: "done" })
        .where("id", "in", ["f-unrestricted", "f-scope-a"])
        .execute();
      await db.updateTable("indexed_files").set({ summary: "ready" }).where("id", "=", "f-scope-a").execute();

      const repo = createConnectorRepository(db);
      const list = await repo.listAllFiles({ limit: 50, offset: 0, viewer: adminViewer, status: "raw" });
      const total = await repo.countAllFiles({ viewer: adminViewer, status: "raw" });
      const filtered = await repo.countEnrichedFiles({ viewer: adminViewer, status: "raw" });

      expect(list.map((file) => file.id)).toEqual(["f-unrestricted"]);
      expect(filtered).toBe(total);
    });
  });

  describe("countFilesByConnector — chip count parity", () => {
    it("chip count for the connector equals list length when filtered by source", async () => {
      const repo = createConnectorRepository(db);
      for (const viewer of [adminViewer, member("alice@example.com"), member("stranger@example.com")]) {
        const chip = await repo.countFilesByConnector("cfg", viewer);
        const list = await repo.listAllFiles({ limit: 50, offset: 0, viewer, connectorType: "google_drive" });
        expect({ viewer: viewer.email, chip }).toEqual({ viewer: viewer.email, chip: list.length });
      }
    });
  });

  describe("countFilesBySource — viewer-aware chip aggregation", () => {
    it("admin sees every file in the source bucket", async () => {
      const repo = createConnectorRepository(db);
      const counts = await repo.countFilesBySource(adminViewer);
      expect(counts).toEqual([{ source: "google_drive", count: 4 }]);
    });

    it("alice sees unrestricted + scope-a", async () => {
      const repo = createConnectorRepository(db);
      const counts = await repo.countFilesBySource(member("alice@example.com"));
      expect(counts).toEqual([{ source: "google_drive", count: 2 }]);
    });

    it("charlie sees unrestricted + their per-file share", async () => {
      const repo = createConnectorRepository(db);
      const counts = await repo.countFilesBySource(member("charlie@example.com"));
      expect(counts).toEqual([{ source: "google_drive", count: 2 }]);
    });

    it("stranger and null-email see only unrestricted", async () => {
      const repo = createConnectorRepository(db);
      const stranger = await repo.countFilesBySource(member("stranger@example.com"));
      expect(stranger).toEqual([{ source: "google_drive", count: 1 }]);
      const anon = await repo.countFilesBySource(nullEmail);
      expect(anon).toEqual([{ source: "google_drive", count: 1 }]);
    });

    it("count per source agrees with list length filtered by that source for every viewer", async () => {
      const repo = createConnectorRepository(db);
      for (const viewer of [
        adminViewer,
        member("alice@example.com"),
        member("bob@example.com"),
        member("charlie@example.com"),
        member("stranger@example.com"),
        nullEmail,
      ]) {
        const counts = await repo.countFilesBySource(viewer);
        const list = await repo.listAllFiles({ limit: 50, offset: 0, viewer, connectorType: "google_drive" });
        const chip = counts.find((c) => c.source === "google_drive")?.count ?? 0;
        expect({ viewer: viewer.email, chip }).toEqual({ viewer: viewer.email, chip: list.length });
      }
    });
  });

  describe("manual file sharing (file_share_emails + share_with_everyone)", () => {
    it("a manual share grants list visibility; share_with_everyone fans out to any email", async () => {
      const repo = createConnectorRepository(db);

      // dana isn't in any scope or per-file ACL; before sharing, she sees only the unrestricted file.
      const before = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("dana@example.com") });
      expect(before.map((f) => f.id)).toEqual(["f-unrestricted"]);

      // Grant dana a manual share to a restricted file → it should show up in her list.
      await db
        .insertInto("users")
        .values({ id: "u-admin", name: "admin", email: "admin@example.com" })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await db
        .insertInto("file_share_emails")
        .values({ indexed_file_id: "f-scope-a", email: "dana@example.com", granted_by_user_id: "u-admin" })
        .execute();

      const afterShare = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("dana@example.com") });
      expect(afterShare.map((f) => f.id).sort()).toEqual(["f-scope-a", "f-unrestricted"]);

      // Flip share_with_everyone on a different file → it must be visible to any email
      // (e.g. an unrelated 'eve@example.com') with no other access path.
      await db.updateTable("indexed_files").set({ share_with_everyone: 1 }).where("id", "=", "f-scope-b").execute();

      const eveFiles = await repo.listAllFiles({ limit: 50, offset: 0, viewer: member("eve@example.com") });
      expect(eveFiles.map((f) => f.id).sort()).toEqual(["f-scope-b", "f-unrestricted"]);

      const nullViewerFiles = await repo.listAllFiles({ limit: 50, offset: 0, viewer: nullEmail });
      expect(nullViewerFiles.map((f) => f.id).sort()).toEqual(["f-scope-b", "f-unrestricted"]);
    });
  });

  it("matches phone, Slack user, and WhatsApp LID principals without email", async () => {
    const repo = createConnectorRepository(db);
    const typedFile = {
      connector_config_id: "cfg",
      file_name: "typed",
      file_type: "doc",
      content_category: "document" as const,
      content_hash: "typed-hash",
      is_archived: 0 as const,
      synced_at: new Date().toISOString(),
    };
    await db
      .insertInto("access_scopes")
      .values([
        { id: "scope-phone", connector_config_id: "cfg", scope_type: "whatsapp_group", provider_scope_id: "phone" },
        { id: "scope-slack", connector_config_id: "cfg", scope_type: "slack_channel", provider_scope_id: "slack" },
        { id: "scope-lid", connector_config_id: "cfg", scope_type: "whatsapp_group", provider_scope_id: "lid" },
      ])
      .execute();
    await db
      .insertInto("access_scope_members")
      .values([
        { access_scope_id: "scope-phone", principal_type: "phone", principal_value: "+15550000001" },
        { access_scope_id: "scope-slack", principal_type: "slack_user", principal_value: "U-HIDDEN" },
        { access_scope_id: "scope-lid", principal_type: "whatsapp_lid", principal_value: "12345@lid" },
      ])
      .execute();
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "f-phone",
          ...typedFile,
          provider_file_id: "p-phone",
          source: "whatsapp",
          access_scope_id: "scope-phone",
        },
        { id: "f-slack", ...typedFile, provider_file_id: "p-slack", source: "slack", access_scope_id: "scope-slack" },
        { id: "f-lid", ...typedFile, provider_file_id: "p-lid", source: "whatsapp", access_scope_id: "scope-lid" },
      ])
      .execute();

    await expect(
      repo.listAllFiles({
        limit: 50,
        offset: 0,
        viewer: { email: null, phone: "+1 (555) 000-0001", isAdmin: false },
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "f-phone" })]));
    await expect(
      repo.listAllFiles({ limit: 50, offset: 0, viewer: { email: null, slackUserId: "U-HIDDEN", isAdmin: false } }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "f-slack" })]));
    await expect(
      repo.listAllFiles({ limit: 50, offset: 0, viewer: { email: null, whatsappLid: null, isAdmin: false } }),
    ).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "f-lid" })]));
    await db.updateTable("users").set({ whatsapp_lid: "12345@lid" }).where("id", "=", "lid-user").execute();
    await expect(
      repo.listAllFiles({ limit: 50, offset: 0, viewer: { email: null, whatsappLid: "12345:7@lid", isAdmin: false } }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "f-lid" })]));
  });

  it("keeps entity share_with_everyone visible across every read gate without email", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "ent-shared-everyone",
        name: "Shared Entity",
        source_type: "manual",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
        share_with_everyone: 1,
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "f-entity-share-everyone",
        connector_config_id: "cfg",
        provider_file_id: "entity-share-everyone",
        file_name: "entity-share-everyone.txt",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "shared content",
        content_hash: "entity-share-everyone-hash",
        synced_at: now,
        access_scope_id: "scope-a",
      })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-shared-everyone",
        entity_id: "ent-shared-everyone",
        indexed_file_id: "f-entity-share-everyone",
        chunk_index: null,
        context_snippet: null,
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      })
      .execute();

    const phoneOnly = [{ type: "phone" as const, value: "+15550000009" }];
    const nullEmailWebViewer: FileViewer = { email: null, phone: "+15550000009", isAdmin: false };
    const repo = createConnectorRepository(db);
    const filterSqlVisible = await db
      .selectFrom("indexed_files")
      .select("id")
      .where(fileAccessFilterSql(phoneOnly))
      .where("id", "=", "f-entity-share-everyone")
      .execute();
    const visibleByList = await repo.listAllFiles({ limit: 50, offset: 0, viewer: nullEmailWebViewer });
    const visibleByIds = await filterAccessibleFileIds(db, ["f-entity-share-everyone"], phoneOnly);
    const visibleByContent = await getFileContent(db, "f-entity-share-everyone", phoneOnly);

    expect(filterSqlVisible.map((file) => file.id)).toEqual(["f-entity-share-everyone"]);
    expect(visibleByList.map((file) => file.id)).toContain("f-entity-share-everyone");
    expect(visibleByIds).toEqual(new Set(["f-entity-share-everyone"]));
    expect(visibleByContent?.id).toBe("f-entity-share-everyone");
  });

  it("deduplicates multiple principals that resolve to one user in access summaries", async () => {
    const repo = createConnectorRepository(db);
    await db
      .insertInto("users")
      .values({
        id: "multi-principal-user",
        name: "Multi Principal",
        email: "alice@example.com",
        whatsapp_number: "+15550000001",
        slack_user_id: "U-MULTI",
        whatsapp_lid: "multi@lid",
      })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values([
        { access_scope_id: "scope-a", principal_type: "phone", principal_value: "+15550000001" },
        { access_scope_id: "scope-a", principal_type: "slack_user", principal_value: "U-MULTI" },
        { access_scope_id: "scope-a", principal_type: "whatsapp_lid", principal_value: "multi@lid" },
      ])
      .execute();

    await expect(repo.getFileAccessMap(["f-scope-a"])).resolves.toEqual(
      new Map([["f-scope-a", { type: "scope", count: 1 }]]),
    );
    await expect(repo.getFileAccessDetails("f-scope-a")).resolves.toEqual([
      { email: "alice@example.com", userName: "Multi Principal", userId: "multi-principal-user", source: "scope" },
    ]);
  });

  it("shows unresolved emails raw and sorts named members first", async () => {
    const repo = createConnectorRepository(db);
    await db
      .insertInto("users")
      .values({ id: "named-user", name: "Alice Named", email: "named@example.com" })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values([
        { access_scope_id: "scope-a", principal_type: "email", principal_value: "named@example.com" },
        { access_scope_id: "scope-a", principal_type: "email", principal_value: "unresolved@example.com" },
        { access_scope_id: "scope-a", principal_type: "phone", principal_value: "+15550000008" },
      ])
      .execute();

    await expect(repo.getFileAccessDetails("f-scope-a")).resolves.toEqual([
      { email: "named@example.com", userName: "Alice Named", userId: "named-user", source: "scope" },
      { email: "+155…08", userName: null, userId: null, source: "scope" },
      { email: "alice@example.com", userName: null, userId: null, source: "scope" },
      { email: "unresolved@example.com", userName: null, userId: null, source: "scope" },
    ]);
  });

  describe("system entity visibility", () => {
    it("keeps system entities visible without granting files that mention them", async () => {
      const now = new Date().toISOString();
      await db
        .insertInto("entities")
        .values({
          id: "ent-clickup-space",
          name: "Engineering Space",
          source_type: "clickup_space",
          subtype: null,
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto("entity_mentions")
        .values({
          id: "mention-clickup-space",
          entity_id: "ent-clickup-space",
          indexed_file_id: "f-scope-a",
          chunk_index: null,
          context_snippet: null,
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: now,
        })
        .execute();

      const viewer = member("stranger@example.com");
      const fileRepo = createConnectorRepository(db);
      const entityRepo = createEntityRepository(db);

      const entity = await entityRepo.getEntity("ent-clickup-space", viewer);
      const files = await fileRepo.listAllFiles({ limit: 50, offset: 0, viewer });

      expect(entity?.id).toBe("ent-clickup-space");
      expect(files.map((f) => f.id)).toEqual(["f-unrestricted"]);
    });
  });
});

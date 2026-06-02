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
        { access_scope_id: "scope-a", email: "alice@example.com" },
        { access_scope_id: "scope-b", email: "bob@example.com" },
      ])
      .execute();

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
      .values({ indexed_file_id: "f-per-file-charlie", email: "charlie@example.com" })
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
    });
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

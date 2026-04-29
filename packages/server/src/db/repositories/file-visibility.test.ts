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
import type { DB } from "../schema";
import { createTestDb } from "../../test-utils";
import { type FileViewer, createConnectorRepository } from "./connectors";

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
    await db.insertInto("file_access").values({ indexed_file_id: "f-per-file-charlie", email: "charlie@example.com" }).execute();
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
});

/**
 * Tests for the search module.
 *
 * browseFiles: LIKE wildcard escaping (Phase 2)
 * searchFiles / hybridSearch: FTS5 query sanitization (Phase 7)
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  browseFiles,
  filterAccessibleFileIds,
  getFileContent,
  listIndexedSourcesForPrompt,
  searchFiles,
} from "./search";

/** Insert a minimal indexed_files row for testing path matching. */
async function insertFile(db: Kysely<DB>, id: string, sourcePath: string, source = "google_drive") {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "connector-1",
      provider_file_id: id,
      file_name: `${id}.txt`,
      file_type: "text",
      content_category: "document",
      source,
      source_path: sourcePath,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

describe("browseFiles — LIKE wildcard escaping", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    // Create the connector_configs row that indexed_files references
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-1",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("% in folderPath matches only paths containing a literal percent sign, not all paths", async () => {
    // Two files: one whose path contains a literal "%" and one with a normal path.
    await insertFile(db, "file-percent", "My Drive / 100% Done");
    await insertFile(db, "file-normal", "My Drive / Regular Folder");

    // If % is NOT escaped, searching for "100%" would match both rows because
    // `%100%%` matches any string (the trailing unescaped % is a wildcard).
    const results = await browseFiles(db, { folderPath: "100%" });

    // With correct escaping, only the file whose path actually contains "100%"
    // should be returned.
    const ids = results.map((r) => r.id);
    expect(ids).toContain("file-percent");
    expect(ids).not.toContain("file-normal");
  });

  it("_ in folderPath matches only paths containing a literal underscore, not any single character", async () => {
    // Two files: one with an underscore in the path, one without.
    await insertFile(db, "file-underscore", "My Drive / Project_Alpha");
    await insertFile(db, "file-no-underscore", "My Drive / ProjectBAlpha");

    // Without escaping, `%Project_Alpha%` would match "ProjectBAlpha" too,
    // because _ is a single-char wildcard. With escaping it must not.
    const results = await browseFiles(db, { folderPath: "Project_Alpha" });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("file-underscore");
    expect(ids).not.toContain("file-no-underscore");
  });

  it("a bare % folderPath does not return all files", async () => {
    // Without escaping, folderPath="%" turns into LIKE `%%%` which matches everything.
    await insertFile(db, "file-a", "My Drive / FolderA");
    await insertFile(db, "file-b", "My Drive / FolderB");

    const results = await browseFiles(db, { folderPath: "%" });

    // There are no files whose path contains a literal "%" — result should be empty.
    expect(results).toHaveLength(0);
  });
});

describe("searchFiles — FTS5 query sanitization", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-2",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-fts",
        connector_config_id: "connector-2",
        provider_file_id: "fts-provider",
        file_name: "planning.txt",
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        source_path: "My Drive / Docs",
        provider_url: null,
        content: "quarterly planning document for Q1 2025",
        summary: null,
        context_note: null,
        access_scope_id: null,
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      })
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("a query with FTS5 special characters does not throw", async () => {
    // Characters like *, (, ), ", +, -, OR, AND, NOT would cause FTS5 MATCH to
    // throw a syntax error if passed through unsanitized.
    const specialQueries = [
      "planning*",
      "(planning)",
      '"planning"',
      "planning OR",
      "planning AND",
      "NOT planning",
      "plan+ning",
      "plan-ning",
      "NEAR(planning doc)",
    ];

    for (const query of specialQueries) {
      await expect(searchFiles(db, query)).resolves.not.toThrow();
    }
  });

  it("a normal query still returns matching results", async () => {
    const results = await searchFiles(db, "planning");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fileName).toBe("planning.txt");
  });

  it("search results include providerFileId (needed for integration handoff)", async () => {
    const results = await searchFiles(db, "planning");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].providerFileId).toBe("fts-provider");
  });

  it("an empty or all-special-chars query returns empty array without throwing", async () => {
    await expect(searchFiles(db, "   ")).resolves.toEqual([]);
    await expect(searchFiles(db, "***")).resolves.toBeInstanceOf(Array);
  });
});

describe("filterAccessibleFileIds — 3-tier RBAC", () => {
  let db: Kysely<DB>;

  async function insertFileWithAccess(
    id: string,
    opts: { accessScopeId?: string | null; fileAccessEmails?: string[] } = {},
  ) {
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "connector-rbac",
        provider_file_id: id,
        file_name: `${id}.txt`,
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        source_path: `/${id}`,
        provider_url: null,
        content: "content",
        summary: null,
        context_note: null,
        access_scope_id: opts.accessScopeId ?? null,
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      })
      .execute();
    for (const email of opts.fileAccessEmails ?? []) {
      await db.insertInto("file_access").values({ indexed_file_id: id, email }).execute();
    }
  }

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-rbac",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    // Set up two access scopes with members
    await db
      .insertInto("access_scopes")
      .values({
        id: "scope-a",
        connector_config_id: "connector-rbac",
        scope_type: "drive",
        provider_scope_id: "drive-a",
      })
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: "scope-b",
        connector_config_id: "connector-rbac",
        scope_type: "drive",
        provider_scope_id: "drive-b",
      })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-a", email: "alice@example.com" })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-b", email: "bob@example.com" })
      .execute();

    // File 1: unrestricted (no scope, no file_access)
    await insertFileWithAccess("file-unrestricted");
    // File 2: scope-a (alice can see)
    await insertFileWithAccess("file-scope-a", { accessScopeId: "scope-a" });
    // File 3: scope-b (bob can see)
    await insertFileWithAccess("file-scope-b", { accessScopeId: "scope-b" });
    // File 4: per-file access for charlie only
    await insertFileWithAccess("file-per-file", { fileAccessEmails: ["charlie@example.com"] });
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("returns all files when userEmails is empty (no filtering)", async () => {
    const accessible = await filterAccessibleFileIds(
      db,
      ["file-unrestricted", "file-scope-a", "file-scope-b", "file-per-file"],
      [],
    );
    expect(accessible.size).toBe(4);
  });

  it("returns unrestricted files for any user", async () => {
    const accessible = await filterAccessibleFileIds(db, ["file-unrestricted"], ["nobody@example.com"]);
    expect(accessible.has("file-unrestricted")).toBe(true);
  });

  it("scope-level access: alice sees scope-a, not scope-b", async () => {
    const accessible = await filterAccessibleFileIds(db, ["file-scope-a", "file-scope-b"], ["alice@example.com"]);
    expect(accessible.has("file-scope-a")).toBe(true);
    expect(accessible.has("file-scope-b")).toBe(false);
  });

  it("per-file access: only the explicit email allows access", async () => {
    const accessibleForCharlie = await filterAccessibleFileIds(db, ["file-per-file"], ["charlie@example.com"]);
    expect(accessibleForCharlie.has("file-per-file")).toBe(true);

    const accessibleForAlice = await filterAccessibleFileIds(db, ["file-per-file"], ["alice@example.com"]);
    expect(accessibleForAlice.has("file-per-file")).toBe(false);
  });

  it("empty fileIds returns empty set", async () => {
    const accessible = await filterAccessibleFileIds(db, [], ["alice@example.com"]);
    expect(accessible.size).toBe(0);
  });
});

describe("getFileContent — RBAC", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-content",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: "scope-c",
        connector_config_id: "connector-content",
        scope_type: "drive",
        provider_scope_id: "drive-c",
      })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-c", email: "member@example.com" })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-restricted",
        connector_config_id: "connector-content",
        provider_file_id: "pf-restricted",
        file_name: "secret.txt",
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        source_path: "/secret",
        provider_url: null,
        content: "top secret content",
        summary: null,
        context_note: null,
        access_scope_id: "scope-c",
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      })
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("returns file when no userEmails provided (admin/API without auth)", async () => {
    const file = await getFileContent(db, "file-restricted");
    expect(file).toBeTruthy();
    expect(file?.content).toBe("top secret content");
  });

  it("returns file when user is in the scope", async () => {
    const file = await getFileContent(db, "file-restricted", ["member@example.com"]);
    expect(file).toBeTruthy();
    expect(file?.fileName).toBe("secret.txt");
  });

  it("returns null when user is not in the scope", async () => {
    const file = await getFileContent(db, "file-restricted", ["outsider@example.com"]);
    expect(file).toBeNull();
  });

  it("returns null for missing file id", async () => {
    const file = await getFileContent(db, "does-not-exist", ["member@example.com"]);
    expect(file).toBeNull();
  });
});

describe("listIndexedSourcesForPrompt", () => {
  let db: Kysely<DB>;

  async function insertBasicFile(id: string, source: string, isArchived: 0 | 1 = 0) {
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "connector-idx",
        provider_file_id: id,
        file_name: `${id}.txt`,
        file_type: "text",
        content_category: "document",
        source,
        source_path: `/${id}`,
        provider_url: null,
        content: null,
        summary: null,
        context_note: null,
        access_scope_id: null,
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        is_archived: isArchived,
      })
      .execute();
  }

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-idx",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("returns empty array when no files are indexed", async () => {
    const rows = await listIndexedSourcesForPrompt(db);
    expect(rows).toEqual([]);
  });

  it("lists sources with file counts, sorted by count desc", async () => {
    await insertBasicFile("f1", "fireflies");
    await insertBasicFile("f2", "fireflies");
    await insertBasicFile("f3", "google_drive");
    await insertBasicFile("f4", "google_drive");
    await insertBasicFile("f5", "google_drive");

    const rows = await listIndexedSourcesForPrompt(db);
    expect(rows).toEqual([
      { source: "google_drive", fileCount: 3 },
      { source: "fireflies", fileCount: 2 },
    ]);
  });

  it("excludes archived files from counts", async () => {
    await insertBasicFile("live", "fireflies");
    await insertBasicFile("archived", "fireflies", 1);
    const rows = await listIndexedSourcesForPrompt(db);
    expect(rows).toEqual([{ source: "fireflies", fileCount: 1 }]);
  });

  it("excludes sources that have only archived files (count would be 0)", async () => {
    await insertBasicFile("a1", "notion", 1);
    const rows = await listIndexedSourcesForPrompt(db);
    expect(rows).toEqual([]);
  });
});

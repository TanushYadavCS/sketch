/**
 * Tests for the search module.
 *
 * browseFiles: LIKE wildcard escaping (Phase 2)
 * searchFiles / hybridSearch: FTS5 query sanitization (Phase 7)
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  KIND_TO_RULES,
  browseFiles,
  filterAccessibleFileIds,
  getFileContent,
  hybridSearch,
  listIndexedSourcesForPrompt,
  search,
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
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
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

  it("returns no results when userPrincipals is []", async () => {
    await expect(searchFiles(db, "planning", { userPrincipals: [] })).resolves.toEqual([]);
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

  it("falls back to FTS when query embedding fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }, { status: 429 })),
    );
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await settings.update({ geminiApiKey: "AIza-key", embeddingProvider: "gemini" });

    const results = await search(db, "planning", { geminiMaxRetries: 0 });

    expect(results.map((result) => result.id)).toContain("file-fts");
  });
});

describe("KIND_TO_RULES", () => {
  it("maps message kind to local conversation, WhatsApp, and Slack slice sources", () => {
    expect(KIND_TO_RULES.message).toEqual([{ sources: ["conversation", "whatsapp", "slack"] }]);
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
      await db
        .insertInto("file_access")
        .values({ indexed_file_id: id, principal_type: "email", principal_value: email })
        .execute();
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
      .values({ access_scope_id: "scope-a", principal_type: "email", principal_value: "alice@example.com" })
      .execute();
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-b", principal_type: "email", principal_value: "bob@example.com" })
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

  it("returns all files when userPrincipals is undefined (trusted bypass)", async () => {
    const accessible = await filterAccessibleFileIds(db, [
      "file-unrestricted",
      "file-scope-a",
      "file-scope-b",
      "file-per-file",
    ]);
    expect(accessible.size).toBe(4);
  });

  it("returns empty set when userPrincipals is [] (fail closed)", async () => {
    const accessible = await filterAccessibleFileIds(
      db,
      ["file-unrestricted", "file-scope-a", "file-scope-b", "file-per-file"],
      [],
    );
    expect(accessible.size).toBe(0);
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

  it("scope-level access matches a phone principal", async () => {
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-a", principal_type: "phone", principal_value: "+15550000001" })
      .execute();

    const accessible = await filterAccessibleFileIds(db, ["file-scope-a"], [{ type: "phone", value: "+15550000001" }]);
    expect(accessible).toEqual(new Set(["file-scope-a"]));
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

  it("archived files are excluded even when archival left them scope-less", async () => {
    await insertFileWithAccess("file-archived");
    await db.updateTable("indexed_files").set({ is_archived: 1 }).where("id", "=", "file-archived").execute();

    const accessible = await filterAccessibleFileIds(db, ["file-archived", "file-unrestricted"], ["alice@example.com"]);
    expect(accessible.has("file-archived")).toBe(false);
    expect(accessible.has("file-unrestricted")).toBe(true);
  });
});

describe("search — recency browse applies RBAC before limit", () => {
  let db: Kysely<DB>;

  async function insertMeeting(
    id: string,
    sourceUpdatedAt: string,
    opts: {
      content?: string | null;
      fileAccessEmails?: string[];
      manualShareEmails?: string[];
      shareWithEveryone?: boolean;
    } = {},
  ) {
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "connector-meetings",
        provider_file_id: id,
        file_name: `${id}.txt`,
        file_type: "transcript",
        content_category: "document",
        source: "fireflies",
        source_path: `/meetings/${id}`,
        provider_url: null,
        content: opts.content ?? null,
        summary: null,
        context_note: null,
        access_scope_id: null,
        share_with_everyone: opts.shareWithEveryone ? 1 : 0,
        source_updated_at: sourceUpdatedAt,
        synced_at: sourceUpdatedAt,
      })
      .execute();

    for (const email of opts.fileAccessEmails ?? []) {
      await db
        .insertInto("file_access")
        .values({ indexed_file_id: id, principal_type: "email", principal_value: email })
        .execute();
    }
    if ((opts.manualShareEmails ?? []).length > 0) {
      await db
        .insertInto("users")
        .values({ id: "admin", name: "admin", email: "admin@example.com" })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await db
        .insertInto("file_share_emails")
        .values(
          (opts.manualShareEmails ?? []).map((email) => ({
            indexed_file_id: id,
            email,
            granted_by_user_id: "admin",
          })),
        )
        .execute();
    }
  }

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-meetings",
        connector_type: "fireflies",
        auth_type: "api_key",
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

  it("returns an older accessible meeting when newer candidates are inaccessible", async () => {
    await insertMeeting("restricted-1", "2026-04-30T10:00:00.000Z", { fileAccessEmails: ["other@example.com"] });
    await insertMeeting("restricted-2", "2026-04-30T09:00:00.000Z", { fileAccessEmails: ["other@example.com"] });
    await insertMeeting("restricted-3", "2026-04-30T08:00:00.000Z", { fileAccessEmails: ["other@example.com"] });
    await insertMeeting("accessible", "2026-04-30T07:00:00.000Z");

    const results = await search(db, "", {
      kindRules: KIND_TO_RULES.meeting,
      sortBy: "recency",
      limit: 1,
      userPrincipals: ["alice@example.com"],
    });

    expect(results.map((r) => r.id)).toEqual(["accessible"]);
  });

  it("includes manually shared and org-wide files in non-empty search", async () => {
    await insertMeeting("manual-shared", "2026-04-30T10:00:00.000Z", {
      content: "manual visibility planning",
      fileAccessEmails: ["other@example.com"],
      manualShareEmails: ["alice@example.com"],
    });
    await insertMeeting("org-shared", "2026-04-30T09:00:00.000Z", {
      content: "org visibility planning",
      fileAccessEmails: ["other@example.com"],
      shareWithEveryone: true,
    });
    await insertMeeting("blocked-shared", "2026-04-30T08:00:00.000Z", {
      content: "blocked visibility planning",
      fileAccessEmails: ["other@example.com"],
    });

    const results = await search(db, "shared", {
      source: "fireflies",
      limit: 10,
      userPrincipals: ["alice@example.com"],
    });

    expect(results.map((r) => r.id).sort()).toEqual(["manual-shared", "org-shared"]);
  });

  it("returns no recency results when userPrincipals is []", async () => {
    await insertMeeting("accessible", "2026-04-30T07:00:00.000Z");

    const results = await search(db, "", {
      kindRules: KIND_TO_RULES.meeting,
      sortBy: "recency",
      limit: 1,
      userPrincipals: [],
    });

    expect(results).toEqual([]);
  });

  it("returns no hybrid results when userPrincipals is []", async () => {
    await insertMeeting("planning-meeting", "2026-04-30T07:00:00.000Z");
    await db
      .updateTable("indexed_files")
      .set({ content: "quarterly planning details" })
      .where("id", "=", "planning-meeting")
      .execute();

    const results = await search(db, "planning", { userPrincipals: [] });

    expect(results).toEqual([]);
  });
});

describe("hybridSearch — email thread collapse", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-email-search",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function insertEmailMessage(input: {
    id: string;
    threadId?: string;
    fileName: string;
    subject: string;
    sentAt: string;
    body: string;
    from?: { name: string; email: string };
    accessPrincipals?: string[];
  }) {
    const from = input.from ?? { name: "Jane Doe", email: "jane@example.com" };
    await db
      .insertInto("indexed_files")
      .values({
        id: input.id,
        connector_config_id: "connector-email-search",
        provider_file_id: input.id,
        provider_message_id: `<${input.id}@example.com>`,
        thread_id: input.threadId ?? "thread-a",
        file_name: input.fileName,
        file_type: "email_message",
        content_category: "document",
        source: "google_drive",
        source_path: `/mail/${input.fileName}`,
        provider_url: null,
        content: input.body,
        summary: `${input.subject} summary`,
        context_note: null,
        access_scope_id: null,
        source_created_at: input.sentAt,
        source_updated_at: input.sentAt,
        synced_at: input.sentAt,
      })
      .execute();

    await db
      .insertInto("email_message_envelopes")
      .values({
        indexed_file_id: input.id,
        connector_config_id: "connector-email-search",
        provider_file_id: input.id,
        provider_message_id: `<${input.id}@example.com>`,
        thread_id: input.threadId ?? "thread-a",
        subject: input.subject,
        sent_at: input.sentAt,
        from_json: JSON.stringify(from),
        to_json: JSON.stringify([{ name: "Owner", email: "owner@example.com" }]),
        cc_json: JSON.stringify([]),
        owner_email: "owner@example.com",
        provider_url: null,
      })
      .execute();

    for (const email of input.accessPrincipals ?? []) {
      await db
        .insertInto("file_access")
        .values({ indexed_file_id: input.id, principal_type: "email", principal_value: email })
        .execute();
    }
  }

  it("uses the best matching message as the hit and whole visible thread metadata for the card", async () => {
    await insertEmailMessage({
      id: "email-old",
      fileName: "pricing-question.eml",
      subject: "Pricing question",
      sentAt: "2026-05-01T10:00:00.000Z",
      body: "Can we discuss pricing?",
    });
    await insertEmailMessage({
      id: "email-new",
      fileName: "follow-up.eml",
      subject: "Latest update",
      sentAt: "2026-05-01T12:00:00.000Z",
      body: "Tuesday works.",
    });

    const results = await hybridSearch(db, "pricing", { limit: 10 });
    const thread = results.find((result) => result.resultKind === "email_thread");

    expect(thread).toMatchObject({
      id: "email-old",
      hitFileId: "email-old",
      threadKey: "connector-email-search:thread-a",
      messageCount: 2,
      latestSubject: "Latest update",
      lastActivity: "2026-05-01T12:00:00.000Z",
    });
  });

  it("collapses only the thread messages visible to the requesting user", async () => {
    await insertEmailMessage({
      id: "email-old",
      fileName: "pricing-question.eml",
      subject: "Pricing question",
      sentAt: "2026-05-01T10:00:00.000Z",
      body: "Can we discuss pricing?",
      accessPrincipals: ["bob@example.com"],
    });
    await insertEmailMessage({
      id: "email-new",
      fileName: "follow-up.eml",
      subject: "Confidential update",
      sentAt: "2026-05-01T12:00:00.000Z",
      body: "Tuesday works.",
      from: { name: "Secret Sender", email: "secret@example.com" },
      accessPrincipals: ["owner@example.com"],
    });

    const results = await hybridSearch(db, "pricing", { limit: 10, userPrincipals: ["bob@example.com"] });
    const thread = results.find((result) => result.resultKind === "email_thread");

    expect(thread).toMatchObject({
      id: "email-old",
      hitFileId: "email-old",
      threadKey: "connector-email-search:thread-a",
      messageCount: 1,
      latestSubject: "Pricing question",
      lastActivity: "2026-05-01T10:00:00.000Z",
    });
    expect(thread?.participants).not.toContain("Secret Sender");
    expect(thread?.participants).not.toContain("secret@example.com");
  });

  it("overfetches before thread collapse so one long matching thread does not underfill results", async () => {
    for (let i = 0; i < 55; i++) {
      await insertEmailMessage({
        id: `email-a-${i}`,
        threadId: "thread-a",
        fileName: `pricing-a-${i}.eml`,
        subject: `Pricing A ${i}`,
        sentAt: `2026-05-01T10:${String(i).padStart(2, "0")}:00.000Z`,
        body: "pricing",
      });
    }
    await insertEmailMessage({
      id: "email-b-0",
      threadId: "thread-b",
      fileName: "pricing-b.eml",
      subject: "Pricing B",
      sentAt: "2026-05-01T12:00:00.000Z",
      body: "pricing",
    });

    const results = await hybridSearch(db, "pricing", { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.threadKey)).toEqual(
      expect.arrayContaining(["connector-email-search:thread-a", "connector-email-search:thread-b"]),
    );
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
      .values({ access_scope_id: "scope-c", principal_type: "email", principal_value: "member@example.com" })
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

  it("returns file when userPrincipals is undefined (trusted bypass)", async () => {
    const file = await getFileContent(db, "file-restricted");
    expect(file).toBeTruthy();
    expect(file?.content).toBe("top secret content");
  });

  it("returns null when userPrincipals is [] (fail closed)", async () => {
    const file = await getFileContent(db, "file-restricted", []);
    expect(file).toBeNull();
  });

  it("returns file when user is in the scope", async () => {
    const file = await getFileContent(db, "file-restricted", ["member@example.com"]);
    expect(file).toBeTruthy();
    expect(file?.fileName).toBe("secret.txt");
  });

  it("returns file when a phone principal is in the scope", async () => {
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-c", principal_type: "phone", principal_value: "+15550000001" })
      .execute();

    const file = await getFileContent(db, "file-restricted", [{ type: "phone", value: "+15550000001" }]);
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

  it("denies archived files on the RBAC path even when archival cleared the scope", async () => {
    await db
      .updateTable("indexed_files")
      .set({ is_archived: 1, access_scope_id: null })
      .where("id", "=", "file-restricted")
      .execute();

    expect(await getFileContent(db, "file-restricted", ["member@example.com"])).toBeNull();
    expect((await getFileContent(db, "file-restricted"))?.content).toBe("top secret content");
  });

  it("manual share grants content access; revoking removes it immediately", async () => {
    // outsider isn't in scope-c → blocked.
    expect(await getFileContent(db, "file-restricted", ["outsider@example.com"])).toBeNull();

    await db
      .insertInto("users")
      .values({ id: "u-admin", name: "admin", email: "admin@example.com" })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("file_share_emails")
      .values({ indexed_file_id: "file-restricted", email: "outsider@example.com", granted_by_user_id: "u-admin" })
      .execute();

    const granted = await getFileContent(db, "file-restricted", ["outsider@example.com"]);
    expect(granted?.content).toBe("top secret content");

    await db
      .deleteFrom("file_share_emails")
      .where("indexed_file_id", "=", "file-restricted")
      .where("email", "=", "outsider@example.com")
      .execute();

    expect(await getFileContent(db, "file-restricted", ["outsider@example.com"])).toBeNull();
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

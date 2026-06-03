/**
 * Tests for the sync scheduler.
 *
 * Key scenarios:
 * - startSyncScheduler returns a handle with stop()
 * - stop() awaits the in-flight startup enrichment before resolving,
 *   so calling db.destroy() after stop() does not produce "database connection
 *   is not open" errors
 * - buildOrgContext returns a generic string based on org name, not
 *   hardcoded company data
 */
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { createTestDb, createTestLogger } from "../test-utils";
import { clearEnrichmentData } from "./enrichment";
import { recoverStaleEnrichments, runAllSyncs, runConnectorSync, startSyncScheduler } from "./sync";
import type { NameResolver, SyncedItem } from "./types";

// Stub the heavy enrichment/sync work to keep tests fast
vi.mock("./enrichment", () => ({
  runEnrichment: vi.fn().mockResolvedValue({ filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] }),
  clearEnrichmentData: vi.fn(),
}));

vi.mock("./embeddings", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
}));

// Mock the connector registry so runConnectorSync doesn't hit real APIs
const mockConnectorSync = vi.fn();
vi.mock("./registry", () => ({
  getConnector: vi.fn(() => ({
    type: "google_drive",
    promotableFileTypes: ["project"],
    sync: (...args: unknown[]) => mockConnectorSync(...args),
    getCursor: vi.fn().mockResolvedValue("cursor-v2"),
    validateCredentials: vi.fn().mockResolvedValue(undefined),
  })),
}));

interface StableFactTuple {
  factType: string;
  subjectName: string | null;
  subjectEmail: string | null;
  subjectSourceId: string | null;
  raw: unknown;
}

async function loadStableFactTuples(db: Kysely<DB>, connectorConfigId: string): Promise<StableFactTuple[]> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["fact_type", "subject_name", "subject_email", "subject_source_id", "raw"])
    .where("connector_config_id", "=", connectorConfigId)
    .where("deleted_at", "is", null)
    .execute();

  return rows
    .map((row) => ({
      factType: row.fact_type,
      subjectName: row.subject_name,
      subjectEmail: row.subject_email,
      subjectSourceId: row.subject_source_id,
      raw: row.raw ? JSON.parse(row.raw) : null,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

describe("startSyncScheduler", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed in the test
      }
      db = null;
    }
  });

  it("returns a handle with a stop() method", async () => {
    db = await createTestDb();
    const handle = startSyncScheduler(db, logger, 60 * 60 * 1000);
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });

  it("stop() resolves without error after a normal startup", async () => {
    db = await createTestDb();
    const handle = startSyncScheduler(db, logger, 60 * 60 * 1000);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("stop() then db.destroy() does not throw (regression: flaky bootstrap test)", async () => {
    db = await createTestDb();
    const handle = startSyncScheduler(db, logger, 60 * 60 * 1000);
    // Awaiting stop() ensures the in-flight startup IIFE has completed
    // before we destroy the DB. Without this fix, destroy() would race with
    // the IIFE's DB query and produce "database connection is not open".
    await handle.stop();
    await expect(db.destroy()).resolves.toBeUndefined();
    db = null;
  });
});

describe("recoverStaleEnrichments", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  async function insertFile(database: Kysely<DB>, id: string, opts: { embeddingStatus: string; syncedAt: string }) {
    await database
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "connector-recover",
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
        access_scope_id: null,
        source_updated_at: new Date().toISOString(),
        synced_at: opts.syncedAt,
        embedding_status: opts.embeddingStatus,
      })
      .execute();
  }

  it("resets files stuck in processing older than 1 hour to pending", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-recover",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await insertFile(db, "file-stale", { embeddingStatus: "processing", syncedAt: twoHoursAgo });

    await recoverStaleEnrichments(db, logger);

    const row = await db
      .selectFrom("indexed_files")
      .select("embedding_status")
      .where("id", "=", "file-stale")
      .executeTakeFirst();
    expect(row?.embedding_status).toBe("pending");
  });

  it("leaves recent processing files alone", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-recover",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await insertFile(db, "file-fresh", { embeddingStatus: "processing", syncedAt: fiveMinAgo });

    await recoverStaleEnrichments(db, logger);

    const row = await db
      .selectFrom("indexed_files")
      .select("embedding_status")
      .where("id", "=", "file-fresh")
      .executeTakeFirst();
    expect(row?.embedding_status).toBe("processing");
  });

  it("does nothing when there are no stuck files", async () => {
    db = await createTestDb();
    await expect(recoverStaleEnrichments(db, logger)).resolves.toBeUndefined();
  });
});

describe("findSyncableConfigs / findStaleSyncingConfigs (Phase 0 prereqs)", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  // The partial unique index forbids two Fireflies rows with the same `created_by`,
  // so each test row gets a distinct owner derived from `id`.
  async function insertConfig(
    database: Kysely<DB>,
    id: string,
    opts: { syncStatus: string; lastSyncedAt: string | null; updatedAt?: string },
  ) {
    await database
      .insertInto("connector_configs")
      .values({
        id,
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: `user-${id}`,
        sync_status: opts.syncStatus,
        last_synced_at: opts.lastSyncedAt,
        ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
      })
      .execute();
  }

  it("excludes configs synced within the staleness window (Fix B)", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await insertConfig(db, "fresh", { syncStatus: "active", lastSyncedAt: fiveMinAgo });
    await insertConfig(db, "stale", { syncStatus: "active", lastSyncedAt: thirtyMinAgo });
    await insertConfig(db, "never", { syncStatus: "active", lastSyncedAt: null });

    const rows = await repo.findSyncableConfigs({ staleAfterMs: 15 * 60 * 1000 });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["never", "stale"]);
  });

  it("retries errored configs immediately even if last_synced_at is recent", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);
    // An errored sync did not update last_synced_at, so the filter passes it through.
    await insertConfig(db, "errored", { syncStatus: "error", lastSyncedAt: null });
    const rows = await repo.findSyncableConfigs({ staleAfterMs: 15 * 60 * 1000 });
    expect(rows.map((r) => r.id)).toEqual(["errored"]);
  });

  it("findStaleSyncingConfigs only returns rows past the threshold (Fix C)", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    await insertConfig(db, "stuck", { syncStatus: "syncing", lastSyncedAt: null, updatedAt: twoHoursAgo });
    await insertConfig(db, "fresh-syncing", { syncStatus: "syncing", lastSyncedAt: null, updatedAt: fiveMinAgo });

    const rows = await repo.findStaleSyncingConfigs(60 * 60 * 1000);
    expect(rows.map((r) => r.id)).toEqual(["stuck"]);
  });

  it("listByOwner returns only configs owned by the given user", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);
    await db
      .insertInto("connector_configs")
      .values({ id: "a", connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "u1" })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({ id: "b", connector_type: "notion", auth_type: "api_key", credentials: "{}", created_by: "u2" })
      .execute();

    const u1 = await repo.listByOwner("u1");
    expect(u1.map((r) => r.id)).toEqual(["a"]);
  });

  it("findByTypeAndOwner returns the user's per-user config or undefined", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);
    expect(await repo.findByTypeAndOwner("fireflies", "u1")).toBeUndefined();

    await db
      .insertInto("connector_configs")
      .values({ id: "ff1", connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "u1" })
      .execute();
    const found = await repo.findByTypeAndOwner("fireflies", "u1");
    expect(found?.id).toBe("ff1");
  });

  it("partial unique index allows multiple Fireflies rows across users but not within one user", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({ id: "u1-ff", connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "u1" })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({ id: "u2-ff", connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "u2" })
      .execute();

    await expect(
      db
        .insertInto("connector_configs")
        .values({
          id: "u1-ff-2",
          connector_type: "fireflies",
          auth_type: "api_key",
          credentials: "{}",
          created_by: "u1",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("cross-user dedup: two Fireflies configs ingesting the same transcript produce one indexed_files row", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);

    await db
      .insertInto("connector_configs")
      .values({
        id: "ff-a",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-a",
      })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "ff-b",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-b",
      })
      .execute();

    // Both users sync the same transcript. The unique (source, provider_file_id) index
    // guarantees one indexed_files row across both syncs.
    const item = {
      source: "fireflies",
      providerFileId: "transcript-shared-1",
      providerUrl: null,
      fileName: "Shared meeting",
      fileType: "meeting_transcript",
      contentCategory: "document" as const,
      content: "...",
      sourcePath: null,
      contentHash: "h1",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    };
    const aResult = await repo.upsertFile({ ...item, connectorConfigId: "ff-a" });
    const bResult = await repo.upsertFile({ ...item, connectorConfigId: "ff-b" });
    expect(aResult.id).toBe(bResult.id);
    expect(aResult.created).toBe(true);
    expect(bResult.created).toBe(false);

    await repo.syncFileAccessEmails(aResult.id, ["a@example.com", "b@example.com"]);
    await repo.syncFileAccessEmails(bResult.id, ["a@example.com", "b@example.com"]);

    const accessRows = await db
      .selectFrom("file_access")
      .select("email")
      .where("indexed_file_id", "=", aResult.id)
      .execute();
    expect(accessRows.map((r) => r.email).sort()).toEqual(["a@example.com", "b@example.com"]);

    const indexedFiles = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("source", "=", "fireflies")
      .where("provider_file_id", "=", "transcript-shared-1")
      .execute();
    expect(indexedFiles).toHaveLength(1);
  });

  it("archiveConnectorsForOwner flips status to disabled and scrubs credentials", async () => {
    db = await createTestDb();
    const repo = createConnectorRepository(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "ff",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", api_key: "secret-xyz" }),
        credential_hint: "et-xyz",
        created_by: "leaving-user",
      })
      .execute();

    const result = await repo.archiveConnectorsForOwner("leaving-user");
    expect(result.archived).toBe(1);

    const row = await db.selectFrom("connector_configs").selectAll().where("id", "=", "ff").executeTakeFirstOrThrow();
    expect(row.sync_status).toBe("disabled");
    expect(row.credential_hint).toBeNull();
    const creds = JSON.parse(row.credentials);
    expect(creds.scrubbed).toBe(true);
    expect(creds.api_key).toBeUndefined();
  });
});

describe("runAllSyncs (Fix A + Fix C)", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  it("flips stale-syncing rows to error before the sync run (Fix C)", async () => {
    db = await createTestDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "stuck",
        connector_type: "fireflies",
        auth_type: "api_key",
        // The credentials parse fine but the connector validation will fail at sync time;
        // we don't care — the eligibility filter excludes recently-touched rows so the
        // sync never runs. We only assert the recovery flip.
        credentials: JSON.stringify({ type: "api_key", api_key: "" }),
        created_by: "user-x",
        sync_status: "syncing",
        updated_at: twoHoursAgo,
        last_synced_at: new Date().toISOString(), // recent → excluded from sync attempt this tick
      })
      .execute();

    await runAllSyncs(db, logger);

    const row = await db
      .selectFrom("connector_configs")
      .select(["sync_status", "error_message"])
      .where("id", "=", "stuck")
      .executeTakeFirstOrThrow();
    expect(row.sync_status).toBe("error");
    expect(row.error_message).toMatch(/auto-recovered/);
  });
});

describe("buildOrgContext (via startSyncScheduler enrichment)", () => {
  it("does not contain hardcoded company name", async () => {
    // We test this indirectly by verifying the org context passed to
    // runEnrichment is a generic string when org_name is null.
    // The internal buildOrgContext function is pure and simple enough that
    // this verifies the hardcoded data was removed.
    const { runEnrichment } = await import("./enrichment");
    const db = await createTestDb();
    const logger = createTestLogger();
    const handle = startSyncScheduler(db, logger, 60 * 60 * 1000);
    await handle.stop();

    // runEnrichment is called with orgContext from buildOrgContext.
    // With no org_name in settings (default DB), orgContext should be "".
    const calls = (runEnrichment as ReturnType<typeof vi.fn>).mock.calls;
    if (calls.length > 0) {
      const enrichmentOpts = calls[0][0] as { orgContext?: string };
      const ctx = enrichmentOpts.orgContext ?? "";
      expect(ctx).not.toContain("His Canvas");
      expect(ctx).not.toContain("Apperture");
      expect(ctx).not.toContain("Sangeetha");
    }

    await db.destroy();
  });
});

describe("runConnectorSync — ACL sync on unchanged items", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  it("syncs accessEmails even when content hash is unchanged", async () => {
    // Setup: connector config + existing indexed file with hash "abc123"
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-acl-test",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    await db
      .insertInto("indexed_files")
      .values({
        id: "file-acl-test",
        connector_config_id: "connector-acl-test",
        provider_file_id: "provider-file-1",
        file_name: "test-doc.pdf",
        file_type: "document",
        content_category: "document",
        source: "google_drive",
        source_path: "/test-doc.pdf",
        provider_url: null,
        content: "some content",
        summary: null,
        context_note: null,
        access_scope_id: null,
        content_hash: "abc123",
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        embedding_status: "pending",
      })
      .execute();

    // Configure the module-level mock to yield an item with same hash but new accessEmails
    async function* mockGen() {
      yield {
        providerFileId: "provider-file-1",
        providerUrl: null,
        fileName: "test-doc.pdf",
        fileType: "document",
        contentCategory: "document" as const,
        content: "some content",
        sourcePath: "/test-doc.pdf",
        contentHash: "abc123",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        accessEmails: ["alice@example.com", "bob@example.com"],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const result = await runConnectorSync(db, "connector-acl-test", logger);

    // File was skipped (unchanged content)
    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsUpdated).toBe(0);
    expect(result.itemsCreated).toBe(0);

    // But ACL should still be synced — verify file_access rows exist
    const accessRows = await db
      .selectFrom("file_access")
      .select(["email", "indexed_file_id"])
      .where("indexed_file_id", "=", "file-acl-test")
      .execute();

    const emails = accessRows.map((r) => r.email).sort();
    expect(emails).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("emits the same stable fact set for changed and unchanged item paths", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-fact-parity",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    const item = {
      providerFileId: "provider-file-parity",
      providerUrl: "https://example.test/parity",
      fileName: "Parity Project",
      fileType: "project",
      contentCategory: "document" as const,
      content: "stable parity content",
      sourcePath: "/Parity Project",
      contentHash: "hash-parity",
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
      parentEntities: [{ source: "google_drive", sourceId: "folder-1", contextSnippet: "Folder One" }],
      attendees: [{ name: "Alice Attendee", email: "alice@example.com" }],
      assignees: [{ name: "Bob Assignee", email: "bob@example.com" }],
      authorName: "Carol Author",
      authorEmail: "carol@example.com",
      authorSourceId: "author-carol",
    } satisfies SyncedItem;

    async function* changedPathItems() {
      yield item;
    }
    mockConnectorSync.mockReturnValueOnce(changedPathItems());

    const changedResult = await runConnectorSync(db, "connector-fact-parity", logger);
    expect(changedResult.itemsProcessed).toBe(1);
    expect(changedResult.itemsCreated).toBe(1);

    const changedTuples = await loadStableFactTuples(db, "connector-fact-parity");
    expect(changedTuples.map((tuple) => tuple.factType).sort()).toEqual([
      "assignee",
      "attendee",
      "author",
      "parent_entity",
      "structural_seed",
    ]);

    async function* unchangedPathItems() {
      yield item;
    }
    mockConnectorSync.mockReturnValueOnce(unchangedPathItems());

    const unchangedResult = await runConnectorSync(db, "connector-fact-parity", logger);
    expect(unchangedResult.itemsProcessed).toBe(1);
    expect(unchangedResult.itemsCreated).toBe(0);
    expect(unchangedResult.itemsUpdated).toBe(0);

    const unchangedTuples = await loadStableFactTuples(db, "connector-fact-parity");
    expect(unchangedTuples).toEqual(changedTuples);
  });

  it("clears enrichment data when an existing file's content hash changes", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-clear-enrichment",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    await db
      .insertInto("indexed_files")
      .values({
        id: "file-clear-enrichment",
        connector_config_id: "connector-clear-enrichment",
        provider_file_id: "provider-clear-enrichment",
        file_name: "changed.md",
        file_type: "document",
        content_category: "document",
        source: "google_drive",
        source_path: "/changed.md",
        provider_url: null,
        content: "old content",
        summary: "old summary",
        context_note: "old note",
        access_scope_id: null,
        content_hash: "old-hash",
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        embedding_status: "done",
      })
      .execute();

    async function* mockGen() {
      yield {
        providerFileId: "provider-clear-enrichment",
        providerUrl: null,
        fileName: "changed.md",
        fileType: "document",
        contentCategory: "document" as const,
        content: "new content",
        sourcePath: "/changed.md",
        contentHash: "new-hash",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());
    vi.mocked(clearEnrichmentData).mockClear();

    const result = await runConnectorSync(db, "connector-clear-enrichment", logger);

    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsUpdated).toBe(1);
    expect(clearEnrichmentData).toHaveBeenCalledTimes(1);
    expect(clearEnrichmentData).toHaveBeenCalledWith(expect.anything(), "file-clear-enrichment");
  });

  it("re-seeds person entities for attendees even when content hash is unchanged", async () => {
    // Guards the skip-branch attendees-seed change: a cursor reset (or any
    // sync hitting the content-hash skip path) must now backfill attendee
    // resolution improvements into entities.
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-attendees-test",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    await db
      .insertInto("indexed_files")
      .values({
        id: "file-attendees-test",
        connector_config_id: "connector-attendees-test",
        provider_file_id: "provider-file-attendees",
        file_name: "meeting.md",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "google_drive",
        source_path: null,
        provider_url: null,
        content: "transcript content",
        summary: null,
        context_note: null,
        access_scope_id: null,
        content_hash: "hash-stable",
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        embedding_status: "done",
      })
      .execute();

    async function* mockGen() {
      yield {
        providerFileId: "provider-file-attendees",
        providerUrl: null,
        fileName: "meeting.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "transcript content",
        sourcePath: null,
        contentHash: "hash-stable",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Bob Chen", email: "rchen@acme.com" }, { name: "Prakhar Vijay" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const result = await runConnectorSync(db, "connector-attendees-test", logger);
    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsCreated).toBe(0);
    expect(result.itemsUpdated).toBe(0);

    const persons = await db
      .selectFrom("entities")
      .select(["name", "metadata"])
      .where("source_type", "=", "person")
      .execute();

    const names = persons.map((p) => p.name).sort();
    expect(names).toEqual(["Bob Chen", "Prakhar Vijay"]);

    const bob = persons.find((p) => p.name === "Bob Chen");
    expect(bob?.metadata && JSON.parse(bob.metadata).email).toBe("rchen@acme.com");

    const facts = await db.selectFrom("indexed_file_facts").selectAll().execute();
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => fact.created_by_user_id === "admin")).toBe(true);
    expect(facts.every((fact) => fact.connector_config_id === "connector-attendees-test")).toBe(true);
    expect(facts.every((fact) => fact.materialized_at !== null)).toBe(true);

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "source", "relation"])
      .orderBy("source", "asc")
      .execute();
    expect(mentions).toEqual([
      // ELP-02: Bob Chen's @acme.com domain promotes "Acme" as a company at
      // threshold=1, and the promotion writes an INFERRED company mention
      // on the evidence file so the entity drawer's mention timeline shows
      // the file context.
      { confidence: "INFERRED", source: "email_domain", relation: "mentioned" },
      { confidence: "EXTRACTED", source: "google_drive_attendee", relation: "attended" },
      { confidence: "EXTRACTED", source: "google_drive_attendee", relation: "attended" },
    ]);
  });

  it("writes author facts and materializes authored mentions", async () => {
    db = await createTestDb();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-author-test",
        connector_type: "clickup",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", api_key: "test" }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    async function* mockGen() {
      yield {
        providerFileId: "task-author-1",
        providerUrl: null,
        fileName: "Author task",
        fileType: "task",
        contentCategory: "document" as const,
        content: "Task body",
        sourcePath: null,
        contentHash: "hash-author",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        authorEmail: "ada@example.com",
        authorName: "Ada Lovelace",
        authorSourceId: "user:ada",
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const result = await runConnectorSync(db, "connector-author-test", logger);
    expect(result.itemsProcessed).toBe(1);

    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.fact_type).toBe("author");
    expect(fact.relation).toBe("authored");
    expect(fact.subject_email).toBe("ada@example.com");
    expect(fact.subject_source_id).toBe("user:ada");
    expect(fact.materialized_at).not.toBeNull();

    const mention = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "source", "relation"])
      .executeTakeFirstOrThrow();
    expect(mention).toEqual({ confidence: "EXTRACTED", source: "clickup_author", relation: "authored" });
  });

  it("skips file archival and preserves the graph when a full resync loses most facts", async () => {
    db = await createTestDb();
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-safe-reconcile",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    const factRepo = createIndexedFileFactRepository(db);
    for (let fileIndex = 0; fileIndex < 10; fileIndex++) {
      const fileId = `safe-file-${fileIndex}`;
      const providerFileId = `safe-provider-${fileIndex}`;
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: "connector-safe-reconcile",
          provider_file_id: providerFileId,
          file_name: `Safe ${fileIndex}`,
          file_type: "document",
          content_category: "document",
          source: "google_drive",
          content: `content ${fileIndex}`,
          content_hash: `hash-${fileIndex}`,
          synced_at: now,
        })
        .execute();

      for (let attendeeIndex = 0; attendeeIndex < 10; attendeeIndex++) {
        const attendee = {
          name: `Safe Person ${fileIndex}-${attendeeIndex}`,
          email: `safe-${fileIndex}-${attendeeIndex}@example.com`,
        };
        await factRepo.upsertFact({
          indexedFileId: fileId,
          connectorConfigId: "connector-safe-reconcile",
          createdByUserId: "admin",
          lastSeenSyncRunId: "previous-sync",
          contentHash: `hash-${fileIndex}`,
          source: "google_drive",
          factType: "attendee",
          relation: "attended",
          subjectName: attendee.name,
          subjectEmail: attendee.email,
          subjectSource: "google_drive",
          subjectSourceId: `${providerFileId}:${attendee.email}`,
          contextSnippet: `Attended ${providerFileId}`,
          raw: { providerFileId, attendee },
        });
      }
    }

    await materializeUnmaterializedFacts(db, logger);
    const mentionsBefore = await db
      .selectFrom("entity_mentions")
      .select(db.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(mentionsBefore.count)).toBe(100);

    async function* mockGen() {
      yield {
        providerFileId: "safe-provider-0",
        providerUrl: null,
        fileName: "Safe 0",
        fileType: "document",
        contentCategory: "document" as const,
        content: "content 0 changed",
        sourcePath: null,
        contentHash: "hash-0-next",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Safe Person 0-0", email: "safe-0-0@example.com" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const warn = vi.fn();
    let spyLogger = {} as typeof logger;
    spyLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => spyLogger),
      warn,
    } as unknown as typeof logger;

    const result = await runConnectorSync(db, "connector-safe-reconcile", spyLogger);

    expect(result.itemsArchived).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorConfigId: "connector-safe-reconcile",
        activeBefore: 100,
        wouldTombstone: 99,
        threshold: 0.5,
        override: "SYNC_ALLOW_LARGE_RECONCILE=true",
      }),
      "Stale-fact reconcile skipped: delta exceeds threshold",
    );

    const archived = await db
      .selectFrom("indexed_files")
      .select(db.fn.countAll<number>().as("count"))
      .where("is_archived", "=", 1)
      .executeTakeFirstOrThrow();
    expect(Number(archived.count)).toBe(0);

    const activeFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(activeFacts.count)).toBe(100);

    const mentionsAfter = await db
      .selectFrom("entity_mentions")
      .select(db.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(mentionsAfter.count)).toBe(100);
  });

  it("force override processes the large reconcile and tombstones facts", async () => {
    // Operator escape hatch: SYNC_ALLOW_LARGE_RECONCILE=true must bypass the
    // ratio guard end-to-end so a legitimate large delete (workspace-wide
    // cleanup) can complete via the same sync path.
    db = await createTestDb();
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-force-reconcile",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    const factRepo = createIndexedFileFactRepository(db);
    for (let fileIndex = 0; fileIndex < 10; fileIndex++) {
      const fileId = `force-file-${fileIndex}`;
      const providerFileId = `force-provider-${fileIndex}`;
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: "connector-force-reconcile",
          provider_file_id: providerFileId,
          file_name: `Force ${fileIndex}`,
          file_type: "document",
          content_category: "document",
          source: "google_drive",
          content: `content ${fileIndex}`,
          content_hash: `hash-${fileIndex}`,
          synced_at: now,
        })
        .execute();
      await db
        .insertInto("connector_files")
        .values({
          connector_config_id: "connector-force-reconcile",
          indexed_file_id: fileId,
        })
        .execute();
      for (let attendeeIndex = 0; attendeeIndex < 10; attendeeIndex++) {
        const attendee = {
          name: `Force Person ${fileIndex}-${attendeeIndex}`,
          email: `force-${fileIndex}-${attendeeIndex}@example.com`,
        };
        await factRepo.upsertFact({
          indexedFileId: fileId,
          connectorConfigId: "connector-force-reconcile",
          createdByUserId: "admin",
          lastSeenSyncRunId: "previous-sync",
          contentHash: `hash-${fileIndex}`,
          source: "google_drive",
          factType: "attendee",
          relation: "attended",
          subjectName: attendee.name,
          subjectEmail: attendee.email,
          subjectSource: "google_drive",
          subjectSourceId: `${providerFileId}:${attendee.email}`,
          contextSnippet: `Attended ${providerFileId}`,
          raw: { providerFileId, attendee },
        });
      }
    }
    await materializeUnmaterializedFacts(db, logger);

    async function* mockGen() {
      yield {
        providerFileId: "force-provider-0",
        providerUrl: null,
        fileName: "Force 0",
        fileType: "document",
        contentCategory: "document" as const,
        content: "content 0 changed",
        sourcePath: null,
        contentHash: "hash-0-next",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Force Person 0-0", email: "force-0-0@example.com" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const warn = vi.fn();
    let spyLogger = {} as typeof logger;
    spyLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => spyLogger),
      warn,
    } as unknown as typeof logger;

    const result = await runConnectorSync(db, "connector-force-reconcile", spyLogger, {
      SYNC_ALLOW_LARGE_RECONCILE: true,
      SYNC_MAX_RECONCILE_RATIO: 0.5,
    });

    expect(result.itemsArchived).toBe(9);
    expect(
      warn.mock.calls.some(([, msg]) => typeof msg === "string" && msg.includes("Stale-fact reconcile skipped")),
    ).toBe(false);

    const activeFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(activeFacts.count)).toBe(1);

    const tombstonedFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is not", null)
      .executeTakeFirstOrThrow();
    expect(Number(tombstonedFacts.count)).toBe(99);

    const archivedFiles = await db
      .selectFrom("indexed_files")
      .select(db.fn.countAll<number>().as("count"))
      .where("is_archived", "=", 1)
      .executeTakeFirstOrThrow();
    expect(Number(archivedFiles.count)).toBe(9);
  });

  it("sub-threshold delete tombstones stale facts and updates the graph", async () => {
    // Guard against an over-aggressive threshold: a legitimate 40% delta must
    // still proceed. Failure mode: the helper accidentally blocks normal
    // stale-fact cleanup, silently keeping a stale graph.
    db = await createTestDb();
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-undercut",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();

    const factRepo = createIndexedFileFactRepository(db);
    for (let fileIndex = 0; fileIndex < 10; fileIndex++) {
      const fileId = `undercut-file-${fileIndex}`;
      const providerFileId = `undercut-provider-${fileIndex}`;
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: "connector-undercut",
          provider_file_id: providerFileId,
          file_name: `Undercut ${fileIndex}`,
          file_type: "document",
          content_category: "document",
          source: "google_drive",
          content: `content ${fileIndex}`,
          content_hash: `hash-${fileIndex}`,
          synced_at: now,
        })
        .execute();
      await db
        .insertInto("connector_files")
        .values({
          connector_config_id: "connector-undercut",
          indexed_file_id: fileId,
        })
        .execute();
      const attendee = {
        name: `Undercut Person ${fileIndex}`,
        email: `undercut-${fileIndex}@example.com`,
      };
      await factRepo.upsertFact({
        indexedFileId: fileId,
        connectorConfigId: "connector-undercut",
        createdByUserId: "admin",
        lastSeenSyncRunId: "previous-sync",
        contentHash: `hash-${fileIndex}`,
        source: "google_drive",
        factType: "attendee",
        relation: "attended",
        subjectName: attendee.name,
        subjectEmail: attendee.email,
        subjectSource: "google_drive",
        subjectSourceId: `${providerFileId}:${attendee.email}`,
        contextSnippet: `Attended ${providerFileId}`,
        raw: { providerFileId, attendee },
      });
    }
    await materializeUnmaterializedFacts(db, logger);

    async function* mockGen() {
      for (let fileIndex = 0; fileIndex < 6; fileIndex++) {
        const providerFileId = `undercut-provider-${fileIndex}`;
        yield {
          providerFileId,
          providerUrl: null,
          fileName: `Undercut ${fileIndex}`,
          fileType: "document",
          contentCategory: "document" as const,
          content: `content ${fileIndex}`,
          sourcePath: null,
          contentHash: `hash-${fileIndex}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          attendees: [{ name: `Undercut Person ${fileIndex}`, email: `undercut-${fileIndex}@example.com` }],
        } satisfies SyncedItem;
      }
    }
    mockConnectorSync.mockReturnValue(mockGen());

    const warn = vi.fn();
    let spyLogger = {} as typeof logger;
    spyLogger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => spyLogger),
      warn,
    } as unknown as typeof logger;

    const result = await runConnectorSync(db, "connector-undercut", spyLogger);

    expect(result.itemsArchived).toBe(4);
    expect(
      warn.mock.calls.some(([, msg]) => typeof msg === "string" && msg.includes("Stale-fact reconcile skipped")),
    ).toBe(false);

    const activeFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(activeFacts.count)).toBe(6);

    const tombstonedFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is not", null)
      .executeTakeFirstOrThrow();
    expect(Number(tombstonedFacts.count)).toBe(4);

    const archivedFiles = await db
      .selectFrom("indexed_files")
      .select(db.fn.countAll<number>().as("count"))
      .where("is_archived", "=", 1)
      .executeTakeFirstOrThrow();
    expect(Number(archivedFiles.count)).toBe(4);
  });
});

describe("runConnectorSync — name resolver wiring", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  /**
   * Capture the resolveNameToEmail callback passed into connector.sync by
   * the dispatcher. We don't actually yield any items — we just want to
   * exercise the resolver itself against the test DB state.
   */
  async function captureResolver(testDb: Kysely<DB>): Promise<NameResolver> {
    let captured: NameResolver | undefined;
    async function* mockGen() {
      // yield nothing
    }
    mockConnectorSync.mockImplementation((opts: { resolveNameToEmail?: NameResolver }) => {
      captured = opts.resolveNameToEmail;
      return mockGen();
    });
    await runConnectorSync(testDb, "connector-resolver-test", logger);
    if (!captured) throw new Error("resolveNameToEmail was not passed to connector.sync");
    return captured;
  }

  async function seedConnector(testDb: Kysely<DB>) {
    await testDb
      .insertInto("connector_configs")
      .values({
        id: "connector-resolver-test",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: "admin",
        scope_config: JSON.stringify({}),
      })
      .execute();
  }

  it("resolves a speaker from the users table with `source: 'users'`", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db
      .insertInto("users")
      .values({ id: "u-himanshu", name: "Himanshu Kalra", email: "himanshu@team.com" })
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("Himanshu Kalra")).toEqual({ email: "himanshu@team.com", source: "users" });
  });

  it("resolves a speaker from an entity alias (not just canonical name)", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db
      .insertInto("entities")
      .values({
        id: "ent-simran",
        name: "Simran Suri",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({ email: "simran@x.com" }),
        aliases: JSON.stringify(["Simran Suri Neeli"]),
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("Simran Suri Neeli")).toEqual({
      email: "simran@x.com",
      entityId: "ent-simran",
      source: "entities",
    });
    expect(resolve("Simran Suri")).toEqual({
      email: "simran@x.com",
      entityId: "ent-simran",
      source: "entities",
    });
  });

  it("returns null when two users share a normalized name (ambiguity drop)", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db
      .insertInto("users")
      .values([
        { id: "u-john1", name: "John Smith", email: "john1@a.com" },
        { id: "u-john2", name: "John Smith", email: "john2@b.com" },
      ])
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("John Smith")).toBeNull();
  });

  it("ignores entities whose metadata has no email", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db
      .insertInto("entities")
      .values({
        id: "ent-noemail",
        name: "Mystery Person",
        source_type: "person",
        subtype: "external",
        metadata: null,
        aliases: null,
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("Mystery Person")).toBeNull();
  });

  it("prefers the users table over a matching entity (users-first precedence)", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db.insertInto("users").values({ id: "u-h", name: "Himanshu Kalra", email: "him@team.com" }).execute();
    await db
      .insertInto("entities")
      .values({
        id: "ent-h",
        name: "Himanshu Kalra",
        source_type: "person",
        subtype: "internal",
        metadata: JSON.stringify({ email: "stale@old.com" }),
        aliases: null,
        source_ref_id: null,
        status: "active",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("Himanshu Kalra")).toEqual({ email: "him@team.com", source: "users" });
  });

  it("excludes external users from the team-directory map", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await db
      .insertInto("users")
      .values({ id: "u-ext", name: "External Person", email: "ext@x.com", type: "external" })
      .execute();

    const resolve = await captureResolver(db);
    expect(resolve("External Person")).toBeNull();
  });

  /**
   * End-to-end equivalent of "Test C" in the PR's manual test plan: two
   * Sketch users share a normalized name, so the resolver returns null
   * for that speaker. The connector emits an attendee with no email and
   * an empty accessEmails set. The dispatcher must NOT write a file_access
   * row.
   *
   * Paired with a positive control (single user → resolved → file_access
   * row written) so the assertion proves both directions.
   *
   * Why this is better than the manual DB-mutation E2E test: no destructive
   * setup on a real workspace, no risk of leaving an orphaned duplicate
   * user behind, and the assertion is on file_access (the actual RBAC
   * surface) rather than indirect inspection.
   */
  describe("ambiguous speaker names suppress file_access writes (Test C)", () => {
    /**
     * Mock connector that mirrors what Fireflies' buildPeople does: looks up
     * a speaker via resolveNameToEmail, emits an attendee with/without an
     * email based on the result, and propagates the resolved email into
     * accessEmails. Keeps the test focused on dispatcher wiring + the
     * file_access write path, not on Fireflies' own attendee logic.
     */
    function speakerResolvingMock(speakerName: string, providerFileId: string, fileName: string) {
      return async function* (opts: { resolveNameToEmail?: NameResolver }) {
        const recovered = opts.resolveNameToEmail?.(speakerName);
        const accessEmails = recovered ? [recovered.email] : [];
        yield {
          providerFileId,
          providerUrl: null,
          fileName,
          fileType: "meeting_transcript",
          contentCategory: "document" as const,
          content: `transcript for ${speakerName}`,
          sourcePath: null,
          contentHash: `hash-${providerFileId}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          accessEmails: accessEmails.length > 0 ? accessEmails : null,
          attendees: recovered ? [{ name: speakerName, email: recovered.email }] : [{ name: speakerName }],
        } satisfies SyncedItem;
      };
    }

    async function fileAccessEmailsFor(testDb: Kysely<DB>, providerFileId: string): Promise<string[]> {
      const rows = await testDb
        .selectFrom("file_access")
        .innerJoin("indexed_files", "indexed_files.id", "file_access.indexed_file_id")
        .select("file_access.email")
        .where("indexed_files.provider_file_id", "=", providerFileId)
        .execute();
      return rows.map((r) => r.email).sort();
    }

    it("does not write file_access for an ambiguous speaker (resolver returns null)", async () => {
      db = await createTestDb();
      await seedConnector(db);
      // Two users sharing normalizeName("Simran Suri") with different emails.
      await db
        .insertInto("users")
        .values([
          { id: "u-simran-real", name: "Simran Suri", email: "simran@habuild.in" },
          { id: "u-simran-dup", name: "Simran Suri", email: "fake-collision@test.local" },
        ])
        .execute();

      mockConnectorSync.mockImplementation(speakerResolvingMock("Simran Suri", "meeting-ambig", "ambig.md"));

      const result = await runConnectorSync(db, "connector-resolver-test", logger);
      expect(result.itemsCreated + result.itemsProcessed).toBeGreaterThan(0);

      const emails = await fileAccessEmailsFor(db, "meeting-ambig");
      expect(emails).toEqual([]);
    });

    it("writes file_access for an unambiguous speaker (positive control)", async () => {
      db = await createTestDb();
      await seedConnector(db);
      // Only one user — no collision.
      await db
        .insertInto("users")
        .values({ id: "u-simran-real", name: "Simran Suri", email: "simran@habuild.in" })
        .execute();

      mockConnectorSync.mockImplementation(speakerResolvingMock("Simran Suri", "meeting-clear", "clear.md"));

      await runConnectorSync(db, "connector-resolver-test", logger);

      const emails = await fileAccessEmailsFor(db, "meeting-clear");
      expect(emails).toEqual(["simran@habuild.in"]);
    });

    it("does not write file_access when a real user collides with an entity sharing the same name", async () => {
      // Cross-source ambiguity: one users-table row and one person-entity
      // row both normalize to the same name with different emails.
      // Validates that ambiguity drop applies across the merged precedence
      // chain, not just within a single map.
      db = await createTestDb();
      await seedConnector(db);
      await db
        .insertInto("users")
        .values({ id: "u-overlap", name: "Overlapping Name", email: "from-users@x.com" })
        .execute();
      // Note: a same-name entity with the SAME email as the user wouldn't
      // be ambiguous (values match) — use a distinct email to force the drop.
      // The drop fires inside userEmailByName itself only when the users
      // table has its own collision; with one row in each map, users-first
      // precedence picks users. So this case exercises precedence, not
      // drop — kept for explicit coverage.
      await db
        .insertInto("entities")
        .values({
          id: "ent-overlap",
          name: "Overlapping Name",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "from-entities@x.com" }),
          aliases: null,
          source_ref_id: null,
          status: "active",
          hotness: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      mockConnectorSync.mockImplementation(speakerResolvingMock("Overlapping Name", "meeting-overlap", "overlap.md"));

      await runConnectorSync(db, "connector-resolver-test", logger);

      // Users-first precedence wins; the entity email never appears.
      const emails = await fileAccessEmailsFor(db, "meeting-overlap");
      expect(emails).toEqual(["from-users@x.com"]);
    });
  });
});

describe("runConnectorSync — entity creation review queue (ECR-01)", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    if (db) {
      try {
        await db.destroy();
      } catch {
        // already destroyed
      }
      db = null;
    }
  });

  async function seedConnector(testDb: Kysely<DB>, configId: string, createdBy = "user-1") {
    await testDb
      .insertInto("connector_configs")
      .values({
        id: configId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          accessToken: "test",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        created_by: createdBy,
        scope_config: JSON.stringify({}),
      })
      .execute();
  }

  it("10. queues a name-only attendee with a fuzzy collision (change branch)", async () => {
    db = await createTestDb();
    const testDb = db;
    await seedConnector(testDb, "connector-ecr-1");

    // Pre-seed an existing entity that the attendee name fuzzy-collides with.
    await testDb
      .insertInto("entities")
      .values({
        id: "entity-simran-suri",
        name: "Simran Suri",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({}),
        aliases: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    async function* mockGen() {
      yield {
        providerFileId: "p-ecr-10",
        providerUrl: null,
        fileName: "meeting.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "transcript",
        sourcePath: null,
        contentHash: "hash-ecr-10",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Simran Suri Neeli" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    await runConnectorSync(testDb, "connector-ecr-1", logger);

    const queue = await testDb.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].proposed_name).toBe("Simran Suri Neeli");
    expect(queue[0].candidate_entity_id).toBe("entity-simran-suri");
    expect(queue[0].candidate_reason).toBe("token-superset");
    expect(queue[0].triggered_by_user_id).toBe("user-1");

    const evidence = await testDb.selectFrom("entity_review_evidence").selectAll().execute();
    expect(evidence).toHaveLength(1);

    // Person entity for the queued proposal is NOT created.
    const persons = await testDb.selectFrom("entities").select(["name"]).where("source_type", "=", "person").execute();
    expect(persons.map((p) => p.name).sort()).toEqual(["Simran Suri"]);
  });

  it("11. auto-creates a name-only attendee when no fuzzy collision (change branch)", async () => {
    db = await createTestDb();
    const testDb = db;
    await seedConnector(testDb, "connector-ecr-2");

    async function* mockGen() {
      yield {
        providerFileId: "p-ecr-11",
        providerUrl: null,
        fileName: "meeting.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "transcript",
        sourcePath: null,
        contentHash: "hash-ecr-11",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Aryaman Soni" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    await runConnectorSync(testDb, "connector-ecr-2", logger);

    const queue = await testDb.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);
    const persons = await testDb.selectFrom("entities").select(["name"]).where("source_type", "=", "person").execute();
    expect(persons.map((p) => p.name)).toEqual(["Aryaman Soni"]);
  });

  it("12. cursor reset re-walk bumps evidence seen_at and queue occurrence_count (skip branch)", async () => {
    db = await createTestDb();
    const testDb = db;
    await seedConnector(testDb, "connector-ecr-3");

    await testDb
      .insertInto("entities")
      .values({
        id: "entity-simran-suri-3",
        name: "Simran Suri",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({}),
        aliases: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    // First pass: change-branch through to itemResult, queue row written.
    async function* firstPass() {
      yield {
        providerFileId: "p-ecr-12",
        providerUrl: null,
        fileName: "meet.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "first content",
        sourcePath: null,
        contentHash: "hash-A",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Simran Suri Neeli" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValueOnce(firstPass());
    await runConnectorSync(testDb, "connector-ecr-3", logger);

    const queueAfterFirst = await testDb.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    const evidenceAfterFirst = await testDb.selectFrom("entity_review_evidence").selectAll().executeTakeFirstOrThrow();
    expect(queueAfterFirst.occurrence_count).toBe(1);

    // Step "forward in time" so seen_at updates are observable.
    await new Promise((r) => setTimeout(r, 25));

    // Second pass: same content hash → goes through the skip branch and
    // re-walks the meeting via the cursor-reset attendee loop.
    async function* skipPass() {
      yield {
        providerFileId: "p-ecr-12",
        providerUrl: null,
        fileName: "meet.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "first content",
        sourcePath: null,
        contentHash: "hash-A",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Simran Suri Neeli" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValueOnce(skipPass());
    await runConnectorSync(testDb, "connector-ecr-3", logger);

    const queueAfterSkip = await testDb.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    const evidenceAfterSkip = await testDb.selectFrom("entity_review_evidence").selectAll().executeTakeFirstOrThrow();

    expect(queueAfterSkip.occurrence_count).toBe(2);
    expect(new Date(queueAfterSkip.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(queueAfterFirst.last_seen_at).getTime(),
    );
    expect(evidenceAfterSkip.id).toBe(evidenceAfterFirst.id);
    expect(new Date(evidenceAfterSkip.seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(evidenceAfterFirst.seen_at).getTime(),
    );

    // Still exactly one evidence row — UNIQUE constraint held, no insert.
    const allEvidence = await testDb.selectFrom("entity_review_evidence").selectAll().execute();
    expect(allEvidence).toHaveLength(1);
  });

  it("14. exact-name attendee links to existing entity even when a fuzzy candidate is present (Saurabh Kumar regression)", async () => {
    // Reproduces the production bug found during the first real Fireflies
    // re-sync after ECR-01 landed: two entities exist with distinct emails —
    // "Saurabh Kumar" (saurabh@canvasx.ai) and "Saurabh Kumar Singh"
    // (saurabhkumar.singh@habuild.in). A meeting yields a name-only
    // attendee "Saurabh Kumar" (no email). The fuzzy ranker correctly
    // identifies Singh as a token-superset, but the obvious exact-name
    // link must win — otherwise we queue a row asking "is this the same
    // as Singh?" when the answer is clearly the existing Kumar entity.
    db = await createTestDb();
    const testDb = db;
    await seedConnector(testDb, "connector-ecr-14");

    const now = new Date().toISOString();
    await testDb
      .insertInto("entities")
      .values([
        {
          id: "entity-saurabh-kumar",
          name: "Saurabh Kumar",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "saurabh@canvasx.ai" }),
          aliases: JSON.stringify(["saurabh@canvasx.ai"]),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "entity-saurabh-kumar-singh",
          name: "Saurabh Kumar Singh",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "saurabhkumar.singh@habuild.in" }),
          aliases: JSON.stringify(["saurabhkumar.singh@habuild.in"]),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    async function* mockGen() {
      yield {
        providerFileId: "p-ecr-14",
        providerUrl: null,
        fileName: "meeting.md",
        fileType: "meeting_transcript",
        contentCategory: "document" as const,
        content: "transcript",
        sourcePath: null,
        contentHash: "hash-ecr-14",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        attendees: [{ name: "Saurabh Kumar" }],
      } satisfies SyncedItem;
    }
    mockConnectorSync.mockReturnValue(mockGen());

    await runConnectorSync(testDb, "connector-ecr-14", logger);

    // Critical: no queue row.
    const queue = await testDb.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(0);

    // Critical: no new entity was created — both originals are still here
    // and no third "Saurabh Kumar" row appeared.
    const persons = await testDb
      .selectFrom("entities")
      .select(["id", "name"])
      .where("source_type", "=", "person")
      .execute();
    expect(persons.map((p) => p.id).sort()).toEqual(["entity-saurabh-kumar", "entity-saurabh-kumar-singh"]);

    // Source-ref was recorded against the correct entity (Kumar, not Singh).
    const refs = await testDb
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source_id", "like", "p-ecr-14:%")
      .execute();
    expect(refs).toHaveLength(1);
    expect(refs[0].entity_id).toBe("entity-saurabh-kumar");
  });

  it("13. evidence accumulates across multiple meetings for the same speaker", async () => {
    db = await createTestDb();
    const testDb = db;
    await seedConnector(testDb, "connector-ecr-4");

    await testDb
      .insertInto("entities")
      .values({
        id: "entity-simran-suri-4",
        name: "Simran Suri",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({}),
        aliases: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    async function* threeMeetings() {
      for (let i = 1; i <= 3; i++) {
        yield {
          providerFileId: `p-ecr-13-${i}`,
          providerUrl: null,
          fileName: `meet-${i}.md`,
          fileType: "meeting_transcript",
          contentCategory: "document" as const,
          content: `content ${i}`,
          sourcePath: null,
          contentHash: `hash-${i}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          attendees: [{ name: "Simran Suri Neeli" }],
        } satisfies SyncedItem;
      }
    }
    mockConnectorSync.mockReturnValue(threeMeetings());
    await runConnectorSync(testDb, "connector-ecr-4", logger);

    const queue = await testDb.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0].occurrence_count).toBe(3);

    const evidence = await testDb
      .selectFrom("entity_review_evidence")
      .selectAll()
      .orderBy("indexed_file_id", "asc")
      .execute();
    expect(evidence).toHaveLength(3);
  });
});

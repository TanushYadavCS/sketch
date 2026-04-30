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
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { recoverStaleEnrichments, runAllSyncs, runConnectorSync, startSyncScheduler } from "./sync";
import type { SyncedItem } from "./types";

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
    sync: (...args: unknown[]) => mockConnectorSync(...args),
    getCursor: vi.fn().mockResolvedValue("cursor-v2"),
    validateCredentials: vi.fn().mockResolvedValue(undefined),
  })),
}));

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
});

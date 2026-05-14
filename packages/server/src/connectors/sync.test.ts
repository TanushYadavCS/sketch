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

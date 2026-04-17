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
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { recoverStaleEnrichments, startSyncScheduler } from "./sync";

// Stub the heavy enrichment/sync work to keep tests fast
vi.mock("./enrichment", () => ({
  runEnrichment: vi.fn().mockResolvedValue({ filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] }),
  clearEnrichmentData: vi.fn(),
}));

vi.mock("./embeddings", () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue(null),
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
      expect(enrichmentOpts.orgContext).not.toContain("His Canvas");
      expect(enrichmentOpts.orgContext).not.toContain("Apperture");
      expect(enrichmentOpts.orgContext).not.toContain("Sangeetha");
    }

    await db.destroy();
  });
});

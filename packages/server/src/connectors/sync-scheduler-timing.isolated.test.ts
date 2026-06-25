import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { startSyncScheduler } from "./sync";

const mocks = vi.hoisted(() => ({
  connectorSync: vi.fn(),
  runEnrichment: vi.fn(),
  enrichment: {
    active: false,
    release: undefined as (() => void) | undefined,
    firstRun: true,
  },
}));

vi.mock("./registry", () => ({
  getConnector: vi.fn(() => ({
    type: "google_drive",
    promotableFileTypes: ["project"],
    sync: (...args: unknown[]) => mocks.connectorSync(...args),
    getCursor: vi.fn().mockResolvedValue("cursor-v2"),
    validateCredentials: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./enrichment", () => ({
  SCHEDULED_ENRICHMENT_MAX_FILES_PER_RUN: 50,
  SCHEDULED_ENRICHMENT_TIME_BUDGET_MS: 4 * 60 * 1000,
  clearEnrichmentData: vi.fn(),
  isEnrichmentActive: vi.fn(() => mocks.enrichment.active),
  runEnrichment: mocks.runEnrichment,
}));

describe("startSyncScheduler enrichment timing", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    vi.useRealTimers();
    mocks.connectorSync.mockReset();
    mocks.runEnrichment.mockReset();
    mocks.enrichment.active = false;
    mocks.enrichment.release = undefined;
    mocks.enrichment.firstRun = true;
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("keeps sync ticks running while scheduled enrichment is in flight", async () => {
    vi.useFakeTimers();
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "retrying-sync",
        connector_type: "google_drive",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", api_key: "test" }),
        scope_config: "{}",
        sync_status: "active",
        last_synced_at: null,
        created_by: "admin",
      })
      .execute();

    mocks.connectorSync.mockImplementation(() => {
      throw new Error("sync failed");
    });
    mocks.runEnrichment.mockImplementation(async () => {
      if (!mocks.enrichment.firstRun) {
        return { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] };
      }
      mocks.enrichment.firstRun = false;
      mocks.enrichment.active = true;
      try {
        await new Promise<void>((resolve) => {
          mocks.enrichment.release = resolve;
        });
        return { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] };
      } finally {
        mocks.enrichment.active = false;
      }
    });

    const intervalMs = 5 * 60 * 1000;
    const handle = startSyncScheduler(db, logger, intervalMs);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.waitFor(() => expect(mocks.connectorSync).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(mocks.runEnrichment).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(intervalMs);
      await vi.waitFor(() => expect(mocks.connectorSync).toHaveBeenCalledTimes(2));
      expect(mocks.runEnrichment).toHaveBeenCalledTimes(1);

      mocks.enrichment.release?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(mocks.enrichment.active).toBe(false));
    } finally {
      await handle.stop();
    }
  });
});

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runEnrichment } from "./enrichment";
import { startSyncScheduler } from "./sync";

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

describe("startSyncScheduler overlap guard", () => {
  let db: Kysely<DB> | null = null;
  const logger = createTestLogger();

  afterEach(async () => {
    vi.useRealTimers();
    mockConnectorSync.mockReset();
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("runs scheduled sync while enrichment is active", async () => {
    vi.useFakeTimers();
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "slow-sync",
        connector_type: "google_drive",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", api_key: "test" }),
        scope_config: "{}",
        sync_status: "active",
        last_synced_at: null,
        created_by: "admin",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "active-enrichment-file",
        connector_config_id: "slow-sync",
        provider_file_id: "active-enrichment-file",
        file_name: "active.txt",
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        source_path: "/active.txt",
        provider_url: null,
        content: "Alpha beta gamma delta epsilon.",
        content_hash: "active-hash",
        source_updated_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        embedding_status: "pending",
        summary_status: "pending",
      })
      .execute();

    async function* emptySync() {}
    mockConnectorSync.mockReturnValue(emptySync());

    let releaseEmbedding: (() => void) | undefined;
    const activeRun = runEnrichment({
      db,
      logger,
      embeddingProvider: {
        name: "test",
        dimensions: 3,
        supportsImages: false,
        embedTexts: async (texts) =>
          new Promise<number[][]>((resolve) => {
            releaseEmbedding = () => resolve(texts.map(() => [0, 0, 0]));
          }),
      },
      maxFilesPerRun: 1,
    });
    await vi.waitFor(() => expect(releaseEmbedding).toBeTypeOf("function"));

    const handle = startSyncScheduler(db, logger, 5 * 60 * 1000);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.waitFor(() => expect(mockConnectorSync).toHaveBeenCalledTimes(1));

      releaseEmbedding?.();
      await vi.advanceTimersByTimeAsync(0);
      await activeRun;
    } finally {
      await handle.stop();
    }
  });
});

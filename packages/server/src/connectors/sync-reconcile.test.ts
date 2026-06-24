import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { reconcileConnectorSync } from "./sync-reconcile";

type FactRepo = ReturnType<typeof createIndexedFileFactRepository>;

describe("reconcileConnectorSync", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("reports reconciled true on the normal path", async () => {
    db = await createTestDb();
    const factRepo = {
      reconcileStaleFacts: vi.fn().mockResolvedValue({
        skipped: null,
        tombstonedFactIds: [],
        affectedIndexedFileIds: [],
      }),
      clearMaterializedAtForActiveFacts: vi.fn(),
    } as unknown as FactRepo;

    const result = await reconcileConnectorSync({
      db,
      factRepo,
      connectorConfigId: "connector-normal",
      connectorType: "google_drive",
      syncRunId: "sync-1",
      seenSyncIdentityKeys: new Set(["file:seen"]),
      logger: createTestLogger(),
    });

    expect(result).toMatchObject({ reconciled: true, itemsArchived: 0, affectedIndexedFileIds: [] });
  });

  it("reports reconciled false when the large-delta guard skips", async () => {
    db = await createTestDb();
    const factRepo = {
      reconcileStaleFacts: vi.fn().mockResolvedValue({
        skipped: { ratio: 0.95, threshold: 0.5 },
        activeBefore: 100,
        wouldTombstone: 95,
        tombstonedFactIds: [],
        affectedIndexedFileIds: [],
      }),
      clearMaterializedAtForActiveFacts: vi.fn(),
    } as unknown as FactRepo;

    const result = await reconcileConnectorSync({
      db,
      factRepo,
      connectorConfigId: "connector-skip",
      connectorType: "google_drive",
      syncRunId: "sync-1",
      seenSyncIdentityKeys: new Set(["file:seen"]),
      logger: createTestLogger(),
    });

    expect(result).toMatchObject({ reconciled: false, itemsArchived: 0, affectedIndexedFileIds: [] });
  });
});

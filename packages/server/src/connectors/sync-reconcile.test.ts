import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { reconcileConnectorSync, removeConnectorSourceItems } from "./sync-reconcile";
import { IN_CLAUSE_CHUNK_SIZE } from "./sync-utils";

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

describe("removeConnectorSourceItems id chunking", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("deletes an id set larger than the IN-clause chunk size across chunk boundaries", async () => {
    db = await createTestDb();
    const connectorConfigId = "cfg-bulk-remove";
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorConfigId,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "owner",
      })
      .execute();
    const now = new Date().toISOString();
    const count = IN_CLAUSE_CHUNK_SIZE * 2 + 25;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `file-${i}`,
      connector_config_id: connectorConfigId,
      provider_file_id: `pf-${i}`,
      source: "google_drive",
      file_name: `File ${i}`,
      file_type: "doc",
      content_category: "document",
      synced_at: now,
      source_updated_at: now,
    }));
    await db.insertInto("indexed_files").values(rows).execute();

    const providerFileIds = rows.map((r) => r.provider_file_id);
    const result = await removeConnectorSourceItems({
      db,
      connectorConfigId,
      connectorType: "google_drive",
      providerFileIds,
    });

    expect(result.itemsDeleted).toBe(count);
    expect(new Set(result.affectedIndexedFileIds)).toEqual(new Set(rows.map((r) => r.id)));
    const remaining = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("connector_config_id", "=", connectorConfigId)
      .execute();
    expect(remaining).toHaveLength(0);
  });
});

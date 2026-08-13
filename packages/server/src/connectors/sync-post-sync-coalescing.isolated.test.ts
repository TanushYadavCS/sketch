import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { PostSyncGraphInputs } from "./post-sync";
import type { ConnectorType, SyncedItem } from "./types";

const coordinator = vi.hoisted(() => ({
  drain: vi.fn<(context: unknown) => Promise<void>>().mockResolvedValue(undefined),
  enqueue: vi.fn<(inputs: PostSyncGraphInputs, context: unknown) => Promise<void>>().mockResolvedValue(undefined),
}));
const syncImplementation = vi.hoisted(() => vi.fn());

vi.mock("./post-sync-coordinator", () => ({
  getPostSyncCoordinator: vi.fn(() => coordinator),
}));

vi.mock("../entities/co-mention-sweep", () => ({
  sweepCoMentionContributesTo: vi.fn().mockResolvedValue({ scannedPairs: 0 }),
}));

vi.mock("./registry", () => ({
  getConnector: vi.fn((type: ConnectorType) => ({
    type,
    sync: (options: unknown) => syncImplementation(type, options),
    syncIsCompleteSnapshot: true,
    getCursor: vi.fn().mockResolvedValue("cursor-v2"),
  })),
}));

import { runAllSyncs } from "./sync";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function item(connectorConfigId: string): SyncedItem {
  return {
    providerFileId: `provider-${connectorConfigId}`,
    providerUrl: null,
    fileName: `${connectorConfigId}.txt`,
    fileType: "document",
    contentCategory: "document",
    content: connectorConfigId,
    sourcePath: null,
    contentHash: `hash-${connectorConfigId}`,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
  };
}

async function seedConnector(db: Kysely<DB>, id: string, source: ConnectorType): Promise<void> {
  const userId = `${id}-user`;
  await db
    .insertInto("users")
    .values({ id: userId, name: id, email: `${id}@example.com` })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: source,
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "test" }),
      created_by: userId,
      scope_config: "{}",
    })
    .execute();
}

describe("scheduled post-sync collection", () => {
  let db: Kysely<DB> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    coordinator.drain.mockResolvedValue(undefined);
    coordinator.enqueue.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (db) await db.destroy();
    db = null;
  });

  it("waits for slow connectors and enqueues one union including partial-failure inputs", async () => {
    db = await createTestDb();
    await seedConnector(db, "connector-a", "google_drive");
    await seedConnector(db, "connector-b", "clickup");
    await seedConnector(db, "connector-c", "fireflies");
    const slow = deferred();

    syncImplementation.mockImplementation((source: ConnectorType, value: unknown) => {
      const options = value as { connectorConfigId: string };
      return (async function* () {
        if (options.connectorConfigId === "connector-c") await slow.promise;
        yield item(options.connectorConfigId);
        if (options.connectorConfigId === "connector-b") throw new Error("partial failure");
      })();
    });

    const run = runAllSyncs(db, createTestLogger());
    await vi.waitFor(() => expect(syncImplementation).toHaveBeenCalledTimes(3));
    expect(coordinator.enqueue).not.toHaveBeenCalled();
    slow.resolve();
    await run;

    expect(coordinator.enqueue).toHaveBeenCalledTimes(1);
    const collected = coordinator.enqueue.mock.calls[0][0];
    expect([...collected.affectedIndexedFileIds].sort()).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    const files = await db.selectFrom("indexed_files").select(["id", "connector_config_id"]).execute();
    expect(new Set(collected.affectedIndexedFileIds)).toEqual(new Set(files.map((file) => file.id)));
    expect(new Set(collected.sources)).toEqual(new Set(["google_drive", "clickup", "fireflies"]));
    expect(collected.workCycleReconciles).toHaveLength(2);
    expect(new Set(collected.workCycleReconciles.map((input) => input.connectorConfigId))).toEqual(
      new Set(["connector-a", "connector-c"]),
    );

    const configs = await db
      .selectFrom("connector_configs")
      .select(["id", "sync_status", "sync_cursor"])
      .orderBy("id")
      .execute();
    expect(configs).toEqual([
      { id: "connector-a", sync_status: "active", sync_cursor: "cursor-v2" },
      { id: "connector-b", sync_status: "error", sync_cursor: null },
      { id: "connector-c", sync_status: "active", sync_cursor: "cursor-v2" },
    ]);
  });

  it("keeps a completed connector active with its cursor when the cycle pipeline fails and drains again next tick", async () => {
    db = await createTestDb();
    await seedConnector(db, "connector-a", "google_drive");
    syncImplementation.mockImplementation((source: ConnectorType, value: unknown) => {
      const options = value as { connectorConfigId: string };
      return (async function* () {
        yield item(options.connectorConfigId);
      })();
    });
    const failure = new Error("cycle pipeline failed");
    coordinator.enqueue.mockRejectedValueOnce(failure);

    await expect(runAllSyncs(db, createTestLogger())).resolves.toBeUndefined();
    const config = await db
      .selectFrom("connector_configs")
      .select(["sync_status", "sync_cursor", "last_synced_at", "error_message"])
      .where("id", "=", "connector-a")
      .executeTakeFirstOrThrow();
    expect(config).toEqual({
      sync_status: "active",
      sync_cursor: "cursor-v2",
      last_synced_at: expect.any(String),
      error_message: null,
    });

    await expect(runAllSyncs(db, createTestLogger())).resolves.toBeUndefined();
    expect(coordinator.drain).toHaveBeenCalledTimes(1);
  });
});

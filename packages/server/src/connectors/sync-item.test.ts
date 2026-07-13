import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { getSyncIdentity, syncIdentityKey } from "./sync-identity";
import { loadExistingContentHashes } from "./sync-item";

describe("loadExistingContentHashes config scoping", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function insertConfig(id: string, connectorType: string): Promise<void> {
    await db
      ?.insertInto("connector_configs")
      .values({
        id,
        connector_type: connectorType,
        auth_type: "oauth",
        credentials: "{}",
        created_by: "owner",
      })
      .execute();
  }

  async function insertFile(row: {
    id: string;
    connectorConfigId: string;
    source: string;
    providerFileId: string;
    providerMessageId: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await db
      ?.insertInto("indexed_files")
      .values({
        id: row.id,
        connector_config_id: row.connectorConfigId,
        provider_file_id: row.providerFileId,
        provider_message_id: row.providerMessageId,
        source: row.source,
        file_name: row.id,
        file_type: "doc",
        content_category: "document",
        content_hash: `hash-${row.id}`,
        synced_at: now,
        source_updated_at: now,
      })
      .execute();
  }

  it("excludes another config's message-keyed rows from the map", async () => {
    db = await createTestDb();
    await insertConfig("cfg-a", "outlook");
    await insertConfig("cfg-b", "outlook");
    await insertFile({
      id: "file-a",
      connectorConfigId: "cfg-a",
      source: "outlook",
      providerFileId: "graph-a",
      providerMessageId: "<msg-a@example.com>",
    });
    await insertFile({
      id: "file-b",
      connectorConfigId: "cfg-b",
      source: "outlook",
      providerFileId: "graph-b",
      providerMessageId: "<msg-b@example.com>",
    });

    const map = await loadExistingContentHashes(db, "outlook", "cfg-b");

    const ownKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-b",
        connectorType: "outlook",
        providerFileId: "graph-b",
        providerMessageId: "<msg-b@example.com>",
      }),
    );
    const otherKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-a",
        connectorType: "outlook",
        providerFileId: "graph-a",
        providerMessageId: "<msg-a@example.com>",
      }),
    );
    expect(map.get(ownKey)?.id).toBe("file-b");
    expect(map.has(otherKey)).toBe(false);
  });

  it("retains another config's globally-deduped provider_file_id rows for cross-config dedup", async () => {
    db = await createTestDb();
    await insertConfig("cfg-a", "google_drive");
    await insertConfig("cfg-b", "google_drive");
    await insertFile({
      id: "file-shared",
      connectorConfigId: "cfg-a",
      source: "google_drive",
      providerFileId: "shared-pf",
      providerMessageId: null,
    });

    const map = await loadExistingContentHashes(db, "google_drive", "cfg-b");

    const sharedKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-b",
        connectorType: "google_drive",
        providerFileId: "shared-pf",
        providerMessageId: null,
      }),
    );
    expect(map.get(sharedKey)?.id).toBe("file-shared");
  });
});

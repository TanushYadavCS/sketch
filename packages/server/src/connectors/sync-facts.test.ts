import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { emitFactsForSyncedItem } from "./sync-facts";
import type { Connector } from "./types";

describe("emitFactsForSyncedItem contact points", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("emits contact point facts from synced items", async () => {
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        name: "User One",
        email: "user@example.com",
        password_hash: "hash",
      })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "config-1",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-1",
        connector_config_id: "config-1",
        provider_file_id: "meeting-1",
        file_name: "meeting",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        synced_at: new Date().toISOString(),
      })
      .execute();

    const connector: Connector = {
      type: "fireflies",
      perUserAuth: false,
      requiresOAuthClientSetup: false,
      async validateCredentials() {},
      async *sync() {},
      async getCursor() {
        return null;
      },
    };

    await emitFactsForSyncedItem({
      factRepo: createIndexedFileFactRepository(db),
      connector,
      connectorType: "fireflies",
      factContext: {
        connectorConfigId: "config-1",
        createdByUserId: "user-1",
        lastSeenSyncRunId: "sync-1",
      },
      indexedFileId: "file-1",
      item: {
        providerFileId: "meeting-1",
        providerUrl: null,
        fileName: "meeting",
        fileType: "meeting_transcript",
        contentCategory: "document",
        content: null,
        sourcePath: "Meeting",
        contentHash: "hash-1",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        contactPoints: [
          {
            subjectName: "Simran Suri",
            subjectEmail: "simran@example.com",
            subjectSource: "fireflies",
            subjectSourceId: "meeting-1:simran@example.com",
            kind: "email",
            value: "simran@example.com",
            source: "fireflies",
          },
        ],
      },
    });

    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact).toMatchObject({
      indexed_file_id: "file-1",
      connector_config_id: "config-1",
      source: "fireflies",
      fact_type: "contact_point",
      relation: "contactable",
      subject_name: "Simran Suri",
      subject_email: "simran@example.com",
      subject_source: "fireflies",
      subject_source_id: "meeting-1:simran@example.com",
    });
    expect(JSON.parse(fact.raw ?? "{}").contactPoint.value).toBe("simran@example.com");
  });
});

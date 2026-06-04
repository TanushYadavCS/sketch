import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { type UpsertIndexedFileFactInput, createIndexedFileFactRepository } from "./indexed-file-facts";

describe("createIndexedFileFactRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedConnectorFacts(params: {
    connectorConfigId?: string;
    count: number;
    currentRunCount: number;
    syncRunId: string;
  }): Promise<void> {
    const connectorConfigId = params.connectorConfigId ?? "connector-1";
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: connectorConfigId,
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();

    const fileIds = Array.from({ length: Math.ceil(params.count / 10) }, (_, i) => `file-${i}`);
    for (const fileId of fileIds) {
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: connectorConfigId,
          provider_file_id: `provider-${fileId}`,
          file_name: fileId,
          file_type: "transcript",
          content_category: "transcript",
          source: "fireflies",
          synced_at: now,
        })
        .execute();
    }

    for (let i = 0; i < params.count; i++) {
      await db
        .insertInto("indexed_file_facts")
        .values({
          id: `fact-${i}`,
          indexed_file_id: fileIds[Math.floor(i / 10)] ?? fileIds[0],
          connector_config_id: connectorConfigId,
          source: "fireflies",
          fact_type: "attendee",
          relation: "attended",
          subject_name: `Person ${i}`,
          fact_key: `fact-key-${i}`,
          last_seen_sync_run_id: i < params.currentRunCount ? params.syncRunId : "previous-run",
        })
        .execute();
    }
  }

  it("rejects malformed raw payloads at write time", async () => {
    const repo = createIndexedFileFactRepository(db);

    await expect(
      repo.upsertFact({
        source: "fireflies",
        factType: "attendee",
        relation: "attended",
        subjectName: "Saurabh",
        raw: { providerFileId: "meeting-1" } as never,
      }),
    ).rejects.toThrow("attendee facts require raw.providerFileId and raw.attendee");

    await expect(
      repo.upsertFact({
        source: "notion",
        factType: "author",
        relation: "authored",
        raw: { providerFileId: "page-1", author: {} },
      }),
    ).rejects.toThrow("author facts require raw.author.email or raw.author.name");
  });

  it("stores valid raw payloads", async () => {
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });

    const row = await db.selectFrom("indexed_file_facts").select("raw").executeTakeFirstOrThrow();
    expect(JSON.parse(row.raw ?? "{}")).toEqual({ providerFileId: "meeting-1", attendee: { name: "Saurabh" } });
  });

  it("validates and stores contact point facts", async () => {
    const repo = createIndexedFileFactRepository(db);

    await expect(
      repo.upsertFact({
        source: "gmail",
        factType: "contact_point",
        relation: "contactable",
        subjectName: "Simran",
        raw: { providerFileId: "message-1", contactPoint: { kind: "email", value: "simran@example.com" } } as never,
      }),
    ).rejects.toThrow(
      "contact_point facts require subjectName, subjectSource, subjectSourceId, kind, value, and source",
    );

    await repo.upsertFact({
      source: "gmail",
      factType: "contact_point",
      relation: "contactable",
      subjectName: "Simran",
      subjectEmail: "simran@example.com",
      subjectSource: "gmail",
      subjectSourceId: "person:simran",
      raw: {
        providerFileId: "message-1",
        contactPoint: {
          subjectName: "Simran",
          subjectEmail: "simran@example.com",
          subjectSource: "gmail",
          subjectSourceId: "person:simran",
          kind: "email",
          value: "simran@example.com",
          source: "gmail",
        },
      },
    });

    const row = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "raw"])
      .executeTakeFirstOrThrow();
    expect(row.fact_type).toBe("contact_point");
    expect(row.relation).toBe("contactable");
    expect(JSON.parse(row.raw ?? "{}").contactPoint.value).toBe("simran@example.com");
  });

  it("includes contact point kind and value in fact keys", async () => {
    const repo = createIndexedFileFactRepository(db);
    const base: Omit<UpsertIndexedFileFactInput, "raw"> = {
      source: "gmail",
      factType: "contact_point",
      relation: "contactable",
      subjectName: "Simran",
      subjectSource: "gmail",
      subjectSourceId: "person:simran",
    };

    await repo.upsertFact({
      ...base,
      raw: {
        providerFileId: "message-1",
        contactPoint: {
          subjectName: "Simran",
          subjectSource: "gmail",
          subjectSourceId: "person:simran",
          kind: "email",
          value: "simran@example.com",
          source: "gmail",
        },
      },
    });
    await repo.upsertFact({
      ...base,
      raw: {
        providerFileId: "message-1",
        contactPoint: {
          subjectName: "Simran",
          subjectSource: "gmail",
          subjectSourceId: "person:simran",
          kind: "linkedin",
          value: "simran-suri",
          source: "gmail",
        },
      },
    });

    const rows = await db.selectFrom("indexed_file_facts").select("id").execute();
    expect(rows).toHaveLength(2);
  });

  it("deduplicates facts when subject email only differs by whitespace", async () => {
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectEmail: " Saurabh@CanvasX.ai ",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });
    await repo.upsertFact({
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectEmail: "saurabh@canvasx.ai",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });

    const rows = await db.selectFrom("indexed_file_facts").select(["subject_email"]).execute();
    expect(rows).toEqual([{ subject_email: "saurabh@canvasx.ai" }]);
  });

  it("includes content hash in LLM extraction fact keys", async () => {
    const repo = createIndexedFileFactRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        name: "Admin",
        email: "admin@example.com",
        email_verified_at: now,
        password_hash: "hash",
        auth_role: "admin",
      })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-1",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-1",
        connector_config_id: "connector-1",
        provider_file_id: "doc-1",
        file_name: "Notes",
        file_type: "text",
        content_category: "document",
        source: "google_drive",
        content_hash: "hash-1",
        synced_at: now,
      })
      .execute();

    const base: UpsertIndexedFileFactInput = {
      indexedFileId: "file-1",
      connectorConfigId: "connector-1",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Jane Doe",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:Jane Doe",
      raw: {
        contentHash: "hash-1",
        promptVersion: "llm-extraction-v1",
        model: "gemini",
        mention: "Jane Doe",
        type: "person",
        variations: ["Jane"],
      },
    };

    await repo.upsertFact({ ...base, contentHash: "hash-1" });
    await repo.upsertFact({
      ...base,
      contentHash: "hash-2",
      raw: {
        contentHash: "hash-2",
        promptVersion: "llm-extraction-v1",
        model: "gemini",
        mention: "Jane Doe",
        type: "person",
        variations: ["Jane"],
      },
    });

    const rows = await db.selectFrom("indexed_file_facts").select(["content_hash", "fact_key"]).execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.content_hash).sort()).toEqual(["hash-1", "hash-2"]);
    expect(new Set(rows.map((r) => r.fact_key)).size).toBe(2);
  });

  it("stores owner state and resets materialization markers when a fact reappears", async () => {
    const repo = createIndexedFileFactRepository(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-1",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();

    await repo.upsertFact({
      connectorConfigId: "connector-1",
      createdByUserId: "user-1",
      lastSeenSyncRunId: "run-1",
      contentHash: "hash-1",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectSource: "fireflies",
      subjectSourceId: "meeting-1:saurabh",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });
    const first = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    await db
      .updateTable("indexed_file_facts")
      .set({ materialized_at: "2026-01-01T00:00:00.000Z", deleted_at: "2026-01-02T00:00:00.000Z" })
      .where("id", "=", first.id)
      .execute();

    await repo.upsertFact({
      connectorConfigId: "connector-1",
      createdByUserId: "user-1",
      lastSeenSyncRunId: "run-2",
      contentHash: "hash-2",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectSource: "fireflies",
      subjectSourceId: "meeting-1:saurabh",
      raw: { providerFileId: "meeting-1", attendee: { name: "Saurabh" } },
    });

    const rows = await db.selectFrom("indexed_file_facts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connector_config_id: "connector-1",
      created_by_user_id: "user-1",
      last_seen_sync_run_id: "run-2",
      content_hash: "hash-2",
      materialized_at: null,
      deleted_at: null,
    });
  });

  it("reconciles connector stale facts when the deletion ratio is under the threshold", async () => {
    const repo = createIndexedFileFactRepository(db);
    await seedConnectorFacts({ count: 100, currentRunCount: 60, syncRunId: "run-current" });

    const result = await repo.reconcileStaleFacts(
      { kind: "connector", connectorConfigId: "connector-1", syncRunId: "run-current" },
      null,
    );

    expect(result).toMatchObject({
      activeBefore: 100,
      wouldTombstone: 40,
      tombstoned: 40,
    });
    expect(result.skipped).toBeUndefined();
    expect(result.affectedIndexedFileIds.sort()).toEqual(["file-6", "file-7", "file-8", "file-9"]);

    const tombstoned = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is not", null)
      .executeTakeFirstOrThrow();
    expect(Number(tombstoned.count)).toBe(40);
  });

  it("skips connector stale fact reconciliation when the deletion ratio exceeds the threshold", async () => {
    const repo = createIndexedFileFactRepository(db);
    await seedConnectorFacts({ count: 100, currentRunCount: 5, syncRunId: "run-current" });

    const result = await repo.reconcileStaleFacts(
      { kind: "connector", connectorConfigId: "connector-1", syncRunId: "run-current" },
      null,
    );

    expect(result).toMatchObject({
      activeBefore: 100,
      wouldTombstone: 95,
      tombstoned: 0,
      affectedIndexedFileIds: [],
      skipped: { reason: "delta_exceeds_threshold", ratio: 0.95, threshold: 0.5 },
    });

    const active = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(active.count)).toBe(100);
  });

  it("ignores non-sync-tracked facts during connector stale fact reconciliation", async () => {
    const repo = createIndexedFileFactRepository(db);
    await seedConnectorFacts({ count: 10, currentRunCount: 8, syncRunId: "run-current" });
    await db
      .insertInto("indexed_file_facts")
      .values(
        Array.from({ length: 20 }, (_, i) => ({
          id: `llm-fact-${i}`,
          indexed_file_id: "file-0",
          connector_config_id: "connector-1",
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: `LLM Mention ${i}`,
          fact_key: `llm-fact-key-${i}`,
          last_seen_sync_run_id: null,
        })),
      )
      .execute();

    const result = await repo.reconcileStaleFacts(
      { kind: "connector", connectorConfigId: "connector-1", syncRunId: "run-current" },
      null,
    );

    expect(result).toMatchObject({
      activeBefore: 10,
      wouldTombstone: 2,
      tombstoned: 2,
    });

    const activeLlmFacts = await db
      .selectFrom("indexed_file_facts")
      .select(db.fn.countAll<number>().as("count"))
      .where("source", "=", "llm_extraction")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(activeLlmFacts.count)).toBe(20);
  });

  it("reconciles all file-scope stale facts when no facts were seen", async () => {
    const repo = createIndexedFileFactRepository(db);
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-1",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-1",
        connector_config_id: "connector-1",
        provider_file_id: "provider-file-1",
        file_name: "Notes",
        file_type: "document",
        content_category: "document",
        source: "google_drive",
        synced_at: now,
      })
      .execute();

    for (let i = 0; i < 5; i++) {
      await db
        .insertInto("indexed_file_facts")
        .values({
          id: `llm-fact-${i}`,
          indexed_file_id: "file-1",
          connector_config_id: "connector-1",
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: `Mention ${i}`,
          fact_key: `llm-fact-key-${i}`,
          content_hash: "hash-1",
        })
        .execute();
    }

    const result = await repo.reconcileStaleFacts(
      { kind: "file", indexedFileId: "file-1", source: "llm_extraction", factType: "llm_extracted" },
      new Set(),
    );

    expect(result).toMatchObject({
      activeBefore: 5,
      wouldTombstone: 5,
      tombstoned: 5,
      affectedIndexedFileIds: ["file-1"],
    });
    expect(result.skipped).toBeUndefined();
  });
});

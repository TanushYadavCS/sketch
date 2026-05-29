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
});

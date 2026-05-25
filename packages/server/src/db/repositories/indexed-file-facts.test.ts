import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createIndexedFileFactRepository } from "./indexed-file-facts";

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

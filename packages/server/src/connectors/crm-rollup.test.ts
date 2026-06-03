import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { refreshCrmActivityRollups } from "./crm-rollup";

const logger = createTestLogger();

describe("CRM activity rollups", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("generates incremental summaries for dirty CRM activity groups", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await seedCrmFile(db, {
      id: "deal-file",
      providerFileId: "Deals:d1",
      fileName: "Acme renewal",
      fileType: "crm_deal",
      rollupGroupId: "Deals:d1",
      contentHash: "deal-hash",
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedCrmFile(db, {
      id: "task-file",
      providerFileId: "Tasks:t1",
      fileName: "Follow up - Jane Buyer",
      fileType: "crm_task",
      rollupGroupId: "Deals:d1",
      content: "Confirm renewal paperwork.",
      contentHash: "task-hash-1",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    });
    await seedCrmFile(db, {
      id: "note-file",
      providerFileId: "Notes:n1",
      fileName: "Renewal context - Acme renewal",
      fileType: "crm_note",
      rollupGroupId: "Deals:d1",
      content: "Jane prefers annual billing.",
      contentHash: "note-hash-1",
      sourceUpdatedAt: "2026-01-03T00:00:00.000Z",
    });

    const generate = vi.fn(async (_prompt: string, opts?: { label?: string }) =>
      opts?.label?.includes(":reduce") ? "Reduced Acme activity summary" : "Chunk summary",
    );

    const first = await refreshCrmActivityRollups({
      db,
      connectorConfigId: "zoho-crm",
      dirtyGroupIds: ["Deals:d1"],
      generator: { generate },
      activityChunkSize: 1,
      logger,
    });

    expect(first).toMatchObject({ groupsConsidered: 1, groupsRefreshed: 1, groupsSkipped: 0, errors: [] });
    expect(generate).toHaveBeenCalledTimes(3);

    const summary = await db
      .selectFrom("crm_object_summaries")
      .select(["group_id", "summary", "activity_count", "basis_first_at", "basis_last_at", "basis_hash"])
      .executeTakeFirstOrThrow();
    expect(summary).toMatchObject({
      group_id: "Deals:d1",
      summary: "Reduced Acme activity summary",
      activity_count: 2,
      basis_first_at: "2026-01-02T00:00:00.000Z",
      basis_last_at: "2026-01-03T00:00:00.000Z",
    });

    const second = await refreshCrmActivityRollups({
      db,
      connectorConfigId: "zoho-crm",
      dirtyGroupIds: ["Deals:d1"],
      generator: { generate },
      activityChunkSize: 1,
      logger,
    });

    expect(second).toMatchObject({ groupsConsidered: 1, groupsRefreshed: 0, groupsSkipped: 1, errors: [] });
    expect(generate).toHaveBeenCalledTimes(3);

    await db.updateTable("indexed_files").set({ content_hash: "task-hash-2" }).where("id", "=", "task-file").execute();

    const third = await refreshCrmActivityRollups({
      db,
      connectorConfigId: "zoho-crm",
      dirtyGroupIds: ["Deals:d1"],
      generator: { generate },
      activityChunkSize: 1,
      logger,
    });

    expect(third).toMatchObject({ groupsConsidered: 1, groupsRefreshed: 1, groupsSkipped: 0, errors: [] });
    expect(generate).toHaveBeenCalledTimes(6);

    const updated = await db.selectFrom("crm_object_summaries").select("basis_hash").executeTakeFirstOrThrow();
    expect(updated.basis_hash).not.toBe(summary.basis_hash);
  });

  it("deletes a group summary when the group has no active activities", async () => {
    db = await createTestDb();
    await seedConnector(db);
    await seedCrmFile(db, {
      id: "task-file",
      providerFileId: "Tasks:t1",
      fileName: "Follow up",
      fileType: "crm_task",
      rollupGroupId: "Deals:d1",
      contentHash: "task-hash",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    });

    await refreshCrmActivityRollups({ db, connectorConfigId: "zoho-crm", dirtyGroupIds: ["Deals:d1"], logger });
    expect(await db.selectFrom("crm_object_summaries").selectAll().execute()).toHaveLength(1);

    await db.updateTable("indexed_files").set({ is_archived: 1 }).where("id", "=", "task-file").execute();
    const result = await refreshCrmActivityRollups({
      db,
      connectorConfigId: "zoho-crm",
      affectedIndexedFileIds: ["task-file"],
      logger,
    });

    expect(result).toMatchObject({ groupsConsidered: 1, groupsDeleted: 1, errors: [] });
    expect(await db.selectFrom("crm_object_summaries").selectAll().execute()).toHaveLength(0);
  });
});

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "zoho-crm",
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin-user",
    })
    .execute();
}

async function seedCrmFile(
  db: Kysely<DB>,
  file: {
    id: string;
    providerFileId: string;
    fileName: string;
    fileType: string;
    rollupGroupId: string;
    contentHash: string;
    sourceUpdatedAt: string;
    content?: string;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: file.id,
      connector_config_id: "zoho-crm",
      provider_file_id: file.providerFileId,
      provider_url: null,
      file_name: file.fileName,
      file_type: file.fileType,
      content_category: file.fileType === "crm_deal" ? "structured" : "document",
      content: file.content ?? file.fileName,
      source: "zoho_crm",
      source_path: null,
      rollup_group_id: file.rollupGroupId,
      content_hash: file.contentHash,
      source_created_at: null,
      source_updated_at: file.sourceUpdatedAt,
      synced_at: file.sourceUpdatedAt,
    })
    .execute();
}

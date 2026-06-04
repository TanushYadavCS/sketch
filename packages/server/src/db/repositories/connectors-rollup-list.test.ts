import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { type FileViewer, createConnectorRepository } from "./connectors";

const ADMIN: FileViewer = { email: null, isAdmin: true };

describe("connectors repo — CRM rollup collapse", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createConnectorRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createConnectorRepository(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg",
        connector_type: "zoho_crm",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "u",
        scope_config: "{}",
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedFile(
    providerFileId: string,
    fileType: string,
    rollupGroupId: string | null,
    contentCategory: "document" | "structured" = "structured",
  ): Promise<{ id: string }> {
    return repo.upsertFile({
      source: "zoho_crm",
      providerFileId,
      providerUrl: null,
      fileName: providerFileId,
      fileType,
      contentCategory,
      content: null,
      sourcePath: null,
      contentHash: providerFileId,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      connectorConfigId: "cfg",
      rollupGroupId,
    });
  }

  it("collapses activity members under their anchor and annotates the anchor", async () => {
    const anchor = await seedFile("Accounts:a1", "crm_account", "Accounts:a1");
    await seedFile("Tasks:t1", "crm_task", "Accounts:a1", "document"); // bodied → listed on expand
    await seedFile("Calls:c1", "crm_call", "Accounts:a1"); // bodyless reminder → counted, not listed
    await seedFile("Deals:d1", "crm_deal", "Deals:d1"); // self-anchor, no members
    await db
      .insertInto("crm_object_summaries")
      .values({
        connector_config_id: "cfg",
        group_id: "Accounts:a1",
        summary: "Acme: 2 activities, latest call.",
        activity_count: 2,
        basis_hash: "b",
        updated_at: new Date().toISOString(),
      })
      .execute();

    // Collapsed list excludes the 2 members, keeps both self-anchors.
    const collapsed = await repo.listAllFiles({ limit: 50, offset: 0, viewer: ADMIN, collapseRollups: true });
    const ids = collapsed.map((f) => f.provider_file_id).sort();
    expect(ids).toEqual(["Accounts:a1", "Deals:d1"]);

    // Uncollapsed list returns everything.
    const flat = await repo.listAllFiles({ limit: 50, offset: 0, viewer: ADMIN });
    expect(flat).toHaveLength(4);

    // Counts honor the collapse.
    expect(await repo.countAllFiles({ viewer: ADMIN, collapseRollups: true })).toBe(2);
    const bySource = await repo.countFilesBySource(ADMIN);
    expect(bySource.find((r) => r.source === "zoho_crm")?.count).toBe(2);

    // Activity counts drive the badge/expand even without a generated summary.
    await seedFile("Notes:n1", "crm_note", "Deals:d1"); // member under Deals:d1, which has NO summary
    const counts = await repo.getActivityCounts([
      { connectorConfigId: "cfg", groupId: "Accounts:a1" },
      { connectorConfigId: "cfg", groupId: "Deals:d1" },
    ]);
    expect(counts.get("cfg::Accounts:a1")).toBe(2);
    expect(counts.get("cfg::Deals:d1")).toBe(1);

    // Summary lookup is optional — present for Accounts:a1, absent for Deals:d1.
    const summaries = await repo.getRollupSummaries([
      { connectorConfigId: "cfg", groupId: "Accounts:a1" },
      { connectorConfigId: "cfg", groupId: "Deals:d1" },
    ]);
    expect(summaries.get("cfg::Accounts:a1")).toEqual({
      activityCount: 2,
      summary: "Acme: 2 activities, latest call.",
    });
    expect(summaries.get("cfg::Deals:d1")).toBeUndefined();

    // Members endpoint returns the activities, not the anchor.
    const ref = await repo.getRollupAnchorRef(anchor.id, ADMIN);
    expect(ref?.provider_file_id).toBe("Accounts:a1");
    const members = await repo.listGroupActivities({
      connectorConfigId: "cfg",
      groupId: "Accounts:a1",
      viewer: ADMIN,
      limit: 50,
      offset: 0,
    });
    // All touches are listed (bodied + bodyless) so the object's full timeline is visible.
    expect(members.map((m) => m.provider_file_id).sort()).toEqual(["Calls:c1", "Tasks:t1"]);
  });

  it("matches enriched counts to collapsed visible rows", async () => {
    await seedFile("Accounts:a1", "crm_account", "Accounts:a1");
    const member = await seedFile("Tasks:t1", "crm_task", "Accounts:a1", "document");
    await db
      .updateTable("indexed_files")
      .set({ summary: "Hidden member summary" })
      .where("id", "=", member.id)
      .execute();

    const files = await repo.listAllFiles({ limit: 50, offset: 0, viewer: ADMIN, collapseRollups: true });
    const total = await repo.countAllFiles({ viewer: ADMIN, collapseRollups: true });
    const enrichedTotal = await repo.countEnrichedFiles({ viewer: ADMIN, collapseRollups: true });

    expect(files.map((file) => file.provider_file_id)).toEqual(["Accounts:a1"]);
    expect(total).toBe(1);
    expect(enrichedTotal).toBe(0);
  });
});

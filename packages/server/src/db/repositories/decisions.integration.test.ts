import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestLogger, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { upsertDecisionFact, upsertDecisionFactsForFile } from "./decisions";
import { createEntityRepository } from "./entities";
import { createSubEntityRepository } from "./sub-entities";
import { TEST_ACCOUNT_ENTITY_ID } from "./tasks";

const USER_ID = "decision-pg-user";
const CONNECTOR_ID = "decision-pg-config";

describe("decision sub-entity supersession postgres", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("supersedes changed decisions and keeps normalized statement replays idempotent", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedProject(db, { id: "decision-project-forward", name: "Decision Project Forward" });
    await seedProject(db, { id: TEST_ACCOUNT_ENTITY_ID, name: "Test Account" });
    await seedFile(db, "decision-file-forward", "2026-06-22T09:00:00.000Z");

    await expect(
      upsertDecisionFact(db, {
        experimentalFlag: false,
        indexedFileId: "decision-file-forward",
        connectorConfigId: CONNECTOR_ID,
        createdByUserId: USER_ID,
        source: "linear",
        topic: "Pricing Tier",
        statement: "Use price A",
        parentEntityId: project.id,
        decidedAt: "2026-06-22T09:00:00.000Z",
        evidence: { fileIds: ["decision-file-forward"], entityIds: [project.id, TEST_ACCOUNT_ENTITY_ID] },
      }),
    ).resolves.toEqual({ emitted: false });
    expect(await countDecisionRows(db)).toBe(0);

    await upsertDecisionFactsForFile(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-forward",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      decisions: [
        {
          topic: "Pricing Tier",
          statement: "Use price A",
          parentEntityId: project.id,
          decidedAt: "2026-06-22T09:00:00.000Z",
          evidence: { fileIds: ["decision-file-forward"], entityIds: [project.id, TEST_ACCOUNT_ENTITY_ID] },
        },
      ],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    await upsertDecisionFactsForFile(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-forward",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      decisions: [
        {
          topic: "Pricing Tier",
          statement: "Use price B",
          parentEntityId: project.id,
          decidedAt: "2026-06-22T11:00:00.000Z",
          evidence: { fileIds: ["decision-file-forward"], entityIds: [project.id] },
        },
      ],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    let rows = await decisionRows(db, project.id, "pricing tier");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.display_name === "Use price A")).toMatchObject({
      status: "superseded",
      valid_from: "2026-06-22T09:00:00.000Z",
      valid_to: "2026-06-22T11:00:00.000Z",
    });
    expect(rows.find((row) => row.display_name === "Use price A")?.status).toBe("superseded");
    expect(rows.find((row) => row.display_name === "Use price B")).toMatchObject({
      status: "active",
      valid_from: "2026-06-22T11:00:00.000Z",
      valid_to: null,
    });

    await upsertDecisionFactsForFile(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-forward",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      decisions: [
        {
          topic: "Pricing Tier",
          statement: " use   PRICE b ",
          parentEntityId: project.id,
          decidedAt: "2026-06-22T11:00:00.000Z",
          evidence: { fileIds: ["decision-file-forward"], entityIds: [project.id] },
        },
      ],
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    rows = await decisionRows(db, project.id, "pricing tier");
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.valid_to === null)).toHaveLength(1);
  }, 30000);

  it("places out-of-order decisions into the same-day temporal interval", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedProject(db, { id: "decision-project-order", name: "Decision Project Order" });
    await seedFile(db, "decision-file-order", "2026-06-22T10:00:00.000Z");

    await upsertDecisionFact(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-order",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      topic: "Launch Date",
      statement: "Launch at noon",
      parentEntityId: project.id,
      decidedAt: "2026-06-22T12:00:00.000Z",
      evidence: { fileIds: ["decision-file-order"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    await upsertDecisionFact(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-order",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      topic: "Launch Date",
      statement: "Launch in the morning",
      parentEntityId: project.id,
      decidedAt: "2026-06-22T10:00:00.000Z",
      evidence: { fileIds: ["decision-file-order"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    const asOf = await createSubEntityRepository(db).getSubEntitiesAsOf({
      parentEntityId: project.id,
      kind: "decision",
      at: "2026-06-22T10:30:00.000Z",
    });
    const current = await createSubEntityRepository(db).listCurrentByKind({
      parentEntityId: project.id,
      kind: "decision",
    });
    const rows = await decisionRows(db, project.id, "launch date");

    expect(asOf.map((row) => row.display_name)).toEqual(["Launch in the morning"]);
    expect(current.map((row) => row.display_name)).toEqual(["Launch at noon"]);
    expect(rows.find((row) => row.display_name === "Launch in the morning")).toMatchObject({
      status: "superseded",
      valid_from: "2026-06-22T10:00:00.000Z",
      valid_to: "2026-06-22T12:00:00.000Z",
    });
    expect(rows.find((row) => row.display_name === "Launch at noon")).toMatchObject({
      status: "active",
      valid_from: "2026-06-22T12:00:00.000Z",
      valid_to: null,
    });
  }, 30000);

  it("deduplicates decisions within a parent while keeping parent scopes separate", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const projectA = await seedProject(db, { id: "decision-project-a", name: "Decision Project A" });
    const projectB = await seedProject(db, { id: "decision-project-b", name: "Decision Project B" });
    await seedFile(db, "decision-file-a1", "2026-06-22T09:00:00.000Z");
    await seedFile(db, "decision-file-a2", "2026-06-22T09:05:00.000Z");
    await seedFile(db, "decision-file-b1", "2026-06-22T09:10:00.000Z");

    await upsertDecisionFact(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-a1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      topic: "Support Model",
      statement: "Use staffed support",
      parentEntityId: projectA.id,
      decidedAt: "2026-06-22T09:00:00.000Z",
      evidence: { fileIds: ["decision-file-a1"], entityIds: [projectA.id] },
    });
    await upsertDecisionFact(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-a2",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      topic: " support   model ",
      statement: "use STAFFED support",
      parentEntityId: projectA.id,
      decidedAt: "2026-06-22T09:05:00.000Z",
      evidence: { fileIds: ["decision-file-a2"], entityIds: [projectA.id] },
    });
    await upsertDecisionFact(db, {
      experimentalFlag: true,
      indexedFileId: "decision-file-b1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      topic: "Support Model",
      statement: "Use staffed support",
      parentEntityId: projectB.id,
      decidedAt: "2026-06-22T09:10:00.000Z",
      evidence: { fileIds: ["decision-file-b1"], entityIds: [projectB.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    const projectARows = await decisionRows(db, projectA.id, "support model");
    const projectBRows = await decisionRows(db, projectB.id, "support model");
    expect(projectARows).toHaveLength(1);
    expect(projectBRows).toHaveLength(1);
    expect(projectARows[0].parent_scope_key).toBe(projectA.id);
    expect(projectBRows[0].parent_scope_key).toBe(projectB.id);
    expect(projectARows[0].valid_to).toBeNull();
    expect(projectBRows[0].valid_to).toBeNull();
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Decision PG User", email: "decision-pg-user@example.com" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
}

async function seedProject(db: Kysely<DB>, input: { id: string; name: string }) {
  const repo = createEntityRepository(db);
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: "project",
      subtype: "external",
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await repo.upsertSourceRef({ entityId: input.id, source: "linear", sourceId: `${input.id}-source` });
  return db.selectFrom("entities").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
}

async function seedFile(db: Kysely<DB>, id: string, sourceTime: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      provider_url: null,
      file_name: id,
      file_type: "issue",
      content_category: "structured",
      content: "Decision file",
      source: "linear",
      source_path: null,
      content_hash: `${id}-hash`,
      source_created_at: sourceTime,
      source_updated_at: sourceTime,
      synced_at: sourceTime,
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function decisionRows(db: Kysely<DB>, parentEntityId: string, normalizedName: string) {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "decision")
    .where("parent_entity_id", "=", parentEntityId)
    .where("normalized_name", "=", normalizedName)
    .orderBy("valid_from", "asc")
    .execute();
}

async function countDecisionRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("sub_entities")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("kind", "=", "decision")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

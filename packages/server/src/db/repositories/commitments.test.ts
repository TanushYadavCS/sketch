import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMaterializeDeps, materializeFromFact, materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestDb, createTestLogger } from "../../test-utils";
import type { DB } from "../schema";
import { listOpenCommitments, markCommitmentDone, upsertCommitmentFact } from "./commitments";
import { createEntityRepository } from "./entities";
import { createIndexedFileFactRepository } from "./indexed-file-facts";
import { createSubEntityRepository } from "./sub-entities";
import { TEST_ACCOUNT_ENTITY_ID } from "./tasks";

const USER_ID = "commitment-user";
const CONNECTOR_ID = "commitment-config";

describe("commitment sub-entities", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("keeps local commitment status across re-sync while external rows track source status", async () => {
    await seedBase(db);
    const project = await seedProject(db, { id: "commitment-project", name: "Commitment Project" });
    await seedProject(db, { id: TEST_ACCOUNT_ENTITY_ID, name: "Test Account" });

    await upsertCommitmentFact(db, {
      experimentalFlag: false,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-off",
      source: "linear",
      commitmentId: "flag-off",
      parentRef: { source: "linear", sourceId: `${project.id}-source` },
      title: "Flag-off commitment",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id] },
    });
    expect(await countRows(db, "indexed_file_facts", "commitment")).toBe(0);
    expect(await countRows(db, "sub_entities", "commitment")).toBe(0);

    await upsertCommitmentFact(db, {
      experimentalFlag: true,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-1",
      source: "linear",
      commitmentId: "commitment-1",
      parentRef: { source: "linear", sourceId: `${project.id}-source` },
      title: "Send the follow-up",
      status: "open",
      dueAt: "2026-07-01T00:00:00.000Z",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id, TEST_ACCOUNT_ENTITY_ID] },
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "commitment-1")
      .executeTakeFirstOrThrow();
    const offResult = await materializeFromFact(await buildMaterializeDeps(db, { experimentalFlag: false }), fact);
    expect(offResult).toEqual({ kind: "skipped", reason: "experimental_off" });
    expect(await countRows(db, "sub_entities", "commitment")).toBe(0);

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    expect(summary).toMatchObject({
      factsRead: 1,
      entitiesCreated: 0,
      entitiesLinked: 0,
      queued: 0,
      mentionsWritten: 0,
      relationshipsWritten: 0,
      skipped: 0,
      materialized: 1,
      deferred: 0,
      deferredBelowThreshold: 0,
    });
    let row = await currentCommitmentRow(db, "Send the follow-up");
    expect(row).toMatchObject({
      parent_entity_id: project.id,
      parent_scope_key: project.id,
      kind: "commitment",
      normalized_name: "send the follow-up",
      display_name: "Send the follow-up",
      status: "open",
      status_authority: "external",
      due_at: "2026-07-01T00:00:00.000Z",
      created_by_user_id: USER_ID,
    });
    expect(row?.valid_to).toBeNull();
    const rawAfterMaterialize = JSON.parse(
      (await db.selectFrom("indexed_file_facts").select("raw").where("id", "=", fact.id).executeTakeFirstOrThrow())
        .raw ?? "{}",
    );
    expect(rawAfterMaterialize).toMatchObject({ status: "open" });
    expect(rawAfterMaterialize.parent_entity_id).toBeUndefined();
    expect(rawAfterMaterialize.parentEntityId).toBeUndefined();

    await expect(listOpenCommitments(db, { parentEntityId: project.id })).resolves.toHaveLength(1);
    await expect(markCommitmentDone(db, "commitment-1")).resolves.toBe(true);
    await expect(listOpenCommitments(db, { parentEntityId: project.id })).resolves.toHaveLength(0);
    row = await currentCommitmentRow(db, "Send the follow-up");
    expect(row).toMatchObject({ status: "done", status_authority: "local" });

    await upsertCommitmentFact(db, {
      experimentalFlag: true,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-2",
      source: "linear",
      commitmentId: "commitment-1",
      parentRef: { source: "linear", sourceId: `${project.id}-source` },
      title: "Send the follow-up",
      status: "open",
      dueAt: "2026-07-01T00:00:00.000Z",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id] },
    });
    await createIndexedFileFactRepository(db).reconcileStaleFacts(
      { kind: "connector", connectorConfigId: CONNECTOR_ID, syncRunId: "sync-2" },
      null,
    );
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    row = await currentCommitmentRow(db, "Send the follow-up");
    expect(row).toMatchObject({ status: "done", status_authority: "local", valid_to: null });
    const rawAfterDone = JSON.parse(
      (
        await db
          .selectFrom("indexed_file_facts")
          .select("raw")
          .where("subject_source_id", "=", "commitment-1")
          .executeTakeFirstOrThrow()
      ).raw ?? "{}",
    );
    expect(rawAfterDone.status).toBe("open");

    await upsertCommitmentFact(db, {
      experimentalFlag: true,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-3",
      source: "linear",
      commitmentId: "commitment-2",
      parentEntityId: project.id,
      title: "Update the rollout note",
      status: "open",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    await upsertCommitmentFact(db, {
      experimentalFlag: true,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      lastSeenSyncRunId: "sync-4",
      source: "linear",
      commitmentId: "commitment-2",
      parentEntityId: project.id,
      title: "Update the rollout note",
      status: "dropped",
      evidence: { fileIds: ["commitment-file-1"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
    expect(await currentCommitmentRow(db, "Update the rollout note")).toMatchObject({
      status: "dropped",
      status_authority: "external",
    });
  });

  it("deduplicates commitment sub-entities within parent scope and global scope", async () => {
    await seedBase(db);
    const projectA = await seedProject(db, { id: "project-a", name: "Project A" });
    const projectB = await seedProject(db, { id: "project-b", name: "Project B" });

    await seedCommitmentFact(db, "commitment-a1", projectA.id, "Send Update");
    await seedCommitmentFact(db, "commitment-a2", projectA.id, " send   update ");
    await seedCommitmentFact(db, "commitment-b1", projectB.id, "Send Update");
    await seedCommitmentFact(db, "commitment-global-1", null, "Send Update");
    await seedCommitmentFact(db, "commitment-global-2", null, "send update");

    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    const rows = await db
      .selectFrom("sub_entities")
      .selectAll()
      .where("kind", "=", "commitment")
      .orderBy("parent_scope_key", "asc")
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.parent_scope_key).sort()).toEqual(["global", projectA.id, projectB.id].sort());
    expect(rows.every((row) => row.normalized_name === "send update")).toBe(true);

    const projectARow = rows.find((row) => row.parent_entity_id === projectA.id);
    expect(projectARow).toBeDefined();
    const evidence = await db
      .selectFrom("sub_entity_evidence")
      .select(["kind", "ref_id"])
      .where("sub_entity_id", "=", projectARow?.id ?? "")
      .where("kind", "=", "fact")
      .execute();
    expect(evidence).toHaveLength(2);
  });

  it("keeps commitment sub-entities off entity and search indexes", async () => {
    await seedBase(db);
    const project = await seedProject(db, { id: "commitment-project", name: "Commitment Project" });
    await seedCommitmentFact(db, "commitment-1", project.id, "Send the follow-up");

    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    const subEntities = await createSubEntityRepository(db).listOpenSubEntities({
      parentEntityId: project.id,
      kind: "commitment",
    });
    expect(subEntities).toHaveLength(1);
    expect(subEntities[0]).toMatchObject({
      kind: "commitment",
      display_name: "Send the follow-up",
      parent_entity_id: project.id,
    });

    await expect(
      db.selectFrom("entities").selectAll().where("name", "=", "Send the follow-up").execute(),
    ).resolves.toHaveLength(0);
    await expect(createEntityRepository(db).searchEntities("Send the follow-up")).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("indexed_files").selectAll().where("id", "=", subEntities[0].id).execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("document_chunks").selectAll().where("id", "=", subEntities[0].id).execute(),
    ).resolves.toHaveLength(0);
  });
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Commitment User",
      email: "commitment-user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
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
  await db
    .insertInto("indexed_files")
    .values({
      id: "commitment-file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "commitment-file-1",
      provider_url: null,
      file_name: "Commitment file",
      file_type: "issue",
      content_category: "structured",
      content: "Commitment file",
      source: "linear",
      source_path: null,
      content_hash: "hash-1",
      source_created_at: now,
      source_updated_at: now,
      synced_at: now,
      access_scope_id: null,
      share_with_everyone: 1,
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

async function seedCommitmentFact(
  db: Kysely<DB>,
  commitmentId: string,
  parentEntityId: string | null,
  title: string,
): Promise<void> {
  await upsertCommitmentFact(db, {
    experimentalFlag: true,
    indexedFileId: "commitment-file-1",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: "sync-1",
    source: "linear",
    commitmentId,
    parentEntityId: parentEntityId ?? undefined,
    title,
    status: "open",
    evidence: { fileIds: ["commitment-file-1"], entityIds: parentEntityId ? [parentEntityId] : [] },
  });
}

async function currentCommitmentRow(db: Kysely<DB>, displayName: string) {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "commitment")
    .where("display_name", "=", displayName)
    .where("valid_to", "is", null)
    .executeTakeFirst();
}

async function countRows(db: Kysely<DB>, table: "indexed_file_facts" | "sub_entities", kind: string): Promise<number> {
  const column = table === "indexed_file_facts" ? "fact_type" : "kind";
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where(column, "=", kind)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

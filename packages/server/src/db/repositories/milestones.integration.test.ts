import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestLogger, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { resolveCurrentMilestoneForTask, upsertMilestoneFact } from "./milestones";
import { createSubEntityRepository } from "./sub-entities";
import { createTaskRepository } from "./tasks";

const USER_ID = "milestone-pg-user";
const CONNECTOR_ID = "milestone-pg-config";

describe("milestone sub-entity supersession postgres", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("supersedes a slipped due date while preserving milestone history", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedProject(db, { id: "milestone-project-slip", name: "Milestone Project Slip" });
    await seedFile(db, "milestone-file-slip-1", "2026-06-01T09:00:00.000Z");
    await seedFile(db, "milestone-file-slip-2", "2026-06-15T09:00:00.000Z");

    await upsertMilestoneFact(db, {
      experimentalFlag: true,
      indexedFileId: "milestone-file-slip-1",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      milestoneId: "milestone-slip",
      milestoneName: "Public beta",
      parentEntityId: project.id,
      status: "planned",
      dueAt: "2026-06-30",
      observedAt: "2026-06-01T09:00:00.000Z",
      evidence: { fileIds: ["milestone-file-slip-1"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    await upsertMilestoneFact(db, {
      experimentalFlag: true,
      indexedFileId: "milestone-file-slip-2",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      milestoneId: "milestone-slip",
      milestoneName: "Public beta",
      parentEntityId: project.id,
      status: "planned",
      dueAt: "2026-09-30",
      observedAt: "2026-06-15T09:00:00.000Z",
      evidence: { fileIds: ["milestone-file-slip-2"], entityIds: [project.id] },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    const rows = await milestoneRows(db, project.id, "public beta");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      display_name: "Public beta",
      status: "planned",
      due_at: "2026-06-30",
      valid_from: "2026-06-01T09:00:00.000Z",
      valid_to: "2026-06-15T09:00:00.000Z",
    });
    expect(rows[1]).toMatchObject({
      display_name: "Public beta",
      status: "planned",
      due_at: "2026-09-30",
      valid_from: "2026-06-15T09:00:00.000Z",
      valid_to: null,
    });

    const current = await createSubEntityRepository(db).listCurrentByKind({
      parentEntityId: project.id,
      kind: "milestone",
    });
    expect(current.map((row) => row.id)).toEqual([rows[1].id]);

    const asOf = await createSubEntityRepository(db).getSubEntitiesAsOf({
      parentEntityId: project.id,
      kind: "milestone",
      at: "2026-06-10T09:00:00.000Z",
    });
    expect(asOf.map((row) => row.id)).toEqual([rows[0].id]);
  }, 30000);

  it("orders status transitions, reopened intervals, and backdated slips deterministically", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedProject(db, { id: "milestone-project-order", name: "Milestone Project Order" });
    await seedFile(db, "milestone-file-order-1", "2026-06-15T09:00:00.000Z");
    await seedFile(db, "milestone-file-order-2", "2026-07-15T09:00:00.000Z");
    await seedFile(db, "milestone-file-order-3", "2026-07-01T09:00:00.000Z");

    await emitMilestone(db, project.id, {
      fileId: "milestone-file-order-1",
      status: "planned",
      dueAt: "2026-09-30",
      observedAt: "2026-06-15T09:00:00.000Z",
    });
    await emitMilestone(db, project.id, {
      fileId: "milestone-file-order-2",
      status: "hit",
      dueAt: "2026-09-30",
      observedAt: "2026-07-15T09:00:00.000Z",
    });
    await emitMilestone(db, project.id, {
      fileId: "milestone-file-order-3",
      status: "planned",
      dueAt: "2026-12-31",
      observedAt: "2026-07-01T09:00:00.000Z",
    });

    const rows = await milestoneRows(db, project.id, "ga launch");
    expect(
      rows.map((row) => ({ status: row.status, dueAt: row.due_at, from: row.valid_from, to: row.valid_to })),
    ).toEqual([
      {
        status: "planned",
        dueAt: "2026-09-30",
        from: "2026-06-15T09:00:00.000Z",
        to: "2026-07-01T09:00:00.000Z",
      },
      {
        status: "planned",
        dueAt: "2026-12-31",
        from: "2026-07-01T09:00:00.000Z",
        to: "2026-07-15T09:00:00.000Z",
      },
      {
        status: "hit",
        dueAt: "2026-09-30",
        from: "2026-07-15T09:00:00.000Z",
        to: null,
      },
    ]);
    expect(rows.find((row) => row.valid_to === null)).toMatchObject({ status: "hit", due_at: "2026-09-30" });
  }, 30000);

  it("resolves a task milestone series link to the current interval across a slip", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const project = await seedProject(db, { id: "milestone-project-task", name: "Milestone Project Task" });
    await seedFile(db, "milestone-file-task-1", "2026-06-01T09:00:00.000Z");
    await seedFile(db, "milestone-file-task-2", "2026-06-15T09:00:00.000Z");

    await emitMilestone(db, project.id, {
      fileId: "milestone-file-task-1",
      status: "planned",
      dueAt: "2026-06-30",
      observedAt: "2026-06-01T09:00:00.000Z",
    });
    const first = await currentMilestone(db, project.id, "ga launch");
    expect(first.series_key).toBeTruthy();

    const taskResult = await createTaskRepository(db).upsertTask({
      parentEntityId: project.id,
      parentSourceRef: null,
      parentName: project.name,
      source: "linear",
      externalRef: null,
      title: "Ship the release notes",
      status: "open",
      statusRaw: "Open",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "milestone-task-1",
      createdByUserId: USER_ID,
    });
    await db
      .updateTable("tasks")
      .set({ milestone_series_key: first.series_key })
      .where("id", "=", taskResult.taskId)
      .execute();

    await emitMilestone(db, project.id, {
      fileId: "milestone-file-task-2",
      status: "planned",
      dueAt: "2026-09-30",
      observedAt: "2026-06-15T09:00:00.000Z",
    });

    const rows = await milestoneRows(db, project.id, "ga launch");
    expect(new Set(rows.map((row) => row.series_key))).toEqual(new Set([first.series_key]));
    const resolved = await resolveCurrentMilestoneForTask(db, taskResult.taskId);
    expect(resolved).toMatchObject({
      id: rows[1].id,
      due_at: "2026-09-30",
      valid_to: null,
    });
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Milestone PG User", email: "milestone-pg-user@example.com" })
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
      content: "Milestone file",
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

async function emitMilestone(
  db: Kysely<DB>,
  projectId: string,
  input: { fileId: string; status: "planned" | "hit" | "missed"; dueAt: string; observedAt: string },
): Promise<void> {
  await upsertMilestoneFact(db, {
    experimentalFlag: true,
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "linear",
    milestoneId: "milestone-ga",
    milestoneName: "GA Launch",
    parentEntityId: projectId,
    status: input.status,
    dueAt: input.dueAt,
    observedAt: input.observedAt,
    evidence: { fileIds: [input.fileId], entityIds: [projectId] },
  });
  await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });
}

async function milestoneRows(db: Kysely<DB>, parentEntityId: string, normalizedName: string) {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "milestone")
    .where("parent_entity_id", "=", parentEntityId)
    .where("normalized_name", "=", normalizedName)
    .orderBy("valid_from", "asc")
    .execute();
}

async function currentMilestone(db: Kysely<DB>, parentEntityId: string, normalizedName: string) {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("kind", "=", "milestone")
    .where("parent_entity_id", "=", parentEntityId)
    .where("normalized_name", "=", normalizedName)
    .where("valid_to", "is", null)
    .executeTakeFirstOrThrow();
}

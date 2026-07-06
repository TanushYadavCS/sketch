import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitFactsForSyncedItem } from "../connectors/sync-facts";
import type { Connector, SyncedItem } from "../connectors/types";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { TEST_ACCOUNT_ENTITY_ID, createTaskRepository } from "../db/repositories/tasks";
import { getCycleRollup } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";

const USER_ID = "task-user";
const CONNECTOR_ID = "task-config";

async function seedBase(db: Kysely<DB>, source = "linear") {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Task User",
      email: "task-user@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: source,
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "task-1",
      provider_url: null,
      file_name: "Task one",
      file_type: "issue",
      content_category: "structured",
      content: "Task one",
      source,
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

async function seedProject(db: Kysely<DB>, input: { id?: string; name: string; source: string; sourceId: string }) {
  const repo = createEntityRepository(db);
  const entity = input.id
    ? await insertEntity(db, input.id, input.name, "project")
    : await repo.upsertEntity({ name: input.name, sourceType: "project", subtype: "external" });
  await repo.upsertSourceRef({ entityId: entity.id, source: input.source, sourceId: input.sourceId });
  return entity;
}

async function seedPerson(db: Kysely<DB>, input: { id?: string; name: string; source: string; sourceId: string }) {
  const repo = createEntityRepository(db);
  const entity = input.id
    ? await insertEntity(db, input.id, input.name, "person")
    : await repo.upsertPersonEntity({
        name: input.name,
        subtype: "external",
        source: input.source,
        sourceId: input.sourceId,
      });
  if (input.id) await repo.upsertSourceRef({ entityId: entity.id, source: input.source, sourceId: input.sourceId });
  return entity;
}

async function insertEntity(db: Kysely<DB>, id: string, name: string, sourceType: string) {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
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
  return db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function upsertTaskFact(
  db: Kysely<DB>,
  input: {
    source?: string;
    sourceTaskId?: string;
    statusType: string;
    statusRaw: string;
    title?: string;
    project?: { name: string; source: string; sourceId: string };
    assignee?: { name: string; source?: string; sourceId?: string };
    fileId?: string;
    cycle?: {
      source: string;
      externalRef: string;
      name: string;
      scopeRef?: { source: string; sourceId: string };
      startsAt?: string;
      endsAt?: string;
      sequence?: number;
      isSprint: boolean;
    };
  },
) {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.fileId ?? "file-1",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: "sync-1",
    source: input.source ?? "linear",
    factType: "structural_task",
    relation: "mentioned",
    subjectName: input.title ?? "Task one",
    subjectSource: input.source ?? "linear",
    subjectSourceId: input.sourceTaskId ?? "task-1",
    raw: {
      indexedFileId: input.fileId ?? "file-1",
      task: {
        sourceTaskId: input.sourceTaskId ?? "task-1",
        externalRef: "SKE-1",
        title: input.title ?? "Task one",
        statusType: input.statusType,
        statusRaw: input.statusRaw,
        project: input.project,
        assignee: input.assignee,
        cycle: input.cycle,
      },
    },
  });
}

describe("structural task materialization", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("mirrors status, falls unknown types back to open, and resolves ClickUp folder and folderless parents", async () => {
    await seedBase(db, "linear");
    const linearProject = await seedProject(db, { name: "Sketch OSS", source: "linear", sourceId: "proj-1" });
    await upsertTaskFact(db, {
      statusType: "completed",
      statusRaw: "Done",
      project: { name: "Sketch OSS", source: "linear", sourceId: "proj-1" },
    });
    await upsertTaskFact(db, {
      sourceTaskId: "task-unknown",
      statusType: "mystery",
      statusRaw: "Needs Design",
      title: "Unknown status",
      project: { name: "Sketch OSS", source: "linear", sourceId: "proj-1" },
    });
    await seedProject(db, { name: "Delivery Folder", source: "clickup", sourceId: "folder-1" });
    await seedProject(db, { name: "Launch List", source: "clickup", sourceId: "list-1" });
    await upsertTaskFact(db, {
      source: "clickup",
      sourceTaskId: "cu-folder-task",
      statusType: "done",
      statusRaw: "closed",
      title: "Folder task",
      project: { name: "Delivery Folder", source: "clickup", sourceId: "folder-1" },
    });
    await upsertTaskFact(db, {
      source: "clickup",
      sourceTaskId: "cu-list-task",
      statusType: "custom",
      statusRaw: "In Progress",
      title: "Folderless list task",
      project: { name: "Launch List", source: "clickup", sourceId: "list-1" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    const rows = await db.selectFrom("tasks").selectAll().orderBy("source_task_id").execute();
    const byId = new Map(rows.map((row) => [row.source_task_id, row]));
    expect(byId.get("task-1")).toMatchObject({
      status: "done",
      status_authority: "external",
      status_raw: "Done",
      parent_entity_id: linearProject.id,
    });
    expect(byId.get("task-unknown")).toMatchObject({ status: "open", status_raw: "Needs Design" });
    expect(byId.get("cu-folder-task")?.parent_source_ref).toBe("clickup:folder-1");
    expect(byId.get("cu-list-task")?.parent_source_ref).toBe("clickup:list-1");
    expect(byId.get("cu-folder-task")?.parent_source_ref).not.toContain("space");
    const evidence = await db.selectFrom("task_evidence").selectAll().execute();
    expect(evidence.some((row) => row.kind === "file" && row.ref_id === "file-1")).toBe(true);
  });

  it("reanchors null parents through the sweep and resolves assignees without linking the test account", async () => {
    await seedBase(db, "linear");
    const assignee = await seedPerson(db, { name: "Priya Shah", source: "linear", sourceId: "user-1" });
    await seedPerson(db, { id: TEST_ACCOUNT_ENTITY_ID, name: "Test Account", source: "linear", sourceId: "user-test" });
    await upsertTaskFact(db, {
      statusType: "started",
      statusRaw: "In Progress",
      project: { name: "Queued Project", source: "linear", sourceId: "proj-queued" },
      assignee: { name: "Priya Shah", source: "linear", sourceId: "user-1" },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    const before = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    expect(before.parent_entity_id).toBeNull();
    expect(before.parent_source_ref).toBe("linear:proj-queued");
    expect(before.assignee_entity_id).toBe(assignee.id);
    expect(before.assignee_entity_id).not.toBe(TEST_ACCOUNT_ENTITY_ID);
    const projectCount = await db
      .selectFrom("entities")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("source_type", "=", "project")
      .executeTakeFirstOrThrow();
    expect(Number(projectCount.count)).toBe(0);

    const project = await seedProject(db, { name: "Queued Project", source: "linear", sourceId: "proj-queued" });
    const reanchored = await createTaskRepository(db).reanchorNullParentTasks();
    const after = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    expect(reanchored).toMatchObject({
      count: 1,
      taskIds: [before.id],
      indexedFileIds: ["file-1"],
      parentEntityIds: [project.id],
    });
    expect(after.parent_entity_id).toBe(project.id);
  });

  it("emits task facts, updates status idempotently, and expires deleted structural tasks", async () => {
    await seedBase(db, "linear");
    const connector = { type: "linear" } as Connector;
    const item: SyncedItem = {
      providerFileId: "task-1",
      providerUrl: null,
      fileName: "Task",
      fileType: "issue",
      contentCategory: "structured",
      content: "Task",
      sourcePath: null,
      contentHash: "hash-task",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      task: { sourceTaskId: "task-1", title: "Task", statusType: "started", statusRaw: "Started" },
    };
    await emitFactsForSyncedItem({
      factRepo: createIndexedFileFactRepository(db),
      connector,
      connectorType: "linear",
      factContext: { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: "sync-1" },
      item,
      indexedFileId: "file-1",
    });
    let factCount = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("fact_type", "=", "structural_task")
      .executeTakeFirstOrThrow();
    expect(Number(factCount.count)).toBe(1);

    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    const started = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    await upsertTaskFact(db, {
      sourceTaskId: "task-1",
      statusType: "completed",
      statusRaw: "Done",
      title: "Task renamed",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    const completedRows = await db.selectFrom("tasks").selectAll().execute();
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]).toMatchObject({
      id: started.id,
      title: "Task renamed",
      status: "done",
      valid_to: null,
    });
    expect(completedRows[0].completed_at).not.toBeNull();
    expect(completedRows[0].status_changed_at).not.toBeNull();

    await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: new Date().toISOString(), materialized_at: null })
      .where("fact_type", "=", "structural_task")
      .execute();
    const expired = await createTaskRepository(db).expireOrphanedTasks("linear");
    const expiredRow = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    const visible = await createTaskRepository(db).listTasksByParent("missing", {
      viewer: { email: "task-user@example.com", isAdmin: true },
    });
    factCount = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("fact_type", "=", "structural_task")
      .executeTakeFirstOrThrow();
    const taskCount = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(factCount.count)).toBe(1);
    expect(Number(taskCount.count)).toBe(1);
    expect(expired).toBe(1);
    expect(expiredRow.valid_to).not.toBeNull();
    expect(visible).toHaveLength(0);
  });

  it("closes an open sprint membership when a task is observed outside a sprint", async () => {
    await seedBase(db, "clickup");
    await seedProject(db, { name: "Delivery Folder", source: "clickup", sourceId: "folder-1" });
    await upsertTaskFact(db, {
      source: "clickup",
      sourceTaskId: "cu-sprint-move",
      statusType: "custom",
      statusRaw: "In Progress",
      title: "Move from sprint",
      project: { name: "Delivery Folder", source: "clickup", sourceId: "folder-1" },
      cycle: {
        source: "clickup",
        externalRef: "sprint-5",
        name: "Sprint 5",
        scopeRef: { source: "clickup", sourceId: "folder-1" },
        isSprint: true,
      },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    const cycle = await db.selectFrom("work_cycles").selectAll().executeTakeFirstOrThrow();
    const openBefore = await db
      .selectFrom("task_cycle_memberships")
      .selectAll()
      .where("cycle_id", "=", cycle.id)
      .where("removed_at", "is", null)
      .execute();
    expect(openBefore).toHaveLength(1);

    await upsertTaskFact(db, {
      source: "clickup",
      sourceTaskId: "cu-sprint-move",
      statusType: "custom",
      statusRaw: "In Progress",
      title: "Move from sprint",
      project: { name: "Delivery Folder", source: "clickup", sourceId: "folder-1" },
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    const memberships = await db
      .selectFrom("task_cycle_memberships")
      .selectAll()
      .where("cycle_id", "=", cycle.id)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].removed_at).not.toBeNull();
    await expect(db.selectFrom("work_cycles").selectAll().executeTakeFirstOrThrow()).resolves.toMatchObject({
      id: cycle.id,
      deleted_at: null,
      state: "active",
    });
    await expect(getCycleRollup(db, cycle.id)).resolves.toMatchObject({ total: 0 });
  });
});

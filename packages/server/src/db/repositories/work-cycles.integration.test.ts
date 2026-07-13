import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestLogger, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { createIndexedFileFactRepository } from "./indexed-file-facts";
import { type TaskStatus, createTaskRepository } from "./tasks";
import { assignMembership, getCycleRollup, reconcileWorkCycles, upsertWorkCycle } from "./work-cycles";

const USER_ID = "work-cycle-pg-user";
const CONNECTOR_ID = "work-cycle-pg-config";

describe("work cycle sink postgres", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("promotes sprint cycles and preserves task materialization for non-sprints", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const scope = await seedProject(db, {
      id: "work-cycle-scope",
      name: "Work Cycle Scope",
      sourceId: "scope-folder",
    });
    await seedFile(db, "work-cycle-file-sprint");

    await emitStructuralTaskFact(db, {
      fileId: "work-cycle-file-sprint",
      sourceTaskId: "work-cycle-task-sprint",
      title: "Finish sprint scope",
      cycle: {
        source: "linear",
        externalRef: "sprint-23",
        name: "Sprint 23",
        scopeRef: { source: "linear", sourceId: "scope-folder" },
        isSprint: true,
      },
      syncRunId: "sync-1",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});

    const cycle = await db.selectFrom("work_cycles").selectAll().executeTakeFirstOrThrow();
    expect(cycle).toMatchObject({
      scope_entity_id: scope.id,
      source: "linear",
      external_ref: "sprint-23",
      name: "Sprint 23",
      sequence: 23,
      state: "active",
      deleted_at: null,
      last_seen_sync_run_id: "sync-1",
      connector_config_id: CONNECTOR_ID,
    });
    expect(await tableCount(db, "work_cycles")).toBe(1);
    expect(await openMembershipCount(db, "work-cycle-task-sprint")).toBe(1);

    await emitStructuralTaskFact(db, {
      fileId: "work-cycle-file-sprint",
      sourceTaskId: "work-cycle-task-sprint",
      title: "Finish sprint scope",
      cycle: {
        source: "linear",
        externalRef: "sprint-23",
        name: "Sprint 23",
        scopeRef: { source: "linear", sourceId: "scope-folder" },
        isSprint: true,
      },
      syncRunId: "sync-1",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    expect(await tableCount(db, "work_cycles")).toBe(1);
    expect(await openMembershipCount(db, "work-cycle-task-sprint")).toBe(1);

    await seedFile(db, "work-cycle-file-nonsprint");
    await emitStructuralTaskFact(db, {
      fileId: "work-cycle-file-nonsprint",
      sourceTaskId: "work-cycle-task-nonsprint",
      title: "Stay on ordinary list",
      cycle: {
        source: "linear",
        externalRef: "ordinary-list",
        name: "Ordinary List",
        scopeRef: { source: "linear", sourceId: "scope-folder" },
        isSprint: false,
      },
      syncRunId: "sync-1",
    });
    await materializeUnmaterializedFacts(db, createTestLogger(), {});
    const nonSprintTask = await db
      .selectFrom("tasks")
      .select(["title", "source_task_id", "status"])
      .where("source_task_id", "=", "work-cycle-task-nonsprint")
      .executeTakeFirstOrThrow();
    expect(nonSprintTask).toEqual({
      title: "Stay on ordinary list",
      source_task_id: "work-cycle-task-nonsprint",
      status: "open",
    });
    expect(await tableCount(db, "work_cycles")).toBe(1);
    expect(await openMembershipCount(db, "work-cycle-task-nonsprint")).toBe(0);
  }, 30000);

  it("preserves carryover history and rejects a duplicate open membership", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const task = await seedTask(db, { sourceTaskId: "carryover-task", title: "Carry over", status: "open" });
    const cycleA = await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "linear",
      externalRef: "sprint-a",
      name: "Sprint 1",
      lastSeenSyncRunId: "sync-1",
    });
    const cycleB = await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "linear",
      externalRef: "sprint-b",
      name: "Sprint 2",
      lastSeenSyncRunId: "sync-1",
    });

    await assignMembership(db, {
      taskId: task.taskId,
      cycleId: cycleA.cycleId,
      sourceFactId: null,
      at: "2026-06-01T00:00:00.000Z",
    });
    await assignMembership(db, {
      taskId: task.taskId,
      cycleId: cycleB.cycleId,
      sourceFactId: null,
      at: "2026-06-08T00:00:00.000Z",
    });

    const memberships = await db
      .selectFrom("task_cycle_memberships")
      .selectAll()
      .where("task_id", "=", task.taskId)
      .orderBy("assigned_at", "asc")
      .execute();
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toMatchObject({ cycle_id: cycleA.cycleId, removed_at: "2026-06-08T00:00:00.000Z" });
    expect(memberships[1]).toMatchObject({ cycle_id: cycleB.cycleId, removed_at: null });
    expect(memberships.filter((row) => row.removed_at === null)).toHaveLength(1);

    await expect(
      db
        .insertInto("task_cycle_memberships")
        .values({
          id: "raw-duplicate-open-membership",
          task_id: task.taskId,
          cycle_id: cycleA.cycleId,
          assigned_at: "2026-06-09T00:00:00.000Z",
          removed_at: null,
          source_fact_id: null,
        })
        .execute(),
    ).rejects.toThrow();
  }, 30000);

  it("reconciles unseen cycles and returns current task rollups", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    const cycleA = await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "linear",
      externalRef: "sprint-rollup-a",
      name: "Sprint 10",
      lastSeenSyncRunId: "sync-1",
    });
    const cycleB = await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "linear",
      externalRef: "sprint-rollup-b",
      name: "Sprint 11",
      lastSeenSyncRunId: "sync-1",
    });
    const open = await seedTask(db, { sourceTaskId: "rollup-open", title: "Open", status: "open" });
    const progress = await seedTask(db, {
      sourceTaskId: "rollup-progress",
      title: "Progress",
      status: "in_progress",
    });
    const done = await seedTask(db, { sourceTaskId: "rollup-done", title: "Done", status: "done" });
    const dropped = await seedTask(db, { sourceTaskId: "rollup-dropped", title: "Dropped", status: "dropped" });
    const closedTask = await seedTask(db, { sourceTaskId: "rollup-closed-cycle", title: "Closed", status: "open" });

    for (const task of [open, progress, done, dropped]) {
      await assignMembership(db, {
        taskId: task.taskId,
        cycleId: cycleA.cycleId,
        sourceFactId: null,
        at: "2026-06-01T00:00:00.000Z",
      });
    }
    await assignMembership(db, {
      taskId: closedTask.taskId,
      cycleId: cycleB.cycleId,
      sourceFactId: null,
      at: "2026-06-01T00:00:00.000Z",
    });
    await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "linear",
      externalRef: "sprint-rollup-a",
      name: "Sprint 10",
      lastSeenSyncRunId: "sync-2",
    });

    const closed = await reconcileWorkCycles(db, {
      connectorConfigId: CONNECTOR_ID,
      syncRunId: "sync-2",
      at: "2026-06-15T00:00:00.000Z",
    });
    expect(closed).toBe(1);

    const rows = await db
      .selectFrom("work_cycles")
      .select(["external_ref", "state", "deleted_at"])
      .orderBy("external_ref", "asc")
      .execute();
    expect(rows).toEqual([
      { external_ref: "sprint-rollup-a", state: "active", deleted_at: null },
      { external_ref: "sprint-rollup-b", state: "closed", deleted_at: "2026-06-15T00:00:00.000Z" },
    ]);
    const bMemberships = await db
      .selectFrom("task_cycle_memberships")
      .selectAll()
      .where("cycle_id", "=", cycleB.cycleId)
      .execute();
    expect(bMemberships).toHaveLength(1);
    expect(bMemberships[0].removed_at).toBe("2026-06-15T00:00:00.000Z");
    await expect(getCycleRollup(db, cycleA.cycleId)).resolves.toEqual({
      open: 1,
      in_progress: 1,
      done: 1,
      dropped: 1,
      total: 4,
    });
  }, 30000);

  it("keeps work cycle identity scoped to connector config", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedConnector(db, "work-cycle-pg-config-b");

    const cycleA = await upsertWorkCycle(db, {
      connectorConfigId: CONNECTOR_ID,
      source: "clickup",
      externalRef: "shared-list-id",
      name: "Sprint Shared A",
      lastSeenSyncRunId: "sync-old",
    });
    const cycleB = await upsertWorkCycle(db, {
      connectorConfigId: "work-cycle-pg-config-b",
      source: "clickup",
      externalRef: "shared-list-id",
      name: "Sprint Shared B",
      lastSeenSyncRunId: "sync-old",
    });

    expect(cycleA.cycleId).not.toBe(cycleB.cycleId);
    await expect(
      db.selectFrom("work_cycles").selectAll().where("external_ref", "=", "shared-list-id").execute(),
    ).resolves.toHaveLength(2);

    await expect(
      reconcileWorkCycles(db, {
        connectorConfigId: CONNECTOR_ID,
        syncRunId: "sync-new",
        at: "2026-06-15T00:00:00.000Z",
      }),
    ).resolves.toBe(1);

    await expect(loadCycleState(db, cycleA.cycleId)).resolves.toEqual({
      state: "closed",
      deleted_at: "2026-06-15T00:00:00.000Z",
    });
    await expect(loadCycleState(db, cycleB.cycleId)).resolves.toEqual({ state: "active", deleted_at: null });

    await expect(
      reconcileWorkCycles(db, {
        connectorConfigId: "work-cycle-pg-config-b",
        syncRunId: "sync-new",
        at: "2026-06-16T00:00:00.000Z",
      }),
    ).resolves.toBe(1);
    await expect(loadCycleState(db, cycleB.cycleId)).resolves.toEqual({
      state: "closed",
      deleted_at: "2026-06-16T00:00:00.000Z",
    });
  }, 30000);
});

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Work Cycle PG User", email: "work-cycle-pg-user@example.com" })
    .execute();
  await seedConnector(db, CONNECTOR_ID);
}

async function seedConnector(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
}

async function seedProject(db: Kysely<DB>, input: { id: string; name: string; sourceId: string }) {
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
  await createEntityRepository(db).upsertSourceRef({ entityId: input.id, source: "linear", sourceId: input.sourceId });
  return db.selectFrom("entities").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
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
      content: "Work cycle file",
      source: "linear",
      source_path: null,
      content_hash: `${id}-hash`,
      source_created_at: "2026-06-01T00:00:00.000Z",
      source_updated_at: "2026-06-01T00:00:00.000Z",
      synced_at: "2026-06-01T00:00:00.000Z",
      access_scope_id: null,
      share_with_everyone: 1,
    })
    .execute();
}

async function emitStructuralTaskFact(
  db: Kysely<DB>,
  input: {
    fileId: string;
    sourceTaskId: string;
    title: string;
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
    syncRunId: string;
  },
): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: input.syncRunId,
    contentHash: `${input.fileId}-${input.syncRunId}-hash`,
    source: "linear",
    factType: "structural_task",
    relation: "mentioned",
    subjectName: input.title,
    subjectSource: "linear",
    subjectSourceId: input.sourceTaskId,
    contextSnippet: null,
    raw: {
      indexedFileId: input.fileId,
      task: {
        sourceTaskId: input.sourceTaskId,
        externalRef: input.sourceTaskId,
        title: input.title,
        statusType: "unstarted",
        statusRaw: "Unstarted",
        cycle: input.cycle,
      },
    },
  });
}

async function seedTask(
  db: Kysely<DB>,
  input: { sourceTaskId: string; title: string; status: TaskStatus },
): Promise<{ taskId: string; created: boolean }> {
  return createTaskRepository(db).upsertTask({
    parentEntityId: null,
    parentSourceRef: null,
    parentName: null,
    source: "linear",
    externalRef: input.sourceTaskId,
    title: input.title,
    status: input.status,
    statusRaw: input.status,
    statusAuthority: "external",
    assigneeEntityId: null,
    priority: null,
    dueAt: null,
    provenance: "structural",
    sourceTaskId: input.sourceTaskId,
  });
}

async function tableCount(db: Kysely<DB>, table: "tasks" | "work_cycles" | "task_cycle_memberships"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function openMembershipCount(db: Kysely<DB>, sourceTaskId: string): Promise<number> {
  const row = await db
    .selectFrom("task_cycle_memberships")
    .innerJoin("tasks", "tasks.id", "task_cycle_memberships.task_id")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("tasks.source_task_id", "=", sourceTaskId)
    .where("task_cycle_memberships.removed_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function loadCycleState(db: Kysely<DB>, id: string): Promise<{ state: string; deleted_at: string | null }> {
  return db.selectFrom("work_cycles").select(["state", "deleted_at"]).where("id", "=", id).executeTakeFirstOrThrow();
}

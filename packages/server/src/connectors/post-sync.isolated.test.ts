import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskRepository } from "../db/repositories/tasks";
import { assignMembership, upsertWorkCycle } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
import { reconcileStructuralAssigneeContributesTo } from "../entities/structural-assignee";
import { createTestDb, createTestLogger } from "../test-utils";
import { floorRetryForDomains } from "./engagement-floor";
import { runPostSyncGraphPipeline } from "./post-sync";
import { sweepDomainPromotions } from "./smart-enrichment";

vi.mock("../entities/materialize", () => ({
  materializeUnmaterializedFacts: vi.fn().mockResolvedValue({ factsRead: 0 }),
}));

vi.mock("../entities/co-mention-sweep", () => ({
  sweepCoMentionContributesTo: vi.fn().mockResolvedValue({ examined: 0, promoted: 0 }),
}));

vi.mock("../entities/structural-assignee", () => ({
  reconcileStructuralAssigneeContributesTo: vi.fn().mockResolvedValue({
    scannedPairs: 0,
    upsertedRelationships: 0,
    addedEvidence: 0,
    removedEvidence: 0,
    removedCoMentionEvidence: 0,
    removedRelationships: 0,
  }),
}));

vi.mock("./engagement-floor", () => ({
  floorRetryForDomains: vi.fn().mockResolvedValue({ processed: 0 }),
}));

vi.mock("./smart-enrichment", () => ({
  sweepDomainPromotions: vi.fn().mockResolvedValue({
    scanned: 0,
    promoted: 0,
    promotedDomains: [],
    linkedExisting: 0,
    pendingFuzzy: 0,
    worksAtCreated: 0,
  }),
}));

describe("runPostSyncGraphPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the co-mention sweep scoped to affected files and passes the configured threshold", async () => {
    const { materializeUnmaterializedFacts } = await import("../entities/materialize");
    const { sweepCoMentionContributesTo } = await import("../entities/co-mention-sweep");
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: ["file-1", "file-2"],
        sources: [],
        workCycleReconciles: [],
        coMentionContributesToThreshold: 4,
      });

      expect(materializeUnmaterializedFacts).toHaveBeenCalledTimes(1);
      expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(1);
      expect(sweepCoMentionContributesTo).toHaveBeenCalledWith(db, expect.anything(), {
        scope: { kind: "files", indexedFileIds: ["file-1", "file-2"] },
        threshold: 4,
      });
    } finally {
      await db.destroy();
    }
  });

  it("runs the structural assignee producer for affected files before the co-mention sweep", async () => {
    const { sweepCoMentionContributesTo } = await import("../entities/co-mention-sweep");
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: ["file-1", "file-2"],
        sources: [],
        workCycleReconciles: [],
        coMentionContributesToThreshold: 4,
      });

      expect(reconcileStructuralAssigneeContributesTo).toHaveBeenCalledTimes(1);
      expect(reconcileStructuralAssigneeContributesTo).toHaveBeenCalledWith(db, expect.anything(), {
        scope: { kind: "files", indexedFileIds: ["file-1", "file-2"] },
      });
      expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reconcileStructuralAssigneeContributesTo).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sweepCoMentionContributesTo).mock.invocationCallOrder[0],
      );
    } finally {
      await db.destroy();
    }
  });

  it("runs the structural assignee producer for reanchored task ids when files were not affected", async () => {
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await seedConnector(db, "connector-reanchor");
      await seedIndexedFile(db, "connector-reanchor", "old-file");
      await seedProjectWithSourceRef(db, "old-project", "Old Project", "linear", "old-project");
      const task = await createTaskRepository(db).upsertTask({
        parentEntityId: null,
        parentSourceRef: "linear:old-project",
        parentName: "Old Project",
        source: "linear",
        externalRef: "old-task",
        title: "Old task",
        status: "open",
        statusRaw: "open",
        statusAuthority: "external",
        assigneeEntityId: null,
        priority: null,
        dueAt: null,
        provenance: "structural",
        sourceTaskId: "old-task",
      });
      await createTaskRepository(db).upsertEvidence(task.taskId, "file", "old-file");
      await seedStructuralTaskFact(db, {
        connectorConfigId: "connector-reanchor",
        fileId: "old-file",
        source: "linear",
        sourceTaskId: "old-task",
      });

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        sources: [],
        workCycleReconciles: [],
      });

      expect(reconcileStructuralAssigneeContributesTo).toHaveBeenCalledTimes(1);
      expect(reconcileStructuralAssigneeContributesTo).toHaveBeenCalledWith(db, expect.anything(), {
        scope: { kind: "tasks", taskIds: [task.taskId] },
      });
    } finally {
      await db.destroy();
    }
  });

  it("passes FLOOR_RETRY_MAX_FILES_PER_DOMAIN when domain promotion triggers floor retry", async () => {
    const { materializeUnmaterializedFacts } = await import("../entities/materialize");
    const { sweepCoMentionContributesTo } = await import("../entities/co-mention-sweep");
    vi.mocked(sweepDomainPromotions).mockResolvedValueOnce({
      scanned: 1,
      promoted: 1,
      promotedDomains: ["canvasx.ai"],
      linkedExisting: 0,
      pendingFuzzy: 0,
      worksAtCreated: 0,
    });
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: ["file-1"],
        sources: [],
        workCycleReconciles: [],
        floorRetryMaxFilesPerDomain: 7,
      });

      expect(floorRetryForDomains).toHaveBeenCalledTimes(1);
      expect(floorRetryForDomains).toHaveBeenCalledWith({ db, logger: expect.anything() }, ["canvasx.ai"], {
        maxFilesPerDomain: 7,
      });
      const orderedCalls = [
        vi.mocked(materializeUnmaterializedFacts).mock.invocationCallOrder[0],
        vi.mocked(reconcileStructuralAssigneeContributesTo).mock.invocationCallOrder[0],
        vi.mocked(sweepDomainPromotions).mock.invocationCallOrder[0],
        vi.mocked(floorRetryForDomains).mock.invocationCallOrder[0],
        vi.mocked(sweepCoMentionContributesTo).mock.invocationCallOrder[0],
      ];
      expect(orderedCalls).toEqual([...orderedCalls].sort((left, right) => left - right));
    } finally {
      await db.destroy();
    }
  });

  it("runs work cycle reconcile only for full reconciled runs", async () => {
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await seedConnector(db, "connector-a");
      const task = await seedTask(db, "task-a");
      const cycle = await upsertWorkCycle(db, {
        connectorConfigId: "connector-a",
        source: "clickup",
        externalRef: "sprint-a",
        name: "Sprint A",
        lastSeenSyncRunId: "sync-old",
      });
      await assignMembership(db, {
        taskId: task.taskId,
        cycleId: cycle.cycleId,
        sourceFactId: null,
        at: "2026-06-01T00:00:00.000Z",
      });

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        sources: [],
        workCycleReconciles: [],
      });
      await expect(loadCycle(db, cycle.cycleId)).resolves.toMatchObject({ state: "active", deleted_at: null });
      await expect(openMemberships(db, cycle.cycleId)).resolves.toBe(1);

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        sources: [],
        workCycleReconciles: [{ connectorConfigId: "connector-a", syncRunId: "sync-new" }],
      });
      await expect(loadCycle(db, cycle.cycleId)).resolves.toMatchObject({
        state: "closed",
        deleted_at: expect.any(String),
      });
      await expect(openMemberships(db, cycle.cycleId)).resolves.toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it("scopes work cycle reconcile to the syncing connector config", async () => {
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await seedConnector(db, "connector-a");
      await seedConnector(db, "connector-b");
      const cycleA = await upsertWorkCycle(db, {
        connectorConfigId: "connector-a",
        source: "clickup",
        externalRef: "sprint-a",
        name: "Sprint A",
        lastSeenSyncRunId: "sync-old",
      });
      const cycleB = await upsertWorkCycle(db, {
        connectorConfigId: "connector-b",
        source: "clickup",
        externalRef: "sprint-b",
        name: "Sprint B",
        lastSeenSyncRunId: "sync-old",
      });

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        sources: [],
        workCycleReconciles: [{ connectorConfigId: "connector-a", syncRunId: "sync-new" }],
      });

      await expect(loadCycle(db, cycleA.cycleId)).resolves.toMatchObject({ state: "closed" });
      await expect(loadCycle(db, cycleB.cycleId)).resolves.toMatchObject({ state: "active", deleted_at: null });
    } finally {
      await db.destroy();
    }
  });
});

async function seedConnector(db: Kysely<DB>, connectorConfigId: string): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: `${connectorConfigId}-user`, name: connectorConfigId, email: `${connectorConfigId}@example.com` })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorConfigId,
      connector_type: "clickup",
      auth_type: "api_key",
      credentials: "{}",
      created_by: `${connectorConfigId}-user`,
      scope_config: "{}",
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, connectorConfigId: string, indexedFileId: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: indexedFileId,
      connector_config_id: connectorConfigId,
      provider_file_id: indexedFileId,
      file_name: `${indexedFileId}.txt`,
      file_type: "issue",
      content_category: "structured",
      content: indexedFileId,
      source: "linear",
      content_hash: `hash-${indexedFileId}`,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedProjectWithSourceRef(
  db: Kysely<DB>,
  entityId: string,
  name: string,
  source: string,
  sourceId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: entityId,
      name,
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
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `${entityId}-ref`,
      entity_id: entityId,
      source,
      source_id: sourceId,
      source_url: null,
      last_seen_at: now,
    })
    .execute();
}

async function seedStructuralTaskFact(
  db: Kysely<DB>,
  input: { connectorConfigId: string; fileId: string; source: string; sourceTaskId: string },
): Promise<void> {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `${input.sourceTaskId}-fact`,
      indexed_file_id: input.fileId,
      connector_config_id: input.connectorConfigId,
      created_by_user_id: `${input.connectorConfigId}-user`,
      source: input.source,
      fact_type: "structural_task",
      relation: "mentioned",
      subject_name: input.sourceTaskId,
      subject_email: null,
      subject_source: input.source,
      subject_source_id: input.sourceTaskId,
      context_snippet: null,
      raw: "{}",
      fact_key: `${input.source}:structural_task:${input.sourceTaskId}`,
      last_seen_sync_run_id: "sync-new",
      deleted_at: null,
      content_hash: null,
      materialized_at: new Date().toISOString(),
    })
    .execute();
}

async function seedTask(db: Kysely<DB>, sourceTaskId: string): Promise<{ taskId: string; created: boolean }> {
  return createTaskRepository(db).upsertTask({
    parentEntityId: null,
    parentSourceRef: null,
    parentName: null,
    source: "clickup",
    externalRef: sourceTaskId,
    title: sourceTaskId,
    status: "open",
    statusRaw: "open",
    statusAuthority: "external",
    assigneeEntityId: null,
    priority: null,
    dueAt: null,
    provenance: "structural",
    sourceTaskId,
  });
}

async function loadCycle(db: Kysely<DB>, cycleId: string) {
  return db.selectFrom("work_cycles").selectAll().where("id", "=", cycleId).executeTakeFirstOrThrow();
}

async function openMemberships(db: Kysely<DB>, cycleId: string): Promise<number> {
  const row = await db
    .selectFrom("task_cycle_memberships")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("cycle_id", "=", cycleId)
    .where("removed_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

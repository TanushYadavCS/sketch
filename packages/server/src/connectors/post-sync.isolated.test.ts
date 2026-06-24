import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskRepository } from "../db/repositories/tasks";
import { assignMembership, upsertWorkCycle } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
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

  it("passes FLOOR_RETRY_MAX_FILES_PER_DOMAIN when domain promotion triggers floor retry", async () => {
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
        affectedIndexedFileIds: [],
        floorRetryMaxFilesPerDomain: 7,
      });

      expect(floorRetryForDomains).toHaveBeenCalledTimes(1);
      expect(floorRetryForDomains).toHaveBeenCalledWith({ db, logger: expect.anything() }, ["canvasx.ai"], {
        maxFilesPerDomain: 7,
      });
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
        connectorConfigId: "connector-a",
        syncRunId: "sync-new",
        experimentalFlag: true,
        runCycleReconcile: false,
      });
      await expect(loadCycle(db, cycle.cycleId)).resolves.toMatchObject({ state: "active", deleted_at: null });
      await expect(openMemberships(db, cycle.cycleId)).resolves.toBe(1);

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        connectorConfigId: "connector-a",
        syncRunId: "sync-new",
        experimentalFlag: true,
        runCycleReconcile: true,
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

  it("does not close pre-existing cycles when the experimental flag is off", async () => {
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await seedConnector(db, "connector-a");
      const cycle = await upsertWorkCycle(db, {
        connectorConfigId: "connector-a",
        source: "clickup",
        externalRef: "sprint-flag-off",
        name: "Sprint Flag Off",
        lastSeenSyncRunId: "sync-old",
      });

      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        connectorConfigId: "connector-a",
        syncRunId: "sync-new",
        experimentalFlag: false,
        runCycleReconcile: true,
      });

      await expect(loadCycle(db, cycle.cycleId)).resolves.toMatchObject({ state: "active", deleted_at: null });
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
        connectorConfigId: "connector-a",
        syncRunId: "sync-new",
        experimentalFlag: true,
        runCycleReconcile: true,
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

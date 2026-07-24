import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { reconcileWorkCycles, upsertWorkCycle } from "../db/repositories/work-cycles";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { PostSyncGraphInputs, PostSyncGraphPipelineParams } from "./post-sync";
import { type ScheduledPostSyncContext, createPostSyncCoordinator } from "./post-sync-coordinator";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createContext(db: Kysely<DB> = {} as Kysely<DB>): ScheduledPostSyncContext {
  const child = vi.fn();
  const logger = { child } as unknown as Logger;
  child.mockReturnValue(logger);
  return {
    db,
    logger,
    coMentionContributesToThreshold: 4,
    floorRetryMaxFilesPerDomain: 7,
  };
}

function inputs(
  affectedIndexedFileIds: string[],
  sources: string[],
  workCycleReconciles: PostSyncGraphInputs["workCycleReconciles"] = [],
): PostSyncGraphInputs {
  return { affectedIndexedFileIds, sources, workCycleReconciles };
}

describe("post-sync coordinator", () => {
  it("drains one deduplicated union after concurrent successful, partial, and slow connector workers settle", async () => {
    const runPipeline = vi.fn<(params: PostSyncGraphPipelineParams) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = createPostSyncCoordinator(runPipeline);
    const context = createContext();
    const cohort = new Set<PostSyncGraphInputs>();
    const slow = deferred();

    const workers = [
      Promise.resolve().then(() => {
        cohort.add(inputs(["file-a"], ["google_drive"], [{ connectorConfigId: "a", syncRunId: "run-a" }]));
      }),
      Promise.resolve().then(() => {
        cohort.add(inputs(["file-b", "file-a"], ["clickup"]));
        throw new Error("partial connector failure");
      }),
      slow.promise.then(() => {
        cohort.add(inputs(["file-c"], ["fireflies"], [{ connectorConfigId: "c", syncRunId: "run-c" }]));
      }),
    ];

    slow.resolve();
    await Promise.allSettled(workers);
    const merged = inputs([], []);
    for (const connectorInputs of cohort) {
      merged.affectedIndexedFileIds.push(...connectorInputs.affectedIndexedFileIds);
      merged.sources.push(...connectorInputs.sources);
      merged.workCycleReconciles.push(...connectorInputs.workCycleReconciles);
    }
    await coordinator.enqueue(merged, context);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith({
      db: context.db,
      syncLogger: context.logger,
      affectedIndexedFileIds: ["file-a", "file-b", "file-c"],
      sources: ["google_drive", "clickup", "fireflies"],
      workCycleReconciles: [
        { connectorConfigId: "a", syncRunId: "run-a" },
        { connectorConfigId: "c", syncRunId: "run-c" },
      ],
      coMentionContributesToThreshold: 4,
      floorRetryMaxFilesPerDomain: 7,
    });
  });

  it("marks overlapping cohorts dirty and runs exactly one follow-up drain", async () => {
    const firstDrain = deferred();
    const firstStarted = deferred();
    const runPipeline = vi.fn<(params: PostSyncGraphPipelineParams) => Promise<void>>(async () => {
      if (runPipeline.mock.calls.length === 1) {
        firstStarted.resolve();
        await firstDrain.promise;
      }
    });
    const coordinator = createPostSyncCoordinator(runPipeline);
    const context = createContext();

    const first = coordinator.enqueue(inputs(["file-a"], ["google_drive"]), context);
    await firstStarted.promise;
    const second = coordinator.enqueue(inputs(["file-b"], ["clickup"]), context);
    const third = coordinator.enqueue(inputs(["file-c"], ["fireflies"]), context);
    firstDrain.resolve();
    await Promise.all([first, second, third]);

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline.mock.calls[0][0]).toMatchObject({
      affectedIndexedFileIds: ["file-a"],
      sources: ["google_drive"],
    });
    expect(runPipeline.mock.calls[1][0]).toMatchObject({
      affectedIndexedFileIds: ["file-b", "file-c"],
      sources: ["clickup", "fireflies"],
    });
  });

  it("keeps only the newest reconcile tuple for each connector across queued enqueues", async () => {
    const runPipeline = vi.fn<(params: PostSyncGraphPipelineParams) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = createPostSyncCoordinator(runPipeline);
    const context = createContext();

    const first = coordinator.enqueue(
      inputs(
        [],
        [],
        [
          { connectorConfigId: "a", syncRunId: "run-a-old" },
          { connectorConfigId: "b", syncRunId: "run-b-old" },
        ],
      ),
      context,
    );
    const second = coordinator.enqueue(
      inputs(
        [],
        [],
        [
          { connectorConfigId: "a", syncRunId: "run-a-new" },
          { connectorConfigId: "b", syncRunId: "run-b-new" },
        ],
      ),
      context,
    );
    await Promise.all([first, second]);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0][0].workCycleReconciles).toEqual([
      { connectorConfigId: "a", syncRunId: "run-a-new" },
      { connectorConfigId: "b", syncRunId: "run-b-new" },
    ]);
  });

  it("restores a failed snapshot and retries its full union on the next drain", async () => {
    const failure = new Error("cycle pipeline failed");
    const runPipeline = vi
      .fn<(params: PostSyncGraphPipelineParams) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const coordinator = createPostSyncCoordinator(runPipeline);
    const context = createContext();
    const snapshot = inputs(["file-a"], ["google_drive"], [{ connectorConfigId: "a", syncRunId: "run-a" }]);

    await expect(coordinator.enqueue(snapshot, context)).rejects.toBe(failure);
    await expect(coordinator.drain(context)).resolves.toBeUndefined();

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline.mock.calls[1][0]).toMatchObject(snapshot);
  });

  it("does not restore an older reconcile tuple over a newer sync after a failed drain", async () => {
    const db = await createTestDb();
    const logger = createTestLogger();
    const context = { ...createContext(db), logger };
    const firstStarted = deferred();
    const failFirst = deferred();
    const failure = new Error("cycle pipeline failed");
    const reconciled: PostSyncGraphInputs["workCycleReconciles"][] = [];
    const runPipeline = vi.fn<(params: PostSyncGraphPipelineParams) => Promise<void>>(async (params) => {
      if (runPipeline.mock.calls.length === 1) {
        firstStarted.resolve();
        await failFirst.promise;
        throw failure;
      }
      reconciled.push(params.workCycleReconciles);
      for (const input of params.workCycleReconciles) {
        await reconcileWorkCycles(params.db, { ...input, at: "2026-07-14T08:00:00.000Z" });
      }
    });
    const coordinator = createPostSyncCoordinator(runPipeline);

    try {
      await db.insertInto("users").values({ id: "user-a", name: "User A", email: "user-a@example.com" }).execute();
      await db
        .insertInto("connector_configs")
        .values({
          id: "connector-a",
          connector_type: "linear",
          auth_type: "api_key",
          credentials: "{}",
          created_by: "user-a",
          scope_config: "{}",
        })
        .execute();
      const cycle = await upsertWorkCycle(db, {
        connectorConfigId: "connector-a",
        source: "linear",
        externalRef: "cycle-a",
        name: "Cycle A",
        lastSeenSyncRunId: "sync-old",
      });

      const first = coordinator.enqueue(
        inputs(["file-old"], ["linear"], [{ connectorConfigId: "connector-a", syncRunId: "sync-old" }]),
        context,
      );
      const firstResult = expect(first).rejects.toBe(failure);
      await firstStarted.promise;

      await upsertWorkCycle(db, {
        connectorConfigId: "connector-a",
        source: "linear",
        externalRef: "cycle-a",
        name: "Cycle A",
        lastSeenSyncRunId: "sync-new",
      });
      const second = coordinator.enqueue(
        inputs(["file-new"], ["linear"], [{ connectorConfigId: "connector-a", syncRunId: "sync-new" }]),
        context,
      );
      failFirst.resolve();

      await firstResult;
      await expect(second).resolves.toBeUndefined();

      expect(reconciled).toEqual([[{ connectorConfigId: "connector-a", syncRunId: "sync-new" }]]);
      await expect(
        db
          .selectFrom("work_cycles")
          .select(["state", "deleted_at"])
          .where("id", "=", cycle.cycleId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ state: "active", deleted_at: null });
      expect(runPipeline.mock.calls[1][0]).toMatchObject({
        affectedIndexedFileIds: ["file-new", "file-old"],
        sources: ["linear"],
        workCycleReconciles: [{ connectorConfigId: "connector-a", syncRunId: "sync-new" }],
      });
    } finally {
      await db.destroy();
    }
  });
});

import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { PostSyncGraphInputs } from "../../connectors/post-sync";
import type { DB } from "../schema";

export type GraphPassRunStatus = "running" | "complete" | "failed";

export type PostSyncRunSnapshot = PostSyncGraphInputs & { kind: "post_sync" };

/**
 * A queue run has no dirty-file set — it is queue-wide. It records how many
 * in-scope non-terminal rows it scanned and what the projection did with them.
 */
export type QueueRunSnapshot = {
  kind: "queue";
  scannedRows: number;
  set: Record<string, number>;
  cleared: number;
  frozen: number;
  candidatesRepointed: number;
  candidatesCleared: number;
};

export type GraphPassRunSnapshot = PostSyncRunSnapshot | QueueRunSnapshot;

export interface GraphPassRun {
  id: string;
  status: GraphPassRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  inputSnapshot: GraphPassRunSnapshot;
}

type GraphPassRunRow = Selectable<DB["graph_pass_runs"]>;

function readCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number") out[key] = count;
  }
  return out;
}

function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Rows written before queue runs existed carry no `kind`, so an absent
 * discriminant reads as post-sync.
 */
function parseSnapshot(value: unknown): GraphPassRunSnapshot {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
  if (parsed?.kind === "queue") {
    return {
      kind: "queue",
      scannedRows: readNumber(parsed.scannedRows),
      set: readCounts(parsed.set),
      cleared: readNumber(parsed.cleared),
      frozen: readNumber(parsed.frozen),
      candidatesRepointed: readNumber(parsed.candidatesRepointed),
      candidatesCleared: readNumber(parsed.candidatesCleared),
    };
  }
  return {
    kind: "post_sync",
    affectedIndexedFileIds: Array.isArray(parsed?.affectedIndexedFileIds)
      ? (parsed.affectedIndexedFileIds as string[])
      : [],
    sources: Array.isArray(parsed?.sources) ? (parsed.sources as PostSyncGraphInputs["sources"]) : [],
    workCycleReconciles: Array.isArray(parsed?.workCycleReconciles)
      ? (parsed.workCycleReconciles as PostSyncGraphInputs["workCycleReconciles"])
      : [],
  };
}

function mapRun(row: GraphPassRunRow): GraphPassRun {
  return {
    id: row.id,
    status: row.status as GraphPassRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    inputSnapshot: parseSnapshot(row.input_snapshot_json),
  };
}

export function createGraphPassRunRepository(db: Kysely<DB>) {
  return {
    async start(inputSnapshot: GraphPassRunSnapshot, id?: string): Promise<string> {
      const runId = id ?? randomUUID();
      const now = new Date().toISOString();
      const existing = await db.selectFrom("graph_pass_runs").select("id").where("id", "=", runId).executeTakeFirst();
      if (existing) {
        await db
          .updateTable("graph_pass_runs")
          .set({
            status: "running",
            started_at: now,
            finished_at: null,
            error_message: null,
            input_snapshot_json: JSON.stringify(inputSnapshot),
          })
          .where("id", "=", runId)
          .execute();
        return runId;
      }

      await db
        .insertInto("graph_pass_runs")
        .values({
          id: runId,
          status: "running",
          started_at: now,
          input_snapshot_json: JSON.stringify(inputSnapshot),
        })
        .execute();
      return runId;
    },

    async updateSnapshot(id: string, inputSnapshot: GraphPassRunSnapshot): Promise<void> {
      await db
        .updateTable("graph_pass_runs")
        .set({ input_snapshot_json: JSON.stringify(inputSnapshot) })
        .where("id", "=", id)
        .execute();
    },

    async complete(id: string): Promise<void> {
      await db
        .updateTable("graph_pass_runs")
        .set({ status: "complete", finished_at: new Date().toISOString(), error_message: null })
        .where("id", "=", id)
        .execute();
    },

    async fail(id: string, errorMessage: string): Promise<void> {
      await db
        .updateTable("graph_pass_runs")
        .set({ status: "failed", finished_at: new Date().toISOString(), error_message: errorMessage })
        .where("id", "=", id)
        .execute();
    },

    async get(id: string): Promise<GraphPassRun | null> {
      const row = await db.selectFrom("graph_pass_runs").selectAll().where("id", "=", id).executeTakeFirst();
      return row ? mapRun(row) : null;
    },

    async getRunning(): Promise<GraphPassRun | null> {
      const row = await db
        .selectFrom("graph_pass_runs")
        .selectAll()
        .where("status", "=", "running")
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
      return row ? mapRun(row) : null;
    },

    async list(limit = 50): Promise<GraphPassRun[]> {
      const rows = await db
        .selectFrom("graph_pass_runs")
        .selectAll()
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(mapRun);
    },

    async listUnfinished(): Promise<GraphPassRun[]> {
      const rows = await db
        .selectFrom("graph_pass_runs")
        .selectAll()
        .where("status", "=", "running")
        .orderBy("started_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(mapRun);
    },

    /**
     * A queue run interrupted by a restart has nothing to resume — the passes
     * recompute from scratch on the next run — but a row left `running` would
     * make `getRunning()` report a pass that is not happening.
     */
    async failUnfinishedQueueRuns(): Promise<number> {
      const unfinished = await db.selectFrom("graph_pass_runs").selectAll().where("status", "=", "running").execute();
      const ids = unfinished.filter((row) => parseSnapshot(row.input_snapshot_json).kind === "queue").map((r) => r.id);
      if (ids.length === 0) return 0;
      const result = await db
        .updateTable("graph_pass_runs")
        .set({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: "interrupted by restart",
        })
        .where("id", "in", ids)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
  };
}

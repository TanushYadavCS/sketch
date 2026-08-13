import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { PostSyncGraphInputs } from "../../connectors/post-sync";
import type { DB } from "../schema";

export type GraphPassRunStatus = "running" | "complete" | "failed";

export interface GraphPassRun {
  id: string;
  status: GraphPassRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  inputSnapshot: PostSyncGraphInputs;
}

type GraphPassRunRow = Selectable<DB["graph_pass_runs"]>;

function parseSnapshot(value: unknown): PostSyncGraphInputs {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as Partial<PostSyncGraphInputs>;
  return {
    affectedIndexedFileIds: Array.isArray(parsed.affectedIndexedFileIds) ? parsed.affectedIndexedFileIds : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    workCycleReconciles: Array.isArray(parsed.workCycleReconciles) ? parsed.workCycleReconciles : [],
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
    async start(inputSnapshot: PostSyncGraphInputs, id?: string): Promise<string> {
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
  };
}

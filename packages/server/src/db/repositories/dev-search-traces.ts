import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { StageReport } from "../../connectors/enrichment-stage-report";
import type { DB } from "../schema";

/** How many traces the table keeps. Pruned on insert; no cron, no config knob. */
export const DEV_SEARCH_TRACE_RETENTION = 500;

/** `dev_tools` is a search run from the dev-tools tab. It goes through the same traced
 * core as every other origin, so what it records is what an agent would have received. */
export type DevSearchTraceOrigin = "agent" | "automation" | "public_mcp" | "dev_tools";
export type DevSearchTraceStatus = "done" | "failed" | "empty";

export interface DevSearchTraceInput {
  /** Supplied by the dev-tools route so it can read the trace back by id. */
  id?: string;
  origin: DevSearchTraceOrigin;
  userId: string | null;
  conversationId: number | null;
  query: string;
  args: Record<string, unknown>;
  principals: unknown;
  stages: StageReport[];
  status: DevSearchTraceStatus;
  error: string | null;
  resultCount: number;
  durationMs: number;
}

export interface DevSearchTraceHeader {
  id: string;
  origin: DevSearchTraceOrigin;
  userId: string | null;
  conversationId: number | null;
  query: string;
  status: DevSearchTraceStatus;
  error: string | null;
  resultCount: number;
  durationMs: number;
  startedAt: string;
  stageCount: number;
}

export interface DevSearchTraceDetail extends DevSearchTraceHeader {
  args: Record<string, unknown>;
  principals: unknown;
  stages: StageReport[];
}

export function createDevSearchTraceRepository(db: Kysely<DB>) {
  return {
    /**
     * Writes one trace and prunes the table back to the retention cap.
     *
     * Ordering uses `(started_at, id)` because `CURRENT_TIMESTAMP` is second-precision on
     * SQLite: without the id tiebreak, traces landing in the same second would make "the
     * newest N" nondeterministic and the prune could drop the row just written.
     */
    async record(input: DevSearchTraceInput): Promise<string> {
      const id = input.id ?? randomUUID();
      await db
        .insertInto("dev_search_traces")
        .values({
          id,
          origin: input.origin,
          user_id: input.userId,
          conversation_id: input.conversationId,
          query: input.query,
          args_json: JSON.stringify(input.args),
          principals_json: JSON.stringify(input.principals ?? null),
          stages_json: JSON.stringify(input.stages),
          status: input.status,
          error: input.error,
          result_count: input.resultCount,
          duration_ms: input.durationMs,
        })
        .execute();

      const keep = await db
        .selectFrom("dev_search_traces")
        .select("id")
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(DEV_SEARCH_TRACE_RETENTION)
        .execute();
      if (keep.length >= DEV_SEARCH_TRACE_RETENTION) {
        await db
          .deleteFrom("dev_search_traces")
          .where(
            "id",
            "not in",
            keep.map((row) => row.id),
          )
          .execute();
      }
      return id;
    },

    async list(limit = 100): Promise<DevSearchTraceHeader[]> {
      const rows = await db
        .selectFrom("dev_search_traces")
        .select([
          "id",
          "origin",
          "user_id",
          "conversation_id",
          "query",
          "status",
          "error",
          "result_count",
          "duration_ms",
          "started_at",
          "stages_json",
        ])
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        origin: row.origin as DevSearchTraceOrigin,
        userId: row.user_id,
        conversationId: row.conversation_id,
        query: row.query,
        status: row.status as DevSearchTraceStatus,
        error: row.error,
        resultCount: row.result_count,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        stageCount: parseStages(row.stages_json).length,
      }));
    },

    async get(id: string): Promise<DevSearchTraceDetail | null> {
      const row = await db.selectFrom("dev_search_traces").selectAll().where("id", "=", id).executeTakeFirst();
      if (!row) return null;
      const stages = parseStages(row.stages_json);
      return {
        id: row.id,
        origin: row.origin as DevSearchTraceOrigin,
        userId: row.user_id,
        conversationId: row.conversation_id,
        query: row.query,
        status: row.status as DevSearchTraceStatus,
        error: row.error,
        resultCount: row.result_count,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        stageCount: stages.length,
        args: parseObject(row.args_json),
        principals: parseUnknown(row.principals_json),
        stages,
      };
    },
  };
}

/**
 * A trace is debugging evidence, so unreadable JSON degrades to empty rather than throwing
 * and taking the whole feed down with it.
 */
function parseStages(raw: string): StageReport[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StageReport[]) : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

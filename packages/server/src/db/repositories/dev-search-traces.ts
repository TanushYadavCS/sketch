import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { StageReport } from "../../connectors/enrichment-stage-report";
import type { DB } from "../schema";

/** How many traces the table keeps. Pruned on insert; no cron, no config knob. */
export const DEV_SEARCH_TRACE_RETENTION = 500;

/** Result rows kept per trace. The Search tool's `limit` has no ceiling; this does. */
export const DEV_SEARCH_TRACE_RESULT_CAP = 50;

/** How long stored result text and syntheses survive. Applied on write, not on a timer. */
export const DEV_SEARCH_TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** `dev_tools` is a search run from the dev-tools tab. It goes through the same traced
 * core as every other origin, so what it records is what an agent would have received. */
export type DevSearchTraceOrigin = "agent" | "automation" | "public_mcp" | "dev_tools";
export type DevSearchTraceStatus = "done" | "failed" | "empty";

export interface DevSearchTraceResultInput {
  position: number;
  hitFileId: string;
  resultKind: string;
  fileName: string;
  source: string;
  providerUrl: string | null;
  agentText: string;
  snippet: string | null;
  summary: string | null;
  score: number;
  similarity: number | null;
}

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
  results?: DevSearchTraceResultInput[];
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

export interface DevSearchSynthesis {
  id: string;
  traceId: string;
  provider: string;
  model: string;
  prompt: string;
  answer: string | null;
  status: string;
  error: string | null;
  durationMs: number;
  createdAtMs: number;
}

export interface DevSearchTraceDetail extends DevSearchTraceHeader {
  args: Record<string, unknown>;
  principals: unknown;
  stages: StageReport[];
  results: DevSearchTraceResultInput[];
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
      const nowMs = Date.now();
      /**
       * One transaction for the parent, its results and both prunes. Captures are
       * fire-and-forget and can overlap, so a separate child write could land after
       * another capture's prune had already removed the parent it points at.
       */
      await db.transaction().execute(async (trx) => {
        await trx
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

        if (input.results && input.results.length > 0) {
          await trx
            .insertInto("dev_search_trace_results")
            .values(
              input.results.map((row) => ({
                trace_id: id,
                position: row.position,
                hit_file_id: row.hitFileId,
                result_kind: row.resultKind,
                file_name: row.fileName,
                source: row.source,
                provider_url: row.providerUrl,
                agent_text: row.agentText,
                snippet: row.snippet,
                summary: row.summary,
                score: row.score,
                similarity: row.similarity,
                created_at_ms: nowMs,
              })),
            )
            .execute();
        }

        const keep = await trx
          .selectFrom("dev_search_traces")
          .select("id")
          .orderBy("started_at", "desc")
          .orderBy("id", "desc")
          .limit(DEV_SEARCH_TRACE_RETENTION)
          .execute();
        if (keep.length >= DEV_SEARCH_TRACE_RETENTION) {
          await trx
            .deleteFrom("dev_search_traces")
            .where(
              "id",
              "not in",
              keep.map((row) => row.id),
            )
            .execute();
        }

        /**
         * Age-out deletes rather than nulling the text: syntheses hold prompts and answers
         * too, so clearing only the snippet columns would satisfy the letter of a 30-day
         * rule while leaving most of the content in place.
         */
        const cutoffMs = nowMs - DEV_SEARCH_TEXT_RETENTION_MS;
        await trx.deleteFrom("dev_search_trace_results").where("created_at_ms", "<", cutoffMs).execute();
        await trx.deleteFrom("dev_search_syntheses").where("created_at_ms", "<", cutoffMs).execute();
      });
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
      const resultRows = await db
        .selectFrom("dev_search_trace_results")
        .selectAll()
        .where("trace_id", "=", id)
        .orderBy("position", "asc")
        .execute();
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
        results: resultRows.map((result) => ({
          position: result.position,
          hitFileId: result.hit_file_id,
          resultKind: result.result_kind,
          fileName: result.file_name,
          source: result.source,
          providerUrl: result.provider_url,
          agentText: result.agent_text,
          snippet: result.snippet,
          summary: result.summary,
          score: result.score,
          similarity: result.similarity,
        })),
      };
    },

    /** Headers only — prompts and answers are large and are fetched per run. */
    async listSyntheses(traceId: string): Promise<Omit<DevSearchSynthesis, "prompt" | "answer">[]> {
      const rows = await db
        .selectFrom("dev_search_syntheses")
        .select(["id", "trace_id", "provider", "model", "status", "error", "duration_ms", "created_at_ms"])
        .where("trace_id", "=", traceId)
        .orderBy("created_at_ms", "desc")
        .orderBy("id", "desc")
        .execute();
      return rows.map((row) => ({
        id: row.id,
        traceId: row.trace_id,
        provider: row.provider,
        model: row.model,
        status: row.status,
        error: row.error,
        durationMs: row.duration_ms,
        createdAtMs: Number(row.created_at_ms),
      }));
    },

    async getSynthesis(id: string): Promise<DevSearchSynthesis | null> {
      const row = await db.selectFrom("dev_search_syntheses").selectAll().where("id", "=", id).executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        traceId: row.trace_id,
        provider: row.provider,
        model: row.model,
        prompt: row.prompt,
        answer: row.answer,
        status: row.status,
        error: row.error,
        durationMs: row.duration_ms,
        createdAtMs: Number(row.created_at_ms),
      };
    },

    async recordSynthesis(input: Omit<DevSearchSynthesis, "id" | "createdAtMs">): Promise<string> {
      const id = randomUUID();
      await db
        .insertInto("dev_search_syntheses")
        .values({
          id,
          trace_id: input.traceId,
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          answer: input.answer,
          status: input.status,
          error: input.error,
          duration_ms: input.durationMs,
          created_at_ms: Date.now(),
        })
        .execute();
      return id;
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

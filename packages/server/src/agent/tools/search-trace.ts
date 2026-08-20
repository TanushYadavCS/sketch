/**
 * Captures one real `Search` call for the dev-tools search tab.
 *
 * A capture is built **per invocation**, never per tool registration: `createSearchTools`
 * closes over its deps once per agent run, and queues are per-channel, so two concurrent
 * searches sharing one collector would interleave into a single incoherent trace.
 *
 * Nothing here may break the search it is observing. The record is fire-and-forget with
 * its own catch: losing a trace is acceptable, failing a user's search is not.
 */
import type { Logger } from "pino";
import type { SearchCandidate, StageReport, StageReporter } from "../../connectors/enrichment-stage-report";
import type { HybridSearchResult } from "../../connectors/search";
import {
  DEV_SEARCH_TRACE_RESULT_CAP,
  type DevSearchTraceOrigin,
  type DevSearchTraceResultInput,
  type DevSearchTraceStatus,
  createDevSearchTraceRepository,
} from "../../db/repositories/dev-search-traces";
import type { SketchMcpDeps } from "./types";

export interface SearchTraceCapture {
  report: StageReporter;
  /** Records the tool's own post-sort — the order the caller actually received. */
  rerank: (results: HybridSearchResult[], applied: boolean, rerankSetSize: number) => void;
  /** Records the rendered blocks the agent received, paired with their result rows. */
  finalOutput: (results: HybridSearchResult[], agentBlocks: string[]) => void;
  finish: (status: DevSearchTraceStatus, error: string | null, resultCount: number) => void;
}

/**
 * Returns null when dev tools are off, which is what keeps the production path free: the
 * reporter stays undefined and every report site in search.ts is a no-op optional call.
 */
export function createSearchTraceCapture(args: {
  deps: SketchMcpDeps;
  origin: DevSearchTraceOrigin;
  query: string;
  toolArgs: Record<string, unknown>;
  principals: unknown;
}): SearchTraceCapture | null {
  if (!args.deps.devToolsEnabled || !args.deps.db) return null;

  const db = args.deps.db;
  const logger = args.deps.logger;
  const startedAt = Date.now();
  const stages: StageReport[] = [];
  let results: DevSearchTraceResultInput[] = [];
  let recorded = false;

  return {
    report(report) {
      const existing = stages.findIndex((entry) => entry.stage === report.stage);
      if (existing >= 0) stages[existing] = { ...stages[existing], ...report };
      else stages.push(report);
    },

    rerank(results, applied, rerankSetSize) {
      const position = new Map(results.map((result, index) => [result.hitFileId, index + 1]));
      const finalize = stages.find((entry) => entry.stage === "finalize");
      const candidates = (finalize?.candidates ?? []).map(
        (candidate): SearchCandidate => ({
          ...candidate,
          finalPosition: position.get(candidate.fileId) ?? candidate.finalPosition,
        }),
      );
      /**
       * The draft carries `finalPosition: null` on every row, because positions are not
       * known until this point. Leaving it on the finalize stage would render a table
       * claiming nothing was returned, so ownership moves here with the positions filled.
       */
      if (finalize) finalize.candidates = undefined;

      stages.push({
        stage: "rerank",
        label: "Entity re-sort",
        kind: "code",
        status: applied ? "done" : "skipped",
        ...(applied
          ? { summary: { set: "rerank", filesInRerankSet: rerankSetSize, returned: results.length } }
          : { error: "No entity re-sort applied — order is as search() returned it" }),
        candidates,
      });
    },

    finalOutput(hits, agentBlocks) {
      /**
       * Capped rather than unbounded: the Search tool's `limit` has no ceiling, so one
       * call could otherwise write thousands of text rows into a debugging table.
       */
      results = hits.slice(0, DEV_SEARCH_TRACE_RESULT_CAP).map((hit, index) => ({
        position: index + 1,
        hitFileId: hit.hitFileId,
        resultKind: hit.resultKind,
        fileName: hit.fileName,
        source: hit.source,
        providerUrl: hit.providerUrl,
        agentText: agentBlocks[index] ?? "",
        snippet: hit.snippet,
        summary: hit.summary,
        score: hit.score,
        similarity: hit.similarity,
      }));

      stages.push({
        stage: "finalOutput",
        label: "Final output",
        kind: "code",
        status: hits.length > 0 ? "done" : "skipped",
        summary: {
          returned: hits.length,
          stored: results.length,
          agentTextChars: results.reduce((total, row) => total + row.agentText.length, 0),
          note: "Text as the agent received it — summary preferred over snippet, cut at 200 characters. Reading the full document is a separate GetFileContent call.",
        },
      });
    },

    finish(status, error, resultCount) {
      if (recorded) return;
      recorded = true;
      void recordTrace({
        db,
        logger,
        id: args.deps.devSearchTraceId,
        origin: args.origin,
        userId: args.deps.currentUserId ?? null,
        conversationId: args.deps.conversationContext?.conversationId ?? null,
        query: args.query,
        toolArgs: args.toolArgs,
        principals: args.principals,
        stages,
        status,
        error,
        resultCount,
        durationMs: Date.now() - startedAt,
        results,
      });
    },
  };
}

async function recordTrace(input: {
  db: NonNullable<SketchMcpDeps["db"]>;
  logger?: Logger;
  id?: string;
  origin: DevSearchTraceOrigin;
  userId: string | null;
  conversationId: number | null;
  query: string;
  toolArgs: Record<string, unknown>;
  principals: unknown;
  stages: StageReport[];
  status: DevSearchTraceStatus;
  error: string | null;
  resultCount: number;
  durationMs: number;
  results: DevSearchTraceResultInput[];
}): Promise<void> {
  try {
    await createDevSearchTraceRepository(input.db).record({
      ...(input.id ? { id: input.id } : {}),
      origin: input.origin,
      userId: input.userId,
      conversationId: input.conversationId,
      query: input.query,
      args: input.toolArgs,
      principals: input.principals,
      stages: input.stages,
      status: input.status,
      error: input.error,
      resultCount: input.resultCount,
      durationMs: input.durationMs,
      results: input.results,
    });
  } catch (err) {
    input.logger?.warn({ err }, "Failed to record dev search trace");
  }
}

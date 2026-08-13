/**
 * In-memory capture of a single enrichment run, for the dev-only trace surface.
 *
 * Nothing is persisted and nothing new is instrumented. The pipeline already
 * reports every stage and every drop through pino, so the capture is a logger
 * wrapper: hand `runEnrichment` a traced logger and every downstream
 * `logger.child(...)` — extraction, fact reconciliation, entity proposal,
 * materialisation — reports into the same run.
 *
 * Runs live in a bounded ring and are lost on restart. That is deliberate:
 * this is a debugging window for the team that owns the pipeline, not a record,
 * so it needs no table, no retention policy and no tenant-facing surface.
 *
 * Prompt and response bodies are never captured here. They already go to
 * `data/llm-dumps/`, which stays on the server's disk.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { MaterializeStageSummary, StageReport } from "../connectors/enrichment-stage-report";

/** Level methods intercepted on the wrapped logger. */
const LEVEL_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

const MAX_RUNS = 20;
const MAX_STEPS_PER_RUN = 4000;
const MAX_STRING_CHARS = 600;
const MAX_ARRAY_ITEMS = 25;
const MAX_FIELD_DEPTH = 3;
const STAGE_ORDER = new Map([
  ["extractEntities", 1],
  ["dedupAdjudicate", 2],
  ["reconcileFacts", 3],
  ["matchEntities", 4],
  ["generateSummary", 5],
  ["extractEntityFacts", 6],
  ["engagementFloor", 7],
  ["materialize", 8],
  ["neighbourhood", 1],
  ["gatherContext", 2],
  ["extractCandidates", 3],
  ["writeCandidates", 4],
]);

export type DevTraceRunStatus = "running" | "done" | "failed";

/** Which pipeline a run traced. Decides the stage list the UI renders against. */
export type DevTraceRunKind = "enrichment" | "mint";

export interface DevTraceStep {
  /** 1-based, monotonic within a run. Clients poll with `since` to fetch only new steps. */
  seq: number;
  at: string;
  level: string;
  msg: string;
  /** The structured fields pino was given, truncated for display. */
  fields: Record<string, unknown>;
}

export interface DevTraceRun {
  id: string;
  kind: DevTraceRunKind;
  fileId: string;
  fileName: string;
  startedAt: string;
  finishedAt: string | null;
  status: DevTraceRunStatus;
  error: string | null;
  /** Server-side directory holding the raw prompts and responses for this run. */
  dumpDir: string;
  stageReports: StageReport[];
  steps: DevTraceStep[];
  /** Set once the run exceeded `MAX_STEPS_PER_RUN` and later steps were dropped. */
  truncated: boolean;
}

const runs = new Map<string, DevTraceRun>();

export function startTraceRun(input: {
  kind?: DevTraceRunKind;
  fileId: string;
  fileName: string;
  dumpDir: string;
}): DevTraceRun {
  const run: DevTraceRun = {
    id: randomUUID(),
    kind: input.kind ?? "enrichment",
    fileId: input.fileId,
    fileName: input.fileName,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    error: null,
    dumpDir: input.dumpDir,
    stageReports: [],
    steps: [],
    truncated: false,
  };
  runs.set(run.id, run);
  evictOldest();
  return run;
}

export function finishTraceRun(run: DevTraceRun, status: Exclude<DevTraceRunStatus, "running">, error?: unknown): void {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  run.error = error ? errorMessage(error) : null;
}

export function appendTraceStageReport(run: DevTraceRun, report: StageReport): void {
  const existingIndex = run.stageReports.findIndex((item) => item.stage === report.stage);
  if (existingIndex >= 0) {
    const existing = run.stageReports[existingIndex];
    run.stageReports[existingIndex] = {
      ...existing,
      ...report,
      context: report.context ?? existing.context,
      outcomes: [...(existing.outcomes ?? []), ...(report.outcomes ?? [])],
      summary: { ...(existing.summary ?? {}), ...(report.summary ?? {}) },
      materializeSummary: mergeMaterializeSummary(existing.materializeSummary, report.materializeSummary),
    };
    sortStageReports(run);
    return;
  }
  run.stageReports.push(report);
  sortStageReports(run);
}

function mergeMaterializeSummary(
  existing: MaterializeStageSummary | undefined,
  incoming: MaterializeStageSummary | undefined,
): MaterializeStageSummary | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    eligibleFacts: existing.eligibleFacts + incoming.eligibleFacts,
    indexBuilds: existing.indexBuilds + incoming.indexBuilds,
    scopeKeyReads: existing.scopeKeyReads + incoming.scopeKeyReads,
  };
}

function sortStageReports(run: DevTraceRun): void {
  run.stageReports.sort((a, b) => (STAGE_ORDER.get(a.stage) ?? 999) - (STAGE_ORDER.get(b.stage) ?? 999));
}

export function getTraceRun(id: string): DevTraceRun | undefined {
  return runs.get(id);
}

/**
 * Newest first, without step bodies — the list view only needs the headers.
 * Ordering follows insertion, not `startedAt`, so runs started in the same
 * millisecond still come back in the order they were started.
 */
export function listTraceRuns(): Array<Omit<DevTraceRun, "steps"> & { stepCount: number }> {
  return [...runs.values()].reverse().map(({ steps, ...rest }) => ({ ...rest, stepCount: steps.length }));
}

export function clearTraceRuns(): void {
  runs.clear();
}

/**
 * Wraps a pino logger so every call also lands in `run`. Child loggers stay
 * wrapped, which is what makes a single call site capture the whole pipeline.
 *
 * Steps are recorded regardless of the logger's own level, so `debug` lines the
 * server would not print still show up in the trace.
 */
export function createTracedLogger(base: Logger, run: DevTraceRun): Logger {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "child") {
        const child = Reflect.get(target, prop, target) as unknown as (
          bindings: Record<string, unknown>,
          options?: unknown,
        ) => Logger;
        return (bindings: Record<string, unknown>, options?: unknown) =>
          createTracedLogger(child.call(target, bindings, options), run);
      }
      if (typeof prop === "string" && LEVEL_METHODS.has(prop)) {
        const original = Reflect.get(target, prop, target) as (...args: unknown[]) => void;
        return (...args: unknown[]) => {
          original.apply(target, args);
          appendStep(run, prop, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Logger;
}

/**
 * Records one pino call. Handles both `log(obj, msg)` and `log(msg)` forms.
 */
function appendStep(run: DevTraceRun, level: string, args: unknown[]): void {
  if (run.steps.length >= MAX_STEPS_PER_RUN) {
    run.truncated = true;
    return;
  }
  const [first, second] = args;
  const hasFields = typeof first === "object" && first !== null;
  run.steps.push({
    seq: run.steps.length + 1,
    at: new Date().toISOString(),
    level,
    msg: hasFields ? (typeof second === "string" ? second : "") : typeof first === "string" ? first : "",
    fields: hasFields ? (safeValue(first, MAX_FIELD_DEPTH) as Record<string, unknown>) : {},
  });
}

/**
 * Truncating serializer. Fields reaching here are log payloads, which can hold
 * whole mention arrays and error objects; the caps keep one run's capture bounded.
 */
function safeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Error) return { name: value.name, message: value.message };
  const type = typeof value;
  if (type === "string") {
    const text = value as string;
    return text.length > MAX_STRING_CHARS ? `${text.slice(0, MAX_STRING_CHARS)}…` : text;
  }
  if (type === "number" || type === "boolean") return value;
  if (type !== "object") return String(value);
  if (Array.isArray(value)) {
    if (depth <= 0) return `[${value.length} items]`;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeValue(item, depth - 1));
    return value.length > MAX_ARRAY_ITEMS ? [...items, `… ${value.length - MAX_ARRAY_ITEMS} more`] : items;
  }
  if (depth <= 0) return "{…}";
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = safeValue(nested, depth - 1);
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map iteration is insertion-ordered, so the first key is the oldest run. */
function evictOldest(): void {
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next();
    if (oldest.done) return;
    runs.delete(oldest.value);
  }
}

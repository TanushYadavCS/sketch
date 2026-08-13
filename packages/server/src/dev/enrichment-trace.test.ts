/**
 * Three failure modes this surface can have, and nothing else:
 *
 * 1. The capture silently loses the pipeline. Everything downstream of the
 *    route uses `logger.child(...)`, so a wrapper that stops propagating
 *    through children would produce an empty-looking but "successful" trace.
 * 2. The capture grows without bound. Runs are held in process memory, so a
 *    long run or a busy afternoon must not be able to hold the heap.
 * 3. The trace turns into a record. Runs must be evicted, so the surface stays
 *    a window and never becomes something anyone depends on.
 */
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DevTraceRun,
  clearTraceRuns,
  createTracedLogger,
  finishTraceRun,
  getTraceRun,
  listTraceRuns,
  startTraceRun,
} from "./enrichment-trace";

function silentLogger() {
  return pino({ level: "silent" });
}

function newRun(fileName = "meeting.md"): DevTraceRun {
  return startTraceRun({ fileId: `file-${fileName}`, fileName, dumpDir: "data/llm-dumps/x" });
}

beforeEach(() => {
  clearTraceRuns();
});

describe("createTracedLogger", () => {
  it("captures calls made through nested child loggers", () => {
    const run = newRun();
    const traced = createTracedLogger(silentLogger(), run);

    traced.info({ fileId: "f1" }, "smartEnrichFile: start");
    const child = traced.child({ component: "enrichment" });
    const grandchild = child.child({ stage: "materialize" });
    grandchild.warn({ displayName: "Canvasx" }, "Dropped email-provider company mention");

    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]).toMatchObject({ seq: 1, level: "info", msg: "smartEnrichFile: start" });
    expect(run.steps[1]).toMatchObject({
      seq: 2,
      level: "warn",
      msg: "Dropped email-provider company mention",
      fields: { displayName: "Canvasx" },
    });
  });

  it("records levels the logger itself would not print", () => {
    const run = newRun();
    createTracedLogger(pino({ level: "error" }), run).debug({ matchedCount: 3 }, "entity match results");

    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].level).toBe("debug");
  });

  it("truncates long strings and large arrays instead of holding the payload", () => {
    const run = newRun();
    const traced = createTracedLogger(silentLogger(), run);

    traced.info({ content: "x".repeat(5000), mentions: Array.from({ length: 400 }, (_, i) => `m${i}`) }, "extracted");

    const fields = run.steps[0].fields as { content: string; mentions: unknown[] };
    expect(fields.content.length).toBeLessThan(700);
    expect(fields.content.endsWith("…")).toBe(true);
    expect(fields.mentions.length).toBeLessThan(30);
    expect(String(fields.mentions.at(-1))).toContain("more");
  });

  it("stops appending once a run hits the step cap and says so", () => {
    const run = newRun();
    const traced = createTracedLogger(silentLogger(), run);

    for (let i = 0; i < 4100; i++) traced.info({ i }, "step");

    expect(run.truncated).toBe(true);
    expect(run.steps.length).toBeLessThanOrEqual(4000);
  });
});

describe("trace run store", () => {
  it("evicts the oldest runs so the window never becomes a record", () => {
    const created: DevTraceRun[] = [];
    for (let i = 0; i < 25; i++) {
      const run = startTraceRun({ fileId: `f${i}`, fileName: `file-${i}`, dumpDir: "data/llm-dumps/x" });
      created.push(run);
      finishTraceRun(run, "done");
    }

    const listed = listTraceRuns();
    expect(listed).toHaveLength(20);
    expect(listed[0].fileName).toBe("file-24");
    expect(getTraceRun(created[0].id)).toBeUndefined();
    expect(getTraceRun(created[4].id)).toBeUndefined();
    expect(getTraceRun(created[5].id)).toBeDefined();
  });

  it("reports a failed run with its message", () => {
    const run = newRun();
    finishTraceRun(run, "failed", new Error("Gemini rate limited"));

    expect(run.status).toBe("failed");
    expect(run.error).toBe("Gemini rate limited");
    expect(run.finishedAt).not.toBeNull();
  });
});

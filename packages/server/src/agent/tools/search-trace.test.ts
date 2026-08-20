import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HybridSearchResult } from "../../connectors/search";
import { DEV_SEARCH_TRACE_RESULT_CAP, createDevSearchTraceRepository } from "../../db/repositories/dev-search-traces";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { createSearchTraceCapture } from "./search-trace";
import type { SketchMcpDeps } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

function capture(overrides: Partial<SketchMcpDeps> = {}) {
  return createSearchTraceCapture({
    deps: { db, devToolsEnabled: true, currentUserId: "user-1", ...overrides } as SketchMcpDeps,
    origin: "agent",
    query: "auth decision",
    toolArgs: { query: "auth decision" },
    principals: [{ type: "email", value: "a@b.com" }],
  });
}

function result(id: string, score: number): HybridSearchResult {
  return { resultKind: "file", id, hitFileId: id, fileName: id, source: "notion", score } as HybridSearchResult;
}

function candidate(fileId: string, score: number) {
  return {
    fileId,
    fileName: fileId,
    source: "notion",
    ftsRank: 1,
    vecRank: null,
    similarity: null,
    boosted: false,
    score,
    finalPosition: null,
    droppedAt: null,
    dropReason: null,
    mergedInto: null,
  };
}

function searchHit(position: number) {
  return {
    resultKind: "file",
    id: `f-${position}`,
    hitFileId: `f-${position}`,
    fileName: `doc ${position}.txt`,
    source: "slack",
    contentCategory: "document",
    summary: null,
    providerFileId: `p-${position}`,
    providerUrl: null,
    sourcePath: null,
    sourceUpdatedAt: null,
    sourceCreatedAt: null,
    snippet: "a preview",
    similarity: 0.5,
    score: 1 / position,
  } as unknown as HybridSearchResult;
}

async function onlyTrace() {
  const repo = createDevSearchTraceRepository(db);
  const headers = await vi.waitFor(async () => {
    const rows = await repo.list();
    expect(rows.length).toBeGreaterThan(0);
    return rows;
  });
  const detail = await repo.get(headers[0].id);
  if (!detail) throw new Error("trace vanished");
  return detail;
}

describe("createSearchTraceCapture", () => {
  it("returns null when dev tools are off, so no reporter ever reaches the search", () => {
    expect(createSearchTraceCapture({ ...capturedArgs(db), deps: { db } as SketchMcpDeps })).toBeNull();
  });

  it("caps the rows it stores, because the Search tool's limit has no ceiling", async () => {
    /**
     * This is the enforcement point. The repository inserts whatever it is handed, so a
     * test that pre-slices its input to the cap proves nothing — that was the earlier
     * version of this assertion.
     */
    const traced = capture();
    const hits = Array.from({ length: DEV_SEARCH_TRACE_RESULT_CAP + 12 }, (_, index) => searchHit(index + 1));
    traced?.finalOutput(
      hits,
      hits.map((hit) => `**${hit.fileName}**\n> preview`),
    );
    traced?.finish("done", null, hits.length);

    const detail = await onlyTrace();
    expect(detail.results).toHaveLength(DEV_SEARCH_TRACE_RESULT_CAP);
    expect(detail.results[0]?.agentText).toContain("> preview");
    /** The stage still reports the true count, so the cap is visible rather than silent. */
    const stage = detail.stages.find((entry) => entry.stage === "finalOutput");
    expect(stage?.summary?.returned).toBe(DEV_SEARCH_TRACE_RESULT_CAP + 12);
    expect(stage?.summary?.stored).toBe(DEV_SEARCH_TRACE_RESULT_CAP);
  });

  it("records a trace for a search that returned results", async () => {
    const trace = capture();
    trace?.report({ stage: "fuse", label: "Fuse", kind: "code", status: "done", summary: { scored: 3 } });
    trace?.rerank([result("a", 0.9)], false, 0);
    trace?.finish("done", null, 1);

    const detail = await onlyTrace();
    expect(detail.status).toBe("done");
    expect(detail.origin).toBe("agent");
    expect(detail.userId).toBe("user-1");
    expect(detail.resultCount).toBe(1);
    expect(detail.stages.map((stage) => stage.stage)).toEqual(["fuse", "rerank"]);
  });

  it("records a trace for a search that returned nothing, with the reason", async () => {
    const trace = capture();
    trace?.finish("empty", "no query and no filter", 0);

    const detail = await onlyTrace();
    expect(detail.status).toBe("empty");
    expect(detail.error).toBe("no query and no filter");
    expect(detail.stages).toEqual([]);
  });

  it("fills final positions from the order the caller actually received", async () => {
    const trace = capture();
    trace?.report({
      stage: "finalize",
      label: "Collapse",
      kind: "code",
      status: "done",
      candidates: [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)],
    });
    trace?.rerank([result("c", 0.7), result("a", 0.9)], true, 2);
    trace?.finish("done", null, 2);

    const detail = await onlyTrace();
    const rerank = detail.stages.find((stage) => stage.stage === "rerank");
    const positions = Object.fromEntries(
      (rerank?.candidates ?? []).map((entry) => [entry.fileId, entry.finalPosition]),
    );
    expect(positions).toEqual({ c: 1, a: 2, b: null });
  });

  it("builds an independent collector per call, so concurrent searches do not interleave", async () => {
    const one = capture();
    const two = capture();
    one?.report({ stage: "fuse", label: "Fuse", kind: "code", status: "done", summary: { scored: 1 } });
    two?.report({ stage: "fuse", label: "Fuse", kind: "code", status: "done", summary: { scored: 99 } });
    one?.finish("done", null, 1);
    two?.finish("done", null, 99);

    const repo = createDevSearchTraceRepository(db);
    const rows = await vi.waitFor(async () => {
      const listed = await repo.list();
      expect(listed).toHaveLength(2);
      return listed;
    });
    const scores = await Promise.all(
      rows.map(async (row) => {
        const detail = await repo.get(row.id);
        return detail?.stages[0]?.summary?.scored;
      }),
    );
    expect(scores.sort()).toEqual([1, 99]);
  });

  it("records only once, even if finish is called again", async () => {
    const trace = capture();
    trace?.finish("done", null, 1);
    trace?.finish("failed", "second call", 0);

    const repo = createDevSearchTraceRepository(db);
    await vi.waitFor(async () => expect(await repo.list()).toHaveLength(1));
  });
});

function capturedArgs(database: Kysely<DB>) {
  return {
    deps: { db: database } as SketchMcpDeps,
    origin: "agent" as const,
    query: "q",
    toolArgs: {},
    principals: null,
  };
}

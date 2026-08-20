/**
 * Storage for what a traced Search handed back.
 *
 * The age prune is the load-bearing case. An earlier draft compared an ISO cutoff against
 * `CURRENT_TIMESTAMP`, which SQLite writes space-separated — `' '` sorts below `'T'`, so
 * every row read as expired and the first prune emptied the table. Epoch millis removed the
 * format entirely; these tests keep it that way.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import {
  DEV_SEARCH_TEXT_RETENTION_MS,
  DEV_SEARCH_TRACE_RESULT_CAP,
  createDevSearchTraceRepository,
} from "./dev-search-traces";

let db: Kysely<DB>;

const result = (position: number) => ({
  position,
  hitFileId: `file-${position}`,
  resultKind: "file",
  fileName: `doc ${position}.txt`,
  source: "slack",
  providerUrl: null,
  agentText: `**doc ${position}.txt** (Slack)\n> a preview`,
  snippet: "the untruncated snippet",
  summary: null,
  score: 1 / position,
  similarity: 0.5,
});

const trace = (id: string, results = [result(1)]) => ({
  id,
  origin: "agent" as const,
  userId: null,
  conversationId: null,
  query: "connectivity",
  args: {},
  principals: null,
  stages: [],
  status: "done" as const,
  error: null,
  resultCount: results.length,
  durationMs: 5,
  results,
});

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  try {
    await db.destroy();
  } catch {
    // already destroyed
  }
});

describe("dev search trace results", () => {
  it("stores the text the agent received and reads it back in order", async () => {
    const repo = createDevSearchTraceRepository(db);
    await repo.record(trace("t1", [result(1), result(2)]));

    const detail = await repo.get("t1");
    expect(detail?.results.map((row) => row.position)).toEqual([1, 2]);
    expect(detail?.results[0]?.agentText).toContain("> a preview");
    expect(detail?.results[0]?.snippet).toBe("the untruncated snippet");
  });

  it("keeps a row written now, which a lexical cutoff comparison would have deleted", async () => {
    const repo = createDevSearchTraceRepository(db);
    await repo.record(trace("t1"));
    /** A second write is what triggers the prune. */
    await repo.record(trace("t2"));

    expect((await repo.get("t1"))?.results).toHaveLength(1);
    expect((await repo.get("t2"))?.results).toHaveLength(1);
  });

  it("deletes result text older than the retention window on the next write", async () => {
    const repo = createDevSearchTraceRepository(db);
    await repo.record(trace("old"));
    await db
      .updateTable("dev_search_trace_results")
      .set({ created_at_ms: Date.now() - DEV_SEARCH_TEXT_RETENTION_MS - 1000 })
      .execute();

    await repo.record(trace("fresh"));

    expect((await repo.get("old"))?.results).toHaveLength(0);
    expect((await repo.get("fresh"))?.results).toHaveLength(1);
    /** Only the text ages out — the trace and its ranking data survive. */
    expect(await repo.get("old")).not.toBeNull();
  });

  it("records a synthesis per run and lists them without prompts or answers", async () => {
    const repo = createDevSearchTraceRepository(db);
    await repo.record(trace("t1"));

    const first = await repo.recordSynthesis({
      traceId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: "Question: connectivity",
      answer: "an answer",
      status: "done",
      error: null,
      durationMs: 900,
    });

    const listed = await repo.listSyntheses("t1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("prompt");
    expect(listed[0]?.model).toBe("claude-sonnet-4-6");
    expect((await repo.getSynthesis(first))?.prompt).toBe("Question: connectivity");
  });

  it("stores every row it is handed — the cap lives in the capture, not here", async () => {
    /**
     * `record()` inserts what it is given. The cap is applied in
     * `SearchTraceCapture.finalOutput`, which `search-trace.test.ts` covers — an earlier
     * version of this test pre-sliced its input to the cap and so asserted nothing.
     */
    const repo = createDevSearchTraceRepository(db);
    const rows = Array.from({ length: DEV_SEARCH_TRACE_RESULT_CAP + 3 }, (_, index) => result(index + 1));
    await repo.record(trace("t1", rows));

    expect((await repo.get("t1"))?.results).toHaveLength(DEV_SEARCH_TRACE_RESULT_CAP + 3);
  });
});

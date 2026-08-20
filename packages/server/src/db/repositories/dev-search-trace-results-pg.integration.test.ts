/**
 * The epoch-millis columns on Postgres.
 *
 * Migration 198 first declared `created_at_ms` as `integer`, which is int4 on Postgres and
 * caps at 2,147,483,647 — `Date.now()` is already ~1.79e12. Every insert failed with
 * `value "1787229046476" is out of range for type integer`, and since the trace write is one
 * transaction the parent row rolled back with it: searches ran, no trace was ever stored.
 * SQLite's INTEGER is 64-bit, so the entire unit suite passed and only Postgres broke.
 *
 * These run on Postgres specifically. A SQLite-only test cannot see this class of bug.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createDevSearchTraceRepository } from "./dev-search-traces";

let db: Kysely<DB>;

const trace = (id: string) => ({
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
  resultCount: 1,
  durationMs: 5,
  results: [
    {
      position: 1,
      hitFileId: "file-1",
      resultKind: "file",
      fileName: "doc.txt",
      source: "slack",
      providerUrl: null,
      agentText: "**doc.txt** (Slack)\n> a preview",
      snippet: "the untruncated snippet",
      summary: null,
      score: 0.9,
      similarity: 0.5,
    },
  ],
});

beforeEach(async () => {
  db = await createTestPgDb();
});

afterEach(async () => {
  try {
    await db.destroy();
  } catch {
    // already destroyed
  }
});

describe("dev search trace storage on postgres", () => {
  it("stores a trace whose timestamp exceeds int4", async () => {
    const repo = createDevSearchTraceRepository(db);

    await repo.record(trace("t1"));

    const detail = await repo.get("t1");
    expect(detail?.results[0]?.agentText).toContain("> a preview");
  });

  it("reads the synthesis timestamp back as a number, not a bigint string", async () => {
    const repo = createDevSearchTraceRepository(db);
    await repo.record(trace("t2"));

    const before = Date.now();
    await repo.recordSynthesis({
      traceId: "t2",
      provider: "anthropic",
      model: "claude-opus-5",
      prompt: "what changed?",
      answer: "this",
      status: "done",
      error: null,
      durationMs: 12,
    });

    const [synthesis] = await repo.listSyntheses("t2");
    expect(typeof synthesis?.createdAtMs).toBe("number");
    expect(synthesis?.createdAtMs).toBeGreaterThanOrEqual(before);
  });
});

/**
 * Tests for searchFiles() and hybridSearch() on Postgres (PGlite).
 *
 * Complements search.test.ts (SQLite/FTS5). These tests exercise the
 * tsvector/ts_rank path and the pgvector cosine-similarity path that the
 * Phase 2 production code will implement.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { hybridSearch, searchFiles } from "./search";

/**
 * Build a sparse vector string of `dims` dimensions.
 * `values` maps zero-based dimension indices to non-zero floats.
 */
function makeVector(dims: number, values: Record<number, number> = {}): string {
  const arr = new Array(dims).fill(0);
  for (const [idx, val] of Object.entries(values)) {
    arr[Number(idx)] = val;
  }
  return `[${arr.join(",")}]`;
}

async function insertFile(
  db: Kysely<DB>,
  id: string,
  opts: {
    fileName: string;
    source?: string;
    sourcePath?: string;
    summary?: string | null;
    tags?: string | null;
    content?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-pg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "connector-pg",
      provider_file_id: id,
      file_name: opts.fileName,
      file_type: "text",
      content_category: "document",
      source: opts.source ?? "google_drive",
      source_path: opts.sourcePath ?? null,
      provider_url: null,
      content: opts.content ?? null,
      summary: opts.summary ?? null,
      tags: opts.tags ?? null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

describe("searchFiles on Postgres — tsvector/ts_rank", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns results matching by file_name", async () => {
    await insertFile(db, "f-name-1", { fileName: "quarterly-planning.txt" });
    await insertFile(db, "f-name-2", { fileName: "invoice-2024.txt" });

    const results = await searchFiles(db, "quarterly");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-name-1");
    expect(ids).not.toContain("f-name-2");
  });

  it("returns results matching by summary", async () => {
    await insertFile(db, "f-sum-1", {
      fileName: "doc.txt",
      summary: "annual budget review",
    });
    await insertFile(db, "f-sum-2", { fileName: "other.txt", summary: "meeting notes" });

    const results = await searchFiles(db, "budget");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-sum-1");
    expect(ids).not.toContain("f-sum-2");
  });

  it("returns results matching by tags", async () => {
    await insertFile(db, "f-tag-1", {
      fileName: "doc.txt",
      tags: '["engineering","roadmap"]',
    });
    await insertFile(db, "f-tag-2", { fileName: "doc.txt", tags: '["sales","pipeline"]' });

    const results = await searchFiles(db, "roadmap");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-tag-1");
    expect(ids).not.toContain("f-tag-2");
  });

  it("returns empty array for a query that matches nothing", async () => {
    await insertFile(db, "f-empty-1", { fileName: "unrelated.txt" });

    const results = await searchFiles(db, "xyzzyquuxfrob");
    expect(results).toHaveLength(0);
  });

  it("respects source filter", async () => {
    await insertFile(db, "f-src-1", { fileName: "planning.txt", source: "google_drive" });
    await insertFile(db, "f-src-2", { fileName: "planning.txt", source: "notion" });

    const results = await searchFiles(db, "planning", { source: "notion" });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-src-2");
    expect(ids).not.toContain("f-src-1");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await insertFile(db, `f-lim-${i}`, { fileName: `planning-doc-${i}.txt` });
    }

    const results = await searchFiles(db, "planning", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("does not throw for queries with special characters", async () => {
    await insertFile(db, "f-special-1", { fileName: "planning.txt" });

    const specialQueries = [
      "planning & review",
      "planning | review",
      "planning -- review",
      "plan!ning",
      "(planning)",
      "100%",
      "plan:ning",
    ];

    for (const query of specialQueries) {
      await expect(searchFiles(db, query)).resolves.not.toThrow();
    }
  });

  it("relevance score is a number (ts_rank)", async () => {
    await insertFile(db, "f-rank-1", { fileName: "strategic-planning.txt", summary: "planning overview" });

    const results = await searchFiles(db, "planning");
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].relevance).toBe("number");
  });
});

describe("hybridSearch on Postgres — vector + FTS", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("hybridSearch with queryEmbedding returns results ranked by cosine similarity", async () => {
    await insertFile(db, "f-vec-1", { fileName: "similar-doc.txt", summary: "machine learning overview" });
    await insertFile(db, "f-vec-2", { fileName: "distant-doc.txt", summary: "accounting spreadsheet" });

    // Insert a document_chunks row for f-vec-1
    const chunkId = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({
        id: chunkId,
        indexed_file_id: "f-vec-1",
        chunk_index: 0,
        content: "machine learning overview content",
        token_count: 10,
      })
      .execute();

    // Insert chunk embedding with a vector pointing in direction of dim 0
    const embeddingVec = makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0 });
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (${chunkId}, ${embeddingVec}::vector)`.execute(
      db,
    );

    // Query with a vector closely aligned to f-vec-1's embedding
    const queryEmbedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 0.9;
    queryEmbedding[1] = 0.1;

    const results = await hybridSearch(db, "machine learning", { queryEmbedding });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-vec-1");
  });

  it("hybridSearch without queryEmbedding falls back to FTS-only", async () => {
    await insertFile(db, "f-fts-1", { fileName: "planning-overview.txt", summary: "strategic planning" });
    await insertFile(db, "f-fts-2", { fileName: "invoice-april.txt", summary: "billing invoice" });

    const results = await hybridSearch(db, "planning");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-fts-1");
    expect(ids).not.toContain("f-fts-2");
  });

  it("hybridSearch with time filter restricts results by timeframe", async () => {
    await insertFile(db, "f-tf-1", { fileName: "q1-review.txt", summary: "Q1 quarterly review" });
    await insertFile(db, "f-tf-2", { fileName: "q4-review.txt", summary: "Q4 quarterly review" });

    // Add a timeframe for f-tf-1 (Q1 2024)
    await db
      .insertInto("document_timeframes")
      .values({
        id: randomUUID(),
        indexed_file_id: "f-tf-1",
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        context: "Q1 2024",
      })
      .execute();

    // Add a timeframe for f-tf-2 (Q4 2024)
    await db
      .insertInto("document_timeframes")
      .values({
        id: randomUUID(),
        indexed_file_id: "f-tf-2",
        start_date: "2024-10-01",
        end_date: "2024-12-31",
        context: "Q4 2024",
      })
      .execute();

    const results = await hybridSearch(db, "quarterly", {
      timeFilter: { after: "2024-01-01", before: "2024-06-30" },
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-tf-1");
    expect(ids).not.toContain("f-tf-2");
  });
});

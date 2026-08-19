/**
 * Tests for searchFiles() and hybridSearch() on Postgres (PGlite).
 *
 * Complements search.test.ts (SQLite/FTS5). These tests exercise the
 * tsvector/ts_rank path and the pgvector cosine-similarity path that the
 * Phase 2 production code will implement.
 */
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import type { DB } from "../db/schema";
import { createTestPgDb, getSharedPgDb } from "../test-utils";
import type { StageReport } from "./enrichment-stage-report";
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
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

describe("searchFiles on Postgres — tsvector/ts_rank", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("returns results matching by file_name", async () => {
    await insertFile(db, "f-name-1", { fileName: "quarterly-planning.txt" });
    await insertFile(db, "f-name-2", { fileName: "invoice-2024.txt" });

    const results = await searchFiles(db, "quarterly");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("f-name-1");
    expect(ids).not.toContain("f-name-2");
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
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
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
    await insertFile(db, "f-tf-1", { fileName: "q1-quarterly-review.txt", summary: "Q1 review" });
    await insertFile(db, "f-tf-2", { fileName: "q4-quarterly-review.txt", summary: "Q4 review" });

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

/**
 * Its own database, not the shared one with per-test BEGIN/ROLLBACK.
 *
 * `hybridSearch` opens its own transaction for the KNN reads, so under an ambient
 * manual BEGIN the inner COMMIT ends the outer transaction and the rollback no longer
 * undoes anything — rows leak into the next test. This is the case CLAUDE.md reserves a
 * fresh `createTestPgDb()` for.
 */
describe("hybridSearch vector hit sources", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
  }, 30000);

  /**
   * Explicit deletes rather than the usual BEGIN/ROLLBACK: `hybridSearch` opens its own
   * transaction, so an ambient one would be committed out from under the test. Cascades
   * from `indexed_files` clear the chunk and field embedding rows.
   */
  afterEach(async () => {
    await sql`DELETE FROM indexed_files`.execute(db);
  });

  it("shows the vector that won a file even when its source's slots are taken by losers", async () => {
    /**
     * 60 files whose closest vector is a content chunk, 20 of which also carry a worse
     * file-name vector, plus one file reachable only by its name. That last name vector
     * is the worst-ranked of its source but the only thing representing its file — and
     * filling the source's slots by global rank alone would spend all 15 on the losers
     * and drop it.
     */
    for (let i = 0; i < 60; i++) {
      await insertFile(db, `f-chunk-${i}`, { fileName: `doc ${i}.txt`, summary: null });
      const chunkId = randomUUID();
      await db
        .insertInto("document_chunks")
        .values({ id: chunkId, indexed_file_id: `f-chunk-${i}`, chunk_index: 0, content: `body ${i}`, token_count: 5 })
        .execute();
      await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (
        ${chunkId}, ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0, 1: 0.001 * i })}::vector
      )`.execute(db);

      if (i < 20) {
        await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
          ${`f-chunk-${i}`}, 'file_name',
          ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0, 1: 0.9 + 0.001 * i })}::vector,
          ${`doc ${i}.txt`}
        )`.execute(db);
      }
    }

    await insertFile(db, "f-name-only", { fileName: "reachable only by name.txt", summary: null });
    await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
      'f-name-only', 'file_name',
      ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0, 1: 1.4 })}::vector,
      'reachable only by name.txt'
    )`.execute(db);

    const queryEmbedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 1.0;

    const reports: StageReport[] = [];
    await hybridSearch(db, "doc", { queryEmbedding, stageReport: (report) => reports.push(report) });

    const hits = reports.find((report) => report.stage === "vectorCandidates")?.vectorChunks ?? [];
    const nameHits = hits.filter((hit) => hit.source === "file_name");

    /** Worst of its source, but the only row that carries its file. */
    expect(nameHits.some((hit) => hit.fileId === "f-name-only" && hit.bestForFile)).toBe(true);

    /** No file may appear only through a row that lost, while the winner is off the page. */
    const shownByFile = new Map<string, boolean>();
    for (const hit of hits) shownByFile.set(hit.fileId, (shownByFile.get(hit.fileId) ?? false) || hit.bestForFile);
    expect([...shownByFile.entries()].filter(([, hasWinner]) => !hasWinner)).toEqual([]);
  });

  it("keeps a distant summary visible when near-identical file names fill the cap", async () => {
    /**
     * The real corpus that produced this: 70 WhatsApp files named
     * `WhatsApp: Internal OW - <timestamp>`, whose name vectors sit ~0.13 apart. A
     * name-shaped query pulls all of them into one band that fills the display cap, and
     * the tool showed zero summary hits while the summary arm was scoring normally.
     */
    for (let i = 0; i < 70; i++) {
      await insertFile(db, `f-name-${i}`, { fileName: `templated name ${i}.txt`, summary: null });
      await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
        ${`f-name-${i}`}, 'file_name',
        ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0, 1: 0.001 * i })}::vector,
        ${`templated name ${i}.txt`}
      )`.execute(db);
    }

    await insertFile(db, "f-far-summary", { fileName: "outlier.txt", summary: "a distant summary" });
    await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
      'f-far-summary', 'summary', ${makeVector(EMBEDDING_DIMENSIONS, { 0: 0.5, 1: 0.866 })}::vector, 'a distant summary'
    )`.execute(db);

    const queryEmbedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 1.0;

    const reports: StageReport[] = [];
    await hybridSearch(db, "templated name", {
      queryEmbedding,
      stageReport: (report) => reports.push(report),
    });

    const hits = reports.find((report) => report.stage === "vectorCandidates")?.vectorChunks ?? [];
    const summaryHits = hits.filter((hit) => hit.source === "summary");

    /** Every name outranks it, so a flat top-60 would have cut it entirely. */
    expect(summaryHits).toHaveLength(1);
    expect(summaryHits[0]?.rank).toBeGreaterThan(60);
    expect(hits.filter((hit) => hit.source === "file_name").length).toBeGreaterThan(15);
  });

  it("labels each vector hit with its source, and gives the file to the closest one", async () => {
    await insertFile(db, "f-src-1", {
      fileName: "notes.txt",
      summary: "a summary that is a near-exact match for the query",
      content: "loosely related body text",
    });

    const chunkId = randomUUID();
    await db
      .insertInto("document_chunks")
      .values({
        id: chunkId,
        indexed_file_id: "f-src-1",
        chunk_index: 0,
        content: "loosely related body text",
        token_count: 10,
      })
      .execute();

    /** The chunk sits at ~60 degrees off the query; the summary sits directly on it. */
    await sql`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (
    ${chunkId}, ${makeVector(EMBEDDING_DIMENSIONS, { 0: 0.5, 1: 0.866 })}::vector
  )`.execute(db);
    await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
    'f-src-1', 'summary', ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1.0 })}::vector, 'a summary that is a near-exact match for the query'
  )`.execute(db);
    await sql`INSERT INTO file_field_embeddings (indexed_file_id, field, embedding, source_text) VALUES (
    'f-src-1', 'file_name', ${makeVector(EMBEDDING_DIMENSIONS, { 2: 1.0 })}::vector, 'notes.txt'
  )`.execute(db);

    const queryEmbedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 1.0;

    const reports: StageReport[] = [];
    await hybridSearch(db, "near-exact match", {
      queryEmbedding,
      stageReport: (report) => reports.push(report),
    });

    const hits = reports.find((report) => report.stage === "vectorCandidates")?.vectorChunks ?? [];
    expect(hits.map((hit) => hit.source).sort()).toEqual(["content", "file_name", "summary"]);

    const summaryHit = hits.find((hit) => hit.source === "summary");
    const contentHit = hits.find((hit) => hit.source === "content");
    const nameHit = hits.find((hit) => hit.source === "file_name");

    expect(summaryHit?.chunkPreview).toContain("near-exact match");
    expect(nameHit?.chunkPreview).toBe("notes.txt");

    /**
     * The whole point: one file, three vectors, and only the closest one is credited.
     * Before field vectors existed the content chunk would have been marked green here.
     */
    expect(summaryHit?.bestForFile).toBe(true);
    expect(contentHit?.bestForFile).toBe(false);
    expect(nameHit?.bestForFile).toBe(false);
    expect((summaryHit?.distance ?? 1) < (contentHit?.distance ?? 0)).toBe(true);
  });
});

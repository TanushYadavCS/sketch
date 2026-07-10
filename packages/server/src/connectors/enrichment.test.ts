/**
 * Tests for the enrichment pipeline.
 *
 * Focuses on batch operations:
 * - clearEnrichmentData removes chunks via a single subquery DELETE
 *   (no N per-chunk calls)
 * - runEnrichment inserts multiple chunks in a single batch INSERT
 *
 * Uses a real in-memory SQLite DB (without sqlite-vec, so no embeddings).
 * The LLM call is stubbed to return a simple tagging result.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { EmbeddingProvider } from "./embeddings/types";
import { clearEnrichmentData, isEnrichmentActive, runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";

/** Insert the minimum rows needed to have an indexed file ready for enrichment. */
async function seedFile(
  db: Kysely<DB>,
  fileId: string,
  content: string,
  opts: {
    connectorType?: string;
    fileName?: string;
    fileType?: string;
    contentCategory?: string;
    source?: string;
    sourcePath?: string;
  } = {},
): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "conn-1",
      connector_type: opts.connectorType ?? "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "conn-1",
      provider_file_id: fileId,
      file_name: opts.fileName ?? "test.txt",
      file_type: opts.fileType ?? "text",
      content_category: opts.contentCategory ?? "document",
      source: opts.source ?? "google_drive",
      source_path: opts.sourcePath ?? "My Drive",
      provider_url: null,
      content,
      summary: null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function seedImageFile(db: Kysely<DB>, fileId: string, sourceUpdatedAt: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "conn-1",
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
      id: fileId,
      connector_config_id: "conn-1",
      provider_file_id: fileId,
      file_name: "image.png",
      file_type: "image",
      content_category: "document",
      source: "google_drive",
      source_path: "My Drive",
      provider_url: null,
      content: null,
      content_hash: null,
      mime_type: "image/png",
      summary: null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: sourceUpdatedAt,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

describe("clearEnrichmentData — batch DELETE via subquery", () => {
  let db: Kysely<DB>;

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

  it("removes all chunks for the file in a single operation", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content");

    // Insert several document_chunks manually
    const chunkIds = [randomUUID(), randomUUID(), randomUUID()];
    await db
      .insertInto("document_chunks")
      .values(
        chunkIds.map((id, i) => ({
          id,
          indexed_file_id: fileId,
          chunk_index: i,
          content: `chunk content ${i}`,
          token_count: 10,
        })),
      )
      .execute();

    const beforeCount = await db
      .selectFrom("document_chunks")
      .where("indexed_file_id", "=", fileId)
      .select(sql<number>`count(*)`.as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(beforeCount.n)).toBe(3);

    await clearEnrichmentData(db, fileId);

    const afterCount = await db
      .selectFrom("document_chunks")
      .where("indexed_file_id", "=", fileId)
      .select(sql<number>`count(*)`.as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(afterCount.n)).toBe(0);
  });

  it("is a no-op for a file with no chunks (no throw)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "content");
    await expect(clearEnrichmentData(db, fileId)).resolves.toBeUndefined();
  });

  it("preserves EXTRACTED mentions and removes content-derived mentions", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "content");
    const entityRepo = createEntityRepository(db);
    const extractedEntity = await entityRepo.upsertPersonEntity({
      name: "Extracted Person",
      email: "extracted@example.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "meeting-1:extracted@example.com",
    });
    const inferredEntity = await entityRepo.upsertEntity({
      name: "Inferred Company",
      sourceType: "company",
      status: "confirmed",
    });

    await entityRepo.createMention({
      entityId: extractedEntity.id,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    await entityRepo.createMention({
      entityId: inferredEntity.id,
      indexedFileId: fileId,
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    await clearEnrichmentData(db, fileId);

    const mentions = await db.selectFrom("entity_mentions").selectAll().where("indexed_file_id", "=", fileId).execute();
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      entity_id: extractedEntity.id,
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
  });
});

describe("runEnrichment — batch chunk insert", () => {
  let db: Kysely<DB>;

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

  it("inserts multiple chunks for a file in a single run", async () => {
    const fileId = randomUUID();
    // Use text long enough to produce multiple chunks at default maxTokens=500
    // (500 tokens * 4 chars = 2000 chars per chunk; we'll force small chunks via content length)
    const longContent = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(25).trim()}`).join(
      "\n\n",
    );
    await seedFile(db, fileId, longContent);

    // Set embedding_status to pending
    await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "=", fileId).execute();

    const logger = createTestLogger();

    await runEnrichment({
      db,
      logger,
      embeddingProvider: null,
      fileIds: [fileId],
    });

    const chunks = await db
      .selectFrom("document_chunks")
      .where("indexed_file_id", "=", fileId)
      .selectAll()
      .orderBy("chunk_index", "asc")
      .execute();

    // The long content should produce at least 2 chunks
    expect(chunks.length).toBeGreaterThan(1);

    // Chunk indices should be sequential
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it("processes every pending file with its own content fetched lazily", async () => {
    const files = [
      { id: randomUUID(), marker: "ALPHAMARKER" },
      { id: randomUUID(), marker: "BRAVOMARKER" },
      { id: randomUUID(), marker: "CHARLIEMARKER" },
    ];
    for (const f of files) {
      await seedFile(db, f.id, `${f.marker} document body ${"word ".repeat(30).trim()}`, {
        fileName: `${f.marker}.txt`,
      });
      await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "=", f.id).execute();
    }

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });

    expect(result.filesProcessed).toBe(files.length);
    for (const f of files) {
      const chunks = await db
        .selectFrom("document_chunks")
        .select("content")
        .where("indexed_file_id", "=", f.id)
        .execute();
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => c.content).join(" ")).toContain(f.marker);

      const status = await db
        .selectFrom("indexed_files")
        .select("embedding_status")
        .where("id", "=", f.id)
        .executeTakeFirstOrThrow();
      expect(status.embedding_status).toBe("done");
    }
  });

  it("runs smart enrichment for short calendar event documents", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "Planning review with Jane Doe from Acme about pricing next steps tomorrow morning.", {
      connectorType: "google_calendar",
      fileName: "Planning review",
      fileType: "calendar_event",
      source: "google_calendar",
      sourcePath: "Google Calendar / Work",
    });
    await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "=", fileId).execute();

    let extractCalls = 0;
    const generator = {
      generate: async () => "Planning review summary.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          extractCalls += 1;
          return { mentions: [], relations: [] } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      fileIds: [fileId],
      generator,
    });

    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary", "summary_status"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(result.filesProcessed).toBe(1);
    expect(extractCalls).toBe(1);
    expect(file).toEqual({
      embedding_status: "done",
      summary: "Planning review summary.",
      summary_status: "done",
    });
  });
});

/**
 * Scheduled enrichment must not claim files already in `processing` — that path
 * lets two concurrent runs both "claim" the same file (status stays `processing`,
 * `numUpdatedRows` is 1 for both) and race on chunk_embeddings inserts. Manual
 * fileIds reruns are the explicit-override escape hatch.
 */
describe("runEnrichment — claim semantics", () => {
  let db: Kysely<DB>;

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

  async function setStatus(fileId: string, status: "pending" | "failed" | "processing" | "done"): Promise<void> {
    await db.updateTable("indexed_files").set({ embedding_status: status }).where("id", "=", fileId).execute();
  }

  async function getStatus(fileId: string): Promise<string | undefined> {
    const row = await db
      .selectFrom("indexed_files")
      .select("embedding_status")
      .where("id", "=", fileId)
      .executeTakeFirst();
    return row?.embedding_status ?? undefined;
  }

  it("scheduled run does NOT pick up files in `processing` status", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content here");
    await setStatus(fileId, "processing");

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });

    // The file should be untouched: not in pendingFiles, so neither processed nor skipped.
    expect(result.filesProcessed).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(await getStatus(fileId)).toBe("processing");
  });

  it("scheduled run picks up `pending` files", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content here");
    await setStatus(fileId, "pending");

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });

    expect(result.filesProcessed).toBe(1);
    expect(await getStatus(fileId)).toBe("done");
  });

  it("scheduled run picks up `failed` files (retry)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content here");
    await setStatus(fileId, "failed");

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });

    expect(result.filesProcessed).toBe(1);
    expect(await getStatus(fileId)).toBe("done");
  });

  it("explicit fileIds rerun DOES claim a file in `processing` (manual override)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content here");
    await setStatus(fileId, "processing");

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      fileIds: [fileId],
    });

    expect(result.filesProcessed).toBe(1);
    expect(await getStatus(fileId)).toBe("done");
  });

  it("respects maxFilesPerRun and leaves the rest pending", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      await seedFile(db, id, "some content here");
      await setStatus(id, "pending");
    }

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null, maxFilesPerRun: 2 });

    const statuses = await db
      .selectFrom("indexed_files")
      .select(["id", "embedding_status"])
      .where("id", "in", ids)
      .execute();
    const doneCount = statuses.filter((row) => row.embedding_status === "done").length;
    const pendingCount = statuses.filter((row) => row.embedding_status === "pending").length;
    expect(result.filesProcessed).toBe(2);
    expect(result.stoppedReason).toBe("file_limit");
    expect(doneCount).toBe(2);
    expect(pendingCount).toBe(1);
  });

  it("stops before claiming another file when the time budget is exhausted", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await seedFile(db, id, "some content here");
      await setStatus(id, "pending");
    }
    let now = 0;
    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      maxFilesPerRun: 2,
      timeBudgetMs: 2,
      now: () => now++,
    });

    const statuses = await db
      .selectFrom("indexed_files")
      .select(["id", "embedding_status"])
      .where("id", "in", ids)
      .execute();
    expect(result.filesProcessed).toBe(1);
    expect(result.stoppedReason).toBe("time_budget");
    expect(statuses.filter((row) => row.embedding_status === "done")).toHaveLength(1);
    expect(statuses.filter((row) => row.embedding_status === "pending")).toHaveLength(1);
  });

  it("tracks overlapping enrichment runs until all have finished", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    await seedFile(db, firstId, "some content here");
    await seedFile(db, secondId, "some other content here");
    await setStatus(firstId, "pending");
    await setStatus(secondId, "pending");

    const embedResolves: Array<() => void> = [];
    const embeddingProvider: EmbeddingProvider = {
      name: "blocking-test",
      dimensions: 1,
      supportsImages: false,
      embedTexts: async (texts) =>
        new Promise((resolve) => {
          embedResolves.push(() => resolve(texts.map(() => [1])));
        }),
    };
    let firstDone = false;
    let secondDone = false;

    const firstRun = runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider,
      fileIds: [firstId],
    }).finally(() => {
      firstDone = true;
    });
    const secondRun = runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider,
      fileIds: [secondId],
    }).finally(() => {
      secondDone = true;
    });

    await vi.waitFor(() => expect(embedResolves).toHaveLength(2));
    expect(isEnrichmentActive()).toBe(true);

    embedResolves[0]();
    await vi.waitFor(() => expect(firstDone).toBe(true));
    expect(secondDone).toBe(false);
    expect(isEnrichmentActive()).toBe(true);

    embedResolves[1]();
    await Promise.all([firstRun, secondRun]);
    expect(isEnrichmentActive()).toBe(false);
  });

  it("skips stale completion when the file is synced during enrichment", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "old body mentioning Acme before the sync update");
    await setStatus(fileId, "pending");

    let releaseEmbedding!: () => void;
    let resolveEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      resolveEmbeddingStarted = resolve;
    });
    const embeddingProvider: EmbeddingProvider = {
      name: "blocking-test",
      dimensions: 1,
      supportsImages: false,
      embedTexts: async (texts) => {
        resolveEmbeddingStarted();
        await new Promise<void>((resolve) => {
          releaseEmbedding = resolve;
        });
        return texts.map(() => [1]);
      },
    };

    const run = runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider,
      fileIds: [fileId],
    });

    await embeddingStarted;
    const newerSyncedAt = new Date(Date.now() + 1000).toISOString();
    await db
      .updateTable("indexed_files")
      .set({
        content: "new body from the later sync",
        content_hash: "new-hash",
        synced_at: newerSyncedAt,
        embedding_status: "pending",
        summary_status: "pending",
        summary: null,
      })
      .where("id", "=", fileId)
      .execute();
    await clearEnrichmentData(db, fileId);

    releaseEmbedding();
    const result = await run;

    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status", "synced_at", "content"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();
    const chunkCount = await db
      .selectFrom("document_chunks")
      .select(sql<number>`count(*)`.as("n"))
      .where("indexed_file_id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(file).toEqual({
      embedding_status: "pending",
      summary_status: "pending",
      synced_at: newerSyncedAt,
      content: "new body from the later sync",
    });
    expect(Number(chunkCount.n)).toBe(0);
  });

  it("completes when an unchanged sync only bumps synced_at during enrichment", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "unchanged body mentioning Acme during a later sync");
    await setStatus(fileId, "pending");

    let releaseEmbedding!: () => void;
    let resolveEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      resolveEmbeddingStarted = resolve;
    });
    const embeddingProvider: EmbeddingProvider = {
      name: "blocking-test",
      dimensions: 1,
      supportsImages: false,
      embedTexts: async (texts) => {
        resolveEmbeddingStarted();
        await new Promise<void>((resolve) => {
          releaseEmbedding = resolve;
        });
        return texts.map(() => [1]);
      },
    };

    const run = runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider,
      fileIds: [fileId],
    });

    await embeddingStarted;
    const newerSyncedAt = new Date(Date.now() + 1000).toISOString();
    await db
      .updateTable("indexed_files")
      .set({
        synced_at: newerSyncedAt,
      })
      .where("id", "=", fileId)
      .execute();

    releaseEmbedding();
    const result = await run;

    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status", "synced_at"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(file).toEqual({
      embedding_status: "done",
      summary_status: "skipped",
      synced_at: newerSyncedAt,
    });
  });

  it("skips stale completion when a hashless image source timestamp changes during enrichment", async () => {
    const fileId = randomUUID();
    const originalSourceUpdatedAt = "2026-01-01T00:00:00.000Z";
    const newerSourceUpdatedAt = "2026-01-02T00:00:00.000Z";
    await seedImageFile(db, fileId, originalSourceUpdatedAt);
    await setStatus(fileId, "pending");

    let releaseEmbedding!: () => void;
    let resolveEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      resolveEmbeddingStarted = resolve;
    });
    const embeddingProvider: EmbeddingProvider = {
      name: "blocking-image-test",
      dimensions: 1,
      supportsImages: true,
      embedTexts: async () => {
        throw new Error("text embedding should not be called for image test");
      },
      embedImage: async () => {
        resolveEmbeddingStarted();
        await new Promise<void>((resolve) => {
          releaseEmbedding = resolve;
        });
        return [1];
      },
    };

    const run = runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider,
      fileIds: [fileId],
      downloadImage: async () => ({ buffer: Buffer.from("image"), mimeType: "image/png" }),
    });

    await embeddingStarted;
    await db
      .updateTable("indexed_files")
      .set({
        source_updated_at: newerSourceUpdatedAt,
        synced_at: new Date(Date.now() + 1000).toISOString(),
        embedding_status: "pending",
      })
      .where("id", "=", fileId)
      .execute();

    releaseEmbedding();
    const result = await run;

    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "source_updated_at"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(file).toEqual({ embedding_status: "pending", source_updated_at: newerSourceUpdatedAt });
  });

  it("explicit fileIds rerun DOES claim a file in `done` (manual override)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "some content here");
    await setStatus(fileId, "done");

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      fileIds: [fileId],
    });

    expect(result.filesProcessed).toBe(1);
    expect(await getStatus(fileId)).toBe("done");
  });

  it("no-key enrichment preserves existing LLM extraction mentions", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "Jane Doe discussed the launch plan.");
    await setStatus(fileId, "pending");
    const entity = await createEntityRepository(db).upsertEntity({
      name: "Jane Doe",
      sourceType: "person",
      status: "confirmed",
    });
    await createEntityRepository(db).createMention({
      entityId: entity.id,
      indexedFileId: fileId,
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null, fileIds: [fileId] });

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["source", "confidence", "relation"])
      .where("indexed_file_id", "=", fileId)
      .execute();
    expect(mentions).toContainEqual({ source: "llm_extraction", confidence: "INFERRED", relation: "mentioned" });
    expect(mentions.some((mention) => mention.source === "deterministic_substring")).toBe(false);
  });

  it("no-key enrichment does not create deterministic substring mentions", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "Jane Doe discussed the launch plan.");
    await setStatus(fileId, "pending");
    await createEntityRepository(db).upsertEntity({
      name: "Jane Doe",
      sourceType: "person",
      status: "confirmed",
    });

    await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null, fileIds: [fileId] });

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["source", "confidence", "relation"])
      .where("indexed_file_id", "=", fileId)
      .execute();
    expect(mentions).toEqual([]);
  });
});

describe("runEnrichment — chronological pending-files order", () => {
  let db: Kysely<DB>;

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

  it("processes pending files in source_created_at ascending order with id as tiebreaker", async () => {
    await db
      .insertInto("connector_configs")
      .values({
        id: "conn-order",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();

    const oldest = "f-aaa";
    const middleEarlier = "f-bbb";
    const middleLater = "f-ccc";
    const newest = "f-ddd";
    const tsOld = "2025-06-01T00:00:00.000Z";
    const tsMid = "2026-01-15T00:00:00.000Z";
    const tsNew = "2026-04-01T00:00:00.000Z";

    const insertions = [
      { id: middleLater, ts: tsMid },
      { id: newest, ts: tsNew },
      { id: oldest, ts: tsOld },
      { id: middleEarlier, ts: tsMid },
    ];
    for (const row of insertions) {
      await db
        .insertInto("indexed_files")
        .values({
          id: row.id,
          connector_config_id: "conn-order",
          provider_file_id: row.id,
          file_name: `${row.id}.txt`,
          file_type: "text",
          content_category: "document",
          source: "google_drive",
          source_path: "My Drive",
          content: `marker:${row.id} this is a fixture body unique to the file so embedTexts can identify which file is being processed in the loop.`,
          source_created_at: row.ts,
          source_updated_at: row.ts,
          synced_at: new Date().toISOString(),
        })
        .execute();
    }

    const order: string[] = [];
    const markerRe = /marker:(f-[a-z]+)/;
    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: {
        name: "stub",
        dimensions: 8,
        supportsImages: false,
        async embedTexts(texts: string[]) {
          for (const text of texts) {
            const m = text.match(markerRe);
            if (m && !order.includes(m[1])) order.push(m[1]);
          }
          return texts.map(() => new Array(8).fill(0));
        },
      },
    });

    expect(result.filesProcessed).toBe(4);
    expect(order).toEqual([oldest, middleEarlier, middleLater, newest]);
  });

  it("honors scheduled retry backoff but lets explicit reruns bypass it", async () => {
    const embeddingFileId = randomUUID();
    const summaryFileId = randomUUID();
    await seedFile(db, embeddingFileId, "embedding retry body");
    await seedFile(db, summaryFileId, "summary retry body");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await db
      .updateTable("indexed_files")
      .set({ embedding_status: "failed", embedding_attempts: 1, embedding_next_retry_at: future })
      .where("id", "=", embeddingFileId)
      .execute();
    await db
      .updateTable("indexed_files")
      .set({
        embedding_status: "done",
        summary_status: "failed",
        summary_attempts: 1,
        summary_next_retry_at: future,
      })
      .where("id", "=", summaryFileId)
      .execute();

    const scheduled = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });
    expect(scheduled.filesProcessed).toBe(0);
    expect(scheduled.filesFailed).toBe(0);

    const explicitEmbedding = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      fileIds: [embeddingFileId],
    });
    const explicitSummary = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      fileIds: [summaryFileId],
    });

    expect(explicitEmbedding.filesProcessed).toBe(1);
    expect(explicitSummary.filesProcessed).toBe(1);
  });

  it("embedding retries preserve completed summary state", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, "retry body ".repeat(120));
    await db
      .updateTable("indexed_files")
      .set({
        embedding_status: "failed",
        embedding_attempts: 1,
        embedding_next_retry_at: new Date(Date.now() - 60 * 1000).toISOString(),
        summary_status: "done",
        summary_attempts: 0,
        summary_next_retry_at: null,
      })
      .where("id", "=", fileId)
      .execute();

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: {
        name: "stub",
        dimensions: 8,
        supportsImages: false,
        async embedTexts(texts: string[]) {
          return texts.map(() => new Array(8).fill(0));
        },
      },
    });

    const row = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status", "summary_attempts", "summary_next_retry_at"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(result.filesProcessed).toBe(1);
    expect(row.embedding_status).toBe("done");
    expect(row.summary_status).toBe("done");
    expect(row.summary_attempts).toBe(0);
    expect(row.summary_next_retry_at).toBeNull();
  });
});

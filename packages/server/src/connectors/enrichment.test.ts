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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { clearEnrichmentData, matchesAsWord, runEnrichment } from "./enrichment";

/** Insert the minimum rows needed to have an indexed file ready for enrichment. */
async function seedFile(db: Kysely<DB>, fileId: string, content: string): Promise<void> {
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
      file_name: "test.txt",
      file_type: "text",
      content_category: "document",
      source: "google_drive",
      source_path: "My Drive",
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

  it("deterministic relinking preserves LLM extraction mentions", async () => {
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
  });
});

describe("matchesAsWord — word-boundary entity name matching", () => {
  it("does NOT match a name embedded inside a longer word", () => {
    // The bug that motivated this helper: "Anshu" inside "Himanshu" was
    // creating false-positive entity_mentions on every "Himanshu" doc.
    expect(matchesAsWord("himanshu kalra is here", "anshu")).toBe(false);
    expect(matchesAsWord("estimated 5 days", "tim")).toBe(false);
    expect(matchesAsWord("donate to charity", "don")).toBe(false);
  });

  it("matches at word boundaries", () => {
    expect(matchesAsWord("anshu is on the call", "anshu")).toBe(true);
    expect(matchesAsWord("called anshu yesterday", "anshu")).toBe(true);
    expect(matchesAsWord("anshu, please review", "anshu")).toBe(true);
    expect(matchesAsWord("hello, anshu!", "anshu")).toBe(true);
  });

  it("matches multi-word names exactly", () => {
    expect(matchesAsWord("himanshu kalra reviewed it", "himanshu kalra")).toBe(true);
    expect(matchesAsWord("met with himanshu kalra today", "himanshu kalra")).toBe(true);
    expect(matchesAsWord("himanshu and kalra are different people", "himanshu kalra")).toBe(false);
  });

  it("escapes regex metacharacters in names", () => {
    // Names with regex-special chars must not be treated as patterns.
    expect(matchesAsWord("invoiced o.brien yesterday", "o.brien")).toBe(true);
    expect(matchesAsWord("invoiced oXbrien yesterday", "o.brien")).toBe(false);
  });
});

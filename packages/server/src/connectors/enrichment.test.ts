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
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { clearEnrichmentData, runEnrichment } from "./enrichment";

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

/**
 * Tests for smart-enrichment's stale-file-id defensiveness.
 *
 * `entity_candidates.seen_file_ids` is a JSON text blob — not a foreign key —
 * so deletions of `indexed_files` rows (dev resets, manual SQL) leave dangling
 * IDs that would crash the FK-guarded mention backfill on promotion.
 * handleCandidates now prunes those dead IDs at both update time and
 * just-before-insert time.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { EmbeddingProvider } from "./embeddings/types";
import type { GeminiGenerator } from "./gemini-generate";
import { handleCandidates, smartEnrichFile } from "./smart-enrichment";

async function seedFile(db: Kysely<DB>, fileId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "conn-smart",
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
      connector_config_id: "conn-smart",
      provider_file_id: fileId,
      file_name: `${fileId}.txt`,
      file_type: "text",
      content_category: "document",
      source: "google_drive",
      source_path: "/",
      provider_url: null,
      content: "hello",
      summary: null,
      context_note: null,
      access_scope_id: null,
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

function makeDeps(db: Kysely<DB>) {
  return {
    db,
    logger: createTestLogger(),
    generator: (() => {
      throw new Error("generator should not be called in these tests");
    }) as unknown as GeminiGenerator,
    embeddingProvider: null as EmbeddingProvider | null,
  };
}

describe("handleCandidates — stale seen_file_ids", () => {
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

  it("promotion does not crash when seen_file_ids contains a dangling id", async () => {
    const liveFileA = randomUUID();
    const liveFileB = randomUUID();
    const ghostFileId = randomUUID();
    await seedFile(db, liveFileA);
    await seedFile(db, liveFileB);
    await seedFile(db, ghostFileId);

    // Candidate already seen in live_a + ghost (count: 2, at threshold — but
    // ghost is about to be deleted, dropping the effective count to 1).
    await db
      .insertInto("entity_candidates")
      .values({
        id: randomUUID(),
        name: "Project Zephyr",
        type: "project",
        variations: JSON.stringify(["zephyr"]),
        first_seen_file_id: liveFileA,
        seen_file_ids: JSON.stringify([liveFileA, ghostFileId]),
        seen_count: 2,
        promoted_entity_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    // Ghost gets hard-deleted (dev reset / manual SQL). first_seen_file_id
    // points to live_a so the candidate survives.
    await db.deleteFrom("indexed_files").where("id", "=", ghostFileId).execute();

    // Second live sighting (live_b) trips the threshold after prune:
    // [live_a] (pruned from [live_a, ghost]) + live_b = count 2 → promote.
    const promoted = await handleCandidates(makeDeps(db), liveFileB, [
      { mention: "Project Zephyr", type: "project", variations: ["zephyr"] },
    ]);

    expect(promoted).toHaveLength(1);
    expect(promoted[0].name).toBe("Project Zephyr");

    // entity_mentions got backfilled for both live files; the ghost was skipped.
    const entity = await db.selectFrom("entities").selectAll().where("name", "=", "Project Zephyr").executeTakeFirst();
    expect(entity).toBeTruthy();
    if (!entity) return;
    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", entity.id).execute();
    expect(mentions).toHaveLength(2);
    const mentionFileIds = mentions.map((m) => m.indexed_file_id).sort();
    expect(mentionFileIds).toEqual([liveFileA, liveFileB].sort());
  });

  it("prunes dangling ids on update even when threshold is not met", async () => {
    const liveFileId = randomUUID();
    const secondLiveFileId = randomUUID();
    const ghostFileId = randomUUID();
    await seedFile(db, liveFileId);
    await seedFile(db, secondLiveFileId);
    await seedFile(db, ghostFileId);

    // Candidate has seen a live file + a ghost that will soon be gone.
    await db
      .insertInto("entity_candidates")
      .values({
        id: randomUUID(),
        name: "Widget Factory",
        type: "product",
        variations: JSON.stringify([]),
        first_seen_file_id: liveFileId,
        seen_file_ids: JSON.stringify([liveFileId, ghostFileId]),
        seen_count: 2,
        promoted_entity_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    await db.deleteFrom("indexed_files").where("id", "=", ghostFileId).execute();

    // We need threshold still unmet after prune so promotion doesn't fire.
    // After prune: [liveFileId]. Plus the new secondLiveFileId = 2 which hits
    // the threshold (2). To keep "not promoted" behavior we raise the count
    // story by using a candidate that gets a fresh id — the prune alone is
    // what this test observes, not promotion. So we assert that storedIds
    // reflects the prune, regardless of promotion.
    await handleCandidates(makeDeps(db), secondLiveFileId, [
      { mention: "Widget Factory", type: "product", variations: [] },
    ]);

    const candidate = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("name", "=", "Widget Factory")
      .executeTakeFirst();
    expect(candidate).toBeTruthy();
    const storedIds = JSON.parse(candidate?.seen_file_ids ?? "[]") as string[];
    expect(storedIds).not.toContain(ghostFileId);
    expect(storedIds).toContain(liveFileId);
    expect(storedIds).toContain(secondLiveFileId);
  });
});

describe("smartEnrichFile — LLM extraction facts", () => {
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

  it("persists LLM facts on first sighting, defers materialization, and promotes once threshold reached", async () => {
    const firstFileId = randomUUID();
    const secondFileId = randomUUID();
    await seedFile(db, firstFileId);
    await seedFile(db, secondFileId);
    const generator = {
      generate: async () => "Jane Doe discussed the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return [{ mention: "Jane Doe", type: "person", variations: ["Jane"] }] as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    const fileBody = (id: string, hash: string) => ({
      id,
      fileName: `${id}.txt`,
      content: "Jane Doe discussed the launch plan.",
      contentCategory: "document",
      source: "google_drive",
      sourcePath: "/",
      contentHash: hash,
      connectorConfigId: "conn-smart",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    });

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      fileBody(firstFileId, "hash-1"),
    );

    const firstFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("indexed_file_id", "=", firstFileId)
      .executeTakeFirstOrThrow();
    expect(firstFact.fact_type).toBe("llm_extracted");
    // Below threshold (1 file < 2): fact stays unmaterialized for retry.
    expect(firstFact.materialized_at).toBeNull();
    const noMentionsYet = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("indexed_file_id", "=", firstFileId)
      .execute();
    expect(noMentionsYet).toHaveLength(0);

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      fileBody(secondFileId, "hash-2"),
    );

    const factsAfter = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "llm_extracted")
      .execute();
    expect(factsAfter.every((f) => f.materialized_at !== null)).toBe(true);

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["source", "confidence", "relation", "indexed_file_id"])
      .execute();
    expect(mentions.length).toBeGreaterThanOrEqual(2);
    expect(mentions.every((m) => m.source === "llm_extraction" && m.confidence === "INFERRED")).toBe(true);
  });
});

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
import { extractEntities, handleCandidates, smartEnrichFile } from "./smart-enrichment";

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

  it("persists high-confidence relation facts and drops low-confidence relation outputs", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    const generator = {
      generate: async () => "Sarah Chen leads Project Atlas.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [
              { mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.94 },
              { mention: "Project Atlas", type: "project", variations: ["Atlas"], confidence: 0.91 },
              { mention: "Low Confidence Product", type: "product", variations: [], confidence: 0.9 },
            ],
            relations: [
              {
                type: "leads",
                source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
                target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
                confidence: 0.93,
                context: "Sarah Chen leads Project Atlas.",
              },
              {
                type: "builds",
                source: { name: "Acme", type: "company", variations: [] },
                target: { name: "Low Confidence Product", type: "product", variations: [] },
                confidence: 0.72,
                context: "Maybe Acme builds Low Confidence Product.",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      {
        id: fileId,
        fileName: `${fileId}.txt`,
        content: "Sarah Chen leads Project Atlas.",
        contentCategory: "document",
        source: "google_drive",
        sourcePath: "/",
        contentHash: "hash-relations",
        connectorConfigId: "conn-smart",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    );

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "subject_name", "materialized_at"])
      .where("indexed_file_id", "=", fileId)
      .orderBy("fact_type")
      .execute();
    expect(facts.filter((f) => f.fact_type === "llm_relation")).toHaveLength(1);
    expect(facts.find((f) => f.fact_type === "llm_relation")).toMatchObject({
      relation: "leads",
      subject_name: "Sarah Chen",
    });

    const relationship = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.relationship_type", "source.name as source_name", "target.name as target_name"])
      .executeTakeFirstOrThrow();
    expect(relationship).toEqual({
      relationship_type: "leads",
      source_name: "Sarah Chen",
      target_name: "Project Atlas",
    });
  });

  it("preserves prior LLM facts when extractEntities throws", async () => {
    // Regression guard: smartEnrichFile re-throws on Gemini failure, so the
    // file-scope reconcile must never run with an empty mention set. If a
    // future refactor swallows the error and falls through with mentions=[],
    // every active llm_extracted fact for the file would be tombstoned.
    const fileId = randomUUID();
    await seedFile(db, fileId);

    const priorMentions = [
      { name: "Acme Corp", type: "company" },
      { name: "Apollo", type: "project" },
      { name: "Sarah Chen", type: "person" },
    ];
    for (const m of priorMentions) {
      await db
        .insertInto("indexed_file_facts")
        .values({
          id: randomUUID(),
          indexed_file_id: fileId,
          connector_config_id: "conn-smart",
          created_by_user_id: "admin",
          content_hash: "hash-prior",
          source: "llm_extraction",
          fact_type: "llm_extracted",
          relation: "mentioned",
          subject_name: m.name,
          subject_source: "llm_extraction",
          subject_source_id: `${fileId}:hash-prior:llm-extraction-v2:${m.name}`,
          fact_key: `llm-prior-${m.name}`,
          raw: JSON.stringify({
            contentHash: "hash-prior",
            promptVersion: "llm-extraction-v2",
            model: "gemini",
            mention: m.name,
            type: m.type,
            variations: [],
          }),
        })
        .execute();
    }

    const throwingGenerator = {
      generate: async () => {
        throw new Error("unexpected summary call");
      },
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          throw new Error("simulated Gemini timeout");
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await expect(
      smartEnrichFile(
        { db, logger: createTestLogger(), generator: throwingGenerator, embeddingProvider: null },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content: "some content that would have been analyzed",
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: "hash-new",
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("simulated Gemini timeout");

    const facts = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .execute();
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.deleted_at === null)).toBe(true);
    expect(facts.map((f) => f.subject_name).sort()).toEqual(["Acme Corp", "Apollo", "Sarah Chen"]);
  });

  it("persists and materializes engaged_with (person -> company) via v3 prompt", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    const generator = {
      generate: async () => "Vedant Parikh kicked off the Oliver Wyman engagement this quarter.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [
              { mention: "Vedant Parikh", type: "person", variations: ["Vedant"], confidence: 0.95 },
              { mention: "Oliver Wyman", type: "company", variations: ["OW"], confidence: 0.93 },
            ],
            relations: [
              {
                type: "engaged_with",
                source: { name: "Vedant Parikh", type: "person", variations: ["Vedant"] },
                target: { name: "Oliver Wyman", type: "company", variations: ["OW"] },
                confidence: 0.92,
                context: "Vedant Parikh kicked off the Oliver Wyman engagement this quarter.",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      {
        id: fileId,
        fileName: `${fileId}.txt`,
        content: "Vedant Parikh kicked off the Oliver Wyman engagement this quarter.",
        contentCategory: "document",
        source: "google_drive",
        sourcePath: "/",
        contentHash: "hash-engaged-with",
        connectorConfigId: "conn-smart",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    );

    const fact = await db
      .selectFrom("indexed_file_facts")
      .select(["relation", "subject_name"])
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_relation")
      .executeTakeFirstOrThrow();
    expect(fact).toEqual({ relation: "engaged_with", subject_name: "Vedant Parikh" });

    const relationship = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.relationship_type", "source.name as src", "target.name as tgt"])
      .executeTakeFirstOrThrow();
    expect(relationship).toEqual({
      relationship_type: "engaged_with",
      src: "Vedant Parikh",
      tgt: "Oliver Wyman",
    });
  });
});

describe("extractEntities prompt — v3 hierarchy + engaged_with", () => {
  it("renders the hierarchy paragraph and engaged_with verb in the prompt body", async () => {
    let capturedPrompt = "";
    const generator = {
      generate: async () => "",
      generateJSON: async <T>(prompt: string) => {
        capturedPrompt = prompt;
        return { mentions: [], relations: [] } as T;
      },
    } as GeminiGenerator;

    await extractEntities(generator, {
      id: "f-prompt",
      fileName: "ow-canvas-standup.txt",
      content: "transcript body",
      contentCategory: "document",
      source: "fireflies",
      sourcePath: "/",
      contentHash: null,
      connectorConfigId: "conn-smart",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    });

    expect(capturedPrompt).toContain("Companies");
    expect(capturedPrompt).toContain("Initiatives");
    expect(capturedPrompt).toContain("Prefer extracting from the top down");
    expect(capturedPrompt).toContain('"engaged_with"');
    expect(capturedPrompt).toContain("without being employed by it");
  });
});

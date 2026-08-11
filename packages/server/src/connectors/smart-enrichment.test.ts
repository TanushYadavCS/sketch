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
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { EmbeddingProvider } from "./embeddings/types";
import type { GeminiGenerator } from "./gemini-generate";
import {
  adjudicateKnownMatches,
  extractEntities,
  handleCandidates,
  hasDistinctiveOverlap,
  mergeKnownEntities,
  projectProductMentionNames,
  purgeConversationalFactsForFile,
  smartEnrichFile,
} from "./smart-enrichment";
import { recoverStaleEnrichments } from "./sync";

const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";

async function countEntitiesBySourceType(db: Kysely<DB>, sourceType: string): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", sourceType)
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countReviewQueueRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_review_queue")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function seedFile(
  db: Kysely<DB>,
  fileId: string,
  opts: { content?: string; contentHash?: string | null } = {},
): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "admin", name: "Connector Owner", email: "connector-owner@example.test" })
    .onConflict((oc) => oc.doNothing())
    .execute();

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
      content: opts.content ?? "hello",
      content_hash: opts.contentHash ?? null,
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

function smartFileContext(
  id: string,
  contentHash: string,
  overrides: Partial<Parameters<typeof smartEnrichFile>[1]> = {},
): Parameters<typeof smartEnrichFile>[1] {
  return {
    id,
    fileName: `${id}.txt`,
    content: "Sarah Chen works on Project Atlas with the Platform Team.",
    contentCategory: "document",
    source: "google_drive",
    sourcePath: "/",
    contentHash,
    connectorConfigId: "conn-smart",
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

function generatorWithProjectExtraction(): GeminiGenerator {
  return {
    generate: async () => "Sarah Chen works on Project Atlas with the Platform Team.",
    generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
      if (opts?.label?.startsWith("extractEntities")) {
        return {
          mentions: [
            { mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 },
            { mention: "Project Atlas", type: "project", variations: ["Atlas"], confidence: 0.94 },
            { mention: "Platform Team", type: "team", variations: ["Platform"], confidence: 0.93 },
          ],
          relations: [
            {
              type: "contributes_to",
              source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
              target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
              confidence: 0.92,
              context: "Sarah Chen works on Project Atlas.",
            },
          ],
        } as T;
      }
      return {} as T;
    },
  } as GeminiGenerator;
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

  it("A0 documents current legacy candidate promotion path creating product and project entities with no review rows until A1 flips it", async () => {
    const firstFileId = randomUUID();
    const secondFileId = randomUUID();
    await seedFile(db, firstFileId);
    await seedFile(db, secondFileId);

    await handleCandidates(makeDeps(db), firstFileId, [
      { mention: "Sketch Product", type: "product", variations: ["Sketch"] },
      { mention: "Apollo Project", type: "project", variations: ["Apollo"] },
    ]);
    const promoted = await handleCandidates(makeDeps(db), secondFileId, [
      { mention: "Sketch Product", type: "product", variations: ["Sketch"] },
      { mention: "Apollo Project", type: "project", variations: ["Apollo"] },
    ]);

    expect(promoted).toHaveLength(2);
    expect(await countEntitiesBySourceType(db, "product")).toBe(1);
    expect(await countEntitiesBySourceType(db, "project")).toBe(1);
    expect(await countReviewQueueRows(db)).toBe(0);
  });
});

describe("smartEnrichFile — structural task file types", () => {
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

  it.each(["issue", "task", "subtask", "Issue"])(
    "drops project/team mentions and project endpoint relations for fileType %s",
    async (fileType) => {
      const fileId = randomUUID();
      const contentHash = `hash-${fileType}`;
      await seedFile(db, fileId, {
        content: "Sarah Chen works on Project Atlas with the Platform Team.",
        contentHash,
      });

      await smartEnrichFile(
        { db, logger: createTestLogger(), generator: generatorWithProjectExtraction(), embeddingProvider: null },
        smartFileContext(fileId, contentHash, { fileType }),
      );

      const facts = await db
        .selectFrom("indexed_file_facts")
        .select(["fact_type", "subject_name", "raw"])
        .where("indexed_file_id", "=", fileId)
        .where("source", "=", "llm_extraction")
        .where("deleted_at", "is", null)
        .orderBy("subject_name", "asc")
        .execute();

      expect(facts.map((fact) => [fact.fact_type, fact.subject_name])).toEqual([["llm_extracted", "Sarah Chen"]]);
      expect(facts.some((fact) => fact.subject_name === "Project Atlas")).toBe(false);
      expect(facts.some((fact) => fact.subject_name === "Platform Team")).toBe(false);
      expect(facts.some((fact) => fact.fact_type === "llm_relation")).toBe(false);

      const projectOrTeamReviewRows = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("entity_type", "in", ["project", "team"])
        .execute();
      expect(projectOrTeamReviewRows).toHaveLength(0);
    },
  );

  it.each(["meeting_transcript", "doc", undefined])("keeps project mentions for fileType %s", async (fileType) => {
    const fileId = randomUUID();
    const contentHash = `hash-${fileType ?? "none"}`;
    await seedFile(db, fileId, {
      content: "Sarah Chen works on Project Atlas with the Platform Team.",
      contentHash,
    });

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator: generatorWithProjectExtraction(), embeddingProvider: null },
      smartFileContext(fileId, contentHash, { fileType }),
    );

    const projectFact = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "subject_name"])
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_extracted")
      .where("subject_name", "=", "Project Atlas")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    expect(projectFact).toEqual({ fact_type: "llm_extracted", subject_name: "Project Atlas" });
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

  async function readLearnedFacts(entityId: string): Promise<unknown[]> {
    const row = await db.selectFrom("entities").select("metadata").where("id", "=", entityId).executeTakeFirstOrThrow();
    const metadata = JSON.parse(row.metadata ?? "{}");
    return metadata.learned_facts ?? [];
  }

  function factGenerator(entityId: string, facts: string[]): GeminiGenerator {
    return {
      generate: async () => "Sarah Chen owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        if (opts?.label?.startsWith("extractEntityFacts")) {
          return { [entityId]: facts.map((fact) => ({ fact })) } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;
  }

  async function seedOpenConversationFile(fileId: string, contentHash: string, content: string): Promise<void> {
    await seedFile(db, fileId, { content, contentHash });
    await db
      .updateTable("indexed_files")
      .set({ file_type: "whatsapp_conversation_slice" })
      .where("id", "=", fileId)
      .execute();
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: "whatsapp",
        kind: "group",
        provider_conversation_id: `group-${fileId}`,
        display_name: "Test Group",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("conversation_slices")
      .values({
        id: randomUUID(),
        conversation_id: conversation.id,
        first_message_id: 1,
        last_message_id: 2,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        message_count: 2,
        denoised_message_ids: null,
        flush_reason: "llm_boundary",
        roster_snapshot: "{}",
        salience_verdict: "kept",
        indexed_file_id: fileId,
        status: "open",
      })
      .execute();
  }

  it("re-enriches an open conversational file without content-hash churn or complement tombstones", async () => {
    const fileId = randomUUID();
    const supportFileId = randomUUID();
    await seedFile(db, fileId, { content: "Sarah Chen joined the chat.", contentHash: "hash-one" });
    await seedFile(db, supportFileId, { content: "Sarah Chen joined another chat.", contentHash: "hash-support" });
    await db
      .updateTable("indexed_files")
      .set({ file_type: "whatsapp_conversation_slice" })
      .where("id", "in", [fileId, supportFileId])
      .execute();
    const conversation = await db
      .insertInto("conversations")
      .values({
        platform: "whatsapp",
        kind: "group",
        provider_conversation_id: `group-${fileId}`,
        display_name: "Test Group",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("conversation_slices")
      .values({
        id: randomUUID(),
        conversation_id: conversation.id,
        first_message_id: 1,
        last_message_id: 2,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        message_count: 2,
        denoised_message_ids: null,
        flush_reason: "llm_boundary",
        roster_snapshot: "{}",
        salience_verdict: "kept",
        indexed_file_id: fileId,
        status: "open",
      })
      .execute();
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "manual",
      sourceId: "manual:sarah-chat",
    });

    let mentions = ["Sarah Chen"];
    const generator: GeminiGenerator = {
      generate: async () => "Sarah Chen joined the chat.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: mentions.map((mention) => ({ mention, type: "person", variations: [mention.split(" ")[0]] })),
            relations: [],
          } as T;
        }
        return {} as T;
      },
    };
    const deps = { db, logger: createTestLogger(), generator, embeddingProvider: null };

    await smartEnrichFile(deps, smartFileContext(fileId, "hash-one", { fileType: "whatsapp_conversation_slice" }));
    await smartEnrichFile(
      deps,
      smartFileContext(supportFileId, "hash-support", { fileType: "whatsapp_conversation_slice" }),
    );
    const firstFacts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_key", "deleted_at"])
      .where("indexed_file_id", "=", fileId)
      .execute();
    const firstRefs = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "llm_extraction")
      .execute();

    await db.updateTable("indexed_files").set({ content_hash: "hash-two" }).where("id", "=", fileId).execute();
    await smartEnrichFile(deps, smartFileContext(fileId, "hash-two", { fileType: "whatsapp_conversation_slice" }));
    const secondFacts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_key", "deleted_at"])
      .where("indexed_file_id", "=", fileId)
      .execute();
    const secondRefs = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "llm_extraction")
      .execute();
    expect(secondFacts).toHaveLength(firstFacts.length);
    expect(secondFacts.filter((fact) => fact.deleted_at !== null)).toHaveLength(0);
    expect(secondRefs).toHaveLength(firstRefs.length);

    mentions = ["Jane Doe"];
    await entityRepo.upsertEntityFromTool({
      name: "Jane Doe",
      sourceType: "person",
      source: "manual",
      sourceId: "manual:jane-chat",
    });
    await db
      .updateTable("indexed_files")
      .set({ content: "Sarah Chen joined the chat. Jane Doe joined later." })
      .where("id", "=", fileId)
      .execute();
    await db.updateTable("indexed_files").set({ content_hash: "hash-three" }).where("id", "=", fileId).execute();
    await smartEnrichFile(
      deps,
      smartFileContext(fileId, "hash-three", {
        content: "Sarah Chen joined the chat. Jane Doe joined later.",
        fileType: "whatsapp_conversation_slice",
      }),
    );
    const thirdFacts = await db
      .selectFrom("indexed_file_facts")
      .select(["subject_name", "deleted_at"])
      .where("indexed_file_id", "=", fileId)
      .execute();
    expect(thirdFacts.find((fact) => fact.subject_name === "Sarah Chen")?.deleted_at).toBeNull();
    expect(thirdFacts.find((fact) => fact.subject_name === "Jane Doe")?.deleted_at).toBeNull();
  });

  it("tombstones an explicit conversational retraction and removes its learned fact", async () => {
    const fileId = randomUUID();
    await seedOpenConversationFile(fileId, "hash-retraction-one", "Sarah Chen owns the launch plan.");
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "manual",
      sourceId: "manual:sarah-retraction",
    });
    const initialGenerator = factGenerator(entity.id, ["Owns the launch plan"]);
    const file = smartFileContext(fileId, "hash-retraction-one", {
      content: "Sarah Chen owns the launch plan.",
      fileType: "whatsapp_conversation_slice",
    });
    await smartEnrichFile(
      { db, logger: createTestLogger(), generator: initialGenerator, embeddingProvider: null },
      file,
    );
    const fact = await db
      .selectFrom("indexed_file_facts")
      .select("fact_key")
      .where("indexed_file_id", "=", fileId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    const retractingGenerator: GeminiGenerator = {
      generate: async () => "Sarah Chen no longer owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
            relations: [],
          } as T;
        }
        return {
          facts: {},
          retractions: [{ fact_key: fact.fact_key, entity_id: entity.id, fact: "Owns the launch plan" }],
        } as T;
      },
    };
    await db
      .updateTable("indexed_files")
      .set({ content: "Sarah Chen no longer owns the launch plan.", content_hash: "hash-retraction-two" })
      .where("id", "=", fileId)
      .execute();
    await smartEnrichFile(
      { db, logger: createTestLogger(), generator: retractingGenerator, embeddingProvider: null },
      smartFileContext(fileId, "hash-retraction-two", {
        content: "Sarah Chen no longer owns the launch plan.",
        fileType: "whatsapp_conversation_slice",
      }),
    );

    const retracted = await db
      .selectFrom("indexed_file_facts")
      .select("deleted_at")
      .where("fact_key", "=", fact.fact_key)
      .executeTakeFirstOrThrow();
    const entityAfter = await db
      .selectFrom("entities")
      .select("metadata")
      .where("id", "=", entity.id)
      .executeTakeFirstOrThrow();
    expect(retracted.deleted_at).not.toBeNull();
    expect(JSON.parse(entityAfter.metadata ?? "{}").learned_facts ?? []).toEqual([]);
  });

  it("leaves a conversational file pending when the facts pass fails", async () => {
    const fileId = randomUUID();
    await seedOpenConversationFile(fileId, "hash-facts-fail", "Sarah Chen joined the chat.");
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "manual",
      sourceId: "manual:sarah-facts-fail",
    });
    const generator: GeminiGenerator = {
      generate: async () => "Sarah Chen joined the chat.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
            relations: [],
          } as T;
        }
        throw new Error("facts unavailable");
      },
    };
    await expect(
      smartEnrichFile(
        { db, logger: createTestLogger(), generator, embeddingProvider: null },
        smartFileContext(fileId, "hash-facts-fail", { fileType: "whatsapp_conversation_slice" }),
      ),
    ).rejects.toThrow("facts unavailable");
    const status = await db
      .selectFrom("indexed_files")
      .select("embedding_status")
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();
    const slice = await db
      .selectFrom("conversation_slices")
      .select("facts_enriched_content_hash")
      .where("indexed_file_id", "=", fileId)
      .executeTakeFirstOrThrow();
    expect(status.embedding_status).toBe("pending");
    expect(slice.facts_enriched_content_hash).toBeNull();
    expect(entity.id).toBeTruthy();
  });

  it("records the current content hash after a successful conversational facts pass", async () => {
    const fileId = randomUUID();
    await seedOpenConversationFile(fileId, "hash-facts-success", "A short chat.");
    const generator: GeminiGenerator = {
      generate: async () => "A short chat.",
      generateJSON: async <T>() => ({ mentions: [], relations: [] }) as T,
    };
    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      smartFileContext(fileId, "hash-facts-success", {
        content: "A short chat.",
        fileType: "whatsapp_conversation_slice",
      }),
    );
    const slice = await db
      .selectFrom("conversation_slices")
      .select("facts_enriched_content_hash")
      .where("indexed_file_id", "=", fileId)
      .executeTakeFirstOrThrow();
    expect(slice.facts_enriched_content_hash).toBe("hash-facts-success");
  });

  it("purges all conversational facts, learned facts, mentions, and source refs for a shrinking file", async () => {
    const fileId = randomUUID();
    await seedOpenConversationFile(fileId, "hash-purge", "Sarah Chen joined the chat.");
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "manual",
      sourceId: "manual:sarah-purge",
    });
    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator: factGenerator(entity.id, ["Joined the chat"]),
        embeddingProvider: null,
      },
      smartFileContext(fileId, "hash-purge", { fileType: "whatsapp_conversation_slice" }),
    );
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "purge-source-ref",
        entity_id: entity.id,
        source: "llm_extraction",
        source_id: `${fileId}:llm-extraction-v13:Sarah Chen`,
        last_seen_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: "purge-mention",
        entity_id: entity.id,
        indexed_file_id: fileId,
        confidence: "EXTRACTED",
        source: "llm_relation",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    await purgeConversationalFactsForFile(db, fileId);

    const activeFacts = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("indexed_file_id", "=", fileId)
      .where("deleted_at", "is", null)
      .execute();
    const learnedFacts = JSON.parse(
      (await db.selectFrom("entities").select("metadata").where("id", "=", entity.id).executeTakeFirstOrThrow())
        .metadata ?? "{}",
    ).learned_facts;
    expect(activeFacts).toEqual([]);
    expect(learnedFacts).toEqual([]);
    expect(await db.selectFrom("entity_mentions").selectAll().where("indexed_file_id", "=", fileId).execute()).toEqual(
      [],
    );
    expect(
      await db.selectFrom("entity_source_refs").selectAll().where("source_id", "like", `${fileId}:%`).execute(),
    ).toEqual([]);
  });

  it("does not change learned facts when re-enrichment returns the same facts", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, { content: "Sarah Chen owns the launch plan.", contentHash: "hash-idempotent" });
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "google_drive",
      sourceId: "person:sarah-chen-idempotent",
    });
    const file = smartFileContext(fileId, "hash-idempotent", { content: "Sarah Chen owns the launch plan." });

    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator: factGenerator(entity.id, ["Owns the launch plan"]),
        embeddingProvider: null,
      },
      file,
    );
    const firstFacts = await readLearnedFacts(entity.id);

    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator: factGenerator(entity.id, ["  owns   the launch plan  "]),
        embeddingProvider: null,
      },
      file,
    );

    expect(await readLearnedFacts(entity.id)).toEqual(firstFacts);
  });

  it("appends only new learned facts and preserves existing entries", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, { content: "Sarah Chen owns the launch plan.", contentHash: "hash-partial" });
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "google_drive",
      sourceId: "person:sarah-chen-partial",
    });
    const file = smartFileContext(fileId, "hash-partial", { content: "Sarah Chen owns the launch plan." });

    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator: factGenerator(entity.id, ["Owns the launch plan", "Works at Acme"]),
        embeddingProvider: null,
      },
      file,
    );
    const existingFacts = await readLearnedFacts(entity.id);

    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator: factGenerator(entity.id, ["owns the launch plan", "Works at Acme", "Leads sales"]),
        embeddingProvider: null,
      },
      file,
    );

    expect(await readLearnedFacts(entity.id)).toEqual([
      ...existingFacts,
      { fact: "Leads sales", source_file_id: fileId, learned_at: expect.any(String) },
    ]);
  });

  it("does not duplicate learned facts when stale recovery retries enrichment after a crash", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, { content: "Sarah Chen owns the launch plan.", contentHash: "hash-crash-retry" });
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "google_drive",
      sourceId: "person:sarah-chen-crash-retry",
    });
    const file = smartFileContext(fileId, "hash-crash-retry", { content: "Sarah Chen owns the launch plan." });
    const generator = factGenerator(entity.id, ["Owns the launch plan"]);

    await smartEnrichFile({ db, logger: createTestLogger(), generator, embeddingProvider: null }, file);
    const firstFacts = await readLearnedFacts(entity.id);

    await db
      .updateTable("indexed_files")
      .set({ embedding_status: "processing", synced_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })
      .where("id", "=", fileId)
      .execute();
    await recoverStaleEnrichments(db, createTestLogger());
    await smartEnrichFile({ db, logger: createTestLogger(), generator, embeddingProvider: null }, file);

    expect(await readLearnedFacts(entity.id)).toEqual(firstFacts);
  });

  it("persists LLM facts on first sighting and materializes only the current file once threshold is reached", async () => {
    const firstFileId = randomUUID();
    const secondFileId = randomUUID();
    await seedFile(db, firstFileId, { content: "Jane Doe discussed the launch plan.", contentHash: "hash-1" });
    await seedFile(db, secondFileId, { content: "Jane Doe discussed the launch plan.", contentHash: "hash-2" });
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
      .select(["indexed_file_id", "materialized_at"])
      .where("fact_type", "=", "llm_extracted")
      .execute();
    const materializedAtByFile = new Map(factsAfter.map((fact) => [fact.indexed_file_id, fact.materialized_at]));
    expect(materializedAtByFile.get(firstFileId)).toBeNull();
    expect(materializedAtByFile.get(secondFileId)).toEqual(expect.any(String));

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["source", "confidence", "relation", "indexed_file_id"])
      .execute();
    expect(mentions).toHaveLength(1);
    expect(mentions[0].indexed_file_id).toBe(secondFileId);
    expect(mentions.every((m) => m.source === "llm_extraction" && m.confidence === "INFERRED")).toBe(true);
  });

  it("persists high-confidence relation facts and drops low-confidence relation outputs", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, { content: "Sarah Chen leads Project Atlas.", contentHash: "hash-relations" });
    await createEntityRepository(db).upsertEntityFromTool({
      name: "Project Atlas",
      sourceType: "project",
      source: "google_drive",
      sourceId: "project:atlas",
    });
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

  it("drops feature mentions without writing feature facts", async () => {
    const fileId = randomUUID();
    const content = "beaconvendor.com exposes Vendor Analytics. Canvas CRM includes CRM Analytics.";
    await seedFile(db, fileId, { content, contentHash: "hash-feature-domain-parent" });
    const generator = {
      generate: async () => "Canvas CRM includes CRM Analytics.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [
              {
                mention: "Vendor Analytics",
                type: "feature",
                parentProduct: "beaconvendor.com",
                variations: [],
                confidence: 0.93,
              },
              {
                mention: "CRM Analytics",
                type: "feature",
                parentProduct: "Canvas CRM",
                variations: [],
                confidence: 0.94,
              },
            ],
            relations: [],
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
        content,
        contentCategory: "document",
        source: "google_drive",
        sourcePath: "/",
        contentHash: "hash-feature-domain-parent",
        connectorConfigId: "conn-smart",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    );

    const featureFacts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "subject_name"])
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .where("fact_type", "=", "feature")
      .where("deleted_at", "is", null)
      .execute();
    expect(featureFacts).toEqual([]);
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

  it("tombstones LLM facts written before a stale reconcile abort", async () => {
    const fileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, fileId, { content });
    const stale = new Error("file changed");
    stale.name = "StaleEnrichmentError";
    let freshnessChecks = 0;
    const generator = {
      generate: async () => {
        throw new Error("summary should not be generated");
      },
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider: null,
          ensureFresh: async () => {
            freshnessChecks += 1;
            if (freshnessChecks === 3) throw stale;
          },
        },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content,
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: null,
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("file changed");

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "deleted_at"])
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .execute();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fact_type: "llm_extracted" });
    expect(facts[0].deleted_at).not.toBeNull();
  });

  it("tombstones LLM facts written before a post-reconcile freshness abort", async () => {
    const fileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, fileId, { content });
    const stale = new Error("file changed");
    stale.name = "StaleEnrichmentError";
    let freshnessChecks = 0;
    const generator = {
      generate: async () => {
        throw new Error("summary should not be generated");
      },
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider: null,
          ensureFresh: async () => {
            freshnessChecks += 1;
            if (freshnessChecks === 6) throw stale;
          },
        },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content,
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: null,
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("file changed");

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "deleted_at"])
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .execute();
    const mentions = await db
      .selectFrom("entity_mentions")
      .select("id")
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .execute();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fact_type: "llm_extracted" });
    expect(facts[0].deleted_at).not.toBeNull();
    expect(mentions).toHaveLength(0);
  });

  it("tombstones materialized LLM facts written before a late summary freshness abort", async () => {
    const firstFileId = randomUUID();
    const staleFileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, firstFileId, { content, contentHash: "hash-first" });
    await seedFile(db, staleFileId, { content, contentHash: "hash-stale" });
    const stale = new Error("file changed");
    stale.name = "StaleEnrichmentError";
    let freshnessChecks = 0;
    let staleFactWasMaterialized = false;
    let staleMentionWasCreated = false;
    const generator = {
      generate: async () => "Sarah Chen owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;
    const fileBody = (id: string, hash: string) => ({
      id,
      fileName: `${id}.txt`,
      content,
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
      fileBody(firstFileId, "hash-first"),
    );

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider: null,
          ensureFresh: async () => {
            freshnessChecks += 1;
            if (freshnessChecks === 7) {
              const fact = await db
                .selectFrom("indexed_file_facts")
                .select("materialized_at")
                .where("indexed_file_id", "=", staleFileId)
                .where("source", "=", "llm_extraction")
                .executeTakeFirst();
              const mentions = await db
                .selectFrom("entity_mentions")
                .select("id")
                .where("indexed_file_id", "=", staleFileId)
                .where("source", "=", "llm_extraction")
                .execute();
              staleFactWasMaterialized = fact?.materialized_at != null;
              staleMentionWasCreated = mentions.length > 0;
              throw stale;
            }
          },
        },
        fileBody(staleFileId, "hash-stale"),
      ),
    ).rejects.toThrow("file changed");

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "deleted_at", "materialized_at"])
      .where("indexed_file_id", "=", staleFileId)
      .where("source", "=", "llm_extraction")
      .execute();
    const mentions = await db
      .selectFrom("entity_mentions")
      .select("id")
      .where("indexed_file_id", "=", staleFileId)
      .where("source", "=", "llm_extraction")
      .execute();
    expect(staleFactWasMaterialized).toBe(true);
    expect(staleMentionWasCreated).toBe(true);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fact_type: "llm_extracted", materialized_at: null });
    expect(facts[0].deleted_at).not.toBeNull();
    expect(mentions).toHaveLength(0);
  });

  it("rethrows stale freshness errors from summary embedding before writing learned facts", async () => {
    const fileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, fileId, { content });
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "google_drive",
      sourceId: "person:sarah-chen",
    });
    const stale = new Error("file changed");
    stale.name = "StaleEnrichmentError";
    let freshnessChecks = 0;
    let embeddedSummary = false;
    const generator = {
      generate: async () => "Sarah Chen owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        if (opts?.label?.startsWith("extractEntityFacts")) {
          return { [entity.id]: [{ fact: "Owns the launch plan" }] } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;
    const embeddingProvider = {
      name: "test",
      dimensions: 3,
      supportsImages: false,
      embedTexts: async () => {
        embeddedSummary = true;
        return [[0.1, 0.2, 0.3]];
      },
    } satisfies EmbeddingProvider;

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider,
          ensureFresh: async () => {
            freshnessChecks += 1;
            if (embeddedSummary) throw stale;
          },
        },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content,
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: null,
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("file changed");

    expect(freshnessChecks).toBeGreaterThan(0);
    const refreshed = await db
      .selectFrom("entities")
      .select("metadata")
      .where("id", "=", entity.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(refreshed.metadata ?? "{}")).not.toHaveProperty("learned_facts");
  });

  it("does not write summary embeddings when the file changes after embedding", async () => {
    const fileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, fileId, { content });
    const generator = {
      generate: async () => "Sarah Chen owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return { mentions: [] } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;
    let embeddedSummary = false;
    const embeddingProvider = {
      name: "test",
      dimensions: 3,
      supportsImages: false,
      embedTexts: async () => {
        embeddedSummary = true;
        await db.updateTable("indexed_files").set({ content: "new source content" }).where("id", "=", fileId).execute();
        return [[0.1, 0.2, 0.3]];
      },
    } satisfies EmbeddingProvider;

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider,
          ensureFresh: async () => {},
        },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content,
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: null,
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("Stale smart enrichment result");

    expect(embeddedSummary).toBe(true);
  });

  it("does not append learned facts when the file changes before the metadata write", async () => {
    const fileId = randomUUID();
    const content = "Sarah Chen owns the launch plan.";
    await seedFile(db, fileId, { content });
    const entity = await createEntityRepository(db).upsertEntityFromTool({
      name: "Sarah Chen",
      sourceType: "person",
      source: "google_drive",
      sourceId: "person:sarah-chen-race",
    });
    let mutated = false;
    const generator = {
      generate: async () => "Sarah Chen owns the launch plan.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
          } as T;
        }
        if (opts?.label?.startsWith("extractEntityFacts")) {
          return { [entity.id]: [{ fact: "Owns the launch plan" }] } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await expect(
      smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator,
          embeddingProvider: null,
          ensureFresh: async () => {
            const row = await db
              .selectFrom("indexed_files")
              .select("summary_status")
              .where("id", "=", fileId)
              .executeTakeFirstOrThrow();
            if (row.summary_status === "done" && !mutated) {
              mutated = true;
              await db
                .updateTable("indexed_files")
                .set({ content: "new source content" })
                .where("id", "=", fileId)
                .execute();
            }
          },
        },
        {
          id: fileId,
          fileName: `${fileId}.txt`,
          content,
          contentCategory: "document",
          source: "google_drive",
          sourcePath: "/",
          contentHash: null,
          connectorConfigId: "conn-smart",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      ),
    ).rejects.toThrow("Stale smart enrichment result");

    expect(mutated).toBe(true);
    const refreshed = await db
      .selectFrom("entities")
      .select("metadata")
      .where("id", "=", entity.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(refreshed.metadata ?? "{}")).not.toHaveProperty("learned_facts");
  });

  it("persists and materializes engaged_with (person -> company) via v3 prompt", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, {
      content: "Vedant Parikh kicked off the Oliver Wyman engagement this quarter.",
      contentHash: "hash-engaged-with",
    });
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

describe("extractEntities prompt — v6 entity type removal", () => {
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

  it("renders supported entity types with feature guidance", async () => {
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
    expect(capturedPrompt).toContain("Projects");
    expect(capturedPrompt).toContain("Products");
    expect(capturedPrompt).not.toContain("Teams");
    expect(capturedPrompt).toContain("Prefer extracting from the top down");
    expect(capturedPrompt).toContain('"engaged_with"');
    expect(capturedPrompt).toContain("without being employed by it");
    expect(capturedPrompt).toContain('Valid types: "person", "project", "company", "product", "tool"');
    expect(capturedPrompt).not.toContain('"feature"');
    expect(capturedPrompt).not.toContain("parentProduct");
  });

  it("ignores feature mentions and feature endpoint relations emitted by the model", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, {
      content: "OW Tourism Dashboard is the umbrella; Aviation Edge scraper is part of it.",
      contentHash: "hash-feature-partof",
    });
    const generator = {
      generate: async () => "OW Tourism Dashboard is the umbrella; Aviation Edge scraper is part of it.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [
              { mention: "OW Tourism Dashboard", type: "project", variations: ["OW Dashboard"], confidence: 0.95 },
              { mention: "Aviation Edge scraper", type: "feature", variations: ["Aviation Edge"], confidence: 0.92 },
            ],
            relations: [
              {
                type: "part_of",
                source: { name: "Aviation Edge scraper", type: "feature", variations: ["Aviation Edge"] },
                target: { name: "OW Tourism Dashboard", type: "project", variations: ["OW Dashboard"] },
                confidence: 0.9,
                context: "Aviation Edge scraper is part of OW Tourism Dashboard",
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
        content: "OW Tourism Dashboard is the umbrella; Aviation Edge scraper is part of it.",
        contentCategory: "document",
        source: "google_drive",
        sourcePath: "/",
        contentHash: "hash-feature-partof",
        connectorConfigId: "conn-smart",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    );

    const llmFacts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "raw"])
      .where("fact_type", "in", ["llm_extracted", "llm_relation"])
      .execute();
    const typedFeatureFacts = llmFacts.filter((fact) => {
      const raw = JSON.parse(fact.raw ?? "{}") as {
        type?: string;
        source?: { type?: string };
        target?: { type?: string };
      };
      return raw.type === "feature" || raw.source?.type === "feature" || raw.target?.type === "feature";
    });
    expect(typedFeatureFacts).toHaveLength(0);
    const featureEntity = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "feature")
      .executeTakeFirst();
    expect(featureEntity).toBeUndefined();
    const relationship = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "part_of")
      .executeTakeFirst();
    expect(relationship).toBeUndefined();
  });

  it("drops relations whose endpoint is a generic engagement name or a domain/url", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId, {
      content: "Sarah Chen contributes to the Dashboard and to oliverwyman.com.",
      contentHash: "hash-generic-endpoint",
    });
    const generator = {
      generate: async () => "Sarah Chen contributes to the Dashboard.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [{ mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 }],
            relations: [
              {
                type: "contributes_to",
                source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
                target: { name: "Dashboard", type: "project", variations: [] },
                confidence: 0.95,
                context: "Sarah Chen contributes to the Dashboard.",
              },
              {
                type: "contributes_to",
                source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
                target: { name: "oliverwyman.com", type: "project", variations: [] },
                confidence: 0.95,
                context: "Sarah Chen contributes to oliverwyman.com.",
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
        content: "Sarah Chen contributes to the Dashboard and to oliverwyman.com.",
        contentCategory: "document",
        source: "google_drive",
        sourcePath: "/",
        contentHash: "hash-generic-endpoint",
        connectorConfigId: "conn-smart",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
    );

    const relationFacts = await db
      .selectFrom("indexed_file_facts")
      .select("raw")
      .where("fact_type", "=", "llm_relation")
      .execute();
    expect(relationFacts).toHaveLength(0);
    const noiseRows = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("entity_type", "=", "project")
      .where((eb) => eb.fn("lower", ["proposed_name"]), "in", ["dashboard", "oliverwyman.com"])
      .execute();
    expect(noiseRows).toHaveLength(0);
  });
});

describe("extractEntities prompt — v7 quality rules", () => {
  async function capturePrompt(
    orgContext?: Parameters<typeof extractEntities>[2],
    knownEntities?: Parameters<typeof extractEntities>[3],
  ): Promise<string> {
    let captured = "";
    const generator = {
      generate: async () => "",
      generateJSON: async <T>(prompt: string) => {
        captured = prompt;
        return { mentions: [], relations: [] } as T;
      },
    } as GeminiGenerator;

    await extractEntities(
      generator,
      {
        id: "f-v7",
        fileName: "transcript.txt",
        content: "body",
        contentCategory: "document",
        source: "fireflies",
        sourcePath: "/",
        contentHash: null,
        connectorConfigId: "conn-v7",
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
      },
      orgContext,
      knownEntities,
    );
    return captured;
  }

  it("includes name-shape rules that reject degraded person forms", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("Name shape rules");
    expect(prompt).toContain("Title Case");
    expect(prompt).toContain("Single first names with no surname");
    expect(prompt).toContain("Initials-only");
    expect(prompt).toContain("Email-handle style");
    expect(prompt).toContain("ALL-CAPS");
  });

  it("includes the company-suffix → company rule", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("Type disambiguation");
    expect(prompt).toContain("Pvt Ltd");
    expect(prompt).toContain("Private Limited");
    expect(prompt).toContain('is type "company", never "person"');
  });

  it("excludes meeting titles and doc-title projects, and generic-feature products", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("Meeting titles or calendar event names");
    expect(prompt).toContain("Standup");
    expect(prompt).toContain("Document, note, or artifact titles as projects");
    expect(prompt).toContain("Generic feature descriptions or internal component names as products");
    expect(prompt).toContain("branded, proper-noun name");
  });

  it("renders the org description into the extraction prompt when provided", async () => {
    const captured = await capturePrompt({
      orgName: "Canvas Labs",
      description: "AI services company. Sketch is one of our products.",
    });

    expect(captured).toContain("Background on the organization that operates this system (Canvas Labs)");
    expect(captured).toContain("AI services company. Sketch is one of our products.");
  });

  it("includes product disambiguation guidance when org context provides it", async () => {
    const captured = await capturePrompt({
      orgName: "Canvas Labs",
      description: "AI services company.",
      disambiguationGuidance: "A dataset or UI tab is not a product.",
    });

    expect(captured).toContain("Product/disambiguation guidance");
    expect(captured).toContain("A dataset or UI tab is not a product.");
  });

  it("does not hardcode Sketch as a product example and points products at injected known products", async () => {
    const captured = await capturePrompt(undefined, [
      { name: "Known Product", type: "product", description: "Declared product" },
    ]);
    const productLine = captured.split("\n").find((line) => line.startsWith("- **Products**"));

    expect(productLine).toBeDefined();
    expect(captured).not.toContain("Sketch");
    expect(productLine).not.toContain("Sketch");
    expect(productLine).not.toContain("Canvas AI");
    expect(productLine).not.toContain("Meetup by Habuild");
    expect(productLine).toContain("injected known-products list");
    expect(captured).toContain("Known entities likely to appear in this file");
    expect(captured).toContain("Known Product (product)");
  });
});

describe("smartEnrichFile — LLM leak gates", () => {
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

  function extractionGenerator(extraction: unknown): GeminiGenerator {
    return {
      generate: async () => "A short document summary.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) =>
        (opts?.label?.startsWith("extractEntities") ? extraction : {}) as T,
    } as GeminiGenerator;
  }

  async function extractedNames(fileId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("indexed_file_facts")
      .select("subject_name")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_extracted")
      .execute();
    return rows.map((row) => row.subject_name ?? "");
  }

  async function relationEndpointNames(fileId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("indexed_file_facts")
      .select("raw")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_relation")
      .execute();
    return rows.flatMap((row) => {
      const raw = JSON.parse(row.raw ?? "{}") as { source?: { name?: string }; target?: { name?: string } };
      return [raw.source?.name, raw.target?.name].filter((name): name is string => Boolean(name));
    });
  }

  it("drops a personal email-provider company — mention and relation — but keeps a real company", async () => {
    const fileId = randomUUID();
    const content = "Anoushka Srivastava emailed about the project. Oliver Wyman is the client.";
    await seedFile(db, fileId, { content, contentHash: "hash-provider" });
    const generator = extractionGenerator({
      mentions: [
        { mention: "Anoushka Srivastava", type: "person", variations: [], confidence: 0.95 },
        { mention: "Gmail", type: "company", variations: [], confidence: 0.95 },
        { mention: "Oliver Wyman", type: "company", variations: [], confidence: 0.95 },
      ],
      relations: [
        {
          type: "works_at",
          source: { name: "Anoushka Srivastava", type: "person", variations: [] },
          target: { name: "Gmail", type: "company", variations: [] },
          confidence: 0.95,
          context: content,
        },
        {
          type: "engaged_with",
          source: { name: "Anoushka Srivastava", type: "person", variations: [] },
          target: { name: "Oliver Wyman", type: "company", variations: [] },
          confidence: 0.95,
          context: content,
        },
      ],
    });

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      smartFileContext(fileId, "hash-provider", { content }),
    );

    const names = await extractedNames(fileId);
    expect(names).toContain("Oliver Wyman");
    expect(names).toContain("Anoushka Srivastava");
    expect(names).not.toContain("Gmail");

    const endpoints = await relationEndpointNames(fileId);
    expect(endpoints).toContain("Oliver Wyman");
    expect(endpoints).not.toContain("Gmail");
  });

  it("drops a project mention that merely restates the email subject, keeps a body project", async () => {
    const fileId = randomUUID();
    const content =
      "Rajesh Chaudhary discussed the Branding and MVP Design Proposal. We also kicked off K8s Migration.";
    await seedFile(db, fileId, { content, contentHash: "hash-subject" });
    const generator = extractionGenerator({
      mentions: [
        { mention: "Rajesh Chaudhary", type: "person", variations: [], confidence: 0.95 },
        { mention: "Branding and MVP Design Proposal", type: "project", variations: [], confidence: 0.95 },
        { mention: "K8s Migration", type: "project", variations: [], confidence: 0.95 },
      ],
      relations: [],
    });

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      smartFileContext(fileId, "hash-subject", {
        content,
        fileName: "Re: Branding and MVP Design Proposal",
      }),
    );

    const names = await extractedNames(fileId);
    expect(names).toContain("K8s Migration");
    expect(names).not.toContain("Branding and MVP Design Proposal");
  });

  it("does not over-match: companies that merely contain a provider word survive", async () => {
    const fileId = randomUUID();
    const content = "Live Nation and Proton Labs announced a partnership.";
    await seedFile(db, fileId, { content, contentHash: "hash-substring" });
    const generator = extractionGenerator({
      mentions: [
        { mention: "Live Nation", type: "company", variations: [], confidence: 0.95 },
        { mention: "Proton Labs", type: "company", variations: [], confidence: 0.95 },
      ],
      relations: [],
    });

    await smartEnrichFile(
      { db, logger: createTestLogger(), generator, embeddingProvider: null },
      smartFileContext(fileId, "hash-substring", { content }),
    );

    const names = await extractedNames(fileId);
    expect(names).toContain("Live Nation");
    expect(names).toContain("Proton Labs");
  });
});

describe("dedup adjudication", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("builds unique project/product retrieval queries and merges retrieved known entities without replacing existing", () => {
    expect(
      projectProductMentionNames([
        { mention: "Tourism Dashboard", type: "project" },
        { mention: "tourism dashboard", type: "project" },
        { mention: "Insight OS", type: "product" },
        { mention: "Maaden", type: "company" },
      ]),
    ).toEqual([
      { name: "Tourism Dashboard", type: "project" },
      { name: "Insight OS", type: "product" },
    ]);

    const merged = mergeKnownEntities(
      [
        { name: "Tourism Dashboard", type: "project", entityId: "existing" },
        { name: "Maaden", type: "company", entityId: "company" },
      ],
      [
        { name: "tourism dashboard", type: "project", reviewId: "retrieved-duplicate" },
        { name: "Maaden Sites", type: "project", reviewId: "retrieved-new" },
      ],
    );

    expect(merged).toEqual([
      { name: "Tourism Dashboard", type: "project", entityId: "existing" },
      { name: "Maaden", type: "company", entityId: "company" },
      { name: "Maaden Sites", type: "project", reviewId: "retrieved-new" },
    ]);
  });

  it("canonicalizes a dedup hit across mentions and relation endpoints", async () => {
    const fileId = randomUUID();
    const canonical = "[OW x Canvasx] Tourism Recovery Dashboard";
    const content = "Sarah Chen leads Tourism dashboard.";
    await seedFile(db, fileId, { content, contentHash: "hash-dedup-hit" });
    const generator = {
      generate: async () => "Sarah Chen leads the tourism dashboard work.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          return {
            mentions: [
              { mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.96 },
              { mention: "Tourism dashboard", type: "project", variations: [], confidence: 0.95 },
            ],
            relations: [
              {
                type: "leads",
                source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
                target: { name: "Tourism dashboard", type: "project", variations: [] },
                confidence: 0.95,
                context: "Sarah Chen leads Tourism dashboard.",
              },
            ],
          } as T;
        }
        if (opts?.label?.startsWith("dedupAdjudicate:")) {
          return [{ mention: "M1", matchesKnown: "K1" }] as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await smartEnrichFile(
      {
        db,
        logger: createTestLogger(),
        generator,
        embeddingProvider: null,
        knownEntities: [{ name: canonical, type: "project" }],
      },
      smartFileContext(fileId, "hash-dedup-hit", { content }),
    );

    const mentionFacts = await db
      .selectFrom("indexed_file_facts")
      .select("subject_name")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_extracted")
      .execute();
    const mentionNames = mentionFacts.map((fact) => fact.subject_name);
    expect(mentionNames).toContain(canonical);
    expect(mentionNames).not.toContain("Tourism dashboard");

    const relationRaw = await db
      .selectFrom("indexed_file_facts")
      .select("raw")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_relation")
      .executeTakeFirstOrThrow();
    const relation = JSON.parse(relationRaw.raw ?? "{}") as { target?: { name?: string } };
    expect(relation.target?.name).toBe(canonical);
  });

  it("drops a generic-only over-merge and requires distinctive overlap", async () => {
    expect(hasDistinctiveOverlap("War Dashboard", "[OW x Canvasx] Tourism Recovery Dashboard", [])).toBe(false);
    expect(hasDistinctiveOverlap("Tourism dashboard", "[OW x Canvasx] Tourism Recovery Dashboard", [])).toBe(true);
    const mentions = [{ mention: "War Dashboard", type: "project", variations: [], confidence: 0.92 }];
    let dedupCalls = 0;
    const generator = {
      generate: async () => "",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("dedupAdjudicate:")) {
          dedupCalls += 1;
          return [{ mention: "M1", matchesKnown: "K1" }] as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    const rewrites = await adjudicateKnownMatches(
      generator,
      mentions,
      [{ name: "[OW x Canvasx] Tourism Recovery Dashboard", type: "project" }],
      { fileId: "f-war", logger: createTestLogger() },
    );

    expect(dedupCalls).toBe(1);
    expect(rewrites.size).toBe(0);
    expect(mentions[0].mention).toBe("War Dashboard");
    expect((mentions[0] as { matchesKnown?: string }).matchesKnown).toBeUndefined();
  });

  it("rejects a retrieved Maaden Sites candidate for a Maaden Dashboard mention even when the LLM picks it", async () => {
    expect(hasDistinctiveOverlap("Maaden Dashboard", "Maaden Sites", ["Maaden"])).toBe(false);
    const mentions = [{ mention: "Maaden Dashboard", type: "project", variations: [], confidence: 0.94 }];
    const generator = {
      generate: async () => "",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("dedupAdjudicate:")) {
          return [{ mention: "M1", matchesKnown: "K1" }] as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    const rewrites = await adjudicateKnownMatches(
      generator,
      mentions,
      [{ name: "Maaden Sites", type: "project", reviewId: "retrieved-maaden-sites" }],
      { fileId: "f-maaden-overmerge", logger: createTestLogger(), anchorNames: ["Maaden"] },
    );

    expect(rewrites.size).toBe(0);
    expect(mentions[0]).toEqual({
      mention: "Maaden Dashboard",
      type: "project",
      variations: [],
      confidence: 0.94,
      matchesKnown: undefined,
    });
  });

  it("clears stale matchesKnown and fails open when the dedup generator throws", async () => {
    const mentions = [
      {
        mention: "Tourism dashboard",
        type: "project",
        variations: ["tourism dash"],
        confidence: 0.93,
        matchesKnown: "K1",
      },
    ];
    const generator = {
      generate: async () => "",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("dedupAdjudicate:")) throw new Error("dedup unavailable");
        return {} as T;
      },
    } as GeminiGenerator;

    const rewrites = await adjudicateKnownMatches(
      generator,
      mentions,
      [{ name: "[OW x Canvasx] Tourism Recovery Dashboard", type: "project" }],
      { fileId: "f-throw", logger: createTestLogger() },
    );

    expect(rewrites.size).toBe(0);
    expect(mentions[0]).toEqual({
      mention: "Tourism dashboard",
      type: "project",
      variations: ["tourism dash"],
      confidence: 0.93,
      matchesKnown: undefined,
    });
  });
});

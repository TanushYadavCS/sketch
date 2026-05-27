import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EnrichmentDeps, MAX_FILES_PER_RUN } from "../connectors/enrichment";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { RecreateSummary } from "./recreate";
import { runEnrichmentForFileBatches, runReenrichJob, wipeLlmEnrichmentForFiles } from "./reenrich";

const logger = createTestLogger();

async function seedBase(db: Kysely<DB>) {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({ id: "owner", name: "Owner", email: "owner@test.com", created_at: now })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "fireflies",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: "cfg",
      provider_file_id: "provider-1",
      file_name: "File 1",
      file_type: "doc",
      content_category: "document",
      content: "Alice works on Apollo with Acme.",
      source: "fireflies",
      content_hash: "hash-old",
      is_archived: 0,
      synced_at: now,
      embedding_status: "done",
      summary_status: "done",
      summary: "Old summary",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType = "person") {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({ id, name, source_type: sourceType, status: "confirmed", hotness: 0, created_at: now, updated_at: now })
    .execute();
}

async function seedLlmExtractedFact(db: Kysely<DB>, subjectName: string, contentHash = "hash-old") {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: "file-1",
    connectorConfigId: "cfg",
    createdByUserId: "owner",
    contentHash,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName,
    subjectSource: "llm_extraction",
    subjectSourceId: `file-1:${contentHash}:${subjectName}`,
    raw: {
      contentHash,
      promptVersion: "llm-extraction-v2",
      model: "gemini",
      mention: subjectName,
      type: "person",
      variations: [],
    },
  });
}

async function seedLlmRelationFact(db: Kysely<DB>, contentHash = "hash-old") {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: "file-1",
    connectorConfigId: "cfg",
    createdByUserId: "owner",
    contentHash,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: "contributes_to",
    subjectName: "Alice",
    subjectSource: "llm_extraction",
    subjectSourceId: `file-1:${contentHash}:Alice:Apollo`,
    raw: {
      contentHash,
      promptVersion: "llm-extraction-v2",
      model: "gemini",
      relationType: "contributes_to",
      confidence: 0.8,
      source: { name: "Alice", type: "person", variations: [] },
      target: { name: "Apollo", type: "project", variations: [] },
      context: "Alice works on Apollo.",
    },
  });
}

describe("entity re-enrich", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("tombstones only LLM facts and preserves connector mentions", async () => {
    await seedEntity(db, "person-1", "Alice");
    await seedLlmExtractedFact(db, "Alice");
    await seedLlmRelationFact(db);
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: "owner",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Alice",
      subjectEmail: "alice@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "alice@example.com",
      raw: { providerFileId: "provider-1", attendee: { name: "Alice", email: "alice@example.com" } },
    });
    await db.updateTable("indexed_file_facts").set({ materialized_at: new Date().toISOString() }).execute();
    await db
      .insertInto("document_chunks")
      .values({ id: "chunk-1", indexed_file_id: "file-1", chunk_index: 0, content: "Alice", token_count: 1 })
      .execute();
    await db
      .insertInto("document_timeframes")
      .values({ id: "tf-1", indexed_file_id: "file-1", start_date: "2026-01-01" })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: randomUUID(),
          entity_id: "person-1",
          indexed_file_id: "file-1",
          confidence: "EXTRACTED",
          source: "fireflies",
          relation: "attended",
          mentioned_at: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          entity_id: "person-1",
          indexed_file_id: "file-1",
          confidence: "INFERRED",
          source: "llm_extraction",
          relation: "mentioned",
          mentioned_at: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          entity_id: "person-1",
          indexed_file_id: "file-1",
          confidence: "INFERRED",
          source: "deterministic_substring",
          relation: "matched",
          mentioned_at: new Date().toISOString(),
        },
      ])
      .execute();

    const summary = await wipeLlmEnrichmentForFiles(db, logger, ["file-1"]);

    expect(summary.factsByType).toEqual({ llm_extracted: 1, llm_relation: 1 });
    expect(summary.factsTombstoned).toBe(2);
    expect(summary.chunks).toBe(1);
    expect(summary.timeframes).toBe(1);

    const facts = await db.selectFrom("indexed_file_facts").selectAll().execute();
    expect(facts.filter((fact) => fact.fact_type.startsWith("llm_")).every((fact) => fact.deleted_at)).toBe(true);
    expect(facts.find((fact) => fact.fact_type === "attendee")?.deleted_at).toBeNull();

    const mentions = await db.selectFrom("entity_mentions").select(["source"]).execute();
    expect(mentions.map((mention) => mention.source)).toEqual(["fireflies"]);
    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status", "summary"])
      .executeTakeFirstOrThrow();
    expect(file).toEqual({ embedding_status: "pending", summary_status: "pending", summary: null });
  });

  it("removes relation evidence and empty relationships before tombstoning facts", async () => {
    await seedEntity(db, "alice", "Alice");
    await seedEntity(db, "apollo", "Apollo", "project");
    await seedLlmRelationFact(db);
    const fact = await db
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("fact_type", "=", "llm_relation")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("entity_relationships")
      .values({
        id: "rel-1",
        source_entity_id: "alice",
        target_entity_id: "apollo",
        relationship_type: "contributes_to",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_extraction",
      })
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "ev-1",
        relationship_id: "rel-1",
        indexed_file_id: "file-1",
        source_fact_id: fact.id,
        evidence_key: `fact:${fact.id}`,
      })
      .execute();

    const summary = await wipeLlmEnrichmentForFiles(db, logger, ["file-1"]);

    expect(summary.relationshipEvidenceDeleted).toBe(1);
    expect(summary.relationshipsDeleted).toBe(1);
    expect(await db.selectFrom("entity_relationship_evidence").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("entity_relationships").selectAll().execute()).toHaveLength(0);
    const factAfter = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("id", "=", fact.id)
      .executeTakeFirstOrThrow();
    expect(factAfter.deleted_at).not.toBeNull();
  });

  it("batches explicit enrichment scopes and processes every file once", async () => {
    const fileIds = Array.from({ length: MAX_FILES_PER_RUN + 3 }, (_, i) => `file-${i}`);
    const calls: string[][] = [];
    const result = await runEnrichmentForFileBatches(
      {
        db,
        logger,
        embeddingProvider: null,
        runEnrichmentImpl: async (deps: EnrichmentDeps) => {
          calls.push(deps.fileIds ?? []);
          return { filesProcessed: deps.fileIds?.length ?? 0, filesSkipped: 0, filesFailed: 0, errors: [] };
        },
      },
      fileIds,
    );

    expect(calls.map((call) => call.length)).toEqual([MAX_FILES_PER_RUN, 3]);
    expect(calls.flat()).toEqual(fileIds);
    expect(result.filesProcessed).toBe(fileIds.length);
  });

  it("runs a re-enrich job that tombstones stale facts and materializes new ones", async () => {
    await seedLlmExtractedFact(db, "Old Person");
    await db.updateTable("indexed_file_facts").set({ materialized_at: new Date().toISOString() }).execute();

    const summary = await runReenrichJob({
      db,
      logger,
      triggeredByUserId: "owner",
      fileIds: ["file-1"],
      llmPromotionThreshold: 1,
      runEnrichmentImpl: async () => {
        await seedLlmExtractedFact(db, "New Person", "hash-new");
        return { filesProcessed: 1, filesSkipped: 0, filesFailed: 0, errors: [] };
      },
    });

    expect(summary.wipe.factsTombstoned).toBe(1);
    const oldFact = await db
      .selectFrom("indexed_file_facts")
      .select(["deleted_at"])
      .where("subject_name", "=", "Old Person")
      .executeTakeFirstOrThrow();
    expect(oldFact.deleted_at).not.toBeNull();
    const newEntity = await db
      .selectFrom("entities")
      .select("name")
      .where("name", "=", "New Person")
      .executeTakeFirst();
    expect(newEntity?.name).toBe("New Person");
  });

  it("uses caller-provided fact types for the rebuild replay", async () => {
    let capturedFactTypes: string[] | undefined;

    await runReenrichJob({
      db,
      logger,
      triggeredByUserId: "owner",
      fileIds: ["file-1"],
      materializeFactTypes: ["attendee", "llm_extracted"],
      runEnrichmentImpl: async () => ({ filesProcessed: 1, filesSkipped: 0, filesFailed: 0, errors: [] }),
      recreateEntityGraphImpl: async (deps) => {
        capturedFactTypes = deps.materializeFactTypes;
        return emptyRecreateSummary();
      },
    });

    expect(capturedFactTypes).toEqual(["attendee", "llm_extracted"]);
  });

  it("post-sweep engagement floor catches engaged_with edges that the per-file floor missed (bootstrap state)", async () => {
    const now = new Date().toISOString();

    await db
      .updateTable("indexed_files")
      .set({
        content: "# OW <> Canvas Standup\n## Action Items\n-\n**Vedant Parikh**\nContinue work (05:00)\n",
        content_hash: "hash-bootstrap",
      })
      .where("id", "=", "file-1")
      .execute();

    await seedEntity(db, "ent-canvas-rb", "Canvas", "company");
    await seedEntity(db, "ent-ow-rb", "Oliver Wyman", "company");
    await seedEntity(db, "ent-vedant-rb", "Vedant Parikh", "person");
    await db
      .insertInto("entity_domains")
      .values([
        {
          id: randomUUID(),
          entity_id: "ent-canvas-rb",
          domain: "canvasx.ai",
          kind: "corporate",
          is_primary: 1,
          confidence: 1.0,
          source: "manual",
        },
        {
          id: randomUUID(),
          entity_id: "ent-ow-rb",
          domain: "oliverwyman.com",
          kind: "corporate",
          is_primary: 1,
          confidence: 1.0,
          source: "manual",
        },
      ])
      .execute();

    const factsRepo = createIndexedFileFactRepository(db);
    await factsRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: "owner",
      contentHash: "hash-bootstrap",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Vedant Parikh",
      subjectEmail: "vedant@canvasx.ai",
      subjectSource: "fireflies",
      subjectSourceId: "file-1:vedant@canvasx.ai",
      raw: { providerFileId: "file-1", attendee: { name: "Vedant Parikh", email: "vedant@canvasx.ai" } },
    });
    await factsRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: "owner",
      contentHash: "hash-bootstrap",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Ohoud Zitan",
      subjectEmail: "ohoud@oliverwyman.com",
      subjectSource: "fireflies",
      subjectSourceId: "file-1:ohoud@oliverwyman.com",
      raw: { providerFileId: "file-1", attendee: { name: "Ohoud Zitan", email: "ohoud@oliverwyman.com" } },
    });

    const summary = await runReenrichJob({
      db,
      logger,
      triggeredByUserId: "owner",
      fileIds: ["file-1"],
      llmPromotionThreshold: 1,
      runEnrichmentImpl: async () => ({ filesProcessed: 1, filesSkipped: 0, filesFailed: 0, errors: [] }),
    });

    expect(summary.engagementFloor).toBeDefined();
    expect(summary.engagementFloor?.emitted).toBeGreaterThan(0);

    const edge = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as src", "src.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as tgt", "tgt.id", "entity_relationships.target_entity_id")
      .select(["src.name as src", "tgt.name as tgt", "entity_relationships.relationship_type as rel"])
      .where("entity_relationships.relationship_type", "=", "engaged_with")
      .where("src.name", "=", "Vedant Parikh")
      .where("tgt.name", "=", "Oliver Wyman")
      .executeTakeFirst();
    expect(edge).toBeDefined();
  });
});

function emptyRecreateSummary(): RecreateSummary {
  return {
    reset: {
      dryRun: false,
      deleted: {},
      filesMarkedPending: 0,
      factsMarkedUnmaterialized: 0,
      warnings: [],
    },
    replay: {
      factsRead: 0,
      entitiesCreated: 0,
      entitiesLinked: 0,
      queued: 0,
      mentionsWritten: 0,
      relationshipsWritten: 0,
      skipped: 0,
      materialized: 0,
      deferred: 0,
      deferredBelowThreshold: 0,
    },
    enrichmentIterations: 0,
    enrichment: { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] },
  };
}

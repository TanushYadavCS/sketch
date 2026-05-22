import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { recreateEntityGraph, replaySourceFacts } from "./recreate";

const ATTENDED_FILE_ID = "file-1";
const TEST_USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";

async function seedRawCorpus(db: Kysely<DB>) {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: TEST_USER_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: TEST_USER_ID,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: ATTENDED_FILE_ID,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "meeting-1",
      file_name: "Q4 Kickoff",
      file_type: "transcript",
      content_category: "document",
      content: "Saurabh and Hari discussed the launch.",
      source: "fireflies",
      content_hash: "hash-1",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-2",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "task-1",
      file_name: "Polish docs",
      file_type: "task",
      content_category: "document",
      content: "Owner: Saurabh",
      source: "clickup",
      content_hash: "hash-2",
      is_archived: 0,
      synced_at: now,
    })
    .execute();

  const factRepo = createIndexedFileFactRepository(db);

  // Structural seed without a file (onEntitySeed payload — e.g. a ClickUp space).
  await factRepo.upsertFact({
    source: "clickup",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: "Engineering Space",
    subjectSource: "clickup",
    subjectSourceId: "space-eng",
    raw: { sourceType: "clickup_space", sourceUrl: "https://clickup.com/space/eng" },
  });

  // Attendee fact (file-attached).
  await factRepo.upsertFact({
    indexedFileId: ATTENDED_FILE_ID,
    source: "fireflies",
    factType: "attendee",
    relation: "attended",
    subjectName: "Saurabh CanvasX",
    subjectEmail: "saurabh@canvasx.ai",
    subjectSource: "fireflies",
    subjectSourceId: "meeting-1:saurabh@canvasx.ai",
    contextSnippet: "Attended meeting-1",
  });

  // Assignee fact (file-attached, no email — name-only).
  await factRepo.upsertFact({
    indexedFileId: "file-2",
    source: "clickup",
    factType: "assignee",
    relation: "assigned",
    subjectName: "Saurabh CanvasX",
    subjectSource: "clickup",
    subjectSourceId: "user:saurabh",
    contextSnippet: "Assigned to Saurabh CanvasX",
  });

  // Parent entity fact pointing at the structural seed above.
  await factRepo.upsertFact({
    indexedFileId: "file-2",
    source: "clickup",
    factType: "parent_entity",
    relation: "mentioned",
    subjectSource: "clickup",
    subjectSourceId: "space-eng",
    contextSnippet: "In Engineering Space",
  });

  // Person seed (file-less, e.g. ClickUp directory).
  await factRepo.upsertFact({
    source: "clickup",
    factType: "person_seed",
    relation: "seeded",
    subjectName: "Hari Kalra",
    subjectEmail: "hari@canvasx.ai",
    subjectSource: "clickup",
    subjectSourceId: "clickup-user:hari",
    raw: { subtype: "internal" },
  });
}

describe("replaySourceFacts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedRawCorpus(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates entities, source refs, and EXTRACTED mentions from facts", async () => {
    const summary = await replaySourceFacts(db, createTestLogger(), { triggeredByUserId: TEST_USER_ID });

    expect(summary.factsRead).toBe(5);
    expect(summary.entitiesCreated).toBeGreaterThanOrEqual(1);

    const entities = await db.selectFrom("entities").selectAll().execute();
    const names = entities.map((e) => e.name).sort();
    expect(names).toContain("Saurabh CanvasX");
    expect(names).toContain("Hari Kalra");
    expect(names).toContain("Engineering Space");

    const mentions = await db.selectFrom("entity_mentions").selectAll().execute();
    const attendedMention = mentions.find((m) => m.relation === "attended");
    expect(attendedMention).toBeDefined();
    expect(attendedMention?.confidence).toBe("EXTRACTED");
    expect(attendedMention?.indexed_file_id).toBe(ATTENDED_FILE_ID);

    const assignedMention = mentions.find((m) => m.relation === "assigned");
    expect(assignedMention?.confidence).toBe("EXTRACTED");

    const mentionedMention = mentions.find((m) => m.relation === "mentioned");
    expect(mentionedMention?.source).toBe("clickup_parent_entity");

    const sourceRefs = await db.selectFrom("entity_source_refs").selectAll().execute();
    const refKeys = sourceRefs.map((r) => `${r.source}:${r.source_id}`);
    expect(refKeys).toContain("clickup:space-eng");
    expect(refKeys).toContain("fireflies:meeting-1:saurabh@canvasx.ai");
  });

  it("is idempotent — running twice writes zero new rows on the second pass", async () => {
    await replaySourceFacts(db, createTestLogger(), { triggeredByUserId: TEST_USER_ID });

    const snapshot = async () => ({
      entities: (await db.selectFrom("entities").selectAll().execute()).length,
      mentions: (await db.selectFrom("entity_mentions").selectAll().execute()).length,
      refs: (await db.selectFrom("entity_source_refs").selectAll().execute()).length,
      candidates: (await db.selectFrom("entity_candidates").selectAll().execute()).length,
      queue: (await db.selectFrom("entity_review_queue").selectAll().execute()).length,
      evidence: (await db.selectFrom("entity_review_evidence").selectAll().execute()).length,
    });

    const before = await snapshot();
    await replaySourceFacts(db, createTestLogger(), { triggeredByUserId: TEST_USER_ID });
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it("skips parent_entity facts whose target seed never replayed", async () => {
    // Insert an orphan parent_entity fact pointing at a non-existent seed.
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      source: "notion",
      factType: "parent_entity",
      relation: "mentioned",
      subjectSource: "notion",
      subjectSourceId: "db-missing",
      contextSnippet: "In missing DB",
    });

    const summary = await replaySourceFacts(db, createTestLogger(), { triggeredByUserId: TEST_USER_ID });

    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    const mentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("source", "=", "notion_parent_entity")
      .execute();
    expect(mentions).toHaveLength(0);
  });

  it("queues ambiguous name-only facts instead of direct-upserting synthetic source refs", async () => {
    await db.deleteFrom("indexed_file_facts").execute();
    await db.deleteFrom("entity_mentions").execute();
    await db.deleteFrom("entity_source_refs").execute();
    await db.deleteFrom("entities").execute();

    await createEntityRepository(db).upsertPersonEntity({
      name: "Saurabh Kumar Singh",
      subtype: "external",
      source: "manual",
      sourceId: "person-1",
    });
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: "file-2",
      source: "linear",
      factType: "assignee",
      relation: "assigned",
      subjectName: "Saurabh Kumar",
      subjectSource: "linear",
      subjectSourceId: "user:Saurabh Kumar",
      contextSnippet: "Assigned to Saurabh Kumar",
      raw: {
        providerFileId: "task-1",
        assignee: { name: "Saurabh Kumar" },
        sourceRefKey: "linear:user:Saurabh Kumar",
      },
    });

    const summary = await replaySourceFacts(db, createTestLogger(), { triggeredByUserId: TEST_USER_ID });

    expect(summary.queued).toBe(1);
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("relation", "=", "assigned").execute(),
    ).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(1);
  });
});

describe("recreateEntityGraph", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedRawCorpus(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs the full reset → replay → enrichment chain idempotently", async () => {
    const first = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 2,
    });

    expect(first.replay.factsRead).toBe(5);

    // Snapshot the deterministic tuples (entity name, file id, relation, source)
    // so we can assert stability across recreate runs without depending on
    // entity IDs (which churn — that's an explicit out-of-scope guarantee).
    const snapshot = async () => {
      const rows = await db
        .selectFrom("entity_mentions")
        .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
        .select([
          "entities.name as name",
          "entity_mentions.indexed_file_id as file",
          "entity_mentions.relation",
          "entity_mentions.source",
          "entity_mentions.confidence",
        ])
        .execute();
      return rows.map((r) => `${r.name}|${r.file}|${r.relation}|${r.source}|${r.confidence}`).sort();
    };

    const tuplesBefore = await snapshot();

    const second = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 2,
    });

    const tuplesAfter = await snapshot();

    expect(tuplesAfter).toEqual(tuplesBefore);
    expect(second.replay.factsRead).toBe(5);
  });

  it("does not pass downloadImage into enrichment (no provider downloads)", async () => {
    // We can't directly assert on the runEnrichment call, but we can assert
    // that the recreate path never imports a download helper — runEnrichment's
    // image branch hits the `if (!downloadImage)` short-circuit, marking image
    // files skipped. To exercise this, insert an image file and verify the
    // enrichment loop marks it `skipped` rather than failing on a missing
    // download helper.
    const now = new Date().toISOString();
    await db
      .insertInto("indexed_files")
      .values({
        id: "image-1",
        connector_config_id: CONNECTOR_ID,
        provider_file_id: "img-1",
        file_name: "screenshot.png",
        file_type: "image",
        content_category: "document",
        source: "google_drive",
        content_hash: "img-hash",
        is_archived: 0,
        synced_at: now,
        mime_type: "image/png",
      })
      .execute();

    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 1,
      skipLlm: true,
    });

    // The image row must reach a terminal status without runEnrichment crashing
    // for a missing downloadImage helper. enrichImage short-circuits on the
    // missing helper and the outer loop marks the file done — that's fine.
    // The assertion that matters: no `failed` status (which is what would
    // surface if recreate had tried to call the provider).
    const image = await db
      .selectFrom("indexed_files")
      .selectAll()
      .where("id", "=", "image-1")
      .executeTakeFirstOrThrow();
    expect(["done", "skipped"]).toContain(image.embedding_status);
  });

  it("skipLlm runs deterministic enrichment only", async () => {
    // With skipLlm=true and no gemini key in settings, enrichment must
    // still complete and leave the file with embedding_status='done' or
    // 'skipped' (no `failed`, since no LLM call is attempted).
    const summary = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 2,
      skipLlm: true,
    });

    expect(summary.enrichment.filesFailed).toBe(0);
    const files = await db
      .selectFrom("indexed_files")
      .select(["id", "embedding_status"])
      .where("is_archived", "=", 0)
      .execute();
    for (const f of files) {
      expect(["done", "skipped"]).toContain(f.embedding_status);
    }
  });
});

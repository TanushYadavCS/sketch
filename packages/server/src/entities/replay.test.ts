import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StageReport } from "../connectors/enrichment-stage-report";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  buildMaterializeDeps,
  materializeFromFact,
  materializeUnmaterializedFacts,
  replaySourceFacts,
} from "./materialize";
import { recreateEntityGraph } from "./recreate";

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
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: TEST_USER_ID,
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
    createdByUserId: TEST_USER_ID,
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

  it("materializes a single person fact through materializeFromFact", async () => {
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "attendee")
      .executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db);

    const result = await materializeFromFact(deps, fact);

    expect(result.kind).toBe("entity_created");
    if (result.kind === "entity_created") {
      expect(result.mentionWritten).toBe(true);
      expect(result.entity.name).toBe("Saurabh CanvasX");
    }
    const mentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("indexed_file_id", "=", ATTENDED_FILE_ID)
      .where("relation", "=", "attended")
      .execute();
    expect(mentions).toHaveLength(1);
    expect(mentions[0].confidence).toBe("EXTRACTED");
  });

  it("materializes correspondent facts with corresponded mentions", async () => {
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      source: "google_drive",
      factType: "correspondent",
      relation: "corresponded",
      subjectName: "Jane Doe",
      subjectEmail: "jane@example.com",
      subjectSource: "google_drive",
      subjectSourceId: "message-1:jane@example.com",
      contextSnippet: "Corresponded message-1",
      raw: { providerFileId: "message-1", correspondent: { name: "Jane Doe", email: "jane@example.com" } },
    });

    await materializeUnmaterializedFacts(db, createTestLogger());

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "source", "relation"])
      .where("indexed_file_id", "=", ATTENDED_FILE_ID)
      .where("relation", "=", "corresponded")
      .execute();

    expect(mentions).toEqual([
      { confidence: "EXTRACTED", source: "google_drive_correspondent", relation: "corresponded" },
    ]);
  });

  it("stamps pre-existing open feature facts as disabled without creating graph rows", async () => {
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: "hash-1",
      source: "llm_extraction",
      factType: "feature",
      relation: "mentioned",
      subjectName: "CRM Analytics",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash-1:llm-extraction-v13:CRM Analytics",
      raw: {
        contentHash: "hash-1",
        promptVersion: "llm-extraction-v13",
        model: "gemini",
        featureId: "llm-feature:file-1:crm-analytics",
        featureName: "CRM Analytics",
        parentProductName: "Canvas CRM",
        corroborationKey: "crm-analytics-canvas-crm",
        status: "proposed",
        evidence: { fileIds: [ATTENDED_FILE_ID], entityIds: [] },
        confidence: 0.91,
      } as never,
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "feature")
      .executeTakeFirstOrThrow();

    await expect(materializeFromFact(await buildMaterializeDeps(db), fact)).resolves.toEqual({
      kind: "skipped",
      reason: "feature_disabled",
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), { factTypes: ["feature"] });

    const stored = await db
      .selectFrom("indexed_file_facts")
      .select(["materialized_at", "materialization_attempts"])
      .where("id", "=", fact.id)
      .executeTakeFirstOrThrow();
    expect(stored.materialized_at).not.toBeNull();
    expect(stored.materialization_attempts).toBe(0);
    await expect(db.selectFrom("sub_entities").selectAll().where("kind", "=", "feature").execute()).resolves.toEqual(
      [],
    );
    await expect(db.selectFrom("entities").selectAll().where("source_type", "=", "feature").execute()).resolves.toEqual(
      [],
    );
  });

  it("reports materialize counters and counts person scope-key reads", async () => {
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: "hash-1",
      source: "llm_extraction",
      factType: "feature",
      relation: "mentioned",
      subjectName: "CRM Analytics",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash-1:llm-extraction-v13:CRM Analytics:counters",
      raw: {
        contentHash: "hash-1",
        promptVersion: "llm-extraction-v13",
        model: "gemini",
        featureId: "llm-feature:file-1:crm-analytics-counters",
        featureName: "CRM Analytics",
        parentProductName: "Canvas CRM",
        corroborationKey: "crm-analytics-canvas-crm-counters",
        status: "proposed",
        evidence: { fileIds: [ATTENDED_FILE_ID], entityIds: [] },
        confidence: 0.91,
      } as never,
    });
    const featureReports: StageReport[] = [];

    const featureSummary = await materializeUnmaterializedFacts(db, createTestLogger(), {
      factTypes: ["feature"],
      indexedFileIds: [ATTENDED_FILE_ID],
      stageReport: (report) => featureReports.push(report),
    });

    expect(featureSummary).toMatchObject({ eligibleFacts: 1, indexBuilds: 1, scopeKeyReads: 0 });
    expect(featureReports.at(-1)?.materializeSummary).toEqual({
      eligibleFacts: 1,
      indexBuilds: 1,
      scopeKeyReads: 0,
    });
    const featureFact = await db
      .selectFrom("indexed_file_facts")
      .select(["materialized_at"])
      .where("subject_source_id", "=", "file-1:hash-1:llm-extraction-v13:CRM Analytics:counters")
      .executeTakeFirstOrThrow();
    expect(featureFact.materialized_at).not.toBeNull();

    const now = new Date().toISOString();
    await db
      .insertInto("indexed_files")
      .values({
        id: "scope-read-file",
        connector_config_id: CONNECTOR_ID,
        provider_file_id: "scope-read-file",
        file_name: "Scope read fixture",
        file_type: "calendar",
        content_category: "document",
        content: "Avery Stone attended with a corporate email.",
        source: "calendar",
        content_hash: "hash-scope-read",
        is_archived: 0,
        synced_at: now,
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "person-avery-stone",
        name: "Avery Stone",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify([]),
        metadata: JSON.stringify({}),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "declared",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await factRepo.upsertFact({
      indexedFileId: "scope-read-file",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: "hash-scope-read",
      source: "calendar",
      factType: "attendee",
      relation: "attended",
      subjectName: "Avery Stone",
      subjectEmail: "avery@scoped-corp.test",
      subjectSource: "calendar",
      subjectSourceId: "scope-read-file:attendee:avery-external",
      raw: {
        providerFileId: "scope-read-file",
        attendee: { name: "Avery Stone", email: "avery@scoped-corp.test" },
      },
    });
    const attendeeReports: StageReport[] = [];

    const attendeeSummary = await materializeUnmaterializedFacts(db, createTestLogger(), {
      factTypes: ["attendee"],
      indexedFileIds: ["scope-read-file"],
      stageReport: (report) => attendeeReports.push(report),
    });

    expect(attendeeSummary.eligibleFacts).toBe(1);
    expect(attendeeSummary.indexBuilds).toBe(1);
    expect(attendeeSummary.scopeKeyReads).toBeGreaterThan(0);
    expect(attendeeReports.at(-1)?.materializeSummary?.scopeKeyReads).toBeGreaterThan(0);
  });

  it("upgrades existing INFERRED mentions when a durable fact replays", async () => {
    const entity = await createEntityRepository(db).upsertPersonEntity({
      name: "Saurabh CanvasX",
      email: "saurabh@canvasx.ai",
      subtype: "external",
      source: "fireflies",
      sourceId: "meeting-1:saurabh@canvasx.ai",
    });
    await createEntityRepository(db).createMention({
      entityId: entity.id,
      indexedFileId: ATTENDED_FILE_ID,
      contextSnippet: "LLM guessed attendee",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "attended",
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "attendee")
      .executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db);

    const result = await materializeFromFact(deps, fact);

    expect(result.kind).toBe("entity_linked");
    const mentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", entity.id)
      .where("indexed_file_id", "=", ATTENDED_FILE_ID)
      .where("relation", "=", "attended")
      .execute();
    expect(mentions).toHaveLength(1);
    expect(mentions[0].confidence).toBe("EXTRACTED");
    expect(mentions[0].source).toBe("fireflies_attendee");
    expect(mentions[0].context_snippet).toBe("Attended meeting-1");
  });

  it("materializes LLM extraction facts as INFERRED mentions once threshold reached", async () => {
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: "hash-1",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Jane Doe",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash-1:llm-extraction-v2:Jane Doe",
      raw: {
        contentHash: "hash-1",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        mention: "Jane Doe",
        type: "person",
        variations: ["Jane"],
      },
    });
    const fact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "llm_extracted")
      .executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db, { llmPromotionThreshold: 1 });

    const result = await materializeFromFact(deps, fact);

    expect(result.kind).toBe("entity_created");
    const mention = await db
      .selectFrom("entity_mentions")
      .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
      .select(["entity_mentions.confidence", "entity_mentions.source", "entity_mentions.relation", "entities.name"])
      .where("entity_mentions.indexed_file_id", "=", ATTENDED_FILE_ID)
      .where("entities.name", "=", "Jane Doe")
      .executeTakeFirstOrThrow();
    expect(mention).toMatchObject({
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
      name: "Jane Doe",
    });
  });

  it("returns skipped_missing_owner when a proposal fact has no recoverable owner", async () => {
    await db.deleteFrom("indexed_file_facts").execute();
    await db.deleteFrom("entities").execute();
    await createIndexedFileFactRepository(db).upsertFact({
      source: "manual",
      factType: "attendee",
      relation: "attended",
      subjectName: "Ownerless Person",
      subjectSource: "manual",
      subjectSourceId: "person-ownerless",
    });
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db);

    const result = await materializeFromFact(deps, fact);

    expect(result).toEqual({ kind: "skipped_missing_owner", reason: "missing_fact_owner" });
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("creates entities, source refs, and EXTRACTED mentions from facts", async () => {
    const summary = await replaySourceFacts(db, createTestLogger());

    expect(summary.factsRead).toBe(5);
    expect(summary.entitiesCreated).toBeGreaterThanOrEqual(1);

    const entities = await db.selectFrom("entities").selectAll().execute();
    const names = entities.map((e) => e.name).sort();
    expect(names).toContain("Saurabh CanvasX");
    expect(names).toContain("Hari Kalra");
    expect(names).not.toContain("Engineering Space");

    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(review).toMatchObject({
      proposed_name: "Engineering Space",
      entity_type: "project",
      seed_source: "clickup",
      seed_source_id: "space-eng",
      status: "pending",
    });

    const mentions = await db.selectFrom("entity_mentions").selectAll().execute();
    const attendedMention = mentions.find((m) => m.relation === "attended");
    expect(attendedMention).toBeDefined();
    expect(attendedMention?.confidence).toBe("EXTRACTED");
    expect(attendedMention?.indexed_file_id).toBe(ATTENDED_FILE_ID);

    const assignedMention = mentions.find((m) => m.relation === "assigned");
    expect(assignedMention?.confidence).toBe("EXTRACTED");

    const mentionedMention = mentions.find((m) => m.relation === "mentioned");
    expect(mentionedMention).toBeUndefined();

    const sourceRefs = await db.selectFrom("entity_source_refs").selectAll().execute();
    const refKeys = sourceRefs.map((r) => `${r.source}:${r.source_id}`);
    expect(refKeys).not.toContain("clickup:space-eng");
    expect(refKeys).toContain("fireflies:meeting-1:saurabh@canvasx.ai");
  });

  it("is idempotent — running twice writes zero new rows on the second pass", async () => {
    await replaySourceFacts(db, createTestLogger());

    const snapshot = async () => ({
      entities: (await db.selectFrom("entities").selectAll().execute()).length,
      mentions: (await db.selectFrom("entity_mentions").selectAll().execute()).length,
      refs: (await db.selectFrom("entity_source_refs").selectAll().execute()).length,
      candidates: (await db.selectFrom("entity_candidates").selectAll().execute()).length,
      queue: (await db.selectFrom("entity_review_queue").selectAll().execute()).length,
      evidence: (await db.selectFrom("entity_review_evidence").selectAll().execute()).length,
    });

    const before = await snapshot();
    await replaySourceFacts(db, createTestLogger());
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

    const summary = await replaySourceFacts(db, createTestLogger());

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

    const summary = await replaySourceFacts(db, createTestLogger());

    expect(summary.queued).toBe(1);
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("relation", "=", "assigned").execute(),
    ).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(1);
  });

  it("runs a follow-up materialization pass for concurrent callers", async () => {
    await db.deleteFrom("indexed_file_facts").execute();
    const repo = createIndexedFileFactRepository(db);
    /**
     * The first pass only needs a non-empty batch to materialize; the assertion
     * is that a late fact inserted afterward gets picked up by a follow-up pass.
     * A small batch keeps this CPU-bound test well under the unit tier's default
     * 5s timeout, which a 1000-fact batch tipped over under full-suite contention.
     */
    for (let i = 0; i < 25; i++) {
      await repo.upsertFact({
        createdByUserId: TEST_USER_ID,
        source: "manual",
        factType: "person_seed",
        relation: "seeded",
        subjectName: `Queued Person ${i}`,
        subjectEmail: `queued-${i}@example.com`,
        subjectSource: "manual",
        subjectSourceId: `queued-${i}`,
        raw: { subtype: "external" },
      });
    }

    const first = materializeUnmaterializedFacts(db, createTestLogger());
    await first;

    await repo.upsertFact({
      createdByUserId: TEST_USER_ID,
      source: "manual",
      factType: "person_seed",
      relation: "seeded",
      subjectName: "Late Person",
      subjectEmail: "late@example.com",
      subjectSource: "manual",
      subjectSourceId: "late",
      raw: { subtype: "external" },
    });
    const second = materializeUnmaterializedFacts(db, createTestLogger());

    const followUp = await second;

    expect(followUp.factsRead).toBeGreaterThanOrEqual(1);
    const late = await db
      .selectFrom("indexed_file_facts")
      .select("materialized_at")
      .where("subject_source_id", "=", "late")
      .executeTakeFirstOrThrow();
    expect(late.materialized_at).not.toBeNull();
  });
});

describe("batch-scoped materialization", () => {
  let db: Kysely<DB>;

  async function seedBase(target: Kysely<DB>): Promise<void> {
    const now = new Date().toISOString();
    await target
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
    await target
      .insertInto("connector_configs")
      .values({
        id: CONNECTOR_ID,
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: TEST_USER_ID,
      })
      .execute();
    await target
      .insertInto("indexed_files")
      .values({
        id: ATTENDED_FILE_ID,
        connector_config_id: CONNECTOR_ID,
        provider_file_id: "meeting-1",
        file_name: "Q4 Kickoff",
        file_type: "transcript",
        content_category: "document",
        content: "Discussion.",
        source: "fireflies",
        content_hash: "hash-1",
        is_archived: 0,
        synced_at: now,
      })
      .execute();
  }

  async function seedPersonSeeds(target: Kysely<DB>, count: number): Promise<void> {
    const repo = createIndexedFileFactRepository(target);
    for (let i = 0; i < count; i++) {
      await repo.upsertFact({
        createdByUserId: TEST_USER_ID,
        source: "manual",
        factType: "person_seed",
        relation: "seeded",
        subjectName: `Person ${i}`,
        subjectEmail: `person-${i}@example.com`,
        subjectSource: "manual",
        subjectSourceId: `person-${i}`,
        raw: { subtype: "external" },
      });
    }
  }

  const snapshot = async (target: Kysely<DB>) => ({
    entities: (await target.selectFrom("entities").select(["name"]).orderBy("name").execute()).map((e) => e.name),
    mentions: (await target.selectFrom("entity_mentions").select("id").execute()).length,
    sourceRefs: (await target.selectFrom("entity_source_refs").select("id").execute()).length,
  });

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("materializes a backlog larger than one batch with the same end-state as a single pass", async () => {
    await seedPersonSeeds(db, 5);
    const single = await createTestDb();
    await seedBase(single);
    await seedPersonSeeds(single, 5);

    try {
      const batched = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 2 });
      const onePass = await materializeUnmaterializedFacts(single, createTestLogger(), { batchSize: 1000 });

      expect(batched.factsRead).toBe(5);
      expect(batched.materialized).toBe(5);
      expect(batched).toEqual(onePass);
      expect(await snapshot(db)).toEqual(await snapshot(single));

      const unmaterialized = await db
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("materialized_at", "is", null)
        .execute();
      expect(unmaterialized).toHaveLength(0);
    } finally {
      await single.destroy();
    }
  });

  it("preserves cross-fact dedup when two facts about one entity land in different batches", async () => {
    const repo = createIndexedFileFactRepository(db);
    for (const sourceId of ["seat-a", "seat-b"]) {
      await repo.upsertFact({
        createdByUserId: TEST_USER_ID,
        source: "manual",
        factType: "person_seed",
        relation: "seeded",
        subjectName: "Repeat Person",
        subjectEmail: "repeat@example.com",
        subjectSource: "manual",
        subjectSourceId: sourceId,
        raw: { subtype: "external" },
      });
    }

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 1 });

    expect(summary.factsRead).toBe(2);
    const people = await db
      .selectFrom("entities")
      .select(["id"])
      .where("source_type", "=", "person")
      .where("name", "=", "Repeat Person")
      .execute();
    expect(people).toHaveLength(1);
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

  it("runs the full reset → fact materialization → sweep chain idempotently", async () => {
    const first = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 2,
    });

    expect(first.replay.factsRead).toBe(5);

    // Snapshot the mention tuples (entity name, file id, relation, source)
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

  it("reseeds team directory entities during recreate", async () => {
    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      skipEnrichment: true,
    });

    const entity = await db.selectFrom("entities").selectAll().where("name", "=", "Admin").executeTakeFirstOrThrow();
    expect(entity.source_type).toBe("person");
    expect(entity.subtype).toBe("internal");

    const sourceRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", entity.id)
      .where("source", "=", "team")
      .where("source_id", "=", TEST_USER_ID)
      .executeTakeFirst();
    expect(sourceRef).toBeTruthy();
  });

  it("round-trips author facts through recreate", async () => {
    const now = new Date().toISOString();
    const configs = [
      { id: "connector-clickup-author", connectorType: "clickup", source: "clickup" },
      { id: "connector-notion-author", connectorType: "notion", source: "notion" },
      { id: "connector-gdrive-author", connectorType: "google_drive", source: "google_drive" },
    ];
    await db
      .insertInto("connector_configs")
      .values(
        configs.map((config) => ({
          id: config.id,
          connector_type: config.connectorType,
          auth_type: config.connectorType === "google_drive" ? "oauth" : "api_key",
          credentials: "{}",
          created_by: TEST_USER_ID,
        })),
      )
      .execute();

    const factRepo = createIndexedFileFactRepository(db);
    for (const config of configs) {
      const fileId = `file-${config.source}-author`;
      const providerFileId = `provider-${config.source}-author`;
      const author = {
        name: `${config.source} Author`,
        email: `${config.source.replace("_", "-")}@example.com`,
        sourceId: `user:${config.source}`,
      };
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: config.id,
          provider_file_id: providerFileId,
          file_name: `${config.source} authored file`,
          file_type: "document",
          content_category: "document",
          content: "content",
          source: config.source,
          content_hash: `hash-${config.source}`,
          is_archived: 0,
          synced_at: now,
        })
        .execute();
      await factRepo.upsertFact({
        indexedFileId: fileId,
        connectorConfigId: config.id,
        createdByUserId: TEST_USER_ID,
        source: config.source,
        factType: "author",
        relation: "authored",
        subjectName: author.name,
        subjectEmail: author.email,
        subjectSource: config.source,
        subjectSourceId: author.sourceId,
        contextSnippet: `Authored ${providerFileId}`,
        raw: { providerFileId, author },
      });
    }

    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 2,
    });

    const authored = await db
      .selectFrom("entity_mentions")
      .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
      .select([
        "entities.name as name",
        "entity_mentions.confidence as confidence",
        "entity_mentions.source as source",
        "entity_mentions.relation as relation",
      ])
      .where("entity_mentions.relation", "=", "authored")
      .orderBy("entity_mentions.source", "asc")
      .execute();

    expect(authored).toEqual([
      { name: "clickup Author", confidence: "EXTRACTED", source: "clickup_author", relation: "authored" },
      { name: "google_drive Author", confidence: "EXTRACTED", source: "google_drive_author", relation: "authored" },
      { name: "notion Author", confidence: "EXTRACTED", source: "notion_author", relation: "authored" },
    ]);
  });

  it("rebuilds typed LLM relationships from facts during recreate", async () => {
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: ATTENDED_FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: "hash-1",
      source: "llm_extraction",
      factType: "llm_relation",
      relation: "leads",
      subjectName: "Sarah Chen",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash-1:llm-extraction-v2:leads:Sarah Chen:Atlas",
      contextSnippet: "Sarah Chen leads Atlas.",
      raw: {
        contentHash: "hash-1",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        relationType: "leads",
        confidence: 0.92,
        sourceConfidence: 0.9,
        targetConfidence: 0.9,
        context: "Sarah Chen leads Atlas.",
        source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
        target: { name: "Atlas", type: "product", variations: [] },
      },
    });

    const first = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      skipEnrichment: true,
    });
    const second = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      skipEnrichment: true,
    });

    expect(first.replay.factsRead).toBe(6);
    expect(second.replay.factsRead).toBe(6);
    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["entity_relationships.relationship_type", "source.name as source_name", "target.name as target_name"])
      .execute();
    expect(relationships).toContainEqual({
      relationship_type: "leads",
      source_name: "Sarah Chen",
      target_name: "Atlas",
    });
  });

  it("does not run provider download enrichment during recreate", async () => {
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
        embedding_status: "pending",
      })
      .execute();

    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: TEST_USER_ID,
      maxIterations: 1,
      skipLlm: true,
    });

    const image = await db
      .selectFrom("indexed_files")
      .selectAll()
      .where("id", "=", "image-1")
      .executeTakeFirstOrThrow();
    expect(image.embedding_status).toBe("pending");
  });

  it("skipLlm remains accepted and does not mutate file enrichment statuses", async () => {
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
      expect(f.embedding_status).toBe("pending");
    }
  });
});

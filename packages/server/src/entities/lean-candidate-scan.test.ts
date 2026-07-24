import { CompiledQuery, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize";
import { buildOpenFactCandidateQuery } from "./materialize-replay";

const TEST_USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";
const FILE_ID = "file-1";

async function seedBase(db: Kysely<DB>): Promise<void> {
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
      id: FILE_ID,
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

async function seedPersonSeeds(db: Kysely<DB>, count: number): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
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

const graphSnapshot = async (db: Kysely<DB>) => ({
  entities: (await db.selectFrom("entities").select(["name"]).orderBy("name").execute()).map((e) => e.name),
  mentions: (await db.selectFrom("entity_mentions").select("id").execute()).length,
  sourceRefs: (await db.selectFrom("entity_source_refs").select("id").execute()).length,
});

const PARENT_SOURCE = "manual";
const PARENT_SOURCE_ID = "person-parent";
const DECISION_TOPIC = "Launch timing";
const DECISION_STATEMENT = "Ship in Q1";

/**
 * Seed a person parent plus `count` decision facts that all share one topic and
 * one statement (so one value signature) but carry ascending `decidedAt` times.
 * `decidedAt` and `created_at` rise together, so the correct chronological sweep
 * order is oldest-first — the only order under which `supersedeSubEntity` folds a
 * same-signature observation into its predecessor instead of splitting it into a
 * duplicate versioned row. Fact ids are random, so an id-only page order would
 * process them out of decided-time order and expose duplicates.
 */
async function seedDecisionSupersessionChain(db: Kysely<DB>, count: number): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    createdByUserId: TEST_USER_ID,
    source: PARENT_SOURCE,
    factType: "person_seed",
    relation: "seeded",
    subjectName: "Parent Person",
    subjectEmail: "parent@example.com",
    subjectSource: PARENT_SOURCE,
    subjectSourceId: PARENT_SOURCE_ID,
    raw: { subtype: "internal" },
  });

  for (let i = 0; i < count; i++) {
    await repo.upsertFact({
      indexedFileId: FILE_ID,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: TEST_USER_ID,
      contentHash: `decision-${i}`,
      source: "llm",
      factType: "decision",
      relation: "mentioned",
      subjectName: DECISION_TOPIC,
      subjectSource: "llm",
      subjectSourceId: `decision-${i}`,
      raw: {
        decisionId: `decision-${i}`,
        parentRef: { source: PARENT_SOURCE, sourceId: PARENT_SOURCE_ID },
        topic: DECISION_TOPIC,
        statement: DECISION_STATEMENT,
        decidedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
        evidence: { fileIds: [], entityIds: [] },
      },
    });
  }

  const decisions = await db
    .selectFrom("indexed_file_facts")
    .select(["id", "subject_source_id"])
    .where("fact_type", "=", "decision")
    .execute();
  for (const decision of decisions) {
    const i = Number(decision.subject_source_id?.split("-")[1] ?? 0);
    await db
      .updateTable("indexed_file_facts")
      .set({ created_at: `2026-07-14T00:00:0${i}.000Z` })
      .where("id", "=", decision.id)
      .execute();
  }
}

const decisionSubEntitySnapshot = async (db: Kysely<DB>) => {
  const rows = await db
    .selectFrom("sub_entities")
    .select(["normalized_name", "display_name", "status", "valid_from", "valid_to", "value_signature"])
    .where("kind", "=", "decision")
    .orderBy("valid_from", "asc")
    .execute();
  return rows;
};

describe("lean candidate scan", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("produces the same graph as a single pass when the backlog is an exact multiple of the batch size with created_at ties", async () => {
    await seedPersonSeeds(db, 6);
    // Force created_at ties so the keyset cursor must break ties on id across a
    // page boundary (pages of 2 over a 6-row corpus of 3 tied pairs).
    const rows = await db.selectFrom("indexed_file_facts").select("id").orderBy("id").execute();
    for (let i = 0; i < rows.length; i++) {
      await db
        .updateTable("indexed_file_facts")
        .set({ created_at: `2026-07-14T00:00:0${Math.floor(i / 2)}.000Z` })
        .where("id", "=", rows[i].id)
        .execute();
    }

    const single = await createTestDb();
    await seedBase(single);
    await seedPersonSeeds(single, 6);
    const singleRows = await single.selectFrom("indexed_file_facts").select("id").orderBy("id").execute();
    for (let i = 0; i < singleRows.length; i++) {
      await single
        .updateTable("indexed_file_facts")
        .set({ created_at: `2026-07-14T00:00:0${Math.floor(i / 2)}.000Z` })
        .where("id", "=", singleRows[i].id)
        .execute();
    }

    try {
      const batched = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 2 });
      const onePass = await materializeUnmaterializedFacts(single, createTestLogger(), { batchSize: 1000 });

      expect(batched.factsRead).toBe(6);
      expect(batched.materialized).toBe(6);
      expect(batched).toEqual(onePass);
      expect(await graphSnapshot(db)).toEqual(await graphSnapshot(single));

      const open = await db
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("materialized_at", "is", null)
        .execute();
      expect(open).toHaveLength(0);
    } finally {
      await single.destroy();
    }
  });

  it("collapses a cross-page decision supersession chain identically to a single pass", async () => {
    await seedDecisionSupersessionChain(db, 4);
    const single = await createTestDb();
    await seedBase(single);
    await seedDecisionSupersessionChain(single, 4);

    try {
      const batched = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 1 });
      const onePass = await materializeUnmaterializedFacts(single, createTestLogger(), { batchSize: 1000 });

      expect(batched).toEqual(onePass);
      const batchedDecisions = await decisionSubEntitySnapshot(db);
      const singleDecisions = await decisionSubEntitySnapshot(single);

      // Oldest-first folds all four same-valued observations into one current row.
      expect(batchedDecisions).toEqual(singleDecisions);
      expect(batchedDecisions).toHaveLength(1);
      expect(batchedDecisions[0]).toMatchObject({
        normalized_name: "launch timing",
        display_name: DECISION_STATEMENT,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: null,
      });
    } finally {
      await single.destroy();
    }
  });

  it("never fetches quarantined or deleted facts in the payload phase", async () => {
    await seedPersonSeeds(db, 2);
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      createdByUserId: TEST_USER_ID,
      source: "manual",
      factType: "person_seed",
      relation: "seeded",
      subjectName: "Quarantined Person",
      subjectEmail: "quarantined@example.com",
      subjectSource: "manual",
      subjectSourceId: "quarantined",
      raw: { subtype: "external" },
    });
    await db
      .updateTable("indexed_file_facts")
      .set({ materialization_attempts: 5 })
      .where("subject_source_id", "=", "quarantined")
      .execute();

    await repo.upsertFact({
      createdByUserId: TEST_USER_ID,
      source: "manual",
      factType: "person_seed",
      relation: "seeded",
      subjectName: "Deleted Person",
      subjectEmail: "deleted@example.com",
      subjectSource: "manual",
      subjectSourceId: "deleted",
      raw: { subtype: "external" },
    });
    await db
      .updateTable("indexed_file_facts")
      .set({ deleted_at: new Date().toISOString() })
      .where("subject_source_id", "=", "deleted")
      .execute();

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 1 });

    // Only the two open facts are processed; quarantined/deleted are never read.
    expect(summary.factsRead).toBe(2);
    const names = (await db.selectFrom("entities").select("name").execute()).map((e) => e.name).sort();
    expect(names).not.toContain("Quarantined Person");
    expect(names).not.toContain("Deleted Person");

    const stillClosed = await db
      .selectFrom("indexed_file_facts")
      .select(["subject_source_id", "materialized_at"])
      .where("subject_source_id", "in", ["quarantined", "deleted"])
      .execute();
    for (const row of stillClosed) expect(row.materialized_at).toBeNull();
  });

  it("plans the candidate scan through the open-materializable partial index (SQLite)", async () => {
    await seedPersonSeeds(db, 40);

    const compiled = buildOpenFactCandidateQuery(db, { createdAt: "", id: "" }, 250, {
      factType: "person_seed",
    }).compile();
    const plan = await db.executeQuery<{ detail: string }>(
      CompiledQuery.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.parameters]),
    );
    const detail = plan.rows.map((r) => r.detail).join(" | ");

    expect(detail).toContain("idx_indexed_file_facts_open_materializable");
    expect(detail).not.toMatch(/scan indexed_file_facts\b/i);
  });
});

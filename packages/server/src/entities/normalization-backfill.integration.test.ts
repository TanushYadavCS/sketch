import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { IndexedFileFactRaw } from "../connectors/types";
import {
  type UpsertIndexedFileFactInput,
  createIndexedFileFactRepository,
} from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { readJsonObject } from "./materialize-json";
import { runNormalizationBackfill } from "./normalization-backfill";
import { projectLlmExtractedNormalization } from "./normalization-projection";

async function seedFile(db: Kysely<DB>, id: string, sourceUpdatedAt: string | null = null): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: `user-${id}`,
      name: id,
      email: `${id}@example.com`,
      email_verified_at: "2026-01-01T00:00:00.000Z",
      password_hash: "x",
      auth_role: "member",
    } as never)
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: `cfg-${id}`,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: `user-${id}`,
    } as never)
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: `cfg-${id}`,
      provider_file_id: id,
      file_name: id,
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: "2026-01-01T00:00:00.000Z",
      source_created_at: "2026-01-01T00:00:00.000Z",
      source_updated_at: sourceUpdatedAt,
    } as never)
    .execute();
}

function projectFeatureCorroborationKey(source: string, raw: Record<string, unknown>): string | null {
  if (source !== "llm_extraction" && source !== "llm") return null;
  const key = raw.corroborationKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Snapshots the write-path `materialization_input_hash` per fact id before the columns are cleared. */
async function captureWritePathHashes(db: Kysely<DB>): Promise<Map<string, string | null>> {
  const rows = await db.selectFrom("indexed_file_facts").select(["id", "materialization_input_hash"]).execute();
  return new Map(rows.map((row) => [row.id, row.materialization_input_hash]));
}

function llmFact(fileId: string, subject: string, raw: Record<string, unknown>): UpsertIndexedFileFactInput {
  const contentHash = `${fileId}:${subject}`;
  return {
    indexedFileId: fileId,
    connectorConfigId: `cfg-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: subject,
    contentHash,
    raw: { contentHash, promptVersion: "v1", ...raw } as IndexedFileFactRaw,
  };
}

function featureFact(fileId: string, key: string): UpsertIndexedFileFactInput {
  return {
    indexedFileId: fileId,
    connectorConfigId: `cfg-${fileId}`,
    source: "llm_extraction",
    factType: "feature",
    relation: "builds",
    subjectName: "Insights Dashboard",
    raw: {
      featureId: `${fileId}-feat`,
      featureName: "Insights Dashboard",
      status: "proposed",
      corroborationKey: key,
      parentProductName: "Atlas",
      evidence: { fileIds: [fileId], entityIds: [] },
    } as never,
  };
}

const FIXTURES: Array<{ input: UpsertIndexedFileFactInput }> = [
  { input: llmFact("f1", "Acme", { type: "company" }) },
  { input: llmFact("f2", "Slack", { type: "company" }) },
  { input: llmFact("f3", "iPhone13-Pro", { type: "product", mention: "iPhone 13 Pro" }) },
  { input: llmFact("f4", "Nameless", {}) },
  { input: featureFact("f5", "prod:atlas|feat:insights") },
  { input: featureFact("f6", "prod:atlas|feat:insights") },
];

async function seedLegacyRows(db: Kysely<DB>): Promise<Map<string, string | null>> {
  const repo = createIndexedFileFactRepository(db);
  for (let i = 0; i < FIXTURES.length; i += 1) await seedFile(db, `f${i + 1}`);
  for (const { input } of FIXTURES) await repo.upsertFact(input);
  const writePathHashes = await captureWritePathHashes(db);
  // Simulate rows written before migration 143: clear the projections and the hash.
  await db
    .updateTable("indexed_file_facts")
    .set({
      normalized_subject_name: null,
      normalized_mention_name: null,
      raw_mention_type: null,
      mention_type: null,
      feature_corroboration_key: null,
      materialization_input_hash: null,
      normalization_projected_at: null,
    })
    .execute();
  await db
    .updateTable("normalization_backfill_state")
    .set({ status: "pending", cursor_created_at: null, cursor_id: null })
    .where("id", "=", "v1")
    .execute();
  return writePathHashes;
}

async function expectedFor(row: {
  fact_type: string;
  source: string;
  subject_name: string | null;
  raw: string | null;
}): Promise<{ [k: string]: string | null }> {
  if (row.fact_type === "llm_extracted") {
    const p = projectLlmExtractedNormalization(row.subject_name, readJsonObject(row.raw));
    return { ...p, feature_corroboration_key: null };
  }
  if (row.fact_type === "feature") {
    return {
      raw_mention_type: null,
      normalized_subject_name: null,
      normalized_mention_name: null,
      mention_type: null,
      feature_corroboration_key: projectFeatureCorroborationKey(row.source, readJsonObject(row.raw)),
    };
  }
  return {
    raw_mention_type: null,
    normalized_subject_name: null,
    normalized_mention_name: null,
    mention_type: null,
    feature_corroboration_key: null,
  };
}

async function assertAllProjectionsMatchWritePath(
  db: Kysely<DB>,
  writePathHashes: Map<string, string | null>,
): Promise<void> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select([
      "id",
      "fact_type",
      "source",
      "subject_name",
      "raw",
      "normalized_subject_name",
      "normalized_mention_name",
      "raw_mention_type",
      "mention_type",
      "feature_corroboration_key",
      "materialization_input_hash",
    ])
    .execute();
  for (const row of rows) {
    const expected = await expectedFor(row);
    expect(row.raw_mention_type, `${row.id} raw_mention_type`).toBe(expected.raw_mention_type);
    expect(row.normalized_subject_name, `${row.id} normalized_subject_name`).toBe(expected.normalized_subject_name);
    expect(row.normalized_mention_name, `${row.id} normalized_mention_name`).toBe(expected.normalized_mention_name);
    expect(row.mention_type, `${row.id} mention_type`).toBe(expected.mention_type);
    expect(row.feature_corroboration_key, `${row.id} feature_corroboration_key`).toBe(
      expected.feature_corroboration_key,
    );
    // The backfilled hash must exactly reproduce the write-path hash so an
    // unchanged re-emission preserves the verdict instead of reopening it.
    expect(row.materialization_input_hash, `${row.id} materialization_input_hash`).toBe(writePathHashes.get(row.id));
  }
}

function runSuite(name: string, makeDb: () => Promise<Kysely<DB>>): void {
  describe(name, () => {
    let db: Kysely<DB>;

    afterEach(async () => {
      if (db) await db.destroy();
    });

    it("resumes from a persisted cursor after a mid-run stop and converges", async () => {
      db = await makeDb();
      const writePathHashes = await seedLegacyRows(db);

      let loops = 0;
      await runNormalizationBackfill(db, {
        batchSize: 2,
        shouldStop: () => {
          loops += 1;
          return loops > 1;
        },
      });

      const paused = await db
        .selectFrom("normalization_backfill_state")
        .selectAll()
        .where("id", "=", "v1")
        .executeTakeFirstOrThrow();
      expect(paused.status).toBe("pending");
      expect(paused.cursor_id).not.toBeNull();
      const populatedMidway = await db
        .selectFrom("indexed_file_facts")
        .select((eb) => eb.fn.countAll<number>().as("c"))
        .where((eb) => eb.or([eb("raw_mention_type", "is not", null), eb("feature_corroboration_key", "is not", null)]))
        .executeTakeFirstOrThrow();
      expect(Number(populatedMidway.c)).toBeGreaterThan(0);
      expect(Number(populatedMidway.c)).toBeLessThan(FIXTURES.length);

      // Resume to completion.
      await runNormalizationBackfill(db, { batchSize: 2 });
      const done = await db
        .selectFrom("normalization_backfill_state")
        .selectAll()
        .where("id", "=", "v1")
        .executeTakeFirstOrThrow();
      expect(done.status).toBe("complete");
      await assertAllProjectionsMatchWritePath(db, writePathHashes);
    });

    it("is idempotent: replaying a completed backfill changes nothing", async () => {
      db = await makeDb();
      const writePathHashes = await seedLegacyRows(db);
      await runNormalizationBackfill(db, { batchSize: 3 });
      await assertAllProjectionsMatchWritePath(db, writePathHashes);

      // Force a full replay over already-populated rows and assert convergence.
      await db
        .updateTable("normalization_backfill_state")
        .set({ status: "pending", cursor_created_at: null, cursor_id: null })
        .where("id", "=", "v1")
        .execute();
      await runNormalizationBackfill(db, { batchSize: 3 });
      const state = await db
        .selectFrom("normalization_backfill_state")
        .select("status")
        .where("id", "=", "v1")
        .executeTakeFirstOrThrow();
      expect(state.status).toBe("complete");
      await assertAllProjectionsMatchWritePath(db, writePathHashes);

      // A no-op replay on a completed marker returns immediately without error.
      await runNormalizationBackfill(db);
      const stillComplete = await db
        .selectFrom("normalization_backfill_state")
        .select("status")
        .where("id", "=", "v1")
        .executeTakeFirstOrThrow();
      expect(stillComplete.status).toBe("complete");
    });

    it("reproduces the write-path hash for decision/milestone facts so a re-sync preserves the verdict", async () => {
      db = await makeDb();
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "df", "2026-02-01T00:00:00.000Z");

      const decision: UpsertIndexedFileFactInput = {
        indexedFileId: "df",
        connectorConfigId: "cfg-df",
        source: "linear",
        factType: "decision",
        relation: "mentioned",
        subjectName: "Adopt Kysely",
        raw: {
          decisionId: "dec-1",
          topic: "orm",
          statement: "Adopt Kysely",
          evidence: { fileIds: ["df"], entityIds: [] },
        } as IndexedFileFactRaw,
      };
      const milestone: UpsertIndexedFileFactInput = {
        indexedFileId: "df",
        connectorConfigId: "cfg-df",
        source: "linear",
        factType: "milestone",
        relation: "mentioned",
        subjectName: "GA launch",
        raw: {
          milestoneId: "ms-1",
          milestoneName: "GA launch",
          status: "planned",
          dueAt: "2026-06-01T00:00:00.000Z",
          evidence: { fileIds: ["df"], entityIds: [] },
        } as IndexedFileFactRaw,
      };
      await repo.upsertFact(decision);
      await repo.upsertFact(milestone);
      const writePathHashes = await captureWritePathHashes(db);

      // Simulate pre-2b rows: clear the hash and mark the verdicts complete.
      await db
        .updateTable("indexed_file_facts")
        .set({ materialization_input_hash: null, materialized_at: "2026-02-05T00:00:00.000Z" })
        .execute();
      await db
        .updateTable("normalization_backfill_state")
        .set({ status: "pending", cursor_created_at: null, cursor_id: null })
        .where("id", "=", "v1")
        .execute();

      await runNormalizationBackfill(db, { batchSize: 5 });

      const backfilled = await db
        .selectFrom("indexed_file_facts")
        .select(["id", "fact_type", "materialization_input_hash"])
        .execute();
      for (const row of backfilled) {
        expect(row.materialization_input_hash, `${row.fact_type} backfilled hash`).toBe(writePathHashes.get(row.id));
      }

      // With the hash aligned, the next unchanged re-emission preserves the verdict.
      await repo.upsertFact(decision);
      await repo.upsertFact(milestone);
      const verdicts = await db.selectFrom("indexed_file_facts").select(["fact_type", "materialized_at"]).execute();
      for (const row of verdicts) {
        expect(row.materialized_at, `${row.fact_type} verdict preserved`).toBe("2026-02-05T00:00:00.000Z");
      }
    });

    it("catches up CAS-skipped rows of any fact type — projections and hash — before completing", async () => {
      db = await makeDb();
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "cf", "2026-02-01T00:00:00.000Z");
      await repo.upsertFact(llmFact("cf", "Acme", { type: "company" }));
      // A non-projected fact type: its projections stay NULL, but its hash must
      // still be populated by completion or its reopen is un-absorbed.
      const decision: UpsertIndexedFileFactInput = {
        indexedFileId: "cf",
        connectorConfigId: "cfg-cf",
        source: "linear",
        factType: "decision",
        relation: "mentioned",
        subjectName: "Adopt Kysely",
        raw: {
          decisionId: "dec-1",
          topic: "orm",
          statement: "Adopt Kysely",
          evidence: { fileIds: ["cf"], entityIds: [] },
        } as IndexedFileFactRaw,
      };
      await repo.upsertFact(decision);
      const writePathHashes = await captureWritePathHashes(db);

      // Simulate the production race: a non-projecting updated_at bump failed the
      // keyset pass CAS for BOTH rows, so they are unprocessed while the durable
      // cursor has already advanced past everything.
      await db
        .updateTable("indexed_file_facts")
        .set({
          normalized_subject_name: null,
          normalized_mention_name: null,
          raw_mention_type: null,
          mention_type: null,
          feature_corroboration_key: null,
          materialization_input_hash: null,
          normalization_projected_at: null,
        })
        .execute();
      await db
        .updateTable("normalization_backfill_state")
        .set({ status: "pending", cursor_created_at: "9999-12-31T00:00:00.000Z", cursor_id: "zzzz" })
        .where("id", "=", "v1")
        .execute();

      await runNormalizationBackfill(db, { batchSize: 5 });

      const rows = await db
        .selectFrom("indexed_file_facts")
        .select([
          "id",
          "fact_type",
          "raw_mention_type",
          "normalized_subject_name",
          "materialization_input_hash",
          "normalization_projected_at",
        ])
        .execute();
      for (const row of rows) {
        expect(row.materialization_input_hash, `${row.fact_type} hash`).toBe(writePathHashes.get(row.id));
        expect(row.normalization_projected_at, `${row.fact_type} marker`).not.toBeNull();
      }
      const llm = rows.find((r) => r.fact_type === "llm_extracted");
      expect(llm?.raw_mention_type).toBe("company");
      expect(llm?.normalized_subject_name).toBe("acme");
      const decisionRow = rows.find((r) => r.fact_type === "decision");
      expect(decisionRow?.materialization_input_hash).not.toBeNull();
      expect(decisionRow?.raw_mention_type).toBeNull();

      const state = await db
        .selectFrom("normalization_backfill_state")
        .select("status")
        .where("id", "=", "v1")
        .executeTakeFirstOrThrow();
      expect(state.status).toBe("complete");
    });
  });
}

runSuite("normalization backfill (sqlite)", async () => {
  const { createTestDb } = await import("../test-utils");
  return createTestDb();
});
runSuite("normalization backfill (pglite)", async () => {
  const { createTestPgDb } = await import("../test-utils");
  return createTestPgDb();
});

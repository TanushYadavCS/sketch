import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { performReset } from "../../api/entities/reset-service";
import { materializeUnmaterializedFacts } from "../../entities/materialize";
import { createTestDb, createTestLogger, getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import {
  type UpsertIndexedFileFactInput,
  buildIndexedFileFactKey,
  createIndexedFileFactRepository,
} from "./indexed-file-facts";

const FINISHED_AT = "2026-07-14T00:00:00.000Z";

function personSeedInput(prefix: string): UpsertIndexedFileFactInput {
  return {
    createdByUserId: `${prefix}-owner`,
    lastSeenSyncRunId: `${prefix}-sync-1`,
    contentHash: `${prefix}-content-1`,
    source: "linear",
    factType: "person_seed",
    relation: "seeded",
    subjectName: "  Verdict Person  ",
    subjectEmail: " VERDICT@example.com ",
    subjectSource: "linear",
    subjectSourceId: `${prefix}-person-1`,
    contextSnippet: "Initial context",
    raw: { source: "linear", subtype: "external" },
  };
}

function legacyFactKey(input: UpsertIndexedFileFactInput): string {
  return createHash("sha256")
    .update(
      [
        input.source,
        input.factType,
        input.relation,
        input.indexedFileId ?? "",
        input.subjectSourceId ?? "",
        (input.subjectEmail ?? "").trim().toLowerCase(),
        (input.subjectName ?? "").trim().toLowerCase().replace(/\s+/g, " "),
      ].join("|"),
    )
    .digest("hex");
}

function runVerdictSafeUpsertSuite(
  name: string,
  prefix: string,
  createDb: () => Promise<Kysely<DB>>,
  shared: boolean,
): void {
  describe(name, () => {
    let db: Kysely<DB>;

    beforeAll(async () => {
      if (shared) db = await createDb();
    }, 30000);

    beforeEach(async () => {
      if (shared) {
        await sql`BEGIN`.execute(db);
      } else {
        db = await createDb();
      }
    });

    afterEach(async () => {
      if (shared) {
        await sql`ROLLBACK`.execute(db);
      } else {
        await db.destroy();
      }
    });

    it("preserves a finished verdict and attempts across unchanged sync re-emission", async () => {
      const repo = createIndexedFileFactRepository(db);
      const firstInput = personSeedInput(prefix);
      await repo.upsertFact(firstInput);
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 3, updated_at: "2000-01-01T00:00:00.000Z" })
        .execute();
      const before = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

      await repo.upsertFact({
        ...firstInput,
        lastSeenSyncRunId: `${prefix}-sync-2`,
        raw: { subtype: "external", source: "linear" },
      });

      const after = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(after).toMatchObject({
        id: before.id,
        materialization_input_hash: before.materialization_input_hash,
        materialized_at: FINISHED_AT,
        materialization_attempts: 3,
      });
      expect(after.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    });

    it("atomically reopens a finished fact and clears attempts when content changes", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input = personSeedInput(prefix);
      await repo.upsertFact(input);
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 4 })
        .execute();
      const before = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

      await repo.upsertFact({ ...input, contentHash: `${prefix}-content-2` });

      const after = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(after.materialization_input_hash).not.toBe(before.materialization_input_hash);
      expect(after.materialized_at).toBeNull();
      expect(after.materialization_attempts).toBe(0);
    });

    it("applies the same preserve and reopen rule through the legacy fact-key path", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input = personSeedInput(prefix);
      const oldKey = legacyFactKey(input);
      const currentKey = buildIndexedFileFactKey(input);
      await repo.upsertFact(input);
      const seeded = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      await db
        .updateTable("indexed_file_facts")
        .set({ fact_key: oldKey, materialized_at: FINISHED_AT, materialization_attempts: 5 })
        .execute();

      await repo.upsertFact(input);
      const preserved = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(preserved).toMatchObject({
        id: seeded.id,
        fact_key: currentKey,
        materialized_at: FINISHED_AT,
        materialization_attempts: 5,
      });

      await db.updateTable("indexed_file_facts").set({ fact_key: oldKey }).execute();
      await repo.upsertFact({ ...input, raw: { source: "linear", subtype: "internal" } });
      const reopened = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(reopened).toMatchObject({
        id: seeded.id,
        fact_key: currentKey,
        materialized_at: null,
        materialization_attempts: 0,
      });
      expect(reopened.materialization_input_hash).not.toBe(preserved.materialization_input_hash);
    });

    it("handles NULL content hashes and raw payloads without losing verdict safety", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input: UpsertIndexedFileFactInput = {
        source: "manual",
        factType: "person_seed",
        relation: "seeded",
        subjectName: "Null Payload Person",
        subjectSource: "manual",
        subjectSourceId: `${prefix}-null-person`,
        contentHash: null,
      };
      await repo.upsertFact(input);
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 2 })
        .execute();
      const before = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(before.raw).toBeNull();
      expect(before.content_hash).toBeNull();

      await repo.upsertFact(input);
      const unchanged = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(unchanged).toMatchObject({
        materialization_input_hash: before.materialization_input_hash,
        materialized_at: FINISHED_AT,
        materialization_attempts: 2,
      });

      await repo.upsertFact({ ...input, raw: { subtype: "external" } });
      const rawChanged = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(rawChanged.materialization_input_hash).not.toBe(before.materialization_input_hash);
      expect(rawChanged.materialized_at).toBeNull();
      expect(rawChanged.materialization_attempts).toBe(0);

      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 2 })
        .execute();
      await repo.upsertFact({ ...input, contentHash: `${prefix}-from-null`, raw: { subtype: "external" } });
      const contentHashChanged = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(contentHashChanged.materialized_at).toBeNull();
      expect(contentHashChanged.materialization_attempts).toBe(0);
    });

    it("reopens a legacy row when its NULL input hash transitions to a computed hash", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input = personSeedInput(prefix);
      await repo.upsertFact(input);
      await db
        .updateTable("indexed_file_facts")
        .set({
          materialization_input_hash: null,
          materialized_at: FINISHED_AT,
          materialization_attempts: 5,
        })
        .execute();

      await repo.upsertFact(input);

      const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(fact.materialization_input_hash).not.toBeNull();
      expect(fact.materialized_at).toBeNull();
      expect(fact.materialization_attempts).toBe(0);
    });

    it("keeps quarantined facts closed to sweeps on same input and reopens them on change", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input = personSeedInput(prefix);
      await repo.upsertFact(input);
      await db.updateTable("indexed_file_facts").set({ materialized_at: null, materialization_attempts: 5 }).execute();

      await repo.upsertFact(input);
      const quarantined = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(quarantined.materialized_at).toBeNull();
      expect(quarantined.materialization_attempts).toBe(5);

      await repo.upsertFact({ ...input, contextSnippet: "Changed context" });
      const reopened = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(reopened.materialized_at).toBeNull();
      expect(reopened.materialization_attempts).toBe(0);
      expect(reopened.materialization_input_hash).not.toBe(quarantined.materialization_input_hash);
    });

    it("resets prior failure attempts when materialization succeeds", async () => {
      const repo = createIndexedFileFactRepository(db);
      await repo.upsertFact({
        source: "llm",
        factType: "llm_task",
        relation: "mentioned",
        subjectName: "Disabled legacy task",
        subjectSource: "llm",
        subjectSourceId: `${prefix}-legacy-task`,
        raw: {
          candidateId: `${prefix}-legacy-task`,
          title: "Disabled legacy task",
          hasOwnerVerbObject: true,
          corroborationKey: `${prefix}|legacy-task`,
          evidence: { fileIds: [], entityIds: [] },
          promptVersion: "test-v1",
        },
      });
      await db.updateTable("indexed_file_facts").set({ materialization_attempts: 4 }).execute();

      const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { factTypes: ["llm_task"] });

      const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(summary).toMatchObject({ factsRead: 1, materialized: 1 });
      expect(fact.materialized_at).not.toBeNull();
      expect(fact.materialization_attempts).toBe(0);
    });

    it("keeps operator-reset facts open across a later same-input upsert", async () => {
      const repo = createIndexedFileFactRepository(db);
      const input = personSeedInput(prefix);
      await repo.upsertFact(input);
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 5 })
        .execute();
      const before = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

      await performReset(db, {
        includeConnectors: false,
        includeAi: false,
        includeManual: false,
        orgSourceTypes: [],
        factTypes: ["person_seed"],
      });
      await repo.upsertFact({ ...input, lastSeenSyncRunId: `${prefix}-sync-after-reset` });

      const after = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(after.materialization_input_hash).toBe(before.materialization_input_hash);
      expect(after.materialized_at).toBeNull();
      expect(after.materialization_attempts).toBe(0);
    });

    it("keeps reconciliation-reopened facts open across a later same-input upsert", async () => {
      const connectorId = `${prefix}-reconcile-connector`;
      const fileId = `${prefix}-reconcile-file`;
      await db
        .insertInto("connector_configs")
        .values({
          id: connectorId,
          connector_type: "linear",
          auth_type: "api_key",
          credentials: "{}",
          created_by: `${prefix}-owner`,
        })
        .execute();
      await db
        .insertInto("indexed_files")
        .values({
          id: fileId,
          connector_config_id: connectorId,
          provider_file_id: fileId,
          file_name: "Reconcile fact",
          content_category: "structured",
          source: "linear",
          synced_at: FINISHED_AT,
        })
        .execute();
      const repo = createIndexedFileFactRepository(db);
      const input = { ...personSeedInput(prefix), connectorConfigId: connectorId, indexedFileId: fileId };
      await repo.upsertFact(input);
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: FINISHED_AT, materialization_attempts: 5 })
        .execute();
      const before = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();

      await repo.clearMaterializedAtForActiveFacts([fileId]);
      await repo.upsertFact({ ...input, lastSeenSyncRunId: `${prefix}-sync-after-reconcile` });

      const after = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
      expect(after.materialization_input_hash).toBe(before.materialization_input_hash);
      expect(after.materialized_at).toBeNull();
      expect(after.materialization_attempts).toBe(0);
    });
  });
}

runVerdictSafeUpsertSuite("verdict-safe fact upserts on SQLite", "sqlite-verdict", createTestDb, false);
runVerdictSafeUpsertSuite("verdict-safe fact upserts on Postgres", "pg-verdict", getSharedPgDb, true);

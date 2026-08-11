import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IndexedFileFactRaw } from "../connectors/types";
import {
  type UpsertIndexedFileFactInput,
  createIndexedFileFactRepository,
} from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, getSharedPgDb } from "../test-utils";
import { normalizeEntityMatchName } from "./match-normalize";
import { buildMaterializeDeps } from "./materialize-deps";
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

function llmFact(
  fileId: string,
  subject: string,
  raw: Record<string, unknown>,
  source = "llm_extraction",
): UpsertIndexedFileFactInput {
  const contentHash = `${fileId}:${subject}:${source}`;
  return {
    indexedFileId: fileId,
    connectorConfigId: `cfg-${fileId}`,
    source,
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: subject,
    contentHash,
    raw: { contentHash, promptVersion: "v1", ...raw } as IndexedFileFactRaw,
  };
}

async function setBackfill(db: Kysely<DB>, status: "pending" | "complete"): Promise<void> {
  await db.updateTable("normalization_backfill_state").set({ status }).where("id", "=", "v1").execute();
}

/** Recomputes the (normalizedName, coercedType) pair the materializer passes to the count lookup. */
function countLookupArgs(subject: string, raw: Record<string, unknown>): { name: string; type: string } | null {
  const projection = projectLlmExtractedNormalization(subject, raw);
  if (!projection.mention_type) return null;
  const name = normalizeEntityMatchName(projection.mention_type, subject);
  return name ? { name, type: projection.mention_type } : null;
}

function runSuite(name: string, getDb: () => Promise<Kysely<DB>>, shared: boolean): void {
  describe(name, () => {
    let db: Kysely<DB>;

    beforeAll(async () => {
      if (shared) db = await getDb();
    }, 30000);

    beforeEach(async () => {
      if (shared) {
        await sql`BEGIN`.execute(db);
      } else {
        db = await createTestDb();
      }
    });

    afterEach(async () => {
      if (shared) await sql`ROLLBACK`.execute(db);
    });

    afterAll(async () => {
      if (!shared && db) await db.destroy();
    });

    it("hybrid corroboration counting agrees pre- and post-marker and honors the denylist quirk", async () => {
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "f1");
      await seedFile(db, "f2");
      await seedFile(db, "f3");
      await repo.upsertFact(llmFact("f1", "Acme", { type: "company" }));
      await repo.upsertFact(llmFact("f2", "Acme", { type: "company" }));
      await repo.upsertFact(llmFact("f3", "Globex", { type: "company" }));
      // Same denylisted name on two files, typed company; the materializer coerces
      // the lookup to "tool", which must miss the company-keyed rows exactly as the
      // legacy whole-table map did.
      await repo.upsertFact(llmFact("f1", "Slack", { type: "company" }));
      await repo.upsertFact(llmFact("f2", "Slack", { type: "company" }));

      await setBackfill(db, "pending");
      const legacy = await buildMaterializeDeps(db);
      await setBackfill(db, "complete");
      const indexed = await buildMaterializeDeps(db);

      expect(legacy.normalizationBackfillComplete).toBe(false);
      expect(indexed.normalizationBackfillComplete).toBe(true);

      const acme = countLookupArgs("Acme", { type: "company" });
      const globex = countLookupArgs("Globex", { type: "company" });
      const slack = countLookupArgs("Slack", { type: "company" });
      if (!acme || !globex || !slack) throw new Error("fixture types must coerce");

      expect(slack.type).toBe("tool");
      for (const [label, args, expected] of [
        ["acme", acme, 2],
        ["globex", globex, 1],
        ["slack-as-tool", slack, 0],
      ] as const) {
        const legacyCount = await legacy.countActiveLlmFilesForName(args.name, args.type as never);
        const indexedCount = await indexed.countActiveLlmFilesForName(args.name, args.type as never);
        expect(legacyCount, `${label} legacy`).toBe(expected);
        expect(indexedCount, `${label} indexed`).toBe(expected);
      }

      // The company-keyed count still sees both denylisted rows.
      const legacyCompany = await legacy.countActiveLlmFilesForName("slack", "company" as never);
      const indexedCompany = await indexed.countActiveLlmFilesForName("slack", "company" as never);
      expect(legacyCompany).toBe(2);
      expect(indexedCompany).toBe(2);
    });

    it("hybrid third-party lookup agrees and preserves the source filter", async () => {
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "t1");
      await seedFile(db, "t2");
      await seedFile(db, "t3");
      await repo.upsertFact(llmFact("t1", "Acme", { type: "company", mention: "Acme Corporation" }));
      await repo.upsertFact(llmFact("t2", "Datadog", { type: "tool" }));
      // A non-llm_extraction source is counted but never a third-party match.
      await repo.upsertFact(llmFact("t3", "Hooli", { type: "company" }, "other_source"));

      await setBackfill(db, "pending");
      const legacy = await buildMaterializeDeps(db);
      await setBackfill(db, "complete");
      const indexed = await buildMaterializeDeps(db);

      for (const [label, query, expectedType] of [
        ["acme via distinct mention", "Acme Corporation", "company"],
        ["datadog tool", "Datadog", "tool"],
      ] as const) {
        const legacyHit = await legacy.lookup.findLlmExtractedThirdPartyMention?.(query);
        const indexedHit = await indexed.lookup.findLlmExtractedThirdPartyMention?.(query);
        expect(legacyHit?.type, `${label} legacy`).toBe(expectedType);
        expect(indexedHit?.type, `${label} indexed`).toBe(expectedType);
      }

      for (const query of ["Hooli", "Unknown Co"]) {
        const legacyHit = await legacy.lookup.findLlmExtractedThirdPartyMention?.(query);
        const indexedHit = await indexed.lookup.findLlmExtractedThirdPartyMention?.(query);
        expect(legacyHit ?? null, `${query} legacy`).toBeNull();
        expect(indexedHit ?? null, `${query} indexed`).toBeNull();
      }
    });

    it("decision facts fold file source timestamps into the verdict hash; llm_extracted facts do not", async () => {
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "d1", "2026-02-01T00:00:00.000Z");

      const decision: UpsertIndexedFileFactInput = {
        indexedFileId: "d1",
        connectorConfigId: "cfg-d1",
        source: "linear",
        factType: "decision",
        relation: "mentioned",
        subjectName: "Adopt Kysely",
        raw: {
          decisionId: "dec-1",
          topic: "orm",
          statement: "Adopt Kysely",
          evidence: { fileIds: ["d1"], entityIds: [] },
        },
      };
      await repo.upsertFact(decision);
      const before = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash"])
        .where("fact_type", "=", "decision")
        .executeTakeFirstOrThrow();
      // Simulate a completed verdict, then advance only the file's source timestamp.
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: "2026-02-02T00:00:00.000Z" })
        .where("fact_type", "=", "decision")
        .execute();
      await db
        .updateTable("indexed_files")
        .set({ source_updated_at: "2026-03-01T00:00:00.000Z" })
        .where("id", "=", "d1")
        .execute();
      await repo.upsertFact(decision);
      const after = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash", "materialized_at"])
        .where("fact_type", "=", "decision")
        .executeTakeFirstOrThrow();
      expect(after.materialization_input_hash).not.toBe(before.materialization_input_hash);
      expect(after.materialized_at).toBeNull();

      // An llm_extracted fact on the same file keeps its hash and verdict when the
      // file timestamp moves, because only decision/milestone fold it in.
      const mention = llmFact("d1", "Kysely", { type: "tool" });
      await repo.upsertFact(mention);
      const mentionBefore = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash"])
        .where("fact_type", "=", "llm_extracted")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: "2026-02-02T00:00:00.000Z" })
        .where("fact_type", "=", "llm_extracted")
        .execute();
      await db
        .updateTable("indexed_files")
        .set({ source_updated_at: "2026-04-01T00:00:00.000Z" })
        .where("id", "=", "d1")
        .execute();
      await repo.upsertFact(mention);
      const mentionAfter = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash", "materialized_at"])
        .where("fact_type", "=", "llm_extracted")
        .executeTakeFirstOrThrow();
      expect(mentionAfter.materialization_input_hash).toBe(mentionBefore.materialization_input_hash);
      expect(mentionAfter.materialized_at).toBe("2026-02-02T00:00:00.000Z");
    });

    it("milestone facts fold file source timestamps into the verdict hash and reopen on a timestamp-only change", async () => {
      const repo = createIndexedFileFactRepository(db);
      await seedFile(db, "m1", "2026-02-01T00:00:00.000Z");

      const milestone: UpsertIndexedFileFactInput = {
        indexedFileId: "m1",
        connectorConfigId: "cfg-m1",
        source: "linear",
        factType: "milestone",
        relation: "mentioned",
        subjectName: "GA launch",
        raw: {
          milestoneId: "ms-1",
          milestoneName: "GA launch",
          status: "planned",
          dueAt: "2026-06-01T00:00:00.000Z",
          evidence: { fileIds: ["m1"], entityIds: [] },
        },
      };
      await repo.upsertFact(milestone);
      const before = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash"])
        .where("fact_type", "=", "milestone")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: "2026-02-02T00:00:00.000Z" })
        .where("fact_type", "=", "milestone")
        .execute();
      await db
        .updateTable("indexed_files")
        .set({ source_updated_at: "2026-03-01T00:00:00.000Z" })
        .where("id", "=", "m1")
        .execute();
      await repo.upsertFact(milestone);
      const after = await db
        .selectFrom("indexed_file_facts")
        .select(["materialization_input_hash", "materialized_at"])
        .where("fact_type", "=", "milestone")
        .executeTakeFirstOrThrow();
      expect(after.materialization_input_hash).not.toBe(before.materialization_input_hash);
      expect(after.materialized_at).toBeNull();
    });
  });
}
runSuite("indexed corroboration (sqlite)", async () => createTestDb(), false);
runSuite("indexed corroboration (pglite)", getSharedPgDb, true);

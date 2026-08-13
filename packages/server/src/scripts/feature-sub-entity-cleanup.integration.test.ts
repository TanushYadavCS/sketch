import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { runFeatureSubEntityCleanup } from "./feature-sub-entity-cleanup";

async function seedSubEntity(db: Kysely<DB>, id: string, kind: string): Promise<void> {
  await db
    .insertInto("sub_entities")
    .values({
      id,
      parent_entity_id: null,
      parent_scope_key: "global",
      kind,
      normalized_name: id,
      display_name: id,
      status: "open",
      provenance: "test",
      due_at: null,
      value_signature: null,
      series_key: `${kind}:${id}`,
      created_by_user_id: null,
      source_fact_id: null,
      metadata_json: null,
      valid_to: null,
    })
    .execute();
}

async function seedEvidence(db: Kysely<DB>, subEntityId: string, kind: string, refId: string): Promise<void> {
  await db.insertInto("sub_entity_evidence").values({ sub_entity_id: subEntityId, kind, ref_id: refId }).execute();
}

async function countRows(db: Kysely<DB>, table: "sub_entities" | "sub_entity_evidence"): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function runDialectCase(name: string, createDb: () => Promise<Kysely<DB>>): Promise<void> {
  const db = await createDb();
  try {
    await seedSubEntity(db, `${name}-feature-a`, "feature");
    await seedSubEntity(db, `${name}-feature-b`, "feature");
    await seedSubEntity(db, `${name}-commitment`, "commitment");
    await seedEvidence(db, `${name}-feature-a`, "file", "file-a");
    await seedEvidence(db, `${name}-feature-a`, "fact", "fact-a");
    await seedEvidence(db, `${name}-feature-b`, "file", "file-b");
    await seedEvidence(db, `${name}-commitment`, "file", "file-c");

    const dryRun = await runFeatureSubEntityCleanup(db);
    expect(dryRun).toEqual({
      mode: "dry-run",
      counts: {
        featureSubEntities: 2,
        featureEvidenceRowsBefore: 3,
        deletedSubEntities: 0,
        remainingFeatureSubEntities: 2,
        featureEvidenceRowsAfter: 3,
      },
    });
    expect(await countRows(db, "sub_entities")).toBe(3);
    expect(await countRows(db, "sub_entity_evidence")).toBe(4);

    const executed = await runFeatureSubEntityCleanup(db, { execute: true });
    expect(executed).toEqual({
      mode: "execute",
      counts: {
        featureSubEntities: 2,
        featureEvidenceRowsBefore: 3,
        deletedSubEntities: 2,
        remainingFeatureSubEntities: 0,
        featureEvidenceRowsAfter: 0,
      },
    });
    expect(await db.selectFrom("sub_entities").selectAll().where("kind", "=", "feature").execute()).toEqual([]);
    expect(await countRows(db, "sub_entities")).toBe(1);
    expect(await countRows(db, "sub_entity_evidence")).toBe(1);

    const rerun = await runFeatureSubEntityCleanup(db, { execute: true });
    expect(rerun.counts).toEqual({
      featureSubEntities: 0,
      featureEvidenceRowsBefore: 0,
      deletedSubEntities: 0,
      remainingFeatureSubEntities: 0,
      featureEvidenceRowsAfter: 0,
    });
  } finally {
    await db.destroy();
  }
}

describe("feature sub-entity cleanup", () => {
  it("is dry-run by default, execute-only destructive, idempotent, and cascade-backed on sqlite", async () => {
    await runDialectCase("sqlite", createTestDb);
  });

  it("is dry-run by default, execute-only destructive, idempotent, and cascade-backed on postgres", async () => {
    await runDialectCase("postgres", createTestPgDb);
  });
});

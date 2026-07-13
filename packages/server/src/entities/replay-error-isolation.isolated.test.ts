import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";

/**
 * Force `structural_seed` materialization to throw so the per-fact `try/catch`
 * in the backlog loop is exercised directly. `materialize-structural` is only
 * imported by `materialize-replay`, so mocking it here leaves every other fact
 * type (person seeds) on its real implementation.
 */
vi.mock("./materialize-structural", () => ({
  materializeStructuralSeed: vi.fn(() => {
    throw new Error("poison structural seed");
  }),
  materializeParentEntity: vi.fn(),
}));

const TEST_USER_ID = "user-1";

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
}

describe("batch-scoped materialization error isolation", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
    vi.clearAllMocks();
  });

  it("keeps materializing later facts after a fact throws, and leaves the poison unmaterialized", async () => {
    const { materializeUnmaterializedFacts } = await import("./materialize");
    const repo = createIndexedFileFactRepository(db);

    await repo.upsertFact({
      createdByUserId: TEST_USER_ID,
      source: "manual",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Poison Space",
      subjectSource: "manual",
      subjectSourceId: "poison-space",
      raw: { sourceType: "clickup_space" },
    });
    for (let i = 0; i < 3; i++) {
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

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { batchSize: 1 });

    expect(summary.factsRead).toBe(4);
    expect(summary.skipped).toBe(1);
    expect(summary.materialized).toBe(3);

    const people = await db.selectFrom("entities").select("id").where("source_type", "=", "person").execute();
    expect(people).toHaveLength(3);

    const poison = await db
      .selectFrom("indexed_file_facts")
      .select("materialized_at")
      .where("subject_source_id", "=", "poison-space")
      .executeTakeFirstOrThrow();
    expect(poison.materialized_at).toBeNull();
  });
});

import { CompiledQuery, type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { getSharedPgDb } from "../test-utils";
import { buildOpenFactCandidateQuery } from "./materialize-replay";

const OWNER_ID = "pg-lean-owner";

/**
 * Postgres arm of the Fix 4 partial-index coverage check. The narrow candidate
 * query is DB-shape-dependent, so both dialects must confirm the planner can use
 * `idx_indexed_file_facts_open_materializable` for the open-fact scan. Sequential
 * scan is disabled so the assertion proves the index is usable, not merely that
 * the tiny fixture happened to favor a table scan.
 */
describe("lean candidate scan partial index (Postgres)", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await db
      .insertInto("users")
      .values({
        id: OWNER_ID,
        name: "Owner",
        email: "pg-lean@example.com",
        email_verified_at: "2026-07-14T00:00:00.000Z",
        password_hash: "hash",
        auth_role: "admin",
      })
      .execute();
    const repo = createIndexedFileFactRepository(db);
    for (let i = 0; i < 60; i++) {
      await repo.upsertFact({
        createdByUserId: OWNER_ID,
        source: "manual",
        factType: "person_seed",
        relation: "seeded",
        subjectName: `PG Person ${i}`,
        subjectEmail: `pg-person-${i}@example.com`,
        subjectSource: "manual",
        subjectSourceId: `pg-person-${i}`,
        raw: { subtype: "external" },
      });
    }
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("plans the candidate scan through the open-materializable partial index", async () => {
    await sql`SET LOCAL enable_seqscan = off`.execute(db);

    const compiled = buildOpenFactCandidateQuery(db, { createdAt: "", id: "" }, 250, {
      factType: "person_seed",
    }).compile();
    const plan = await db.executeQuery<{ "QUERY PLAN": string }>(
      CompiledQuery.raw(`EXPLAIN ${compiled.sql}`, [...compiled.parameters]),
    );
    const planText = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");

    expect(planText).toContain("idx_indexed_file_facts_open_materializable");
  });
});

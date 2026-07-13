import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { up as backfillProvenanceTier } from "./130-entity-provenance-tier";

const NOW = "2026-06-26T00:00:00.000Z";

async function insertEntity(db: Kysely<DB>, id: string, name: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

describe("130-entity-provenance-tier", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("backfills structural, human-confirmed, and inferred entity tiers", async () => {
    await insertEntity(db, "structural-entity", "Structural Project");
    await insertEntity(db, "confirmed-entity", "Confirmed Project");
    await insertEntity(db, "llm-entity", "LLM Project");
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "structural-ref",
        entity_id: "structural-entity",
        source: "linear",
        source_id: "linear-project-1",
        source_url: null,
        last_seen_at: NOW,
      })
      .execute();
    await db
      .insertInto("indexed_file_facts")
      .values({
        id: "structural-fact",
        indexed_file_id: null,
        connector_config_id: null,
        created_by_user_id: null,
        source: "linear",
        fact_type: "structural_seed",
        relation: "seeded",
        subject_name: "Structural Project",
        subject_source: "linear",
        subject_source_id: "linear-project-1",
        subject_email: null,
        context_snippet: null,
        raw: "{}",
        fact_key: "linear:linear-project-1:seeded",
        last_seen_sync_run_id: null,
        deleted_at: null,
        content_hash: null,
        materialized_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "confirmed-review",
        proposed_name: "Confirmed Project",
        normalized_name: "confirmed project",
        entity_type: "project",
        proposed_email: null,
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: NOW,
        first_seen_at: NOW,
        last_seen_at: NOW,
        occurrence_count: 1,
        status: "confirmed",
        triggered_by_user_id: "user-1",
        review_started_at: null,
        review_started_by: null,
        backfill_cursor: null,
        resolved_by: "user-1",
        resolved_at: NOW,
        resolved_entity_id: "confirmed-entity",
        seed_source: null,
        seed_source_id: null,
        seed_aliases: null,
      })
      .execute();

    await backfillProvenanceTier(db as unknown as Kysely<unknown>);

    const rows = await db
      .selectFrom("entities")
      .select(["id", "provenance_tier"])
      .where("id", "in", ["structural-entity", "confirmed-entity", "llm-entity"])
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { id: "confirmed-entity", provenance_tier: "human_confirmed" },
      { id: "llm-entity", provenance_tier: "inferred" },
      { id: "structural-entity", provenance_tier: "structural" },
    ]);
  });
});

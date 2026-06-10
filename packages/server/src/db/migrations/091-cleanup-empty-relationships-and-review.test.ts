import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { up } from "./091-cleanup-empty-relationships-and-review";

async function seedConnectorAndFile(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "migration-cleanup-connector",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "migration-cleanup-owner",
      scope_config: "{}",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "migration-cleanup-file",
      connector_config_id: "migration-cleanup-connector",
      provider_file_id: "provider-migration-cleanup-file",
      file_name: "migration-cleanup.md",
      file_type: "document",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: "content",
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name: id,
      source_type: "person",
      aliases: "[]",
      metadata: "{}",
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedReview(
  db: Kysely<DB>,
  input: { id: string; status: string; withEvidence?: boolean },
): Promise<void> {
  await db
    .insertInto("entity_review_queue")
    .values({
      id: input.id,
      proposed_name: input.id,
      normalized_name: input.id,
      entity_type: "person",
      status: input.status,
      triggered_by_user_id: "migration-cleanup-owner",
    })
    .execute();
  if (input.withEvidence) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: `evidence-${input.id}`,
        review_id: input.id,
        indexed_file_id: "migration-cleanup-file",
        source: "llm_extraction",
        note: null,
      })
      .execute();
  }
}

describe("091-cleanup-empty-relationships-and-review migration", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedConnectorAndFile(db);
    await seedEntity(db, "migration-source");
    await seedEntity(db, "migration-target");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("removes empty relationships and pending reviews while retaining evidenced and resolved rows", async () => {
    await db
      .insertInto("entity_relationships")
      .values([
        {
          id: "relationship-empty",
          source_entity_id: "migration-source",
          target_entity_id: "migration-target",
          relationship_type: "engaged_with",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        },
        {
          id: "relationship-evidenced",
          source_entity_id: "migration-target",
          target_entity_id: "migration-source",
          relationship_type: "engaged_with",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        },
        {
          id: "relationship-legitimate-email-domain",
          source_entity_id: "migration-source",
          target_entity_id: "migration-target",
          relationship_type: "works_at",
          confidence: "INFERRED",
          confidence_score: 0.9,
          source: "email_domain",
        },
      ])
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "relationship-evidence",
        relationship_id: "relationship-evidenced",
        indexed_file_id: "migration-cleanup-file",
        note: null,
        source_fact_id: null,
      })
      .execute();

    await seedReview(db, { id: "review-empty-pending", status: "pending" });
    await seedReview(db, { id: "review-evidenced-pending", status: "pending", withEvidence: true });
    await seedReview(db, { id: "review-confirmed-empty", status: "confirmed" });
    await seedReview(db, { id: "review-rejected-empty", status: "rejected" });
    await db
      .insertInto("entity_candidates")
      .values({
        id: "domain-candidate",
        name: "Candidate",
        type: "domain_observation",
        variations: "[]",
        first_seen_file_id: "migration-cleanup-file",
        seen_file_ids: JSON.stringify(["migration-cleanup-file"]),
        seen_count: 1,
        promoted_entity_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        domain: "example.com",
        proposed_company_name: "Example",
        observed_person_entity_ids: "[]",
        evidence_file_ids: JSON.stringify(["migration-cleanup-file"]),
      })
      .execute();
    await db
      .insertInto("entity_review_domain_candidates")
      .values({ review_id: "review-empty-pending", domain_candidate_id: "domain-candidate" })
      .execute();

    await up(db as unknown as Kysely<unknown>);
    await up(db as unknown as Kysely<unknown>);

    const relationships = await db.selectFrom("entity_relationships").select("id").orderBy("id").execute();
    expect(relationships.map((row) => row.id)).toEqual([
      "relationship-evidenced",
      "relationship-legitimate-email-domain",
    ]);

    const reviews = await db.selectFrom("entity_review_queue").select(["id", "status"]).orderBy("id").execute();
    expect(reviews).toEqual([
      { id: "review-confirmed-empty", status: "confirmed" },
      { id: "review-evidenced-pending", status: "pending" },
      { id: "review-rejected-empty", status: "rejected" },
    ]);
    await expect(db.selectFrom("entity_review_domain_candidates").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_candidates").selectAll().execute()).resolves.toHaveLength(1);
  });
});

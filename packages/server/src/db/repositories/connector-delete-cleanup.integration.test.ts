import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityDomainsRepository } from "./entity-domains";
import { createEntityReviewRepo } from "./entity-review";

describe("connector delete relationship and review cleanup postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "pg-cleanup-connector",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "pg-cleanup-owner",
        scope_config: "{}",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "pg-cleanup-file",
        connector_config_id: "pg-cleanup-connector",
        provider_file_id: "provider-pg-cleanup-file",
        file_name: "pg-cleanup.md",
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
    await db
      .insertInto("entities")
      .values([
        {
          id: "pg-cleanup-source",
          name: "PG Cleanup Source",
          source_type: "person",
          aliases: "[]",
          metadata: "{}",
          source_ref_id: null,
          status: "active",
          hotness: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "pg-cleanup-target",
          name: "PG Cleanup Target",
          source_type: "person",
          aliases: "[]",
          metadata: "{}",
          source_ref_id: null,
          status: "active",
          hotness: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .execute();
  }, 30000);

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("deletes scoped empty relationships and pending reviews with NOT EXISTS", async () => {
    await db
      .insertInto("entity_relationships")
      .values({
        id: "pg-cleanup-relationship",
        source_entity_id: "pg-cleanup-source",
        target_entity_id: "pg-cleanup-target",
        relationship_type: "engaged_with",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_extraction",
      })
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "pg-cleanup-relationship-evidence",
        relationship_id: "pg-cleanup-relationship",
        indexed_file_id: "pg-cleanup-file",
        note: null,
        source_fact_id: null,
      })
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "pg-cleanup-review",
        proposed_name: "PG Cleanup Review",
        normalized_name: "pg cleanup review",
        entity_type: "person",
        status: "pending",
        triggered_by_user_id: "pg-cleanup-owner",
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: "pg-cleanup-review-evidence",
        review_id: "pg-cleanup-review",
        indexed_file_id: "pg-cleanup-file",
        source: "llm_extraction",
        note: null,
      })
      .execute();

    const domainsRepo = createEntityDomainsRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    const relationshipIds = await domainsRepo.relationshipIdsWithEvidenceInFiles(["pg-cleanup-file"]);
    const reviewIds = await reviewRepo.nonTerminalReviewIdsWithEvidenceInFiles(["pg-cleanup-file"]);

    await db.deleteFrom("indexed_files").where("id", "=", "pg-cleanup-file").execute();
    await expect(domainsRepo.deleteEmptyRelationshipsByIds(relationshipIds)).resolves.toBe(1);
    await expect(reviewRepo.deleteEmptyNonTerminalReviewsByIds(reviewIds)).resolves.toBe(1);

    await expect(db.selectFrom("entity_relationships").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
  });
});

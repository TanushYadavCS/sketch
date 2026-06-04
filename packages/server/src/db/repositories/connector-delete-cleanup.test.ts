import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createConnectorRepository } from "./connectors";
import { createEntityRepository } from "./entities";
import { createEntityDomainsRepository } from "./entity-domains";
import { createEntityReviewRepo } from "./entity-review";

async function seedConnector(db: Kysely<DB>, id: string, owner: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: owner,
      scope_config: "{}",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, connectorId: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorId,
      provider_file_id: `provider-${id}`,
      file_name: `${id}.md`,
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
  await db.insertInto("connector_files").values({ connector_config_id: connectorId, indexed_file_id: id }).execute();
}

async function seedReview(
  db: Kysely<DB>,
  input: { id: string; status: string; evidenceFileIds?: string[] },
): Promise<void> {
  await db
    .insertInto("entity_review_queue")
    .values({
      id: input.id,
      proposed_name: input.id,
      normalized_name: input.id,
      entity_type: "person",
      status: input.status,
      triggered_by_user_id: "owner-delete",
    })
    .execute();

  for (const fileId of input.evidenceFileIds ?? []) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: `evidence-${input.id}-${fileId}`,
        review_id: input.id,
        indexed_file_id: fileId,
        source: "llm_extraction",
        note: null,
      })
      .execute();
  }
}

describe("connector delete relationship and review cleanup", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("prunes only relationship and pending-review parents supported by the deleted connector files", async () => {
    await seedConnector(db, "connector-delete", "owner-delete");
    await seedConnector(db, "connector-keep", "owner-keep");
    await seedFile(db, "file-delete", "connector-delete");
    await seedFile(db, "file-keep", "connector-keep");

    const entityRepo = createEntityRepository(db);
    const source = await entityRepo.upsertPersonEntity({
      name: "Source Person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "source-person",
    });
    const target = await entityRepo.upsertPersonEntity({
      name: "Target Person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "target-person",
    });
    for (const entity of [source, target]) {
      await entityRepo.createMention({
        entityId: entity.id,
        indexedFileId: "file-keep",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
      });
    }

    await db
      .insertInto("entity_relationships")
      .values([
        {
          id: "rel-delete",
          source_entity_id: source.id,
          target_entity_id: target.id,
          relationship_type: "engaged_with",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        },
        {
          id: "rel-shared",
          source_entity_id: target.id,
          target_entity_id: source.id,
          relationship_type: "engaged_with",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        },
        {
          id: "rel-unrelated-empty",
          source_entity_id: source.id,
          target_entity_id: target.id,
          relationship_type: "partner_of",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        },
      ])
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values([
        {
          id: "rel-delete-evidence",
          relationship_id: "rel-delete",
          indexed_file_id: "file-delete",
          note: null,
          source_fact_id: null,
          evidence_key: "rel-delete:file-delete",
        },
        {
          id: "rel-shared-delete-evidence",
          relationship_id: "rel-shared",
          indexed_file_id: "file-delete",
          note: null,
          source_fact_id: null,
          evidence_key: "rel-shared:file-delete",
        },
        {
          id: "rel-shared-keep-evidence",
          relationship_id: "rel-shared",
          indexed_file_id: "file-keep",
          note: null,
          source_fact_id: null,
          evidence_key: "rel-shared:file-keep",
        },
      ])
      .execute();

    await seedReview(db, { id: "review-delete", status: "pending", evidenceFileIds: ["file-delete"] });
    await seedReview(db, { id: "review-shared", status: "pending", evidenceFileIds: ["file-delete", "file-keep"] });
    await seedReview(db, { id: "review-confirmed", status: "confirmed", evidenceFileIds: ["file-delete"] });
    await seedReview(db, { id: "review-unrelated-empty", status: "pending" });

    await db.transaction().execute(async (trx) => {
      const connectorRepo = createConnectorRepository(trx);
      const txEntityRepo = createEntityRepository(trx);
      const domainsRepo = createEntityDomainsRepository(trx);
      const reviewRepo = createEntityReviewRepo(trx);
      const fileIds = await connectorRepo.getOwnedFileIdsForConnector("connector-delete");
      const relationshipIds = await domainsRepo.relationshipIdsWithEvidenceInFiles(fileIds);
      const reviewIds = await reviewRepo.pendingReviewIdsWithEvidenceInFiles(fileIds);
      await txEntityRepo.deleteEntitiesForFiles(fileIds);
      await connectorRepo.deleteConfig("connector-delete");
      await domainsRepo.deleteEmptyRelationshipsByIds(relationshipIds);
      await reviewRepo.deleteEmptyPendingReviewsByIds(reviewIds);
    });

    const relationships = await db.selectFrom("entity_relationships").select("id").orderBy("id").execute();
    expect(relationships.map((row) => row.id)).toEqual(["rel-shared", "rel-unrelated-empty"]);

    const reviews = await db.selectFrom("entity_review_queue").select(["id", "status"]).orderBy("id").execute();
    expect(reviews).toEqual([
      { id: "review-confirmed", status: "confirmed" },
      { id: "review-shared", status: "pending" },
      { id: "review-unrelated-empty", status: "pending" },
    ]);
  });
});

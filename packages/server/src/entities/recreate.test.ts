import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { resetDerivedEntityData } from "./recreate";

describe("resetDerivedEntityData", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedGraph() {
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        name: "Admin",
        email: "admin@example.com",
        email_verified_at: now,
        password_hash: "hash",
        auth_role: "admin",
      })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-1",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-1",
        connector_config_id: "connector-1",
        provider_file_id: "meeting-1",
        file_name: "Meeting",
        file_type: "transcript",
        content_category: "document",
        content: "hello",
        summary: "generated summary",
        source: "fireflies",
        content_hash: "hash",
        is_archived: 0,
        synced_at: now,
        context_note: "keep me",
        enrichment_status: "enriched",
        embedding_status: "done",
        summary_status: "done",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-archived",
        connector_config_id: "connector-1",
        provider_file_id: "meeting-archived",
        file_name: "Archived",
        file_type: "transcript",
        content_category: "document",
        source: "fireflies",
        content_hash: "archived",
        is_archived: 1,
        synced_at: now,
        summary: "archived summary",
        enrichment_status: "enriched",
        embedding_status: "done",
        summary_status: "done",
      })
      .execute();

    const entityRepo = createEntityRepository(db);
    const entity = await entityRepo.upsertPersonEntity({
      name: "Saurabh",
      email: "saurabh@example.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "meeting-1:saurabh@example.com",
    });
    await entityRepo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: "rejection-1",
        entity_id: entity.id,
        rejected_name: "Saurabh B",
        normalized_rejected_name: "saurabh b",
        rejected_by: "user-1",
      })
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "review-1",
        proposed_name: "Saurabh B",
        normalized_name: "saurabh b",
        entity_type: "person",
        candidate_entity_id: entity.id,
        triggered_by_user_id: "user-1",
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: "evidence-1",
        review_id: "review-1",
        indexed_file_id: "file-1",
        source: "fireflies",
      })
      .execute();
    await db
      .insertInto("document_chunks")
      .values({
        id: "chunk-1",
        indexed_file_id: "file-1",
        chunk_index: 0,
        content: "hello",
      })
      .execute();
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: "file-1",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Saurabh",
      subjectEmail: "saurabh@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "meeting-1:saurabh@example.com",
    });
  }

  it("deletes derived graph data, including alias rejections, and keeps raw facts/content outputs", async () => {
    await seedGraph();

    const summary = await resetDerivedEntityData(db, createTestLogger());

    expect(summary.deleted.entities).toBe(1);
    expect(summary.deleted.entity_alias_rejections).toBe(1);
    expect(summary.deleted.entity_review_queue).toBe(1);
    expect(summary.filesMarkedPending).toBe(0);
    expect(summary.factsMarkedUnmaterialized).toBe(1);
    expect(summary.warnings.join(" ")).toContain("alias rejections will be deleted");

    await expect(db.selectFrom("entities").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_alias_rejections").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("indexed_file_facts").selectAll().execute()).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("document_chunks").selectAll().where("indexed_file_id", "=", "file-1").execute(),
    ).resolves.toHaveLength(1);

    const file = await db.selectFrom("indexed_files").selectAll().where("id", "=", "file-1").executeTakeFirstOrThrow();
    expect(file.embedding_status).toBe("done");
    expect(file.summary_status).toBe("done");
    expect(file.enrichment_status).toBe("enriched");
    expect(file.summary).toBe("generated summary");
    expect(file.context_note).toBe("keep me");

    const archived = await db
      .selectFrom("indexed_files")
      .selectAll()
      .where("id", "=", "file-archived")
      .executeTakeFirstOrThrow();
    expect(archived.embedding_status).toBe("done");
    expect(archived.summary_status).toBe("done");
    expect(archived.enrichment_status).toBe("enriched");
    expect(archived.summary).toBe("archived summary");
  });

  it("dry-run reports counts without writing", async () => {
    await seedGraph();

    const summary = await resetDerivedEntityData(db, createTestLogger(), { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.deleted.entities).toBe(1);
    expect(summary.factsMarkedUnmaterialized).toBe(1);
    await expect(db.selectFrom("entities").selectAll().execute()).resolves.toHaveLength(1);
    const file = await db.selectFrom("indexed_files").selectAll().where("id", "=", "file-1").executeTakeFirstOrThrow();
    expect(file.embedding_status).toBe("done");
  });

  it("preserves human-blessed tiers (declared, human_confirmed) and deletes derived ones", async () => {
    const now = new Date().toISOString();
    const seedEntity = async (id: string, tier: string) => {
      await db
        .insertInto("entities")
        .values({
          id,
          name: id,
          source_type: "project",
          status: "confirmed",
          provenance_tier: tier,
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    };
    await seedEntity("declared-product", "declared");
    await seedEntity("approved-project", "human_confirmed");
    await seedEntity("structural-project", "structural");
    await seedEntity("inferred-guess", "inferred");

    const summary = await resetDerivedEntityData(db, createTestLogger());

    expect(summary.deleted.entities).toBe(2);
    const survivors = await db.selectFrom("entities").select("id").orderBy("id", "asc").execute();
    expect(survivors.map((row) => row.id)).toEqual(["approved-project", "declared-product"]);
  });

  it("rejects while a connector is marked syncing", async () => {
    await seedGraph();
    await db.updateTable("connector_configs").set({ sync_status: "syncing" }).where("id", "=", "connector-1").execute();

    await expect(resetDerivedEntityData(db, createTestLogger())).rejects.toThrow("SYNC_ACTIVE");
  });
});

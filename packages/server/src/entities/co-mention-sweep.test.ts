import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { sweepCoMentionContributesTo } from "./co-mention-sweep";

const ADMIN_ID = "admin-co-mention";
const CONNECTOR_ID = "cfg-co-mention";

async function seedAdminAndConnector(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: ADMIN_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "fireflies",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.txt`,
      file_type: "meeting",
      content_category: "meeting",
      source: "fireflies",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedFiles(db: Kysely<DB>, prefix: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
  for (const id of ids) await seedFile(db, id);
  return ids;
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType: string): Promise<string> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

async function seedExtractedCoMentions(db: Kysely<DB>, personId: string, targetId: string, fileIds: string[]) {
  const repo = createEntityRepository(db);
  for (const fileId of fileIds) {
    await repo.createMention({
      entityId: personId,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: targetId,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
  }
}

async function relationshipRows(db: Kysely<DB>) {
  return db.selectFrom("entity_relationships").selectAll().orderBy("source_entity_id").execute();
}

async function evidenceRows(db: Kysely<DB>) {
  return db.selectFrom("entity_relationship_evidence").selectAll().orderBy("indexed_file_id").execute();
}

describe("sweepCoMentionContributesTo", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdminAndConnector(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("gates on distinct extracted supporting files", async () => {
    const personId = await seedEntity(db, "person-a", "Himanshu", "person");
    const projectId = await seedEntity(db, "project-a", "Project Atlas", "project");
    const firstTwo = await seedFiles(db, "gate", 2);
    await seedExtractedCoMentions(db, personId, projectId, firstTwo);

    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    expect(await relationshipRows(db)).toHaveLength(0);

    await seedFile(db, "gate-3");
    await seedExtractedCoMentions(db, personId, projectId, ["gate-3"]);
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });

    const rows = await relationshipRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_entity_id: personId,
      target_entity_id: projectId,
      relationship_type: "contributes_to",
      confidence: "INFERRED",
      source: "co_mention",
    });
    expect(rows[0].confidence_score).toBeCloseTo(0.65);
    expect(await evidenceRows(db)).toHaveLength(3);
  });

  it("ignores archived files when counting co-mention support", async () => {
    const personId = await seedEntity(db, "person-archived", "Riya", "person");
    const projectId = await seedEntity(db, "project-archived", "Atlas", "project");
    const fileIds = await seedFiles(db, "archived-support", 3);
    await seedExtractedCoMentions(db, personId, projectId, fileIds);
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    expect(await relationshipRows(db)).toHaveLength(1);

    await db.updateTable("indexed_files").set({ is_archived: 1 }).where("id", "=", fileIds[0]).execute();
    const summary = await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });

    expect(summary.removedRelationships).toBe(1);
    expect(await relationshipRows(db)).toHaveLength(0);
    expect(await evidenceRows(db)).toHaveLength(0);
  });

  it("is idempotent and caps confidence below extracted", async () => {
    const personId = await seedEntity(db, "person-cap", "Priya", "person");
    const projectId = await seedEntity(db, "project-cap", "Launch", "project");
    const fileIds = await seedFiles(db, "cap", 10);
    await seedExtractedCoMentions(db, personId, projectId, fileIds);

    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });

    const rows = await relationshipRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence_score).toBe(0.84);
    expect(await evidenceRows(db)).toHaveLength(10);
  });

  it("counts duplicate mentions in one file once", async () => {
    const personId = await seedEntity(db, "person-dupe", "Alex", "person");
    const productId = await seedEntity(db, "product-dupe", "Canvas", "product");
    await seedFile(db, "dupe-1");
    const repo = createEntityRepository(db);
    await repo.createMention({
      entityId: personId,
      indexedFileId: "dupe-1",
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: personId,
      indexedFileId: "dupe-1",
      confidence: "EXTRACTED",
      source: "test",
      relation: "assigned",
    });
    await repo.createMention({
      entityId: productId,
      indexedFileId: "dupe-1",
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });

    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 2 });
    expect(await relationshipRows(db)).toHaveLength(0);
  });

  it("removes stale co-mention evidence and then the empty relationship", async () => {
    const personId = await seedEntity(db, "person-stale", "Sarah", "person");
    const projectId = await seedEntity(db, "project-stale", "Website", "project");
    const fileIds = await seedFiles(db, "stale", 3);
    await seedExtractedCoMentions(db, personId, projectId, fileIds);
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    expect(await relationshipRows(db)).toHaveLength(1);

    await db.deleteFrom("entity_mentions").where("indexed_file_id", "=", fileIds[0]).execute();
    const summary = await sweepCoMentionContributesTo(db, createTestLogger(), {
      threshold: 3,
      scope: { kind: "files", indexedFileIds: [fileIds[0]] },
    });

    expect(summary.removedEvidence).toBe(3);
    expect(summary.removedRelationships).toBe(1);
    expect(await relationshipRows(db)).toHaveLength(0);
    expect(await evidenceRows(db)).toHaveLength(0);
  });

  it("does not overwrite a direct extracted relationship", async () => {
    const personId = await seedEntity(db, "person-direct", "Meera", "person");
    const projectId = await seedEntity(db, "project-direct", "Retention", "project");
    const fileIds = await seedFiles(db, "direct", 5);
    await seedExtractedCoMentions(db, personId, projectId, fileIds);
    const domainsRepo = createEntityDomainsRepository(db);
    const directRelationshipId = await domainsRepo.upsertRelationship({
      sourceEntityId: personId,
      targetEntityId: projectId,
      relationshipType: "contributes_to",
      confidence: "EXTRACTED",
      confidenceScore: 0.94,
      source: "llm_extraction",
    });
    await domainsRepo.addEvidence({
      relationshipId: directRelationshipId,
      indexedFileId: fileIds[0],
      chunkIndex: 0,
      note: "llm_relation:contributes_to",
      sourceFactId: null,
    });

    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });

    const rows = await relationshipRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_entity_id: personId,
      target_entity_id: projectId,
      confidence: "EXTRACTED",
      source: "llm_extraction",
    });
    expect(await evidenceRows(db)).toHaveLength(1);
  });

  it("file scope only reconciles touched co-mention relationships", async () => {
    const personA = await seedEntity(db, "person-scope-a", "A", "person");
    const projectA = await seedEntity(db, "project-scope-a", "A Project", "project");
    const personB = await seedEntity(db, "person-scope-b", "B", "person");
    const projectB = await seedEntity(db, "project-scope-b", "B Project", "project");
    const filesA = await seedFiles(db, "scope-a", 3);
    const filesB = await seedFiles(db, "scope-b", 3);
    await seedExtractedCoMentions(db, personA, projectA, filesA);
    await seedExtractedCoMentions(db, personB, projectB, filesB);
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    expect(await relationshipRows(db)).toHaveLength(2);

    await db.deleteFrom("entity_mentions").where("indexed_file_id", "=", filesA[0]).execute();
    await sweepCoMentionContributesTo(db, createTestLogger(), {
      threshold: 3,
      scope: { kind: "files", indexedFileIds: [filesA[0]] },
    });

    const rows = await relationshipRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_entity_id: personB, target_entity_id: projectB });
  });

  it("does not delete evidence owned by other relationship sources", async () => {
    const personId = await seedEntity(db, "person-owned", "Nina", "person");
    const projectId = await seedEntity(db, "project-owned", "Growth", "project");
    await seedFile(db, "owned-1");
    const domainsRepo = createEntityDomainsRepository(db);
    const relationshipId = await domainsRepo.upsertRelationship({
      sourceEntityId: personId,
      targetEntityId: projectId,
      relationshipType: "contributes_to",
      confidence: "EXTRACTED",
      confidenceScore: 0.9,
      source: "manual",
    });
    await domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: "owned-1",
      chunkIndex: -1,
      note: "co_mention:foreign",
      sourceFactId: null,
    });

    await sweepCoMentionContributesTo(db, createTestLogger(), {
      threshold: 3,
      scope: { kind: "files", indexedFileIds: ["owned-1"] },
    });

    expect(await relationshipRows(db)).toHaveLength(1);
    expect(await evidenceRows(db)).toHaveLength(1);
  });
});

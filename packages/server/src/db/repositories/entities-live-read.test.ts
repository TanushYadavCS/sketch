import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { createEntityRelationshipsRepository } from "./entity-relationships";

async function insertEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    sourceType?: string;
    metadata?: Record<string, unknown> | null;
    hotness?: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType ?? "person",
      subtype: null,
      aliases: null,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      source_ref_id: null,
      status: "confirmed",
      hotness: input.hotness ?? 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function tombstoneEntity(
  db: Kysely<DB>,
  id: string,
  tombstone: { deletedAt?: string; mergedIntoEntityId?: string },
): Promise<void> {
  await db
    .updateTable("entities")
    .set({
      deleted_at: tombstone.deletedAt ?? null,
      merged_into_entity_id: tombstone.mergedIntoEntityId ?? null,
    })
    .where("id", "=", id)
    .execute();
}

describe("entity live read paths", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("excludes manually tombstoned entities from repository reads and upsert resolution", async () => {
    const repo = createEntityRepository(db);
    const relationsRepo = createEntityRelationshipsRepository(db);

    await insertEntity(db, {
      id: "live-person",
      name: "Live Entity",
      metadata: { email: "shared@example.com" },
      hotness: 100,
    });
    await insertEntity(db, {
      id: "deleted-person",
      name: "Deleted Entity",
      metadata: { email: "shared@example.com" },
      hotness: 200,
    });
    await insertEntity(db, {
      id: "merged-person",
      name: "Merged Entity",
      metadata: { email: "shared@example.com" },
      hotness: 300,
    });
    await insertEntity(db, { id: "source-person", name: "Source Entity", hotness: 50 });
    await tombstoneEntity(db, "deleted-person", { deletedAt: "2026-01-01T00:00:00.000Z" });
    await tombstoneEntity(db, "merged-person", { mergedIntoEntityId: "live-person" });

    for (const entityId of ["live-person", "deleted-person", "merged-person"]) {
      await db
        .insertInto("entity_source_refs")
        .values({
          id: `ref-${entityId}`,
          entity_id: entityId,
          source: "test",
          source_id: entityId,
          source_url: null,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
      await repo.upsertContactPoint({
        entityId,
        kind: "email",
        value: "shared@example.com",
        source: "test",
      });
    }

    await db
      .insertInto("entity_relationships")
      .values([
        {
          id: "rel-live",
          source_entity_id: "source-person",
          target_entity_id: "live-person",
          relationship_type: "works_at",
          confidence: "EXTRACTED",
          confidence_score: 1,
          source: "test",
        },
        {
          id: "rel-deleted",
          source_entity_id: "source-person",
          target_entity_id: "deleted-person",
          relationship_type: "works_at",
          confidence: "EXTRACTED",
          confidence_score: 1,
          source: "test",
        },
        {
          id: "rel-merged",
          source_entity_id: "source-person",
          target_entity_id: "merged-person",
          relationship_type: "works_at",
          confidence: "EXTRACTED",
          confidence_score: 1,
          source: "test",
        },
      ])
      .execute();

    await expect(repo.getEntity("live-person")).resolves.toMatchObject({ id: "live-person" });
    await expect(repo.getEntity("deleted-person")).resolves.toBeUndefined();
    await expect(repo.getEntity("merged-person")).resolves.toBeUndefined();
    await expect(repo.getEntities(["live-person", "deleted-person", "merged-person"])).resolves.toEqual([
      expect.objectContaining({ id: "live-person" }),
    ]);
    await expect(repo.getEntitiesBySourceType("person")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "live-person" })]),
    );
    expect((await repo.getEntitiesBySourceType("person")).map((entity) => entity.id)).not.toEqual(
      expect.arrayContaining(["deleted-person", "merged-person"]),
    );
    expect((await repo.getEntitiesByStatus("confirmed")).map((entity) => entity.id)).not.toEqual(
      expect.arrayContaining(["deleted-person", "merged-person"]),
    );
    await expect(repo.searchEntities("Entity")).resolves.toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: "deleted-person" }),
        expect.objectContaining({ id: "merged-person" }),
      ]),
    );
    expect((await repo.getHotEntities(10)).map((entity) => entity.id)).not.toEqual(
      expect.arrayContaining(["deleted-person", "merged-person"]),
    );
    await expect(repo.getEntityBySourceRef("test", "live-person")).resolves.toMatchObject({ id: "live-person" });
    await expect(repo.getEntityBySourceRef("test", "deleted-person")).resolves.toBeNull();
    await expect(repo.getEntityBySourceRef("test", "merged-person")).resolves.toBeNull();
    await expect(repo.getEntityByContactPoint("email", "shared@example.com")).resolves.toMatchObject({
      id: "live-person",
    });
    await expect(repo.getEntitiesByContactPoint("email", "shared@example.com")).resolves.toEqual([
      expect.objectContaining({ id: "live-person" }),
    ]);
    await expect(repo.getPersonEntitiesByEmail("shared@example.com")).resolves.toEqual([
      expect.objectContaining({ id: "live-person" }),
    ]);
    await expect(relationsRepo.listRelationsForEntity("source-person", { limit: 10 })).resolves.toMatchObject({
      outgoing: [expect.objectContaining({ targetEntityId: "live-person" })],
      incoming: [],
    });

    await insertEntity(db, { id: "deleted-company", name: "Reusable Company", sourceType: "company" });
    await tombstoneEntity(db, "deleted-company", { deletedAt: "2026-01-01T00:00:00.000Z" });
    const upsertedCompany = await repo.upsertEntity({ name: "Reusable Company", sourceType: "company" });
    expect(upsertedCompany.id).not.toBe("deleted-company");

    await insertEntity(db, { id: "merged-product", name: "Reusable Product", sourceType: "product" });
    await tombstoneEntity(db, "merged-product", { mergedIntoEntityId: "live-person" });
    const upsertedProduct = await repo.upsertLlmExtractedEntity({ name: "Reusable Product", sourceType: "product" });
    expect(upsertedProduct.entity.id).not.toBe("merged-product");

    await insertEntity(db, {
      id: "merged-email-person",
      name: "Reusable Person",
      metadata: { email: "reusable@example.com" },
    });
    await tombstoneEntity(db, "merged-email-person", { mergedIntoEntityId: "live-person" });
    const upsertedPerson = await repo.upsertPersonEntity({
      name: "Reusable Person",
      email: "reusable@example.com",
      subtype: "external",
      source: "test",
      sourceId: "reusable-person",
    });
    expect(upsertedPerson.id).not.toBe("merged-email-person");
  });
});

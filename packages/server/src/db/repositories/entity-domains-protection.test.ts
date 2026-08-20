import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityDomainsRepository } from "./entity-domains";

describe("relationship protection guards", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(name: string, sourceType: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({ id, name, source_type: sourceType, status: "confirmed", hotness: 0, created_at: now, updated_at: now })
      .execute();
    return id;
  }

  async function seedEdge(sourceId: string, targetId: string, type: string, source: string): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto("entity_relationships")
      .values({
        id,
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: type,
        confidence: source === "declared" ? "CONFIRMED" : "EXTRACTED",
        confidence_score: source === "declared" ? 1 : 0.7,
        source,
        valid_from: "",
      })
      .execute();
    return id;
  }

  it("llm upsert onto a declared edge keeps the declared source and confidence", async () => {
    const project = await seedEntity("One Stop", "project");
    const company = await seedEntity("One Stop AI", "company");
    await seedEdge(project, company, "engagement_for", "declared");

    const repo = createEntityDomainsRepository(db);
    await repo.upsertRelationship({
      sourceEntityId: project,
      targetEntityId: company,
      relationshipType: "engagement_for",
      confidence: "EXTRACTED",
      confidenceScore: 0.8,
      source: "llm_extraction",
    });

    const row = await db
      .selectFrom("entity_relationships")
      .select(["source", "confidence"])
      .where("source_entity_id", "=", project)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ source: "declared", confidence: "CONFIRMED" });
  });

  it("both empty-relationship deleters preserve an evidence-less user_grouping edge", async () => {
    const project = await seedEntity("Habuild", "project");
    const company = await seedEntity("Habuild Health", "company");
    const edgeId = await seedEdge(project, company, "engagement_for", "user_grouping");

    const repo = createEntityDomainsRepository(db);
    await repo.cleanupEmptyRelationships();
    await repo.deleteEmptyRelationshipsByIds([edgeId]);

    const survivors = await db.selectFrom("entity_relationships").select("id").execute();
    expect(survivors).toEqual([{ id: edgeId }]);
  });

  it("both empty-relationship deleters still remove an evidence-less llm edge", async () => {
    const project = await seedEntity("Phantom", "project");
    const company = await seedEntity("Phantom Co", "company");
    const first = await seedEdge(project, company, "engagement_for", "llm_extraction");

    const repo = createEntityDomainsRepository(db);
    expect(await repo.cleanupEmptyRelationships()).toBe(1);

    const second = await seedEdge(company, project, "partner_of", "llm_extraction");
    expect(await repo.deleteEmptyRelationshipsByIds([second])).toBe(1);

    const survivors = await db.selectFrom("entity_relationships").select("id").execute();
    expect(survivors.map((row) => row.id)).not.toContain(first);
    expect(survivors).toHaveLength(0);
  });
});

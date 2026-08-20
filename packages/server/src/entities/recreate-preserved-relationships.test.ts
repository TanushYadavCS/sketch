import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { declareRelationship } from "./declare-relationship";
import { resetDerivedEntityData } from "./recreate";

describe("reset preservation for human-written relationships", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(name: string, sourceType: string, provenanceTier: string): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: sourceType,
        status: "confirmed",
        provenance_tier: provenanceTier,
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
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
        confidence: "CONFIRMED",
        confidence_score: 1,
        source,
        valid_from: "",
      })
      .execute();
    return id;
  }

  it("preserves a declared edge between two preserved-tier entities", async () => {
    const person = await seedEntity("Arun", "person", "human_confirmed");
    const company = await seedEntity("One Stop AI", "company", "declared");
    const edgeId = await seedEdge(person, company, "works_at", "declared");
    await seedEdge(person, company, "engaged_with", "llm_extraction");

    await resetDerivedEntityData(db, createTestLogger());

    const survivors = await db.selectFrom("entity_relationships").select("id").execute();
    expect(survivors).toEqual([{ id: edgeId }]);
  });

  it("drops a human edge when one endpoint is inferred-tier", async () => {
    const project = await seedEntity("Sprint Board", "project", "inferred");
    const company = await seedEntity("Habuild Health", "company", "declared");
    await seedEdge(project, company, "engagement_for", "user_grouping");

    await resetDerivedEntityData(db, createTestLogger());

    const survivors = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(survivors).toHaveLength(0);
  });

  it("declaring an edge promotes an inferred endpoint without touching a declared one", async () => {
    const person = await seedEntity("Nikhil", "person", "inferred");
    const company = await seedEntity("One Stop AI", "company", "declared");

    await declareRelationship(db, { personEntityId: person, companyEntityId: company, relationshipType: "works_at" });

    const tiers = await db
      .selectFrom("entities")
      .select(["id", "provenance_tier"])
      .where("id", "in", [person, company])
      .execute();
    const byId = new Map(tiers.map((row) => [row.id, row.provenance_tier]));
    expect(byId.get(person)).toBe("human_confirmed");
    expect(byId.get(company)).toBe("declared");
  });
});

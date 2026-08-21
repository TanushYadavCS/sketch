import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { mergeEntities, unmergeEntities } from "./merge";

describe("merge collision provenance transfer", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "u1", name: "U", email: "u@example.com" }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(id: string, name: string, sourceType: string): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({ id, name, source_type: sourceType, status: "confirmed", hotness: 0, created_at: now, updated_at: now })
      .execute();
  }

  async function seedEdge(id: string, sourceId: string, targetId: string, source: string): Promise<void> {
    await db
      .insertInto("entity_relationships")
      .values({
        id,
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: "engagement_for",
        confidence: source === "declared" ? "CONFIRMED" : "EXTRACTED",
        confidence_score: source === "declared" ? 1 : 0.8,
        source,
        valid_from: "",
      })
      .execute();
  }

  async function survivorEdge(): Promise<{ id: string; source: string; confidence: string }> {
    return db
      .selectFrom("entity_relationships")
      .select(["id", "source", "confidence"])
      .where("source_entity_id", "=", "project")
      .where("target_entity_id", "=", "company-survivor")
      .executeTakeFirstOrThrow();
  }

  it("declared edge on the loser upgrades the colliding occupant row", async () => {
    await seedEntity("project", "One Stop", "project");
    await seedEntity("company-survivor", "One Stop AI", "company");
    await seedEntity("company-loser", "OSAI", "company");
    await seedEdge("edge-occupant", "project", "company-survivor", "llm_extraction");
    await seedEdge("edge-declared", "project", "company-loser", "declared");

    await mergeEntities(db, { survivorId: "company-survivor", loserId: "company-loser", userId: "u1" });

    const edges = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(edges).toHaveLength(1);
    expect(await survivorEdge()).toEqual({ id: "edge-occupant", source: "declared", confidence: "CONFIRMED" });
  });

  it("unmerge restores the occupant's original provenance and reinserts the declared row", async () => {
    await seedEntity("project", "One Stop", "project");
    await seedEntity("company-survivor", "One Stop AI", "company");
    await seedEntity("company-loser", "OSAI", "company");
    await seedEdge("edge-occupant", "project", "company-survivor", "llm_extraction");
    await seedEdge("edge-declared", "project", "company-loser", "declared");

    const { mergeId } = await mergeEntities(db, {
      survivorId: "company-survivor",
      loserId: "company-loser",
      userId: "u1",
    });
    await unmergeEntities(db, { mergeId, userId: "u1" });

    expect(await survivorEdge()).toEqual({ id: "edge-occupant", source: "llm_extraction", confidence: "EXTRACTED" });
    const restored = await db
      .selectFrom("entity_relationships")
      .select(["source", "confidence", "target_entity_id"])
      .where("id", "=", "edge-declared")
      .executeTakeFirstOrThrow();
    expect(restored).toEqual({ source: "declared", confidence: "CONFIRMED", target_entity_id: "company-loser" });
  });

  it("an inferred edge folding into a declared occupant does not demote it", async () => {
    await seedEntity("project", "One Stop", "project");
    await seedEntity("company-survivor", "One Stop AI", "company");
    await seedEntity("company-loser", "OSAI", "company");
    await seedEdge("edge-occupant", "project", "company-survivor", "declared");
    await seedEdge("edge-inferred", "project", "company-loser", "llm_extraction");

    await mergeEntities(db, { survivorId: "company-survivor", loserId: "company-loser", userId: "u1" });

    const edges = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(edges).toHaveLength(1);
    expect(await survivorEdge()).toEqual({ id: "edge-occupant", source: "declared", confidence: "CONFIRMED" });
  });
});

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { declareCompany, repointEngagements } from "./declare-company";

async function seedEntity(db: Kysely<DB>, name: string, sourceType: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({ id, name, source_type: sourceType, status: "confirmed", hotness: 0, created_at: now, updated_at: now })
    .execute();
  return id;
}

async function seedEngagement(db: Kysely<DB>, sourceId: string, targetId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: "engagement_for",
      confidence: "high",
      confidence_score: 1,
      source: "test",
    })
    .execute();
  return id;
}

describe("declare-company repoint", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("moves a wrong engagement edge to the declared company and is a no-op on rerun", async () => {
    const wrongCompany = await seedEntity(db, "Own Org", "company");
    const project = await seedEntity(db, "One Stop", "project");
    const edgeId = await seedEngagement(db, project, wrongCompany);
    const { entityId: company } = await declareCompany(db, { name: "One Stop AI", aliases: ["OSAI"] });

    const first = await repointEngagements(db, { projectEntityIds: [project], companyEntityId: company });
    expect(first).toEqual([
      {
        projectEntityId: project,
        action: "repointed",
        relationshipId: edgeId,
        oldTargetId: wrongCompany,
        newTargetId: company,
      },
    ]);

    const second = await repointEngagements(db, { projectEntityIds: [project], companyEntityId: company });
    expect(second[0].action).toBe("already_correct");
    const edges = await db
      .selectFrom("entity_relationships")
      .select(["target_entity_id"])
      .where("source_entity_id", "=", project)
      .execute();
    expect(edges).toEqual([{ target_entity_id: company }]);
  });

  it("refuses a project with no engagement edge instead of inventing one", async () => {
    const project = await seedEntity(db, "Edgeless", "project");
    const { entityId: company } = await declareCompany(db, { name: "Some Client", aliases: [] });

    const results = await repointEngagements(db, { projectEntityIds: [project], companyEntityId: company });
    expect(results[0].action).toBe("no_engagement_edge");
    const edges = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("source_entity_id", "=", project)
      .execute();
    expect(edges).toHaveLength(0);
  });

  it("declaring the same company twice upserts into one declared entity", async () => {
    const first = await declareCompany(db, { name: "One Stop AI", aliases: ["OSAI"] });
    const second = await declareCompany(db, { name: "One Stop AI", aliases: ["One Stop"] });
    expect(second.entityId).toBe(first.entityId);
    const row = await db
      .selectFrom("entities")
      .select(["provenance_tier"])
      .where("id", "=", first.entityId)
      .executeTakeFirstOrThrow();
    expect(row.provenance_tier).toBe("declared");
  });
});

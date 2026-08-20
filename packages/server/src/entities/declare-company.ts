import type { Kysely } from "kysely";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { DECLARED_RELATIONSHIP_SOURCE } from "./relationship-provenance";

/**
 * Manual declaration seam for counterparties that have no email domain (the
 * WhatsApp-first client case). Declaration reuses the same repo path the
 * POST /api/entities route takes — upsert by name, declared provenance — so a
 * declared company that later gains structure upgrades in place instead of
 * duplicating. Repointing refuses to invent edges: it only moves an existing
 * engagement_for edge, because a wrong target is a correction while a missing
 * edge is a backfill decision that belongs to the cleanup pass.
 */

export type RepointResult = {
  projectEntityId: string;
  action: "repointed" | "already_correct" | "no_engagement_edge";
  relationshipId: string | null;
  oldTargetId: string | null;
  newTargetId: string;
};

export async function declareCompany(
  db: Kysely<DB>,
  input: { name: string; aliases: string[] },
): Promise<{ entityId: string }> {
  const repo = createEntityRepository(db);
  const entity = await repo.upsertEntity({
    name: input.name,
    sourceType: "company",
    aliases: input.aliases,
    status: "confirmed",
    provenanceTier: "declared",
  });
  return { entityId: entity.id };
}

export async function repointEngagements(
  db: Kysely<DB>,
  input: { projectEntityIds: string[]; companyEntityId: string },
): Promise<RepointResult[]> {
  const results: RepointResult[] = [];
  for (const projectEntityId of input.projectEntityIds) {
    const edges = await db
      .selectFrom("entity_relationships")
      .select(["id", "target_entity_id"])
      .where("source_entity_id", "=", projectEntityId)
      .where("relationship_type", "=", "engagement_for")
      .execute();
    if (edges.length === 0) {
      results.push({
        projectEntityId,
        action: "no_engagement_edge",
        relationshipId: null,
        oldTargetId: null,
        newTargetId: input.companyEntityId,
      });
      continue;
    }
    const correct = edges.find((edge) => edge.target_entity_id === input.companyEntityId);
    if (correct) {
      const stale = edges.filter((edge) => edge.id !== correct.id);
      if (stale.length > 0) {
        await db
          .deleteFrom("entity_relationships")
          .where(
            "id",
            "in",
            stale.map((edge) => edge.id),
          )
          .execute();
      }
      results.push({
        projectEntityId,
        action: "already_correct",
        relationshipId: correct.id,
        oldTargetId: stale[0]?.target_entity_id ?? null,
        newTargetId: input.companyEntityId,
      });
      continue;
    }
    const edge = edges[0];
    await db
      .updateTable("entity_relationships")
      .set({
        target_entity_id: input.companyEntityId,
        source: DECLARED_RELATIONSHIP_SOURCE,
        confidence: "CONFIRMED",
        confidence_score: 1,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", edge.id)
      .execute();
    const extras = edges.filter((other) => other.id !== edge.id);
    if (extras.length > 0) {
      await db
        .deleteFrom("entity_relationships")
        .where(
          "id",
          "in",
          extras.map((other) => other.id),
        )
        .execute();
    }
    results.push({
      projectEntityId,
      action: "repointed",
      relationshipId: edge.id,
      oldTargetId: edge.target_entity_id,
      newTargetId: input.companyEntityId,
    });
  }
  return results;
}

import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../db/schema";
import { LLM_RELATION_CONFIDENCE_THRESHOLD } from "./graph";

export type NeighborSet = Set<string>;

export interface BuildAdjacencyIndexOptions {
  coMentionMinShared?: number;
  coMentionTopK?: number;
  hubDegreeCap?: number;
}

const DEFAULT_CO_MENTION_MIN_SHARED = 2;
const DEFAULT_CO_MENTION_TOP_K = 25;
const DEFAULT_HUB_DEGREE_CAP = 30;

/**
 * Builds a typed adjacency fingerprint for each entity from current
 * high-confidence graph relationships and repeated distinct-file co-mentions.
 * High-degree keys are removed after indexing so ubiquitous people, parents, or
 * broad file co-mentions cannot dominate overlap.
 */
export async function buildAdjacencyIndex(
  db: Kysely<DB>,
  entityIds: string[],
  options: BuildAdjacencyIndexOptions = {},
): Promise<Map<string, NeighborSet>> {
  const uniqueIds = [...new Set(entityIds)].sort();
  const index = new Map<string, NeighborSet>(uniqueIds.map((id) => [id, new Set<string>()]));
  if (uniqueIds.length === 0) return index;

  const coMentionMinShared = options.coMentionMinShared ?? DEFAULT_CO_MENTION_MIN_SHARED;
  const coMentionTopK = options.coMentionTopK ?? DEFAULT_CO_MENTION_TOP_K;
  const hubDegreeCap = options.hubDegreeCap ?? DEFAULT_HUB_DEGREE_CAP;

  const relationshipRows = await db
    .selectFrom("entity_relationships")
    .select(["source_entity_id", "target_entity_id", "relationship_type"])
    .where((eb) => eb.or([eb("source_entity_id", "in", uniqueIds), eb("target_entity_id", "in", uniqueIds)]))
    .where("valid_to", "is", null)
    .where("confidence", "!=", "AMBIGUOUS")
    .where("confidence_score", ">=", LLM_RELATION_CONFIDENCE_THRESHOLD)
    .execute();

  const requested = new Set(uniqueIds);
  for (const row of relationshipRows) {
    if (requested.has(row.source_entity_id)) {
      index.get(row.source_entity_id)?.add(`rel:${row.relationship_type}:${row.target_entity_id}`);
    }
    if (requested.has(row.target_entity_id)) {
      index.get(row.target_entity_id)?.add(`rel:${row.relationship_type}:${row.source_entity_id}`);
    }
  }

  const coMentionRows = await db
    .selectFrom("entity_mentions as subject_mention")
    .innerJoin("entity_mentions as other_mention", "other_mention.indexed_file_id", "subject_mention.indexed_file_id")
    .innerJoin("indexed_files", "indexed_files.id", "subject_mention.indexed_file_id")
    .innerJoin("entities as other_entity", "other_entity.id", "other_mention.entity_id")
    .select([
      "subject_mention.entity_id as subjectEntityId",
      "other_mention.entity_id as otherEntityId",
      sql<number>`COUNT(DISTINCT subject_mention.indexed_file_id)`.as("sharedFileCount"),
    ])
    .where("subject_mention.entity_id", "in", uniqueIds)
    .whereRef("other_mention.entity_id", "!=", "subject_mention.entity_id")
    .where("indexed_files.is_archived", "=", 0)
    .where("other_entity.deleted_at", "is", null)
    .where("other_entity.merged_into_entity_id", "is", null)
    .groupBy(["subject_mention.entity_id", "other_mention.entity_id"])
    .having(sql<number>`COUNT(DISTINCT subject_mention.indexed_file_id)`, ">=", coMentionMinShared)
    .orderBy("subject_mention.entity_id", "asc")
    .orderBy("sharedFileCount", "desc")
    .orderBy("other_mention.entity_id", "asc")
    .execute();

  const coMentionCountsBySubject = new Map<string, number>();
  for (const row of coMentionRows) {
    const used = coMentionCountsBySubject.get(row.subjectEntityId) ?? 0;
    if (used >= coMentionTopK) continue;
    index.get(row.subjectEntityId)?.add(`co:${row.otherEntityId}`);
    coMentionCountsBySubject.set(row.subjectEntityId, used + 1);
  }

  pruneHubNeighbors(index, hubDegreeCap);
  return index;
}

export function overlapCoefficient(a: NeighborSet, b: NeighborSet): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const key of smaller) {
    if (larger.has(key)) intersection += 1;
  }
  return intersection / smaller.size;
}

/**
 * Returns a determinate canonical company scope only for current
 * high-confidence ownership/client relationships. Multiple distinct canonical
 * company ids intentionally collapse to null instead of guessing.
 */
export async function owningCompanyScope(db: Kysely<DB>, entityId: string): Promise<string | null> {
  const rows = await db
    .selectFrom("entity_relationships")
    .innerJoin("entities as source_entity", "source_entity.id", "entity_relationships.source_entity_id")
    .innerJoin("entities as target_entity", "target_entity.id", "entity_relationships.target_entity_id")
    .select([
      "entity_relationships.source_entity_id",
      "entity_relationships.target_entity_id",
      "entity_relationships.relationship_type",
      "source_entity.source_type as sourceType",
      "source_entity.merged_into_entity_id as sourceMergedIntoEntityId",
      "target_entity.source_type as targetType",
      "target_entity.merged_into_entity_id as targetMergedIntoEntityId",
    ])
    .where((eb) => eb.or([eb("source_entity_id", "=", entityId), eb("target_entity_id", "=", entityId)]))
    .where("entity_relationships.valid_to", "is", null)
    .where("entity_relationships.confidence", "!=", "AMBIGUOUS")
    .where("entity_relationships.confidence_score", ">=", LLM_RELATION_CONFIDENCE_THRESHOLD)
    .execute();

  const companyIds = new Set<string>();
  for (const row of rows) {
    if (row.relationship_type === "builds" && row.target_entity_id === entityId && row.sourceType === "company") {
      companyIds.add(row.sourceMergedIntoEntityId ?? row.source_entity_id);
    }
    if (
      row.relationship_type === "engagement_for" &&
      row.source_entity_id === entityId &&
      row.targetType === "company"
    ) {
      companyIds.add(row.targetMergedIntoEntityId ?? row.target_entity_id);
    }
    if (row.relationship_type === "part_of" && row.source_entity_id === entityId && row.targetType === "company") {
      companyIds.add(row.targetMergedIntoEntityId ?? row.target_entity_id);
    }
    if (row.relationship_type === "part_of" && row.target_entity_id === entityId && row.sourceType === "company") {
      companyIds.add(row.sourceMergedIntoEntityId ?? row.source_entity_id);
    }
  }

  return companyIds.size === 1 ? [...companyIds][0] : null;
}

function pruneHubNeighbors(index: Map<string, NeighborSet>, hubDegreeCap: number): void {
  const degreeByNeighbor = new Map<string, Set<string>>();
  for (const [entityId, neighbors] of index) {
    for (const neighbor of neighbors) {
      const degree = degreeByNeighbor.get(neighbor);
      if (degree) degree.add(entityId);
      else degreeByNeighbor.set(neighbor, new Set([entityId]));
    }
  }

  const hubs = new Set(
    [...degreeByNeighbor].filter(([, entityIds]) => entityIds.size > hubDegreeCap).map(([neighbor]) => neighbor),
  );
  if (hubs.size === 0) return;

  for (const neighbors of index.values()) {
    for (const hub of hubs) neighbors.delete(hub);
  }
}

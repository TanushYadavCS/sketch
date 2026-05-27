import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../schema";
import { type FileViewer, fileVisibilityPredicate } from "./connectors";

export type RelationConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface RelationListEntry {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  confidence: string;
  confidenceScore: number;
  source: string;
  validFrom: string | null;
  validTo: string | null;
  other: {
    id: string;
    name: string;
    sourceType: string;
    aliases: string[];
  };
  evidenceCount: number;
}

export interface RelationEvidenceRow {
  fileId: string;
  fileName: string;
  sourceType: string;
  occurredAt: string;
  chunkIndex: number | null;
  contextSnippet: string | null;
  sourceFactId: string | null;
  note: string | null;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function createEntityRelationshipsRepository(db: Kysely<DB>) {
  return {
    /**
     * Lists relations involving `entityId`, partitioned into outgoing (entity is
     * source) and incoming (entity is target). Caps each side at `limit` rows;
     * `truncated` is true if either side hit the cap. Aggregates evidence count
     * via a correlated subquery — no RBAC at this layer (counts are not
     * file-sensitive; per-row visibility lands in `listEvidenceForRelation`).
     */
    async listRelationsForEntity(
      entityId: string,
      opts: { limit: number },
    ): Promise<{
      outgoing: RelationListEntry[];
      incoming: RelationListEntry[];
      truncated: boolean;
      totalCount: number;
    }> {
      const { limit } = opts;
      const evidenceCount = sql<number>`(
        SELECT COUNT(*) FROM entity_relationship_evidence
        WHERE entity_relationship_evidence.relationship_id = entity_relationships.id
      )`;
      const confidenceOrder = sql<number>`CASE entity_relationships.confidence
        WHEN 'AMBIGUOUS' THEN 0
        WHEN 'EXTRACTED' THEN 1
        WHEN 'INFERRED' THEN 2
        ELSE 3
      END`;
      const confidenceScore = sql<number>`COALESCE(entity_relationships.confidence_score, 0)`;

      const outgoingRows = await db
        .selectFrom("entity_relationships")
        .innerJoin("entities", "entities.id", "entity_relationships.target_entity_id")
        .select([
          "entity_relationships.id",
          "entity_relationships.source_entity_id",
          "entity_relationships.target_entity_id",
          "entity_relationships.relationship_type",
          "entity_relationships.confidence",
          "entity_relationships.confidence_score",
          "entity_relationships.source",
          "entity_relationships.valid_from",
          "entity_relationships.valid_to",
          "entities.id as other_id",
          "entities.name as other_name",
          "entities.source_type as other_source_type",
          "entities.aliases as other_aliases",
          evidenceCount.as("evidence_count"),
        ])
        .where("entity_relationships.source_entity_id", "=", entityId)
        .where("entities.status", "!=", "archived")
        .orderBy(confidenceOrder)
        .orderBy(evidenceCount, "desc")
        .orderBy(confidenceScore, "desc")
        .orderBy("entities.name", "asc")
        .orderBy("entity_relationships.id", "asc")
        .limit(limit + 1)
        .execute();

      const incomingRows = await db
        .selectFrom("entity_relationships")
        .innerJoin("entities", "entities.id", "entity_relationships.source_entity_id")
        .select([
          "entity_relationships.id",
          "entity_relationships.source_entity_id",
          "entity_relationships.target_entity_id",
          "entity_relationships.relationship_type",
          "entity_relationships.confidence",
          "entity_relationships.confidence_score",
          "entity_relationships.source",
          "entity_relationships.valid_from",
          "entity_relationships.valid_to",
          "entities.id as other_id",
          "entities.name as other_name",
          "entities.source_type as other_source_type",
          "entities.aliases as other_aliases",
          evidenceCount.as("evidence_count"),
        ])
        .where("entity_relationships.target_entity_id", "=", entityId)
        .where("entities.status", "!=", "archived")
        .orderBy(confidenceOrder)
        .orderBy(evidenceCount, "desc")
        .orderBy(confidenceScore, "desc")
        .orderBy("entities.name", "asc")
        .orderBy("entity_relationships.id", "asc")
        .limit(limit + 1)
        .execute();

      const outgoingTruncated = outgoingRows.length > limit;
      const incomingTruncated = incomingRows.length > limit;

      const map = (rows: typeof outgoingRows): RelationListEntry[] =>
        rows.slice(0, limit).map((r) => ({
          id: r.id,
          sourceEntityId: r.source_entity_id,
          targetEntityId: r.target_entity_id,
          relationshipType: r.relationship_type,
          confidence: r.confidence,
          confidenceScore: Number(r.confidence_score ?? 0),
          source: r.source,
          validFrom: r.valid_from ?? null,
          validTo: r.valid_to ?? null,
          other: {
            id: r.other_id,
            name: r.other_name,
            sourceType: r.other_source_type,
            aliases: parseAliases(r.other_aliases),
          },
          evidenceCount: Number(r.evidence_count ?? 0),
        }));

      return {
        outgoing: map(outgoingRows),
        incoming: map(incomingRows),
        truncated: outgoingTruncated || incomingTruncated,
        totalCount: Math.min(outgoingRows.length, limit) + Math.min(incomingRows.length, limit),
      };
    },

    /**
     * Lists evidence rows backing a single relation, with file-level RBAC.
     * Returns visible rows (capped at `limit`), plus `visibleCount` (rows the
     * viewer is permitted to see) vs `totalCount` (rows that exist). The
     * difference is the "N more not visible to you" signal the drawer renders;
     * file names and snippets are never leaked for hidden rows.
     *
     * Chunk index sentinel `-1` (no chunk) is normalized to `null`.
     */
    async listEvidenceForRelation(
      relationshipId: string,
      opts: { limit: number; viewer: FileViewer },
    ): Promise<{
      rows: RelationEvidenceRow[];
      visibleCount: number;
      totalCount: number;
      truncated: boolean;
    }> {
      const { limit, viewer } = opts;

      const totalRow = await db
        .selectFrom("entity_relationship_evidence")
        .innerJoin("indexed_files", "indexed_files.id", "entity_relationship_evidence.indexed_file_id")
        .select(sql<number>`count(*)`.as("c"))
        .where("entity_relationship_evidence.relationship_id", "=", relationshipId)
        .executeTakeFirst();
      const totalCount = Number(totalRow?.c ?? 0);

      let visibleCountQuery = db
        .selectFrom("entity_relationship_evidence")
        .innerJoin("indexed_files", "indexed_files.id", "entity_relationship_evidence.indexed_file_id")
        .select(sql<number>`count(*)`.as("c"))
        .where("entity_relationship_evidence.relationship_id", "=", relationshipId);
      if (!viewer.isAdmin) {
        visibleCountQuery = visibleCountQuery.where(fileVisibilityPredicate(viewer));
      }
      const visibleRow = await visibleCountQuery.executeTakeFirst();
      const visibleCount = Number(visibleRow?.c ?? 0);

      let rowsQuery = db
        .selectFrom("entity_relationship_evidence")
        .innerJoin("indexed_files", "indexed_files.id", "entity_relationship_evidence.indexed_file_id")
        .leftJoin("indexed_file_facts", "indexed_file_facts.id", "entity_relationship_evidence.source_fact_id")
        .select([
          "indexed_files.id as file_id",
          "indexed_files.file_name",
          "indexed_files.source as file_source",
          "indexed_files.source_updated_at",
          "indexed_files.source_created_at",
          "entity_relationship_evidence.chunk_index",
          "entity_relationship_evidence.note",
          "entity_relationship_evidence.source_fact_id",
          "indexed_file_facts.context_snippet as fact_context_snippet",
          "entity_relationship_evidence.created_at",
        ])
        .where("entity_relationship_evidence.relationship_id", "=", relationshipId)
        .orderBy(
          sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_relationship_evidence.created_at)`,
          "desc",
        )
        .limit(limit);
      if (!viewer.isAdmin) {
        rowsQuery = rowsQuery.where(fileVisibilityPredicate(viewer));
      }
      const rows = await rowsQuery.execute();

      return {
        rows: rows.map((r) => ({
          fileId: r.file_id,
          fileName: r.file_name,
          sourceType: r.file_source,
          occurredAt: r.source_updated_at ?? r.source_created_at ?? r.created_at,
          chunkIndex: r.chunk_index === -1 ? null : (r.chunk_index ?? null),
          contextSnippet: r.fact_context_snippet ?? null,
          sourceFactId: r.source_fact_id ?? null,
          note: r.note ?? null,
        })),
        visibleCount,
        totalCount,
        truncated: visibleCount > limit,
      };
    },

    /** Fetch a single relationship row by id — used by the evidence route to verify it exists. */
    async getRelationship(id: string) {
      return db.selectFrom("entity_relationships").selectAll().where("id", "=", id).executeTakeFirst();
    },
  };
}

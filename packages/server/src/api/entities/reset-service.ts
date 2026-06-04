import type { Kysely } from "kysely";
import { sql } from "kysely";
import { isPg } from "../../db/dialect";
import type { IndexedFileFactType } from "../../db/repositories/indexed-file-facts";
import type { DB } from "../../db/schema";
import type { ResetSummary } from "../../entities/recreate";
import type { ReenrichScope } from "../../entities/reenrich";

export type ResetCategory = "manual" | "connectors" | "ai";

export interface ResetRequest {
  categories: ResetCategory[];
  runAfter: boolean;
  wipeLlmFacts?: boolean;
}

export const FACT_TYPES_BY_CATEGORY: Record<ResetCategory, IndexedFileFactType[]> = {
  connectors: ["structural_seed", "person_seed", "attendee", "correspondent", "assignee", "author", "parent_entity"],
  ai: ["llm_extracted", "llm_relation"],
  manual: [],
};

export interface ResetExecutionOptions {
  includeConnectors: boolean;
  includeAi: boolean;
  includeManual: boolean;
  orgSourceTypes: string[];
  factTypes: IndexedFileFactType[];
}

export interface ResetExecutionResult {
  entitiesDeleted: number;
  resetSummary: ResetSummary;
}

export function parseReenrichScope(scope: unknown): ReenrichScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const value = scope as Record<string, unknown>;
  if (value.all === true) return { all: true };
  if (Array.isArray(value.fileIds)) {
    return { fileIds: value.fileIds.filter((id): id is string => typeof id === "string") };
  }
  if (Array.isArray(value.sources)) {
    return { sources: value.sources.filter((source): source is string => typeof source === "string") };
  }
  return null;
}

const AI_ORIGIN_EXPR = (db: Kysely<DB>) =>
  isPg(db) ? sql`(metadata::jsonb ->> 'origin')` : sql`json_extract(metadata, '$.origin')`;

export async function computeResetCounts(
  db: Kysely<DB>,
  flags: { includeConnectors: boolean; includeAi: boolean; includeManual: boolean },
  orgSourceTypes: string[],
): Promise<{
  entitiesDeleted: number;
  candidatesCleared: number;
  reviewQueueCleared: number;
  reviewEvidenceCleared: number;
  rejectionsCleared: number;
}> {
  const toDelete = await selectEntitiesForCategories(db, flags, orgSourceTypes).execute();
  const candidates =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_candidates").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const queue =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_review_queue").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const evidence =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_review_evidence").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const rejections =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_alias_rejections").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  return {
    entitiesDeleted: toDelete.length,
    candidatesCleared: Number(candidates?.c ?? 0),
    reviewQueueCleared: Number(queue?.c ?? 0),
    reviewEvidenceCleared: Number(evidence?.c ?? 0),
    rejectionsCleared: Number(rejections?.c ?? 0),
  };
}

export function selectEntitiesForCategories(
  db: Kysely<DB>,
  flags: { includeConnectors: boolean; includeAi: boolean; includeManual: boolean },
  orgSourceTypes: string[],
) {
  const aiOrigin = AI_ORIGIN_EXPR(db);
  return db
    .selectFrom("entities as e")
    .select([
      "e.id as id",
      sql<number>`(SELECT COUNT(*) FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source = 'llm_extraction')`.as(
        "llm_ref_count",
      ),
      sql<number>`(SELECT COUNT(*) FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source != 'llm_extraction')`.as(
        "other_ref_count",
      ),
      sql<string | null>`${aiOrigin}`.as("ai_origin"),
      "e.source_type as source_type",
    ])
    .where((eb) => {
      const parts = [];
      if (flags.includeConnectors) {
        parts.push(
          eb.or([
            eb("e.source_type", "not in", orgSourceTypes),
            sql<boolean>`EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source != 'llm_extraction')`,
          ]),
        );
      }
      if (flags.includeAi) {
        parts.push(
          eb.or([
            eb(aiOrigin, "=", "ai"),
            sql<boolean>`EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source = 'llm_extraction')`,
          ]),
        );
      }
      if (flags.includeManual) {
        parts.push(
          eb.and([
            eb("e.source_type", "in", orgSourceTypes),
            sql<boolean>`NOT EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id)`,
            eb.or([eb(aiOrigin, "is", null), eb(aiOrigin, "!=", "ai")]),
          ]),
        );
      }
      return parts.length === 1 ? parts[0] : eb.or(parts);
    });
}

/**
 * Applies a category reset while preserving ownership boundaries for mixed
 * provenance entities. AI resets strip only LLM mentions/refs from connector
 * owned entities; connector resets strip only connector mentions/refs from
 * AI-only org entities. Entities fully owned by the selected category are
 * deleted, and selected fact types are marked unmaterialized for replay.
 */
export async function performReset(db: Kysely<DB>, opts: ResetExecutionOptions): Promise<ResetExecutionResult> {
  const rows = await selectEntitiesForCategories(
    db,
    { includeConnectors: opts.includeConnectors, includeAi: opts.includeAi, includeManual: opts.includeManual },
    opts.orgSourceTypes,
  ).execute();

  const idsForDeletion: string[] = [];
  const preservedConnectorIds: string[] = [];
  const preservedAiOnlyIds: string[] = [];
  for (const row of rows) {
    const llmRefs = Number(row.llm_ref_count ?? 0);
    const otherRefs = Number(row.other_ref_count ?? 0);
    const isConnectorOwned = otherRefs > 0 || !opts.orgSourceTypes.includes(row.source_type);
    const isAiOnly = !isConnectorOwned && (row.ai_origin === "ai" || llmRefs > 0);

    if (isConnectorOwned && opts.includeConnectors) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (isAiOnly && opts.includeAi) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (!isConnectorOwned && !isAiOnly && opts.includeManual) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (isConnectorOwned && opts.includeAi) preservedConnectorIds.push(row.id);
    if (isAiOnly && opts.includeConnectors) preservedAiOnlyIds.push(row.id);
  }

  let candidatesCleared = 0;
  let reviewQueueCleared = 0;
  let reviewEvidenceCleared = 0;
  let rejectionsCleared = 0;

  if (opts.includeConnectors || opts.includeAi) {
    const candidatesResult = await db.deleteFrom("entity_candidates").execute();
    candidatesCleared = Number(candidatesResult[0]?.numDeletedRows ?? 0);

    if (opts.includeConnectors) {
      const evidenceCount = await db
        .selectFrom("entity_review_evidence")
        .select(db.fn.count<number>("id").as("c"))
        .executeTakeFirst();
      reviewEvidenceCleared = Number(evidenceCount?.c ?? 0);

      const queueResult = await db.deleteFrom("entity_review_queue").execute();
      reviewQueueCleared = Number(queueResult[0]?.numDeletedRows ?? 0);

      const rejectionsResult = await db.deleteFrom("entity_alias_rejections").execute();
      rejectionsCleared = Number(rejectionsResult[0]?.numDeletedRows ?? 0);
    } else if (opts.includeAi) {
      const evidenceDeleted = await db
        .deleteFrom("entity_review_evidence")
        .where("source", "=", "llm_extraction")
        .execute();
      reviewEvidenceCleared = Number(evidenceDeleted[0]?.numDeletedRows ?? 0);
      const emptyQueueRows = await db
        .selectFrom("entity_review_queue")
        .select("id")
        .where("id", "not in", db.selectFrom("entity_review_evidence").select("review_id"))
        .execute();
      if (emptyQueueRows.length > 0) {
        const queueIds = emptyQueueRows.map((r) => r.id);
        await db.deleteFrom("entity_review_queue").where("id", "in", queueIds).execute();
        reviewQueueCleared = queueIds.length;
      }
    }
  }

  if (preservedConnectorIds.length > 0) {
    await db
      .deleteFrom("entity_mentions")
      .where("entity_id", "in", preservedConnectorIds)
      .where("source", "=", "llm_extraction")
      .execute();
    await db
      .deleteFrom("entity_source_refs")
      .where("entity_id", "in", preservedConnectorIds)
      .where("source", "=", "llm_extraction")
      .execute();
  }
  if (preservedAiOnlyIds.length > 0) {
    await db
      .deleteFrom("entity_mentions")
      .where("entity_id", "in", preservedAiOnlyIds)
      .where("source", "!=", "llm_extraction")
      .execute();
    await db
      .deleteFrom("entity_source_refs")
      .where("entity_id", "in", preservedAiOnlyIds)
      .where("source", "!=", "llm_extraction")
      .execute();
  }

  if (idsForDeletion.length > 0) {
    await db.deleteFrom("entity_mentions").where("entity_id", "in", idsForDeletion).execute();
    await db.deleteFrom("entity_source_refs").where("entity_id", "in", idsForDeletion).execute();
    await db.deleteFrom("entities").where("id", "in", idsForDeletion).execute();
  }

  let factsMarkedUnmaterialized = 0;
  if (opts.factTypes.length > 0) {
    const result = await db
      .updateTable("indexed_file_facts")
      .set({ materialized_at: null, updated_at: new Date().toISOString() })
      .where("fact_type", "in", opts.factTypes)
      .where("deleted_at", "is", null)
      .where("materialized_at", "is not", null)
      .executeTakeFirst();
    factsMarkedUnmaterialized = Number(result.numUpdatedRows ?? 0);
  }

  const resetSummary: ResetSummary = {
    dryRun: false,
    deleted: {
      entities: idsForDeletion.length,
      entity_candidates: candidatesCleared,
      entity_review_queue: reviewQueueCleared,
      entity_review_evidence: reviewEvidenceCleared,
      entity_alias_rejections: rejectionsCleared,
    },
    filesMarkedPending: 0,
    factsMarkedUnmaterialized,
    warnings: [],
  };

  return { entitiesDeleted: idsForDeletion.length, resetSummary };
}

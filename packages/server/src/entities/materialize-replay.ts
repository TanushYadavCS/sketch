import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";
import { heapStats, heapUsedMb } from "../lib/heap";
import { DEFAULT_FACT_BATCH_SIZE, type FactBatchCursor, forEachFactBatch } from "./fact-batches";
import { materializeCommitment } from "./materialize-commitment";
import { materializeContactPointFact } from "./materialize-contact-points";
import { materializeDecision } from "./materialize-decision";
import { buildMaterializeDeps } from "./materialize-deps";
import { materializeFeature } from "./materialize-feature";
import { readJsonObject } from "./materialize-json";
import { materializeLlmExtractedFact } from "./materialize-llm-mentions";
import { materializeMilestone } from "./materialize-milestone";
import { materializePersonFact, materializePersonSeed } from "./materialize-person";
import { materializeProjectSeed } from "./materialize-project";
import { materializeCrmRelationFact, materializeLlmRelationFact } from "./materialize-relations";
import { materializeParentEntity, materializeStructuralSeed } from "./materialize-structural";
import { materializeStructuralTask } from "./materialize-task";
import type {
  IndexedFileFactRow,
  MaterializeDeps,
  MaterializeFactsSummary,
  MaterializeResult,
  MaterializeUnmaterializedOptions,
  ReplayFactsSummary,
  ReplaySourceFactsOptions,
} from "./materialize-types";

const FACT_REPLAY_ORDER = [
  "structural_seed",
  "person_seed",
  "attendee",
  "correspondent",
  "assignee",
  "author",
  "contact_point",
  "parent_entity",
  "crm_relation",
  "llm_extracted",
  "llm_relation",
  "structural_task",
  "commitment",
  "feature",
  "decision",
  "milestone",
  "llm_task",
] as const;

const FACT_REPLAY_ORDER_RANK = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));

/**
 * Facts whose materialization throws this many times are quarantined: backlog
 * sweeps stop retrying them until their content changes (which resets the
 * counter). Without a cap, a fact that fails deterministically (e.g. an owner
 * foreign-key violation) is retried by every post-sync sweep forever.
 */
export const MAX_MATERIALIZATION_ATTEMPTS = 5;

/**
 * Fetch one keyset page of facts for a backlog-scoped pass. Rows are bounded by
 * `(created_at, id) > cursor`, ordered by `created_at` then `id` ascending, and
 * capped at `limit` so the caller holds at most one page (including `raw`
 * payloads) at a time. Types are processed in `FACT_REPLAY_ORDER` rank order;
 * within a type, `created_at` keeps facts in the chronological order the
 * pre-batching whole-table load produced in practice — sub-entity supersession
 * dedups a same-valued observation into its predecessor only when facts arrive
 * oldest-first — and `id` breaks same-timestamp ties deterministically.
 */
function fetchFactBatch(
  db: Kysely<DB>,
  cursor: FactBatchCursor,
  limit: number,
  filter: {
    factType?: string;
    factTypesIn?: readonly string[];
    factTypesNotIn?: readonly string[];
    onlyUnmaterialized: boolean;
  },
): Promise<IndexedFileFactRow[]> {
  let query = db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("created_at", ">", cursor.createdAt),
        eb.and([eb("created_at", "=", cursor.createdAt), eb("id", ">", cursor.id)]),
      ]),
    )
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(limit);
  if (filter.onlyUnmaterialized)
    query = query
      .where("materialized_at", "is", null)
      .where("materialization_attempts", "<", MAX_MATERIALIZATION_ATTEMPTS);
  if (filter.factType) query = query.where("fact_type", "=", filter.factType);
  if (filter.factTypesIn) query = query.where("fact_type", "in", [...filter.factTypesIn]);
  if (filter.factTypesNotIn) query = query.where("fact_type", "not in", [...filter.factTypesNotIn]);
  return query.execute();
}

export async function materializeFromFact(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (fact.fact_type === "structural_seed") {
    const raw = readJsonObject(fact.raw);
    if (raw.sourceType === "project") {
      return materializeProjectSeed(deps, fact);
    }
    return materializeStructuralSeed(deps, fact);
  }
  if (fact.fact_type === "person_seed") {
    return materializePersonSeed(deps, fact);
  }
  if (fact.fact_type === "contact_point") {
    return materializeContactPointFact(deps, fact);
  }
  if (fact.fact_type === "llm_extracted") {
    return materializeLlmExtractedFact(deps, fact);
  }
  if (fact.fact_type === "llm_relation") {
    return materializeLlmRelationFact(deps, fact);
  }
  if (fact.fact_type === "crm_relation") {
    return materializeCrmRelationFact(deps, fact);
  }
  if (
    fact.fact_type === "attendee" ||
    fact.fact_type === "correspondent" ||
    fact.fact_type === "assignee" ||
    fact.fact_type === "author"
  ) {
    return materializePersonFact(deps, fact);
  }
  if (fact.fact_type === "parent_entity") {
    return materializeParentEntity(deps, fact);
  }
  if (fact.fact_type === "structural_task") {
    return materializeStructuralTask(deps, fact);
  }
  if (fact.fact_type === "commitment") {
    return materializeCommitment(deps, fact);
  }
  if (fact.fact_type === "feature") {
    return materializeFeature(deps, fact);
  }
  if (fact.fact_type === "decision") {
    return materializeDecision(deps, fact);
  }
  if (fact.fact_type === "milestone") {
    return materializeMilestone(deps, fact);
  }
  if (fact.fact_type === "llm_task") {
    return { kind: "skipped", reason: "llm_task_disabled" };
  }
  return { kind: "skipped", reason: "unknown_fact_type" };
}

function accumulate(summary: ReplayFactsSummary, result: MaterializeResult): void {
  if (result.kind === "entity_created") {
    if (result.countEntity !== false) summary.entitiesCreated++;
    if (result.mentionWritten) summary.mentionsWritten++;
    return;
  }
  if (result.kind === "entity_linked") {
    if (result.countEntity !== false) summary.entitiesLinked++;
    if (result.mentionWritten) summary.mentionsWritten++;
    return;
  }
  if (result.kind === "queued") {
    summary.queued++;
    return;
  }
  if (result.kind === "queued_held") {
    summary.queued++;
    return;
  }
  if (result.kind === "relationship_materialized") {
    summary.entitiesCreated += result.entitiesCreated;
    summary.entitiesLinked += result.entitiesLinked;
    summary.mentionsWritten += result.mentionsWritten;
    summary.relationshipsWritten += result.relationshipsWritten;
    return;
  }
  if (result.kind === "task_materialized") {
    if ("materialized" in summary) (summary as MaterializeFactsSummary).materialized++;
    return;
  }
  if (result.kind === "commitment_materialized") {
    if ("materialized" in summary) (summary as MaterializeFactsSummary).materialized++;
    return;
  }
  if (result.kind === "feature_materialized") {
    if ("materialized" in summary) (summary as MaterializeFactsSummary).materialized++;
    return;
  }
  if (result.kind === "decision_materialized") {
    if ("materialized" in summary) (summary as MaterializeFactsSummary).materialized++;
    return;
  }
  if (result.kind === "milestone_materialized") {
    if ("materialized" in summary) (summary as MaterializeFactsSummary).materialized++;
    return;
  }
  if (
    result.kind === "skipped" ||
    result.kind === "skipped_missing_owner" ||
    result.kind === "deferred_below_threshold"
  ) {
    summary.skipped++;
  }
}

export async function replaySourceFacts(
  db: Kysely<DB>,
  logger: Logger,
  opts: ReplaySourceFactsOptions = {},
): Promise<ReplayFactsSummary> {
  const summary: ReplayFactsSummary = {
    factsRead: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    queued: 0,
    mentionsWritten: 0,
    relationshipsWritten: 0,
    skipped: 0,
  };

  const deps = await buildMaterializeDeps(db, {
    llmPromotionThreshold: opts.llmPromotionThreshold,
    llmTaskCorroborationThreshold: opts.llmTaskCorroborationThreshold,
    featureAutoMintThreshold: opts.featureAutoMintThreshold,
    logger,
    birthGateTypes: opts.birthGateTypes,
    birthGateLiveTypes: opts.birthGateLiveTypes,
    structuralAutoBirthTypes: opts.structuralAutoBirthTypes,
    birthGateDryRun: opts.birthGateDryRun,
    embeddingProvider: opts.embeddingProvider,
  });
  const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : DEFAULT_FACT_BATCH_SIZE;
  for (const factType of FACT_REPLAY_ORDER) {
    await forEachFactBatch(
      (cursor, limit) => fetchFactBatch(db, cursor, limit, { factType, onlyUnmaterialized: false }),
      async (facts) => {
        for (const fact of facts) {
          summary.factsRead++;
          try {
            const result = await materializeFromFact(deps, fact);
            accumulate(summary, result);
          } catch (err) {
            logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Replay failed for fact");
            summary.skipped++;
          }
          await yieldToEventLoop();
        }
      },
      batchSize,
    );
  }

  logger.info({ summary }, "Source-fact replay complete");
  return summary;
}

let materializeQueue: Promise<void> = Promise.resolve();

export async function materializeUnmaterializedFacts(
  db: Kysely<DB>,
  logger: Logger,
  opts: MaterializeUnmaterializedOptions = {},
): Promise<MaterializeFactsSummary> {
  const run = materializeQueue.then(() => materializeUnmaterializedFactsInner(db, logger, opts));
  materializeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function cleanupRelationshipEvidenceForFacts(db: Kysely<DB>, sourceFactIds: string[]): Promise<number> {
  return createEntityDomainsRepository(db).deleteEvidenceForSourceFacts(sourceFactIds);
}

export async function cleanupEmptyRelationships(db: Kysely<DB>): Promise<number> {
  return createEntityDomainsRepository(db).cleanupEmptyRelationships();
}

async function materializeUnmaterializedFactsInner(
  db: Kysely<DB>,
  logger: Logger,
  opts: MaterializeUnmaterializedOptions,
): Promise<MaterializeFactsSummary> {
  const startHeapMb = heapUsedMb();
  const summary: MaterializeFactsSummary = {
    factsRead: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    queued: 0,
    mentionsWritten: 0,
    relationshipsWritten: 0,
    skipped: 0,
    materialized: 0,
    deferred: 0,
    deferredBelowThreshold: 0,
  };

  const deps = await buildMaterializeDeps(db, {
    llmPromotionThreshold: opts.llmPromotionThreshold,
    llmTaskCorroborationThreshold: opts.llmTaskCorroborationThreshold,
    featureAutoMintThreshold: opts.featureAutoMintThreshold,
    logger,
    birthGateTypes: opts.birthGateTypes,
    birthGateLiveTypes: opts.birthGateLiveTypes,
    structuralAutoBirthTypes: opts.structuralAutoBirthTypes,
    birthGateDryRun: opts.birthGateDryRun,
    embeddingProvider: opts.embeddingProvider,
  });
  const factTypesFilter = opts.factTypes && opts.factTypes.length > 0 ? opts.factTypes : null;

  let countQuery = db
    .selectFrom("indexed_file_facts")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("deleted_at", "is", null)
    .where("materialized_at", "is", null)
    .where("materialization_attempts", "<", MAX_MATERIALIZATION_ATTEMPTS);
  if (factTypesFilter) {
    countQuery = countQuery.where("fact_type", "in", factTypesFilter);
  }
  const total = Number((await countQuery.executeTakeFirst())?.count ?? 0);
  let completed = 0;
  opts.onProgress?.({ phase: "materialize", completed: 0, total });

  const processFact = async (fact: IndexedFileFactRow): Promise<void> => {
    if (opts.shouldCancel?.()) throw new Error("Re-enrich stopped");
    summary.factsRead++;
    try {
      const result = await materializeFromFact(deps, fact);
      accumulate(summary, result);
      if (result.kind === "deferred_below_threshold") {
        summary.deferredBelowThreshold++;
      }
      if (shouldMarkMaterialized(result)) {
        await db
          .updateTable("indexed_file_facts")
          .set({ materialized_at: new Date().toISOString(), materialization_attempts: 0 })
          .where("id", "=", fact.id)
          .execute();
        if (
          result.kind !== "task_materialized" &&
          result.kind !== "commitment_materialized" &&
          result.kind !== "feature_materialized" &&
          result.kind !== "decision_materialized" &&
          result.kind !== "milestone_materialized"
        )
          summary.materialized++;
      } else {
        summary.deferred++;
      }
    } catch (err) {
      const attempts = fact.materialization_attempts + 1;
      const quarantined = attempts >= MAX_MATERIALIZATION_ATTEMPTS;
      logger.warn(
        { err, factId: fact.id, factType: fact.fact_type, attempts, quarantined },
        quarantined
          ? "Materialization failed for fact, quarantined from future sweeps"
          : "Materialization failed for fact",
      );
      await db
        .updateTable("indexed_file_facts")
        .set((eb) => ({
          materialization_attempts: eb("materialization_attempts", "+", 1),
          updated_at: new Date().toISOString(),
        }))
        .where("id", "=", fact.id)
        .execute();
      summary.skipped++;
      summary.deferred++;
    }
    completed++;
    opts.onProgress?.({ phase: "materialize", completed, total });
    await yieldToEventLoop();
  };

  const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : DEFAULT_FACT_BATCH_SIZE;
  const knownTypes = FACT_REPLAY_ORDER.filter((t) => !factTypesFilter || factTypesFilter.includes(t));
  for (const factType of knownTypes) {
    await forEachFactBatch(
      (cursor, limit) => fetchFactBatch(db, cursor, limit, { factType, onlyUnmaterialized: true }),
      async (facts) => {
        for (const fact of facts) await processFact(fact);
      },
      batchSize,
    );
  }

  /**
   * Facts whose type is absent from `FACT_REPLAY_ORDER` are processed last,
   * matching the single-pass tail where unrecognized types sorted to the end and
   * fell through to a `skipped: unknown_fact_type` result (kept unmaterialized).
   */
  const unknownRequested = factTypesFilter?.filter((t) => !FACT_REPLAY_ORDER_RANK.has(t)) ?? null;
  if (unknownRequested === null || unknownRequested.length > 0) {
    await forEachFactBatch(
      (cursor, limit) =>
        fetchFactBatch(db, cursor, limit, {
          ...(unknownRequested ? { factTypesIn: unknownRequested } : { factTypesNotIn: FACT_REPLAY_ORDER }),
          onlyUnmaterialized: true,
        }),
      async (facts) => {
        for (const fact of facts) await processFact(fact);
      },
      batchSize,
    );
  }

  await cleanupEmptyRelationships(db);
  logger.info({ summary, ...heapStats(startHeapMb) }, "Source-fact materialization complete");
  return summary;
}

export function shouldMarkMaterialized(result: MaterializeResult): boolean {
  if (
    result.kind === "entity_created" ||
    result.kind === "entity_linked" ||
    result.kind === "queued" ||
    result.kind === "relationship_materialized" ||
    result.kind === "task_materialized" ||
    result.kind === "commitment_materialized" ||
    result.kind === "feature_materialized" ||
    result.kind === "decision_materialized" ||
    result.kind === "milestone_materialized" ||
    result.kind === "structural"
  ) {
    return true;
  }
  if (result.kind === "skipped_missing_owner") return false;
  if (result.kind === "deferred_below_threshold") return false;
  if (result.kind === "skipped") {
    return (
      result.reason !== "missing_parent_seed" &&
      result.reason !== "missing_crm_relation_endpoint" &&
      result.reason !== "unknown_fact_type" &&
      result.reason !== "missing_or_invalid_mention_type" &&
      result.reason !== "missing_contact_point_subject_entity"
    );
  }
  return false;
}

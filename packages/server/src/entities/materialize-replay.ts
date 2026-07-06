import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";
import { materializeContactPointFact } from "./materialize-contact-points";
import { buildMaterializeDeps } from "./materialize-deps";
import { readJsonObject } from "./materialize-json";
import { materializeLlmExtractedFact } from "./materialize-llm-mentions";
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
] as const;

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
    logger,
    birthGateTypes: opts.birthGateTypes,
    birthGateDryRun: opts.birthGateDryRun,
    experimentalFlag: opts.experimentalFlag,
  });
  const orderRank = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));
  const facts = (await db.selectFrom("indexed_file_facts").selectAll().where("deleted_at", "is", null).execute())
    .filter((f) => orderRank.has(f.fact_type))
    .sort((a, b) => (orderRank.get(a.fact_type) ?? 0) - (orderRank.get(b.fact_type) ?? 0));

  summary.factsRead = facts.length;

  for (const fact of facts) {
    try {
      const result = await materializeFromFact(deps, fact);
      accumulate(summary, result);
    } catch (err) {
      logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Replay failed for fact");
      summary.skipped++;
    }
    await yieldToEventLoop();
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
    logger,
    birthGateTypes: opts.birthGateTypes,
    birthGateDryRun: opts.birthGateDryRun,
    experimentalFlag: opts.experimentalFlag,
  });
  const orderRank = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));
  let factsQuery = db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("deleted_at", "is", null)
    .where("materialized_at", "is", null);
  if (opts.factTypes && opts.factTypes.length > 0) {
    factsQuery = factsQuery.where("fact_type", "in", opts.factTypes);
  }
  const facts = (await factsQuery.execute()).sort(
    (a, b) =>
      (orderRank.get(a.fact_type) ?? Number.MAX_SAFE_INTEGER) - (orderRank.get(b.fact_type) ?? Number.MAX_SAFE_INTEGER),
  );

  summary.factsRead = facts.length;
  opts.onProgress?.({ phase: "materialize", completed: 0, total: facts.length });

  for (let i = 0; i < facts.length; i++) {
    if (opts.shouldCancel?.()) throw new Error("Re-enrich stopped");
    const fact = facts[i];
    try {
      const result = await materializeFromFact(deps, fact);
      accumulate(summary, result);
      if (result.kind === "deferred_below_threshold") {
        summary.deferredBelowThreshold++;
      }
      if (shouldMarkMaterialized(result)) {
        await db
          .updateTable("indexed_file_facts")
          .set({ materialized_at: new Date().toISOString() })
          .where("id", "=", fact.id)
          .execute();
        if (result.kind !== "task_materialized") summary.materialized++;
      } else {
        summary.deferred++;
      }
    } catch (err) {
      logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Materialization failed for fact");
      summary.skipped++;
      summary.deferred++;
    }
    opts.onProgress?.({ phase: "materialize", completed: i + 1, total: facts.length });
    await yieldToEventLoop();
  }

  await cleanupEmptyRelationships(db);
  logger.info({ summary }, "Source-fact materialization complete");
  return summary;
}

export function shouldMarkMaterialized(result: MaterializeResult): boolean {
  if (
    result.kind === "entity_created" ||
    result.kind === "entity_linked" ||
    result.kind === "queued" ||
    result.kind === "relationship_materialized" ||
    result.kind === "task_materialized" ||
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

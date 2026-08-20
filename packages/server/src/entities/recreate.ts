import type { ExpressionBuilder, Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { type EnrichmentResult, isEnrichmentActive } from "../connectors/enrichment";
import { type DomainSweepResult, sweepDomainPromotions } from "../connectors/smart-enrichment";
import { getSyncProgress, seedTeamDirectoryEntities } from "../connectors/sync";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { sweepCoMentionContributesTo } from "./co-mention-sweep";
import { type MaterializeFactsSummary, type MaterializeProgress, materializeUnmaterializedFacts } from "./materialize";
import { isRecreateActive, withRecreateLock } from "./recreate-state";
import { PROTECTED_RELATIONSHIP_SOURCES, PROTECTED_RELATIONSHIP_TYPES } from "./relationship-provenance";
import { reconcileStructuralAssigneeContributesTo } from "./structural-assignee";

export type { ReplayFactsSummary } from "./materialize";

export interface ResetSummary {
  dryRun: boolean;
  deleted: Record<string, number>;
  filesMarkedPending: number;
  factsMarkedUnmaterialized: number;
  warnings: string[];
}

export interface RecreateConflict {
  code: "RECREATE_ACTIVE" | "SYNC_ACTIVE" | "ENRICHMENT_ACTIVE";
  message: string;
}

/**
 * Order matters: evidence → relationships → mentions → entities, so FK
 * cascades don't fire mid-loop. `entity_domains` is handled separately
 * because it has a per-row override predicate (manual rows survive reset).
 */
const DERIVED_TABLES = [
  "entity_relationship_evidence",
  "entity_relationships",
  "entity_review_evidence",
  "entity_alias_rejections",
  "entity_review_queue",
  "entity_candidates",
  "entity_mentions",
  "entity_source_refs",
  "entities",
] as const;

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table") || message.includes("does not exist");
}

async function countTable(db: Kysely<DB>, table: string): Promise<number> {
  try {
    const result = await sql<{
      count: string | number | bigint;
    }>`SELECT COUNT(*) AS count FROM ${sql.raw(table)}`.execute(db);
    return Number(result.rows[0]?.count ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function deleteTable(db: Kysely<DB>, table: string, logger?: Logger): Promise<number> {
  if (table === "entities") return deleteRecreatableEntities(db);
  if (table === "entity_relationships") return deleteRecreatableRelationships(db, logger);
  const count = await countTable(db, table);
  if (count === 0) return 0;
  try {
    await sql`DELETE FROM ${sql.raw(table)}`.execute(db);
    return count;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

/**
 * Reset preserves human-blessed entities: `declared` (added/declared via Your
 * Org) and `human_confirmed` (approved from the review queue). Both encode an
 * explicit operator decision that replay cannot reconstruct — approvals live in
 * `entity_review_queue`, not in `indexed_file_facts`, so a deleted approved
 * entity would never come back as approved. Only derived tiers (`structural`,
 * `inferred`) are rebuilt from facts.
 */
const PRESERVED_RESET_TIERS = ["declared", "human_confirmed"];

/**
 * Human-written edges (declared, reparents, accepted minting verdicts) encode
 * operator decisions that replay cannot reconstruct, so they survive reset —
 * but only when both endpoint entities are themselves preserved-tier.
 * Otherwise the edge would dangle after `deleteRecreatableEntities`; those
 * rows are dropped and counted in the log. Declared edges never hit that
 * branch: declaring an edge promotes its endpoints to `human_confirmed`.
 */
async function deleteRecreatableRelationships(db: Kysely<DB>, logger?: Logger): Promise<number> {
  try {
    const preservedEndpoint = (
      eb: ExpressionBuilder<DB, "entity_relationships">,
      column: "source_entity_id" | "target_entity_id",
    ) =>
      eb.exists(
        eb
          .selectFrom("entities")
          .select(sql`1`.as("x"))
          .whereRef("entities.id", "=", `entity_relationships.${column}`)
          .where("entities.provenance_tier", "in", PRESERVED_RESET_TIERS),
      );
    const protectedRow = (eb: ExpressionBuilder<DB, "entity_relationships">) =>
      eb.and([
        eb("source", "in", [...PROTECTED_RELATIONSHIP_SOURCES]),
        eb("relationship_type", "in", [...PROTECTED_RELATIONSHIP_TYPES]),
      ]);
    const dangling = await db
      .selectFrom("entity_relationships")
      .select(db.fn.countAll<number>().as("count"))
      .where(protectedRow)
      .where((eb) =>
        eb.or([eb.not(preservedEndpoint(eb, "source_entity_id")), eb.not(preservedEndpoint(eb, "target_entity_id"))]),
      )
      .executeTakeFirst();
    const danglingCount = Number(dangling?.count ?? 0);
    if (danglingCount > 0) {
      logger?.warn(
        { droppedProtectedRelationships: danglingCount },
        "Reset dropped human-written relationships whose endpoints are not preserved-tier",
      );
    }
    const before = await countTable(db, "entity_relationships");
    if (before === 0) return 0;
    const result = await db
      .deleteFrom("entity_relationships")
      .where((eb) =>
        eb.not(
          eb.and([
            protectedRow(eb),
            preservedEndpoint(eb, "source_entity_id"),
            preservedEndpoint(eb, "target_entity_id"),
          ]),
        ),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function deleteRecreatableEntities(db: Kysely<DB>): Promise<number> {
  try {
    const before = await db
      .selectFrom("entities")
      .select(db.fn.countAll<number>().as("count"))
      .where("provenance_tier", "not in", PRESERVED_RESET_TIERS)
      .executeTakeFirst();
    const count = Number(before?.count ?? 0);
    if (count === 0) return 0;
    await db.deleteFrom("entities").where("provenance_tier", "not in", PRESERVED_RESET_TIERS).execute();
    return count;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

/**
 * Scoped delete for `entity_domains`. Manual rows survive — they encode
 * operator intent (the personal/shared seed list, plus any operator-promoted
 * corporate override on a consumer-looking domain). Observed/llm rows are
 * derived from facts and get rebuilt by replay + sweep.
 */
async function deleteDerivedEntityDomains(db: Kysely<DB>): Promise<number> {
  try {
    const before = await db
      .selectFrom("entity_domains")
      .select(db.fn.countAll<number>().as("count"))
      .where("source", "!=", "manual")
      .executeTakeFirst();
    const count = Number(before?.count ?? 0);
    if (count === 0) return 0;
    await db.deleteFrom("entity_domains").where("source", "!=", "manual").execute();
    return count;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

/**
 * After replay + sweep, a preserved manual override may point at an
 * `entity_id` that no longer exists (the company was rebuilt with a new ID,
 * or no fact rebuilds it at all). Re-link via the sweep's corporate row
 * for the same domain when possible; otherwise null the `entity_id` and
 * leave the row intact — operator intent ("this domain is corporate") is
 * the durable signal, the target entity is the recoverable part.
 */
async function fixupPreservedEntityDomainReferences(db: Kysely<DB>, logger: Logger): Promise<void> {
  let preserved: Array<{ id: string; entity_id: string | null; domain: string }>;
  try {
    preserved = await db
      .selectFrom("entity_domains")
      .select(["id", "entity_id", "domain"])
      .where("source", "=", "manual")
      .where("entity_id", "is not", null)
      .execute();
  } catch (err) {
    if (isMissingTableError(err)) return;
    throw err;
  }
  if (preserved.length === 0) return;
  for (const row of preserved) {
    const target = await db
      .selectFrom("entities")
      .select("id")
      .where("id", "=", row.entity_id as string)
      .executeTakeFirst();
    if (target) continue;

    const relink = await db
      .selectFrom("entity_domains")
      .select("entity_id")
      .where("domain", "=", row.domain)
      .where("kind", "=", "corporate")
      .where("source", "!=", "manual")
      .where("entity_id", "is not", null)
      .executeTakeFirst();
    if (relink?.entity_id) {
      await db.updateTable("entity_domains").set({ entity_id: relink.entity_id }).where("id", "=", row.id).execute();
      logger.info({ domain: row.domain, relinkedTo: relink.entity_id }, "Relinked preserved corporate domain override");
      continue;
    }

    await db.updateTable("entity_domains").set({ entity_id: null }).where("id", "=", row.id).execute();
    logger.warn(
      { domain: row.domain, previousEntityId: row.entity_id },
      "Preserved corporate domain override has no rebuild target; cleared entity_id",
    );
  }
}

async function countActiveFacts(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("indexed_file_facts")
    .select(db.fn.countAll<number>().as("count"))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function clearMaterializedFlags(db: Kysely<DB>): Promise<number> {
  const result = await db
    .updateTable("indexed_file_facts")
    .set({ materialized_at: null, materialization_attempts: 0 })
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

async function countFilesWithoutSourceFacts(db: Kysely<DB>): Promise<number> {
  try {
    const row = await db
      .selectFrom("indexed_files")
      .select(db.fn.countAll<number>().as("count"))
      .where("is_archived", "=", 0)
      .where(
        "id",
        "not in",
        db.selectFrom("indexed_file_facts").select("indexed_file_id").where("indexed_file_id", "is not", null),
      )
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

export async function getRecreateConflict(
  db: Kysely<DB>,
  opts: { ignoreActiveRecreate?: boolean } = {},
): Promise<RecreateConflict | null> {
  if (!opts.ignoreActiveRecreate && isRecreateActive()) {
    return { code: "RECREATE_ACTIVE", message: "Entity recreate is already active" };
  }
  if (isEnrichmentActive()) {
    return { code: "ENRICHMENT_ACTIVE", message: "Enrichment is currently active" };
  }
  if (getSyncProgress().length > 0) {
    return { code: "SYNC_ACTIVE", message: "Connector sync is currently active" };
  }
  const syncing = await db
    .selectFrom("connector_configs")
    .select("id")
    .where("sync_status", "=", "syncing")
    .limit(1)
    .executeTakeFirst();
  if (syncing) {
    return { code: "SYNC_ACTIVE", message: "A connector is marked syncing" };
  }
  return null;
}

export async function resetDerivedEntityData(
  db: Kysely<DB>,
  logger: Logger,
  opts: { dryRun?: boolean; lockAlreadyHeld?: boolean } = {},
): Promise<ResetSummary> {
  if (!opts.lockAlreadyHeld) {
    const conflict = await getRecreateConflict(db);
    if (conflict) {
      throw new Error(conflict.code);
    }
  }

  const deleted: Record<string, number> = {};
  for (const table of DERIVED_TABLES) {
    deleted[table] = await countTable(db, table);
  }

  const factsMarkedUnmaterialized = await countActiveFacts(db);
  const filesWithoutSourceFacts = await countFilesWithoutSourceFacts(db);
  const warnings = [
    `${deleted.entities ?? 0} entities will be deleted and recreated from durable facts.`,
    `${deleted.entity_review_queue ?? 0} review-queue rows will be deleted.`,
    `${deleted.entity_alias_rejections ?? 0} alias rejections will be deleted; rejected aliases may be re-proposed after recreate.`,
  ];
  if (filesWithoutSourceFacts > 0) {
    warnings.push(
      `${filesWithoutSourceFacts} non-archived files have no persisted source facts; recreate can only recover content-derived graph data for them.`,
    );
  }

  if (opts.dryRun) {
    return { dryRun: true, deleted, filesMarkedPending: 0, factsMarkedUnmaterialized, warnings };
  }

  return opts.lockAlreadyHeld
    ? resetDerivedEntityDataInner(db, logger)
    : withRecreateLock(() => resetDerivedEntityDataInner(db, logger));
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 — Reset → materialize facts → relationship sweeps.
// ─────────────────────────────────────────────────────────────────────────

export interface RecreateSummary {
  reset: ResetSummary;
  replay: MaterializeFactsSummary;
  domainSweep: DomainSweepResult;
  enrichmentIterations: number;
  enrichment: EnrichmentResult;
}

export interface RecreateDeps {
  db: Kysely<DB>;
  logger: Logger;
  triggeredByUserId: string;
  /**
   * Cap on enrichment passes. At MAX_FILES_PER_RUN=5000, 20 iterations
   * covers up to 100k files. Tests override to 2–3.
   */
  maxIterations?: number;
  /**
   * Deprecated: recreate no longer calls LLM enrichment.
   */
  skipLlm?: boolean;
  /**
   * Skip enrichment entirely — for tests that only validate replay.
   */
  skipEnrichment?: boolean;
  /**
   * Skip the reset phase — for callers that already invoked /reset and now
   * want to do replay + enrichment only.
   */
  skipReset?: boolean;
  lockAlreadyHeld?: boolean;
  /**
   * Threshold passed to the materializer for `llm_extracted` promotion.
   * Production callers should pass `config.LLM_PROMOTION_THRESHOLD`.
   */
  llmPromotionThreshold?: number;
  coMentionContributesToThreshold?: number;
  /**
   * Restrict the materialize replay to a subset of fact types. Used by
   * category reset+rebuild to avoid replaying unrelated pending facts.
   */
  materializeFactTypes?: IndexedFileFactType[];
  /**
   * Fires during the materialize replay phase so reset+rebuild jobs can
   * surface live progress on the rebuild banner.
   */
  onProgress?: (progress: MaterializeProgress) => void;
  shouldCancel?: () => boolean;
}

export async function recreateEntityGraph(deps: RecreateDeps): Promise<RecreateSummary> {
  const { db, logger } = deps;

  const run = async () => {
    const reset = deps.skipReset
      ? {
          dryRun: false,
          deleted: {},
          filesMarkedPending: 0,
          factsMarkedUnmaterialized: 0,
          warnings: ["Reset skipped — caller invoked /reset separately."],
        }
      : await resetDerivedEntityDataInner(db, logger);

    await seedTeamDirectoryEntities(db, logger);

    await seedTeamDirectoryEntities(db, logger);

    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    const replay = await materializeUnmaterializedFacts(db, logger, {
      llmPromotionThreshold: deps.llmPromotionThreshold,
      factTypes: deps.materializeFactTypes,
      onProgress: deps.onProgress,
      shouldCancel: deps.shouldCancel,
    });

    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    const taskRepo = createTaskRepository(db);
    await taskRepo.reanchorNullParentTasks();
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    await taskRepo.expireOrphanedTasks();
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    await reconcileStructuralAssigneeContributesTo(db, logger.child({ component: "recreate-structural-assignee" }), {
      scope: { kind: "full" },
    });
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    // Domain promotions run after materialize so any new company entity and
    // its `works_at` edges are available before downstream sweeps.
    const domainSweep = await sweepDomainPromotions(db, logger.child({ component: "recreate-domain-sweep" }));
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    await fixupPreservedEntityDomainReferences(db, logger.child({ component: "recreate-domain-fixup" }));
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");
    await sweepCoMentionContributesTo(db, logger.child({ component: "recreate-co-mention-sweep" }), {
      scope: { kind: "full" },
      threshold: deps.coMentionContributesToThreshold,
    });
    if (deps.shouldCancel?.()) throw new Error("Re-enrich stopped");

    if (deps.skipEnrichment) {
      return {
        reset,
        replay,
        domainSweep,
        enrichmentIterations: 0,
        enrichment: { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] },
      };
    }

    return {
      reset,
      replay,
      domainSweep,
      enrichmentIterations: 0,
      enrichment: { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] },
    };
  };

  return deps.lockAlreadyHeld ? run() : withRecreateLock(run);
}

/**
 * Reset implementation without the recreate-lock wrapper. Used internally by
 * `recreateEntityGraph`, which acquires the lock for the full phase chain.
 */
async function resetDerivedEntityDataInner(db: Kysely<DB>, logger: Logger): Promise<ResetSummary> {
  const deleted: Record<string, number> = {};
  for (const table of DERIVED_TABLES) deleted[table] = await countTable(db, table);
  const factsMarkedUnmaterialized = await countActiveFacts(db);
  const filesWithoutSourceFacts = await countFilesWithoutSourceFacts(db);
  const warnings = [
    `${deleted.entities ?? 0} entities will be deleted and recreated from durable facts.`,
    `${deleted.entity_review_queue ?? 0} review-queue rows will be deleted.`,
    `${deleted.entity_alias_rejections ?? 0} alias rejections will be deleted; rejected aliases may be re-proposed after recreate.`,
  ];
  if (filesWithoutSourceFacts > 0) {
    warnings.push(
      `${filesWithoutSourceFacts} non-archived files have no persisted source facts; recreate can only recover content-derived graph data for them.`,
    );
  }

  const appliedDeleted: Record<string, number> = {};
  let appliedFactsMarkedUnmaterialized = 0;
  await db.transaction().execute(async (trx) => {
    // Derived domain rows go before the rest so any FK cascades from
    // `entities` deletion don't fire against rows we still need to inspect.
    appliedDeleted.entity_domains = await deleteDerivedEntityDomains(trx);
    for (const table of DERIVED_TABLES) appliedDeleted[table] = await deleteTable(trx, table, logger);
    appliedFactsMarkedUnmaterialized = await clearMaterializedFlags(trx);
  });
  logger.warn(
    { deleted: appliedDeleted, factsMarkedUnmaterialized: appliedFactsMarkedUnmaterialized },
    "Derived entity data reset",
  );
  return {
    dryRun: false,
    deleted: appliedDeleted,
    filesMarkedPending: 0,
    factsMarkedUnmaterialized: appliedFactsMarkedUnmaterialized,
    warnings,
  };
}

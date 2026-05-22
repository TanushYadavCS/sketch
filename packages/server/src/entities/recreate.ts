import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { type EnrichmentResult, isEnrichmentActive, linkEntitiesByDeterministicMatch } from "../connectors/enrichment";
import { getSyncProgress, seedTeamDirectoryEntities } from "../connectors/sync";
import type { DB } from "../db/schema";
import { type MaterializeFactsSummary, materializeUnmaterializedFacts } from "./materialize";
import { isRecreateActive, withRecreateLock } from "./recreate-state";

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

const DERIVED_TABLES = [
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

async function deleteTable(db: Kysely<DB>, table: string): Promise<number> {
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
    .set({ materialized_at: null })
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
// Phase 3 — Reset → materialize facts → deterministic substring linking.
// ─────────────────────────────────────────────────────────────────────────

export interface RecreateSummary {
  reset: ResetSummary;
  replay: MaterializeFactsSummary;
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

    const replay = await materializeUnmaterializedFacts(db, logger);

    if (deps.skipEnrichment) {
      return {
        reset,
        replay,
        enrichmentIterations: 0,
        enrichment: { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] },
      };
    }

    const deterministic = await linkEntitiesByDeterministicMatch(
      db,
      logger.child({ component: "recreate-deterministic-linking" }),
    );
    return { reset, replay, enrichmentIterations: 1, enrichment: deterministic };
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
    for (const table of DERIVED_TABLES) appliedDeleted[table] = await deleteTable(trx, table);
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

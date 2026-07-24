import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type IndexedFileFactRelation,
  type IndexedFileFactType,
  buildMaterializationInputHash,
} from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { DEFAULT_FACT_BATCH_SIZE } from "./fact-batches";
import { readJsonObject } from "./materialize-json";
import { projectFeatureCorroborationKey, projectLlmExtractedNormalization } from "./normalization-projection";

const STATE_ID = "v1";

interface BackfillRow {
  id: string;
  created_at: string;
  updated_at: string;
  fact_type: string;
  relation: string;
  source: string;
  subject_name: string | null;
  subject_email: string | null;
  subject_source: string | null;
  subject_source_id: string | null;
  context_snippet: string | null;
  raw: string | null;
  indexed_file_id: string | null;
  connector_config_id: string | null;
  created_by_user_id: string | null;
  last_seen_sync_run_id: string | null;
  content_hash: string | null;
}

interface ProjectionUpdate {
  materialization_input_hash: string;
  normalized_subject_name?: string | null;
  normalized_mention_name?: string | null;
  raw_mention_type?: string | null;
  mention_type?: string | null;
  feature_corroboration_key?: string | null;
  normalization_projected_at: string;
}

/**
 * Loads `source_created_at`/`source_updated_at` for the decision and milestone
 * rows in one page as a single `IN` query so the per-batch hash recompute never
 * issues one lookup per row.
 */
async function loadFileSourceTimes(
  db: Kysely<DB>,
  rows: BackfillRow[],
): Promise<Map<string, { source_created_at: string | null; source_updated_at: string | null }>> {
  const fileIds = [
    ...new Set(
      rows
        .filter((row) => (row.fact_type === "decision" || row.fact_type === "milestone") && row.indexed_file_id)
        .map((row) => row.indexed_file_id as string),
    ),
  ];
  const map = new Map<string, { source_created_at: string | null; source_updated_at: string | null }>();
  if (fileIds.length === 0) return map;
  const files = await db
    .selectFrom("indexed_files")
    .select(["id", "source_created_at", "source_updated_at"])
    .where("id", "in", fileIds)
    .execute();
  for (const file of files) {
    map.set(file.id, { source_created_at: file.source_created_at, source_updated_at: file.source_updated_at });
  }
  return map;
}

/**
 * Builds the projection/hash update for one row using the exact canonical
 * computation the write path uses, so a later unchanged re-emission preserves the
 * verdict instead of reopening it.
 */
function buildProjectionUpdate(
  row: BackfillRow,
  fileTimes: Map<string, { source_created_at: string | null; source_updated_at: string | null }>,
): ProjectionUpdate {
  const times = row.indexed_file_id ? fileTimes.get(row.indexed_file_id) : undefined;
  const update: ProjectionUpdate = {
    normalization_projected_at: new Date().toISOString(),
    materialization_input_hash: buildMaterializationInputHash({
      indexed_file_id: row.indexed_file_id,
      connector_config_id: row.connector_config_id,
      created_by_user_id: row.created_by_user_id,
      source: row.source,
      fact_type: row.fact_type as IndexedFileFactType,
      relation: row.relation as IndexedFileFactRelation,
      subject_name: row.subject_name,
      subject_email: row.subject_email,
      subject_source: row.subject_source,
      subject_source_id: row.subject_source_id,
      context_snippet: row.context_snippet,
      raw: row.raw,
      last_seen_sync_run_id: row.last_seen_sync_run_id,
      content_hash: row.content_hash,
      file_source_created_at: times?.source_created_at ?? null,
      file_source_updated_at: times?.source_updated_at ?? null,
    }),
  };
  if (row.fact_type === "llm_extracted") {
    Object.assign(update, projectLlmExtractedNormalization(row.subject_name, readJsonObject(row.raw)));
  } else if (row.fact_type === "feature") {
    update.feature_corroboration_key = projectFeatureCorroborationKey(row.source, readJsonObject(row.raw));
  }
  return update;
}

const BACKFILL_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "fact_type",
  "relation",
  "source",
  "subject_name",
  "subject_email",
  "subject_source",
  "subject_source_id",
  "context_snippet",
  "raw",
  "indexed_file_id",
  "connector_config_id",
  "created_by_user_id",
  "last_seen_sync_run_id",
  "content_hash",
] as const;

export interface NormalizationBackfillOptions {
  logger?: Logger;
  batchSize?: number;
  /** Polled between batches so a shutdown can pause a long backfill; it resumes from the durable cursor next boot. */
  shouldStop?: () => boolean;
}

export interface NormalizationBackfillHandle {
  done: Promise<void>;
  stop: () => void;
}

/**
 * Populates the Fix 2b projection columns and the canonical
 * `materialization_input_hash` for rows written before migration 143, so
 * corroboration counting, third-party lookup, and feature corroboration switch
 * from `raw`-parsing scans to indexed SQL.
 *
 * The hash is recomputed with the same canonical formula the write path uses
 * (including the decision/milestone file-source-timestamp fold). Aligning the
 * stored hash to what the next unchanged re-emission would compute is what keeps
 * a big tenant's first post-2b re-sync from reopening every NULL-hash or
 * 2a-formula-hash fact — that reopen wave is exactly the load shape this epic
 * exists to eliminate. It does not retroactively re-derive `effectiveAt` for
 * decision/milestone facts that drifted before 2b: those self-heal only when
 * their file's source timestamp next changes (which the folded hash now catches).
 *
 * Each batch is a keyset-read of one bounded page ordered by `(created_at, id)`
 * followed by per-row updates and a durable cursor advance, all in one short
 * transaction. It never loads the whole table (unlike migration 105's
 * load-all-then-update shape), holds no cross-batch Postgres transaction, and is
 * idempotent: replaying a batch recomputes identical values, and a crash resumes
 * from the persisted cursor. The marker flips to `complete` only after an empty
 * page, so a partially-populated table always keeps legacy readers.
 *
 * Each row update is guarded by a `updated_at` compare-and-set read with the page
 * (outside the transaction). A concurrent re-extraction that bumps `updated_at`
 * fails the CAS, so its own write-path projections and hash are never clobbered
 * by this stale page. But a non-projecting `updated_at` bump (e.g.
 * `clearMaterializedAtForActiveFacts`) can also fail the CAS while leaving the row
 * un-processed after the cursor has advanced past it. To keep "marker complete
 * implies every row carries its hash and projections" a guaranteed invariant, the
 * keyset pass is followed by a catch-up pass over rows of any fact type whose
 * `normalization_projected_at` marker is still NULL; the marker only flips to
 * `complete` when that catch-up finds none. The marker (not a nullable projection
 * column) is the completion signal because a valid row can legitimately project to
 * all-NULL columns; scanning all fact types (not just the projected ones) also
 * ensures a CAS-skipped decision/milestone/structural row does not complete with a
 * NULL `materialization_input_hash`.
 */
export async function runNormalizationBackfill(db: Kysely<DB>, opts: NormalizationBackfillOptions = {}): Promise<void> {
  const batchSize = opts.batchSize ?? DEFAULT_FACT_BATCH_SIZE;
  const state = await db
    .selectFrom("normalization_backfill_state")
    .select(["status", "cursor_created_at", "cursor_id"])
    .where("id", "=", STATE_ID)
    .executeTakeFirst();
  if (!state) {
    opts.logger?.warn("normalization backfill state row missing; skipping");
    return;
  }
  if (state.status === "complete") return;

  let cursor = { createdAt: state.cursor_created_at ?? "", id: state.cursor_id ?? "" };
  let updated = 0;
  for (;;) {
    if (opts.shouldStop?.()) {
      opts.logger?.info({ updated }, "normalization backfill paused; will resume from cursor");
      return;
    }
    const rows: BackfillRow[] = await db
      .selectFrom("indexed_file_facts")
      .select(BACKFILL_COLUMNS)
      .where((eb) =>
        eb.or([
          eb("created_at", ">", cursor.createdAt),
          eb.and([eb("created_at", "=", cursor.createdAt), eb("id", ">", cursor.id)]),
        ]),
      )
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(batchSize)
      .execute();

    if (rows.length === 0) break;

    const fileTimes = await loadFileSourceTimes(db, rows);
    const last = rows[rows.length - 1];
    await db.transaction().execute(async (trx) => {
      updated += await projectRowsWithCas(trx, rows, fileTimes);
      await trx
        .updateTable("normalization_backfill_state")
        .set({ cursor_created_at: last.created_at, cursor_id: last.id, updated_at: new Date().toISOString() })
        .where("id", "=", STATE_ID)
        .execute();
    });
    cursor = { createdAt: last.created_at, id: last.id };
  }

  const caughtUp = await catchUpUnprojectedRows(db, batchSize, opts);
  if (!caughtUp) return;

  await db
    .updateTable("normalization_backfill_state")
    .set({ status: "complete", updated_at: new Date().toISOString() })
    .where("id", "=", STATE_ID)
    .execute();
  opts.logger?.info({ updated }, "normalization backfill complete");
}

/**
 * Applies the CAS-guarded projection update to each row on the given executor,
 * returning how many rows the CAS actually updated.
 */
async function projectRowsWithCas(
  executor: Kysely<DB>,
  rows: BackfillRow[],
  fileTimes: Map<string, { source_created_at: string | null; source_updated_at: string | null }>,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const result = await executor
      .updateTable("indexed_file_facts")
      .set(buildProjectionUpdate(row, fileTimes))
      .where("id", "=", row.id)
      .where("updated_at", "=", row.updated_at)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) > 0) count += 1;
  }
  return count;
}

/**
 * Projects any row the keyset pass left with a NULL marker — a CAS-skipped
 * pre-migration row. The marker is set atomically with the hash (and, for
 * projected types, the mention/feature columns) by both the write path and the
 * backfill, and `upsertFact` is the only runtime insert path, so a NULL marker
 * unambiguously means the row was never processed by Fix 2b. Rescanning every
 * fact type — not just `llm_extracted`/`feature` — also closes the hash gap: a
 * non-projected row (decision/milestone/structural_task) that lost the keyset CAS
 * would otherwise complete with `materialization_input_hash` still NULL and
 * un-absorb its reopen. Returns true when no NULL-marker row remains, so the
 * caller may mark the backfill complete. Returns false if paused or if a pass
 * makes no progress under persistent concurrent contention, leaving the marker
 * unset so a later boot retries rather than declaring a false invariant.
 */
async function catchUpUnprojectedRows(
  db: Kysely<DB>,
  batchSize: number,
  opts: NormalizationBackfillOptions,
): Promise<boolean> {
  for (;;) {
    if (opts.shouldStop?.()) return false;
    const rows: BackfillRow[] = await db
      .selectFrom("indexed_file_facts")
      .select(BACKFILL_COLUMNS)
      .where("normalization_projected_at", "is", null)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(batchSize)
      .execute();
    if (rows.length === 0) return true;
    const fileTimes = await loadFileSourceTimes(db, rows);
    const projected = await db.transaction().execute((trx) => projectRowsWithCas(trx, rows, fileTimes));
    if (projected === 0) {
      opts.logger?.warn(
        { unprojected: rows.length },
        "normalization backfill catch-up stalled on contended rows; leaving pending for a later run",
      );
      return false;
    }
  }
}

/**
 * Fire-and-forget launcher for startup: runs the backfill without blocking
 * readiness and exposes a cooperative stop for graceful shutdown. Failures are
 * logged, not thrown, because the hybrid readers keep working on the legacy path
 * until a later boot finishes the backfill.
 */
export function startNormalizationBackfill(db: Kysely<DB>, logger?: Logger): NormalizationBackfillHandle {
  let stopped = false;
  const done = runNormalizationBackfill(db, { logger, shouldStop: () => stopped }).catch((err) => {
    logger?.error({ err }, "normalization backfill failed; indexed corroboration stays on legacy path");
  });
  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}

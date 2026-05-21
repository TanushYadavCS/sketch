/**
 * CRUD for the entity-review queue and the alias-rejection sticky table.
 *
 * Read/write surface for ECR-01. ECR-02 extends this file with resolve-side
 * methods (confirm, reject, list-with-evidence). The repo is intentionally
 * thin — the proposal-decision logic (auto-create vs auto-link vs queue)
 * lives in `entities/propose.ts`, not here.
 */
import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { isPg } from "../dialect";
import type { DB, EntityAliasRejectionsTable, EntityReviewEvidenceTable, EntityReviewQueueTable } from "../schema";

export type QueueRow = Selectable<EntityReviewQueueTable>;
export type AliasRejection = Selectable<EntityAliasRejectionsTable>;
export type EvidenceRow = Selectable<EntityReviewEvidenceTable>;

/**
 * How long a `pending` row stays "frozen" after a reviewer opens it.
 * Subsequent propose() calls during this window only bump occurrence_count
 * and last_seen_at; the candidate fields aren't disturbed so the reviewer's
 * view stays stable. After the window the row is treated as abandoned and
 * a fresh candidate may be written.
 *
 * Default 24h — long enough that an interrupted review can be resumed
 * without a stale-candidate jump, short enough that a genuinely abandoned
 * review doesn't freeze the row forever. Env-overridable via
 * SKETCH_REVIEW_FREEZE_MS so we can tighten it once we observe real
 * reviewer cadence.
 */
export const DEFAULT_REVIEW_FREEZE_MS = 24 * 60 * 60 * 1000;

export function readReviewFreezeMs(): number {
  const raw = process.env.SKETCH_REVIEW_FREEZE_MS;
  if (!raw) return DEFAULT_REVIEW_FREEZE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_FREEZE_MS;
}

export interface UpsertQueueRowInput {
  proposedName: string;
  normalizedName: string;
  entityType: string;
  proposedEmail?: string | null;
  candidateEntityId: string | null;
  candidateScore: number | null;
  candidateReason: string | null;
  triggeredByUserId: string;
}

export interface UpsertQueueRowResult {
  row: QueueRow;
  /**
   * True when the queue row is already in a terminal state (confirmed /
   * rejected / confirming). Callers MUST skip the corresponding
   * upsertEvidence() call when this is set, otherwise resolved rows
   * accumulate junk evidence rows from late-arriving syncs.
   */
  skipEvidence: boolean;
}

export interface UpsertEvidenceInput {
  reviewId: string;
  indexedFileId: string;
  source: string;
  note?: string | null;
  seenAt?: string;
}

const TERMINAL_STATUSES = new Set(["confirmed", "rejected", "confirming"]);

export function createEntityReviewRepo(db: Kysely<DB>) {
  return {
    /**
     * Insert or update a queue row keyed on (normalized_name, entity_type).
     *
     * Returns `skipEvidence: true` when the existing row is terminal. The
     * caller is responsible for honoring that flag.
     */
    async upsertQueueRow(input: UpsertQueueRowInput): Promise<UpsertQueueRowResult> {
      const now = new Date().toISOString();
      const freezeMs = readReviewFreezeMs();

      const existing = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("normalized_name", "=", input.normalizedName)
        .where("entity_type", "=", input.entityType)
        .executeTakeFirst();

      if (!existing) {
        const id = randomUUID();
        await db
          .insertInto("entity_review_queue")
          .values({
            id,
            proposed_name: input.proposedName,
            normalized_name: input.normalizedName,
            entity_type: input.entityType,
            proposed_email: input.proposedEmail ?? null,
            candidate_entity_id: input.candidateEntityId,
            candidate_score: input.candidateScore,
            candidate_reason: input.candidateReason,
            candidate_generated_at: now,
            first_seen_at: now,
            last_seen_at: now,
            occurrence_count: 1,
            status: "pending",
            triggered_by_user_id: input.triggeredByUserId,
          })
          .execute();

        const row = await db
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        return { row, skipEvidence: false };
      }

      if (TERMINAL_STATUSES.has(existing.status)) {
        return { row: existing, skipEvidence: true };
      }

      const reviewStartedAt = existing.review_started_at;
      const midReview = reviewStartedAt !== null && Date.now() - new Date(reviewStartedAt).getTime() < freezeMs;

      if (midReview) {
        await db
          .updateTable("entity_review_queue")
          .set({
            last_seen_at: now,
            occurrence_count: existing.occurrence_count + 1,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await db
          .updateTable("entity_review_queue")
          .set({
            proposed_name: input.proposedName,
            proposed_email: input.proposedEmail ?? existing.proposed_email,
            candidate_entity_id: input.candidateEntityId,
            candidate_score: input.candidateScore,
            candidate_reason: input.candidateReason,
            candidate_generated_at: now,
            last_seen_at: now,
            occurrence_count: existing.occurrence_count + 1,
          })
          .where("id", "=", existing.id)
          .execute();
      }

      const refreshed = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("id", "=", existing.id)
        .executeTakeFirstOrThrow();
      return { row: refreshed, skipEvidence: false };
    },

    /**
     * Insert evidence row for a queue row. On conflict against the unique
     * (review_id, indexed_file_id, source) tuple, refresh `seen_at` so
     * cursor-reset re-walks are observable.
     */
    async upsertEvidence(input: UpsertEvidenceInput): Promise<void> {
      const seenAt = input.seenAt ?? new Date().toISOString();
      const id = randomUUID();
      if (isPg(db)) {
        await sql`
          INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, note, seen_at)
          VALUES (${id}, ${input.reviewId}, ${input.indexedFileId}, ${input.source}, ${input.note ?? null}, ${seenAt})
          ON CONFLICT (review_id, indexed_file_id, source)
          DO UPDATE SET seen_at = EXCLUDED.seen_at
        `.execute(db);
      } else {
        await sql`
          INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, note, seen_at)
          VALUES (${id}, ${input.reviewId}, ${input.indexedFileId}, ${input.source}, ${input.note ?? null}, ${seenAt})
          ON CONFLICT (review_id, indexed_file_id, source)
          DO UPDATE SET seen_at = excluded.seen_at
        `.execute(db);
      }
    },

    async getByNormalizedName(normalizedName: string, entityType: string) {
      return db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("normalized_name", "=", normalizedName)
        .where("entity_type", "=", entityType)
        .executeTakeFirst();
    },

    async listRejectionsForEntity(entityId: string) {
      return db.selectFrom("entity_alias_rejections").selectAll().where("entity_id", "=", entityId).execute();
    },

    async isRejected(entityId: string, normalizedRejectedName: string): Promise<boolean> {
      const row = await db
        .selectFrom("entity_alias_rejections")
        .select("id")
        .where("entity_id", "=", entityId)
        .where("normalized_rejected_name", "=", normalizedRejectedName)
        .executeTakeFirst();
      return row !== undefined;
    },

    /**
     * Read-side listing for direct DB inspection and the ECR-02 GET route.
     * Owner scope filters to rows triggered by the caller, unless `isAdmin`
     * is true. Cross-user-evidence rows are admin-only and are excluded in
     * SQL for non-admin callers so pagination happens over visible rows.
     */
    async listPending(opts: {
      ownerUserId?: string;
      isAdmin: boolean;
      limit: number;
      offset?: number;
    }) {
      let q = db.selectFrom("entity_review_queue").selectAll().where("status", "=", "pending");
      if (!opts.isAdmin) {
        if (!opts.ownerUserId) return [];
        const ownerUserId = opts.ownerUserId;
        q = q
          .where("triggered_by_user_id", "=", ownerUserId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("entity_review_evidence as e")
                  .innerJoin("indexed_files as f", "f.id", "e.indexed_file_id")
                  .innerJoin("connector_configs as cc", "cc.id", "f.connector_config_id")
                  .select("e.review_id")
                  .whereRef("e.review_id", "=", "entity_review_queue.id")
                  .where("cc.created_by", "!=", ownerUserId),
              ),
            ),
          );
      }
      q = q.orderBy("last_seen_at", "desc").limit(opts.limit);
      if (opts.offset) q = q.offset(opts.offset);
      return q.execute();
    },

    /**
     * Count of `pending` rows under the same visibility predicate as
     * `listPending`. Used by the badge endpoint and by list pagination.
     */
    async countPending(opts: { ownerUserId?: string; isAdmin: boolean }): Promise<number> {
      let q = db
        .selectFrom("entity_review_queue")
        .select(db.fn.countAll<number>().as("c"))
        .where("status", "=", "pending");
      if (!opts.isAdmin) {
        if (!opts.ownerUserId) return 0;
        const ownerUserId = opts.ownerUserId;
        q = q
          .where("triggered_by_user_id", "=", ownerUserId)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("entity_review_evidence as e")
                  .innerJoin("indexed_files as f", "f.id", "e.indexed_file_id")
                  .innerJoin("connector_configs as cc", "cc.id", "f.connector_config_id")
                  .select("e.review_id")
                  .whereRef("e.review_id", "=", "entity_review_queue.id")
                  .where("cc.created_by", "!=", ownerUserId),
              ),
            ),
          );
      }
      const row = await q.executeTakeFirst();
      return Number(row?.c ?? 0);
    },

    /**
     * For each review id, return (source, count) aggregated from
     * `entity_review_evidence`. One round-trip — the row fetch + this call
     * give the route handler everything it needs to assemble the
     * evidenceCount + sourceBreakdown fields.
     *
     * Returns an empty map when `reviewIds` is empty.
     */
    async evidenceSummaryByReview(reviewIds: string[]): Promise<Map<string, Array<{ source: string; count: number }>>> {
      const map = new Map<string, Array<{ source: string; count: number }>>();
      if (reviewIds.length === 0) return map;
      const rows = await db
        .selectFrom("entity_review_evidence")
        .select(["review_id", "source", db.fn.countAll<number>().as("c")])
        .where("review_id", "in", reviewIds)
        .groupBy(["review_id", "source"])
        .execute();
      for (const r of rows) {
        const list = map.get(r.review_id) ?? [];
        list.push({ source: r.source, count: Number(r.c) });
        map.set(r.review_id, list);
      }
      return map;
    },

    /**
     * Fetch a single queue row by id, regardless of status.
     */
    async getById(reviewId: string) {
      return db.selectFrom("entity_review_queue").selectAll().where("id", "=", reviewId).executeTakeFirst();
    },

    /**
     * Set review_started_at = :now on a pending row, but only if the row is
     * not currently inside its freeze window. If review_started_at is null
     * or older than the freeze boundary, the write fires. Inside the freeze
     * window the WHERE clause gates the UPDATE so it's a no-op. Returns the
     * post-update row (or the unchanged row).
     *
     * The route handler MUST run owner-scope checks BEFORE calling this —
     * a 403 GET should not flip review_started_at. See review.ts.
     */
    async markReviewStarted(reviewId: string, userId: string, now: string, freezeBoundary: string) {
      await db
        .updateTable("entity_review_queue")
        .set({ review_started_at: now, review_started_by: userId })
        .where("id", "=", reviewId)
        .where("status", "=", "pending")
        .where((eb) => eb.or([eb("review_started_at", "is", null), eb("review_started_at", "<", freezeBoundary)]))
        .execute();
      return db.selectFrom("entity_review_queue").selectAll().where("id", "=", reviewId).executeTakeFirst();
    },

    /**
     * Mark a pending queue row resolved only if the caller still owns the
     * candidate snapshot it read earlier. Returns false when another resolver
     * won first or propose() refreshed the candidate before the terminal write.
     */
    async markResolved(
      reviewId: string,
      status: "confirmed" | "rejected",
      resolvedEntityId: string,
      by: string,
      candidateGeneratedAt: string,
    ): Promise<boolean> {
      const result = await db
        .updateTable("entity_review_queue")
        .set({
          status,
          resolved_entity_id: resolvedEntityId,
          resolved_by: by,
          resolved_at: new Date().toISOString(),
        })
        .where("id", "=", reviewId)
        .where("status", "=", "pending")
        .where("candidate_generated_at", "=", candidateGeneratedAt)
        .execute();
      return Number(result[0]?.numUpdatedRows ?? 0) > 0;
    },

    /**
     * Insert into entity_alias_rejections. Normalizes `rejectedName` here so
     * route handlers and resolve.ts never call normalizeName directly. On
     * conflict against UNIQUE (entity_id, normalized_rejected_name), this is
     * a no-op — re-rejecting the same (entity, name) pair won't error.
     */
    async addRejection(input: { entityId: string; rejectedName: string; rejectedBy: string }): Promise<void> {
      const normalized = normalizeName(input.rejectedName);
      const id = randomUUID();
      const rejectedAt = new Date().toISOString();
      if (isPg(db)) {
        await sql`
          INSERT INTO entity_alias_rejections (id, entity_id, rejected_name, normalized_rejected_name, rejected_by, rejected_at)
          VALUES (${id}, ${input.entityId}, ${input.rejectedName}, ${normalized}, ${input.rejectedBy}, ${rejectedAt})
          ON CONFLICT (entity_id, normalized_rejected_name) DO NOTHING
        `.execute(db);
      } else {
        await sql`
          INSERT INTO entity_alias_rejections (id, entity_id, rejected_name, normalized_rejected_name, rejected_by, rejected_at)
          VALUES (${id}, ${input.entityId}, ${input.rejectedName}, ${normalized}, ${input.rejectedBy}, ${rejectedAt})
          ON CONFLICT (entity_id, normalized_rejected_name) DO NOTHING
        `.execute(db);
      }
    },

    /**
     * Return all evidence rows for a review, ordered by seen_at ascending.
     * v1 callers should cap the size (resolve.ts caps Confirm/Reject at
     * 1000 evidence rows). No `afterCursor` pagination yet — added when
     * chunking lands.
     */
    async listEvidenceForResolve(reviewId: string) {
      return db
        .selectFrom("entity_review_evidence")
        .selectAll()
        .where("review_id", "=", reviewId)
        .orderBy("seen_at", "asc")
        .execute();
    },

    /**
     * Same as `listEvidenceForResolve` but joined with indexed_files so the
     * UI can render a human-readable file name + link instead of an opaque
     * UUID. Capped to the most-recent 50 rows so the review-mode drawer
     * doesn't blow up on huge proposals — admin SQL is the path for those.
     */
    async listEvidenceWithFiles(reviewId: string, limit: number) {
      return db
        .selectFrom("entity_review_evidence as e")
        .innerJoin("indexed_files as i", "i.id", "e.indexed_file_id")
        .select([
          "e.id as id",
          "e.review_id as review_id",
          "e.indexed_file_id as indexed_file_id",
          "e.source as source",
          "e.note as note",
          "e.seen_at as seen_at",
          "i.file_name as file_name",
          "i.provider_url as provider_url",
          "i.source_path as source_path",
        ])
        .where("e.review_id", "=", reviewId)
        .orderBy("e.seen_at", "desc")
        .limit(limit)
        .execute();
    },

    /**
     * Count distinct owners of evidence files for a review (via
     * indexed_files.connector_config_id → connector_configs.created_by),
     * excluding `triggeredByUserId`. >0 means the row's evidence spans
     * other users — admin-only per ECR-02's owner-scope rules.
     */
    async countOtherOwnersInEvidence(reviewId: string, triggeredByUserId: string): Promise<number> {
      const row = await db
        .selectFrom("entity_review_evidence as e")
        .innerJoin("indexed_files as i", "i.id", "e.indexed_file_id")
        .innerJoin("connector_configs as cc", "cc.id", "i.connector_config_id")
        .select((eb) => eb.fn.count<number>(sql`DISTINCT cc.created_by`).as("owners"))
        .where("e.review_id", "=", reviewId)
        .where("cc.created_by", "!=", triggeredByUserId)
        .executeTakeFirst();
      return Number(row?.owners ?? 0);
    },
  };
}

export type EntityReviewRepository = ReturnType<typeof createEntityReviewRepo>;

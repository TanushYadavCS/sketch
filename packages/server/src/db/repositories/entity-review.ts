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
     * is true. Cross-user-evidence rows are admin-only — the route layer
     * filters those via the DISTINCT-owner query before showing them; this
     * repo method intentionally does NOT replicate that filter so callers
     * can choose their own owner-aware view.
     */
    async listPending(opts: {
      ownerUserId?: string;
      isAdmin: boolean;
      limit: number;
      offset?: number;
    }) {
      let q = db.selectFrom("entity_review_queue").selectAll().where("status", "=", "pending");
      if (!opts.isAdmin && opts.ownerUserId) {
        q = q.where("triggered_by_user_id", "=", opts.ownerUserId);
      }
      q = q.orderBy("last_seen_at", "desc").limit(opts.limit);
      if (opts.offset) q = q.offset(opts.offset);
      return q.execute();
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
     * Mark a queue row resolved. Sets status, resolved_entity_id, resolved_by,
     * resolved_at. Status must be 'confirmed' or 'rejected'. resolved_entity_id
     * is required — by construction, both Confirm and Reject end with a
     * concrete target entity id (after Reject's re-resolve-or-create step).
     */
    async markResolved(
      reviewId: string,
      status: "confirmed" | "rejected",
      resolvedEntityId: string,
      by: string,
    ): Promise<void> {
      await db
        .updateTable("entity_review_queue")
        .set({
          status,
          resolved_entity_id: resolvedEntityId,
          resolved_by: by,
          resolved_at: new Date().toISOString(),
        })
        .where("id", "=", reviewId)
        .execute();
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

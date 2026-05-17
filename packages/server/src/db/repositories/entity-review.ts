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

function readReviewFreezeMs(): number {
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
     * Read-side listing for direct DB inspection. No API surface yet — ECR-02
     * adds the route handlers. Owner scope filters to rows triggered by the
     * caller, unless `isAdmin` is true. Cross-user rows (multiple unique
     * triggers in evidence) require admin; ECR-01 doesn't materialize that
     * filter — left for ECR-02 when admin escalation lands.
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
  };
}

export type EntityReviewRepository = ReturnType<typeof createEntityReviewRepo>;

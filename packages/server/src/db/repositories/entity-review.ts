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
export type EntityReviewOrigin = "tracker" | "inferred";
export type ReclassifyReviewResult =
  | { result: "RECLASSIFY"; row: QueueRow; mergedFromReviewId: string | null }
  | { result: "TYPE_RECLASSIFY_COLLISION"; row: QueueRow; collidingRow: QueueRow };

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
  source?: string | null;
  sourceId?: string | null;
  seedSource?: string | null;
  seedSourceId?: string | null;
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

export interface UpsertSeedReviewRowInput {
  proposedName: string;
  normalizedName: string;
  entityType: string;
  seedSource: string;
  seedSourceId: string;
  candidateEntityId: string | null;
  triggeredByUserId: string;
  metadata?: Record<string, unknown>;
  seedAliases?: string[];
}

export interface UpsertEvidenceInput {
  reviewId: string;
  indexedFileId: string;
  source: string;
  note?: string | null;
  seenAt?: string;
}

const TERMINAL_STATUSES = new Set(["confirmed", "rejected", "confirming"]);
const SPINE_ENTITY_TYPES = new Set(["project", "product", "team"]);
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";

function refsDiffer(
  left: { source: string | null; source_id: string | null },
  right: { source: string | null; source_id: string | null },
): boolean {
  if (!left.source || !left.source_id || !right.source || !right.source_id) return false;
  return left.source !== right.source || left.source_id !== right.source_id;
}

function seedRefsDiffer(
  left: { seed_source: string | null; seed_source_id: string | null },
  right: { seed_source: string | null; seed_source_id: string | null },
): boolean {
  if (!left.seed_source || !left.seed_source_id || !right.seed_source || !right.seed_source_id) return false;
  return left.seed_source !== right.seed_source || left.seed_source_id !== right.seed_source_id;
}

function maxIso(left: string, right: string): string {
  return left > right ? left : right;
}

export function createEntityReviewRepo(db: Kysely<DB>) {
  async function recomputeCandidate(reviewId: string, entityType: string, now: string): Promise<void> {
    const row = await db
      .selectFrom("entity_review_queue")
      .select(["id", "normalized_name", "candidate_reason"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    const entities = await db
      .selectFrom("entities")
      .select(["id", "name", "aliases"])
      .where("source_type", "=", entityType)
      .where("deleted_at", "is", null)
      .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
      .execute();
    const candidate = entities.find((entity) => {
      if (normalizeName(entity.name) === row.normalized_name) return true;
      const aliases: string[] = entity.aliases ? JSON.parse(entity.aliases) : [];
      return aliases.some((alias) => normalizeName(alias) === row.normalized_name);
    });
    await db
      .updateTable("entity_review_queue")
      .set({
        candidate_entity_id: candidate?.id ?? null,
        candidate_score: candidate ? 1 : null,
        candidate_reason: candidate ? "reclassified" : row.candidate_reason,
        candidate_generated_at: now,
      })
      .where("id", "=", row.id)
      .execute();
  }

  async function findSeedReviewRow(seedSource: string, seedSourceId: string): Promise<QueueRow | undefined> {
    return db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("seed_source", "=", seedSource)
      .where("seed_source_id", "=", seedSourceId)
      .orderBy("first_seen_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
  }

  async function insertSeedReviewRow(input: UpsertSeedReviewRowInput, normalizedName: string): Promise<QueueRow> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values({
        id,
        proposed_name: input.proposedName,
        normalized_name: normalizedName,
        entity_type: input.entityType,
        proposed_email: null,
        candidate_entity_id: input.candidateEntityId,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: input.triggeredByUserId,
        seed_source: input.seedSource,
        seed_source_id: input.seedSourceId,
        seed_aliases: input.seedAliases && input.seedAliases.length > 0 ? JSON.stringify(input.seedAliases) : null,
      })
      .execute();

    return db.selectFrom("entity_review_queue").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

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

      const existingBySource =
        input.source && input.sourceId
          ? await db
              .selectFrom("entity_review_queue")
              .selectAll()
              .where("source", "=", input.source)
              .where("source_id", "=", input.sourceId)
              .executeTakeFirst()
          : undefined;
      const existing =
        existingBySource ??
        (await db
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("normalized_name", "=", input.normalizedName)
          .where("entity_type", "=", input.entityType)
          .executeTakeFirst());

      if (!existing) {
        const id = randomUUID();
        await db
          .insertInto("entity_review_queue")
          .values({
            id,
            proposed_name: input.proposedName,
            normalized_name: input.normalizedName,
            entity_type: input.entityType,
            source: input.source ?? null,
            source_id: input.sourceId ?? null,
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
      const sourcePatch =
        existing.source === null && existing.source_id === null && input.source && input.sourceId
          ? { source: input.source, source_id: input.sourceId }
          : {};

      if (midReview) {
        await db
          .updateTable("entity_review_queue")
          .set({
            last_seen_at: now,
            occurrence_count: existing.occurrence_count + 1,
            ...sourcePatch,
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
            ...sourcePatch,
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

    findSeedReviewRow,

    async upsertSeedReviewRow(input: UpsertSeedReviewRowInput): Promise<UpsertQueueRowResult> {
      const existing = await findSeedReviewRow(input.seedSource, input.seedSourceId);
      if (existing && TERMINAL_STATUSES.has(existing.status)) {
        return { row: existing, skipEvidence: true };
      }

      const now = new Date().toISOString();
      if (existing) {
        const isTaken = async (candidate: string): Promise<boolean> => {
          const collision = await db
            .selectFrom("entity_review_queue")
            .select(["id"])
            .where("normalized_name", "=", candidate)
            .where("entity_type", "=", input.entityType)
            .where("id", "!=", existing.id)
            .executeTakeFirst();
          return Boolean(collision);
        };
        const fallback = `${input.normalizedName}:${input.seedSource}:${input.seedSourceId}`;
        const normalizedName = !(await isTaken(input.normalizedName))
          ? input.normalizedName
          : !(await isTaken(fallback))
            ? fallback
            : undefined;
        await db
          .updateTable("entity_review_queue")
          .set({
            proposed_name: input.proposedName,
            ...(normalizedName !== undefined ? { normalized_name: normalizedName } : {}),
            candidate_entity_id: input.candidateEntityId,
            candidate_score: null,
            candidate_reason: null,
            candidate_generated_at: now,
            last_seen_at: now,
            occurrence_count: existing.occurrence_count + 1,
            seed_aliases: input.seedAliases && input.seedAliases.length > 0 ? JSON.stringify(input.seedAliases) : null,
          })
          .where("id", "=", existing.id)
          .execute();

        const refreshed = await db
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
        return { row: refreshed, skipEvidence: false };
      }

      try {
        const row = await insertSeedReviewRow(input, input.normalizedName);
        return { row, skipEvidence: false };
      } catch (error) {
        const rowForHandle = await findSeedReviewRow(input.seedSource, input.seedSourceId);
        if (rowForHandle) {
          return { row: rowForHandle, skipEvidence: TERMINAL_STATUSES.has(rowForHandle.status) };
        }

        const colliding = await db
          .selectFrom("entity_review_queue")
          .select(["id"])
          .where("normalized_name", "=", input.normalizedName)
          .where("entity_type", "=", input.entityType)
          .executeTakeFirst();
        if (!colliding) throw error;

        const row = await insertSeedReviewRow(
          input,
          `${input.normalizedName}:${input.seedSource}:${input.seedSourceId}`,
        );
        return { row, skipEvidence: false };
      }
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
      search?: string;
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
      const search = opts.search?.trim();
      if (search) {
        const pattern = `%${search.toLowerCase()}%`;
        q = q.where((eb) =>
          eb.or([eb("normalized_name", "like", pattern), eb(sql<string>`LOWER(proposed_name)`, "like", pattern)]),
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
    async countPending(opts: { ownerUserId?: string; isAdmin: boolean; search?: string }): Promise<number> {
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
      const search = opts.search?.trim();
      if (search) {
        const pattern = `%${search.toLowerCase()}%`;
        q = q.where((eb) =>
          eb.or([eb("normalized_name", "like", pattern), eb(sql<string>`LOWER(proposed_name)`, "like", pattern)]),
        );
      }
      const row = await q.executeTakeFirst();
      return Number(row?.c ?? 0);
    },

    /**
     * Group pending review rows by spine type and source-derived origin.
     * The CASE expression is selected and grouped directly so SQLite and
     * Postgres execute the same shape without boolean grouping.
     */
    async summarizePendingByTypeAndOrigin(opts: {
      ownerUserId?: string;
      isAdmin: boolean;
    }): Promise<{ groups: Array<{ entityType: string; origin: EntityReviewOrigin; count: number }>; total: number }> {
      const originExpr = sql<EntityReviewOrigin>`CASE WHEN source IS NOT NULL THEN 'tracker' ELSE 'inferred' END`;
      let q = db
        .selectFrom("entity_review_queue")
        .select(["entity_type", originExpr.as("origin"), db.fn.countAll<number>().as("c")])
        .where("status", "=", "pending");
      if (!opts.isAdmin) {
        if (!opts.ownerUserId) return { groups: [], total: 0 };
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
      const rows = await q.groupBy(["entity_type"]).groupBy(originExpr).orderBy("entity_type", "asc").execute();
      const groups = rows.map((row) => ({
        entityType: row.entity_type,
        origin: row.origin,
        count: Number(row.c),
      }));
      return { groups, total: groups.reduce((acc, group) => acc + group.count, 0) };
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

    async pendingReviewIdsWithEvidenceInFiles(fileIds: string[]): Promise<string[]> {
      if (fileIds.length === 0) return [];
      const rows = await db
        .selectFrom("entity_review_evidence")
        .innerJoin("entity_review_queue", "entity_review_queue.id", "entity_review_evidence.review_id")
        .select("entity_review_evidence.review_id")
        .distinct()
        .where("entity_review_evidence.indexed_file_id", "in", fileIds)
        .where("entity_review_queue.status", "=", "pending")
        .execute();
      return rows.map((row) => row.review_id);
    },

    async deleteReviewEvidenceForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;
      const result = await db
        .deleteFrom("entity_review_evidence")
        .where("indexed_file_id", "in", fileIds)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async deleteEmptyPendingReviewsByIds(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const result = await db
        .deleteFrom("entity_review_queue")
        .where("id", "in", ids)
        .where("status", "=", "pending")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("entity_review_evidence")
                .select(sql`1`.as("x"))
                .whereRef("entity_review_evidence.review_id", "=", "entity_review_queue.id"),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    /**
     * Fetch a single queue row by id, regardless of status.
     */
    async getById(reviewId: string) {
      return db.selectFrom("entity_review_queue").selectAll().where("id", "=", reviewId).executeTakeFirst();
    },

    /**
     * Reclassify a pending queue row to a spine entity type. If the new
     * normalized-name/type key already exists, evidence and compatible refs
     * are folded into the existing row without violating either queue ref
     * unique index.
     */
    async reclassifyType(reviewId: string, newEntityType: string, candidateGeneratedAt: string) {
      if (!SPINE_ENTITY_TYPES.has(newEntityType)) {
        throw new Error(`invalid spine entity type: ${newEntityType}`);
      }
      const now = new Date().toISOString();
      const sourceRow = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("id", "=", reviewId)
        .executeTakeFirst();
      if (!sourceRow) return undefined;
      if (sourceRow.candidate_generated_at !== candidateGeneratedAt || sourceRow.status !== "pending") {
        return { kind: "drift" as const, row: sourceRow };
      }
      if (sourceRow.entity_type === newEntityType) {
        await recomputeCandidate(sourceRow.id, newEntityType, now);
        const row = await db
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("id", "=", sourceRow.id)
          .executeTakeFirstOrThrow();
        return { kind: "updated" as const, row, mergedFromReviewId: null };
      }

      const targetRow = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("normalized_name", "=", sourceRow.normalized_name)
        .where("entity_type", "=", newEntityType)
        .where("id", "!=", sourceRow.id)
        .executeTakeFirst();

      if (targetRow) {
        if (refsDiffer(sourceRow, targetRow) || seedRefsDiffer(sourceRow, targetRow)) {
          return { kind: "collision" as const, row: sourceRow, collidingRow: targetRow };
        }

        const sourceEvidence = await db
          .selectFrom("entity_review_evidence")
          .selectAll()
          .where("review_id", "=", sourceRow.id)
          .execute();
        for (const evidence of sourceEvidence) {
          await db
            .insertInto("entity_review_evidence")
            .values({
              id: randomUUID(),
              review_id: targetRow.id,
              indexed_file_id: evidence.indexed_file_id,
              source: evidence.source,
              note: evidence.note,
              seen_at: evidence.seen_at,
            })
            .onConflict((oc) => oc.columns(["review_id", "indexed_file_id", "source"]).doNothing())
            .execute();
        }

        const captured = {
          source: sourceRow.source,
          source_id: sourceRow.source_id,
          seed_source: sourceRow.seed_source,
          seed_source_id: sourceRow.seed_source_id,
        };
        await db.deleteFrom("entity_review_queue").where("id", "=", sourceRow.id).execute();

        const patch: {
          occurrence_count: number;
          last_seen_at: string;
          candidate_generated_at: string;
          source?: string;
          source_id?: string;
          seed_source?: string;
          seed_source_id?: string;
          candidate_reason?: string | null;
        } = {
          occurrence_count: targetRow.occurrence_count + sourceRow.occurrence_count,
          last_seen_at: maxIso(targetRow.last_seen_at, sourceRow.last_seen_at),
          candidate_generated_at: now,
        };
        if (!targetRow.source && !targetRow.source_id && captured.source && captured.source_id) {
          patch.source = captured.source;
          patch.source_id = captured.source_id;
          if (!targetRow.candidate_reason) patch.candidate_reason = sourceRow.candidate_reason;
        }
        if (!targetRow.seed_source && !targetRow.seed_source_id && captured.seed_source && captured.seed_source_id) {
          patch.seed_source = captured.seed_source;
          patch.seed_source_id = captured.seed_source_id;
        }
        await db.updateTable("entity_review_queue").set(patch).where("id", "=", targetRow.id).execute();
        await recomputeCandidate(targetRow.id, newEntityType, now);
        const row = await db
          .selectFrom("entity_review_queue")
          .selectAll()
          .where("id", "=", targetRow.id)
          .executeTakeFirstOrThrow();
        return { kind: "updated" as const, row, mergedFromReviewId: sourceRow.id };
      }

      await db
        .updateTable("entity_review_queue")
        .set({
          entity_type: newEntityType,
          candidate_entity_id: null,
          candidate_score: null,
          candidate_generated_at: now,
        })
        .where("id", "=", sourceRow.id)
        .where("status", "=", "pending")
        .where("candidate_generated_at", "=", candidateGeneratedAt)
        .execute();
      await recomputeCandidate(sourceRow.id, newEntityType, now);
      const row = await db
        .selectFrom("entity_review_queue")
        .selectAll()
        .where("id", "=", sourceRow.id)
        .executeTakeFirstOrThrow();
      return { kind: "updated" as const, row, mergedFromReviewId: null };
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

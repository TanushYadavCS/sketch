/**
 * Confirm / Reject resolution for the entity-review queue.
 *
 * Both flows run inside a single transaction and end with the queue row in
 * a terminal state (`confirmed` or `rejected`) plus retroactive backfill of
 * `entity_mentions` and `file_access` for the evidence files that were
 * held since ECR-01.
 *
 * Errors are returned as typed `ResolveError`s so the route layer can map
 * to HTTP status codes (409 for state conflicts, 422 for size / type
 * violations). Throwing aborts the surrounding transaction.
 *
 * v1 limitations (deferred to v1.1):
 *   - No chunking: a single Confirm/Reject processes all evidence rows in
 *     one go. Capped at MAX_EVIDENCE_PER_RESOLVE to bound the SQLite write
 *     lock window.
 *   - No `confirming` intermediate state — this PR never produces it;
 *     existing rows in that state return 409.
 */
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { normalizeName } from "../connectors/name-normalize";
import { createEntityRepository } from "../db/repositories/entities";
import { type EvidenceRow, type QueueRow, createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB, EntitiesTable } from "../db/schema";

type Entity = Selectable<EntitiesTable>;

export const MAX_EVIDENCE_PER_RESOLVE = 1000;

export type ResolveErrorCode =
  | "CANDIDATE_DRIFT"
  | "CANDIDATE_MISSING"
  | "TARGET_DELETED"
  | "TYPE_MISMATCH"
  | "EVIDENCE_TOO_LARGE"
  | "ALREADY_CONFIRMING"
  | "MULTIPLE_STALE_CANDIDATES"
  | "MULTIPLE_RE_RESOLVE_MATCHES"
  | "ROW_NOT_FOUND";

export class ResolveError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolveCtx {
  db: Kysely<DB>;
  userId: string;
  /** Override `Date.now()` ISO for tests. Defaults to current time. */
  now?: string;
}

interface ResolveTxnCtx {
  db: Kysely<DB>;
  repo: ReturnType<typeof createEntityReviewRepo>;
  entityRepo: ReturnType<typeof createEntityRepository>;
  userId: string;
  now: string;
}

export interface ConfirmOptions {
  /** Pick-a-different-existing target. Omitted → use row.candidate_entity_id. */
  mergeIntoEntityId?: string;
  /** From the client's view of the row — must match row.candidate_generated_at. */
  candidateGeneratedAt: string;
}

export interface RejectOptions {
  /** When set AND ≠ candidate_entity_id, write rejections against both. */
  rejectAgainstEntityId?: string;
  candidateGeneratedAt: string;
}

export interface ConfirmResult {
  row: QueueRow;
  targetEntityId: string;
  /** True when auto-resolution short-circuit applied (target email matched mid-flight). */
  shortCircuited: boolean;
  /** Stale entity merged in (and deleted) during step 5, if any. */
  mergedStaleEntityId: string | null;
  /** True when the 200 is a no-op replay of an already-confirmed row. */
  idempotent: boolean;
}

export interface RejectResult {
  row: QueueRow;
  targetEntityId: string;
  /** True when re-resolve found an existing entity and we linked instead of created. */
  reResolvedToExisting: boolean;
  /** New entity id when step 3 created one; same as targetEntityId in that case. */
  createdEntityId: string | null;
  /** True when the 200 is a no-op replay of an already-rejected row. */
  idempotent: boolean;
}

/**
 * Evidence `source` → `relation` mapping for held-mention materialization.
 * Used only when `entity_mentions.relation` exists (linkage PR-1 lands).
 * Codified here so the same constants drive both Confirm and Reject. Falls
 * back to `'mentioned'` for unknown sources.
 */
const RELATION_BY_SOURCE: Record<string, string> = {
  fireflies: "attended",
  gmail: "corresponded",
  "smart-enrichment": "mentioned",
};

function resolveRelation(source: string): string {
  return RELATION_BY_SOURCE[source] ?? "mentioned";
}

function readEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata);
    return typeof m.email === "string" && m.email.length > 0 ? m.email : null;
  } catch {
    return null;
  }
}

async function fetchRow(ctx: ResolveTxnCtx, reviewId: string): Promise<QueueRow> {
  const row = await ctx.repo.getById(reviewId);
  if (!row) throw new ResolveError("ROW_NOT_FOUND", `queue row ${reviewId} not found`);
  return row;
}

async function fetchEntity(ctx: ResolveTxnCtx, entityId: string): Promise<Entity | undefined> {
  return ctx.db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirst();
}

/**
 * Complete the terminal transition only if the queue row is still pending at
 * the candidate snapshot this transaction validated. A lost CAS throws so the
 * transaction rolls back any alias, entity, evidence, or rejection writes that
 * happened before the terminal update.
 */
async function markResolvedOrThrow(
  ctx: ResolveTxnCtx,
  row: QueueRow,
  status: "confirmed" | "rejected",
  resolvedEntityId: string,
): Promise<QueueRow> {
  if (!row.candidate_generated_at) {
    throw new ResolveError("CANDIDATE_DRIFT", "row missing candidate_generated_at", { currentRow: row });
  }
  const won = await ctx.repo.markResolved(row.id, status, resolvedEntityId, ctx.userId, row.candidate_generated_at);
  if (!won) {
    const currentRow = await fetchRow(ctx, row.id);
    throw new ResolveError("CANDIDATE_DRIFT", "row was resolved or refreshed by another request", {
      currentStatus: currentRow.status,
      currentRow,
    });
  }
  return fetchRow(ctx, row.id);
}

/**
 * Insert one entity_mentions row for (entityId, fileId). Idempotent via the
 * UNIQUE index from migration 056. `chunk_index` and `context_snippet` left
 * null — held mentions don't carry chunk-level info (that's a connector's
 * concern; here we're only re-creating the entity↔file link).
 */
async function insertHeldMention(
  ctx: ResolveTxnCtx,
  entityId: string,
  indexedFileId: string,
  _source: string,
  _confidence: "confirmed" | "inferred",
): Promise<void> {
  await sql`
    INSERT INTO entity_mentions (id, entity_id, indexed_file_id, chunk_index, context_snippet, mentioned_at)
    VALUES (${randomUUID()}, ${entityId}, ${indexedFileId}, NULL, NULL, ${ctx.now})
    ON CONFLICT (entity_id, indexed_file_id) DO NOTHING
  `.execute(ctx.db);
  // `relation` / `confidence` columns land with ENTITY_LINKAGE_PROVENANCE
  // PR-1. When they exist the resolve module's INSERT shape must be widened
  // to populate them (relation = resolveRelation(_source), confidence =
  // _confidence). The relation map is centralized in RELATION_BY_SOURCE
  // above and the confidence vocabulary mirrors that PR's choices. Until
  // those columns ship, the underscore-prefixed args here are unused on
  // purpose — they're already plumbed so the migration that adds the
  // columns is the only place needing edits.
}

/**
 * Ensure (file, email) is in file_access. UNIQUE INDEX (indexed_file_id,
 * email) from migration 021 makes the ON CONFLICT path safe.
 */
async function ensureFileAccess(ctx: ResolveTxnCtx, indexedFileId: string, email: string): Promise<void> {
  await sql`
    INSERT INTO file_access (indexed_file_id, email)
    VALUES (${indexedFileId}, ${email})
    ON CONFLICT (indexed_file_id, email) DO NOTHING
  `.execute(ctx.db);
}

/**
 * Materialize held evidence against `target`. For person entities, also
 * grants `target.email` access on each evidence file. Companies are a
 * no-op for the ACL branch since they don't carry an email.
 */
async function materializeEvidence(
  ctx: ResolveTxnCtx,
  target: Entity,
  evidence: EvidenceRow[],
  confidence: "confirmed" | "inferred",
): Promise<void> {
  const targetEmail = target.source_type === "person" ? readEmail(target.metadata) : null;
  for (const ev of evidence) {
    if (targetEmail) {
      await ensureFileAccess(ctx, ev.indexed_file_id, targetEmail);
    }
    await insertHeldMention(ctx, target.id, ev.indexed_file_id, ev.source, confidence);
  }
}

/**
 * Try to short-circuit Confirm: if another sync seeded the proposed
 * identity directly against the target between propose and Confirm time,
 * the alias-append + stale-merge work is already done. Detection:
 * target carries an email AND its canonical name OR aliases already
 * normalize to `proposedName`. This is the post-state signature of a
 * connector having called `upsertPersonEntity` with the proposed name +
 * matching email, which would have appended the name to target.aliases
 * (see entities.ts upsertPersonEntity by-email branch). We still
 * materialize evidence — the seeding sync may have used a different file
 * window than the queue's evidence rows.
 */
async function autoResolutionShortCircuit(ctx: ResolveTxnCtx, target: Entity, proposedName: string): Promise<boolean> {
  if (target.source_type !== "person") return false;
  const targetEmail = readEmail(target.metadata);
  if (!targetEmail) return false;
  const normalized = normalizeName(proposedName);
  const fresh = await fetchEntity(ctx, target.id);
  if (!fresh) return false;
  if (normalizeName(fresh.name) === normalized) return true;
  const aliases: string[] = fresh.aliases ? JSON.parse(fresh.aliases) : [];
  return aliases.some((a) => normalizeName(a) === normalized);
}

/**
 * Find stale entities to merge during Confirm. Stale = same source_type,
 * canonical name matches the proposed name, no email, distinct from target.
 * Returns 0, 1, or ≥2 — the caller maps ≥2 to a 409.
 */
async function findStaleCandidates(ctx: ResolveTxnCtx, target: Entity, proposedName: string): Promise<Entity[]> {
  const normalized = normalizeName(proposedName);
  const candidates = await ctx.db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "=", target.source_type)
    .where("id", "!=", target.id)
    .execute();
  return candidates.filter((e) => {
    if (normalizeName(e.name) !== normalized) return false;
    if (readEmail(e.metadata)) return false;
    return true;
  });
}

/**
 * Stale-merge: fetch stale's mentions / source_refs, insert under target's
 * id with ON CONFLICT DO NOTHING, then delete stale. JS-side loop rather
 * than INSERT … SELECT because uuid generation differs between SQLite
 * (`randomblob`) and Postgres (`gen_random_uuid()`); a portable per-row
 * insert is simpler and stales in v1 carry tens of rows, not thousands.
 */
async function mergeStaleEntityPortable(ctx: ResolveTxnCtx, stale: Entity, target: Entity): Promise<void> {
  const staleMentions = await ctx.db
    .selectFrom("entity_mentions")
    .selectAll()
    .where("entity_id", "=", stale.id)
    .execute();
  for (const m of staleMentions) {
    await sql`
      INSERT INTO entity_mentions (id, entity_id, indexed_file_id, chunk_index, context_snippet, mentioned_at)
      VALUES (${randomUUID()}, ${target.id}, ${m.indexed_file_id}, ${m.chunk_index}, ${m.context_snippet}, ${m.mentioned_at})
      ON CONFLICT (entity_id, indexed_file_id) DO NOTHING
    `.execute(ctx.db);
  }

  const staleSourceRefs = await ctx.db
    .selectFrom("entity_source_refs")
    .selectAll()
    .where("entity_id", "=", stale.id)
    .execute();
  for (const r of staleSourceRefs) {
    await sql`
      INSERT INTO entity_source_refs (id, entity_id, source, source_id, source_url, last_seen_at)
      VALUES (${randomUUID()}, ${target.id}, ${r.source}, ${r.source_id}, ${r.source_url}, ${r.last_seen_at})
      ON CONFLICT (source, source_id) DO NOTHING
    `.execute(ctx.db);
  }

  // Audit FK fan-out: any other live reference to entities(id) needs to
  // either re-point at target or rely on ON DELETE SET NULL. Live refs in
  // the current schema:
  //   - entity_review_queue.candidate_entity_id  → ON DELETE SET NULL
  //   - entity_review_queue.resolved_entity_id   → ON DELETE SET NULL
  //   - entity_alias_rejections.entity_id        → ON DELETE CASCADE (rejection
  //                                                 disappears when the entity
  //                                                 it was written against is
  //                                                 deleted — intentional, see
  //                                                 master plan §"Cross-plan
  //                                                 risks")
  //   - entity_mentions.entity_id                → ON DELETE CASCADE
  //   - entity_source_refs.entity_id             → ON DELETE CASCADE
  // All handled by FK behaviour; no manual re-point needed for v1. When
  // entity_domains (linkage PR-2) lands it will add another FK — that
  // PR's migration owner is responsible for re-checking this list.
  await ctx.db.deleteFrom("entities").where("id", "=", stale.id).execute();
}

export async function confirmReview(ctx: ResolveCtx, reviewId: string, opts: ConfirmOptions): Promise<ConfirmResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const trxCtx: ResolveTxnCtx = {
      db: trx,
      repo: createEntityReviewRepo(trx),
      entityRepo: createEntityRepository(trx),
      userId: ctx.userId,
      now: ctx.now ?? new Date().toISOString(),
    };
    const row = await fetchRow(trxCtx, reviewId);

    // Idempotent replay against an already-terminal row.
    if (row.status === "confirmed") {
      const target = row.resolved_entity_id;
      if (!target) throw new ResolveError("ROW_NOT_FOUND", "confirmed row missing resolved_entity_id");
      return { row, targetEntityId: target, shortCircuited: false, mergedStaleEntityId: null, idempotent: true };
    }
    if (row.status === "rejected") {
      throw new ResolveError("CANDIDATE_DRIFT", "row already rejected", {
        currentStatus: row.status,
        currentRow: row,
      });
    }
    if (row.status === "confirming") {
      throw new ResolveError("ALREADY_CONFIRMING", "row is mid-confirm (chunked backfill in progress)");
    }

    // 1. Compare-and-swap.
    if (row.candidate_generated_at !== opts.candidateGeneratedAt) {
      throw new ResolveError("CANDIDATE_DRIFT", "candidate_generated_at mismatch", {
        actual: row.candidate_generated_at,
        provided: opts.candidateGeneratedAt,
        currentRow: row,
      });
    }

    // Target selection.
    const targetId: string | null = opts.mergeIntoEntityId ?? row.candidate_entity_id;
    if (!targetId) {
      throw new ResolveError("CANDIDATE_MISSING", "row has no candidate_entity_id and no mergeIntoEntityId provided", {
        currentRow: row,
      });
    }
    const pickedDifferent =
      opts.mergeIntoEntityId !== undefined &&
      row.candidate_entity_id !== null &&
      opts.mergeIntoEntityId !== row.candidate_entity_id;

    // 2. Existence check + type check.
    let target = await fetchEntity(trxCtx, targetId);
    if (!target) {
      throw new ResolveError("TARGET_DELETED", "target entity deleted between candidate-gen and confirm", {
        currentRow: row,
      });
    }
    if (target.source_type !== row.entity_type) {
      throw new ResolveError("TYPE_MISMATCH", "mergeIntoEntityId entity_type does not match queue row", {
        target: target.source_type,
        row: row.entity_type,
      });
    }

    // Evidence cap (chunking deferred).
    const evidence = await trxCtx.repo.listEvidenceForResolve(reviewId);
    if (evidence.length > MAX_EVIDENCE_PER_RESOLVE) {
      throw new ResolveError("EVIDENCE_TOO_LARGE", "too many evidence rows; chunked backfill not yet supported", {
        count: evidence.length,
        cap: MAX_EVIDENCE_PER_RESOLVE,
      });
    }

    // 3. Auto-resolution short-circuit.
    const shortCircuited = await autoResolutionShortCircuit(trxCtx, target, row.proposed_name);

    let mergedStaleEntityId: string | null = null;
    if (!shortCircuited) {
      // 4. Alias append.
      await trxCtx.entityRepo.appendAlias(target.id, row.proposed_name);

      // 5. Stale-entity merge.
      const stales = await findStaleCandidates(trxCtx, target, row.proposed_name);
      if (stales.length > 1) {
        throw new ResolveError(
          "MULTIPLE_STALE_CANDIDATES",
          "multiple stale candidates matched; manual admin merge required",
          {
            staleIds: stales.map((s) => s.id),
          },
        );
      }
      if (stales.length === 1) {
        await mergeStaleEntityPortable(trxCtx, stales[0], target);
        mergedStaleEntityId = stales[0].id;
      }
    }

    // Re-fetch target after alias-append + potential merge so the evidence
    // step sees the latest email / aliases.
    const refreshedTarget = await fetchEntity(trxCtx, target.id);
    if (refreshedTarget) target = refreshedTarget;

    // 6. Held-mention materialization + ACL backfill.
    await materializeEvidence(trxCtx, target, evidence, "confirmed");

    // Held-email path. Rare in v1 (no caller currently populates proposed_email),
    // but column exists so handle it here.
    if (row.proposed_email && row.entity_type === "person") {
      await trxCtx.entityRepo.attachEmailIfAbsent(target.id, row.proposed_email);
    }

    // Pick-different: write rejection against original candidate so it isn't re-suggested.
    if (pickedDifferent && row.candidate_entity_id) {
      await trxCtx.repo.addRejection({
        entityId: row.candidate_entity_id,
        rejectedName: row.proposed_name,
        rejectedBy: trxCtx.userId,
      });
    }

    // 7. Mark resolved.
    const refreshedRow = await markResolvedOrThrow(trxCtx, row, "confirmed", target.id);

    return { row: refreshedRow, targetEntityId: target.id, shortCircuited, mergedStaleEntityId, idempotent: false };
  });
}

/**
 * Find entities that already match the proposed name at Reject time —
 * either canonical name OR alias normalizes to the same key. Excludes the
 * suggested candidate (so we don't link to the very entity we're rejecting)
 * and any explicit `rejectAgainstEntityId`.
 */
async function findReResolveMatches(ctx: ResolveTxnCtx, row: QueueRow, excludeEntityIds: string[]): Promise<Entity[]> {
  const normalized = normalizeName(row.proposed_name);
  const candidates = await ctx.db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "=", row.entity_type)
    .execute();
  const excluded = new Set(excludeEntityIds.filter((id) => id != null));
  const out: Entity[] = [];
  for (const c of candidates) {
    if (excluded.has(c.id)) continue;
    if (normalizeName(c.name) === normalized) {
      out.push(c);
      continue;
    }
    const aliases: string[] = c.aliases ? JSON.parse(c.aliases) : [];
    if (aliases.some((a) => normalizeName(a) === normalized)) out.push(c);
  }
  return out;
}

export async function rejectReview(ctx: ResolveCtx, reviewId: string, opts: RejectOptions): Promise<RejectResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const trxCtx: ResolveTxnCtx = {
      db: trx,
      repo: createEntityReviewRepo(trx),
      entityRepo: createEntityRepository(trx),
      userId: ctx.userId,
      now: ctx.now ?? new Date().toISOString(),
    };
    const row = await fetchRow(trxCtx, reviewId);

    if (row.status === "rejected") {
      const target = row.resolved_entity_id;
      if (!target) throw new ResolveError("ROW_NOT_FOUND", "rejected row missing resolved_entity_id");
      return {
        row,
        targetEntityId: target,
        reResolvedToExisting: false,
        createdEntityId: null,
        idempotent: true,
      };
    }
    if (row.status === "confirmed") {
      throw new ResolveError("CANDIDATE_DRIFT", "row already confirmed", {
        currentStatus: row.status,
        currentRow: row,
      });
    }
    if (row.status === "confirming") {
      throw new ResolveError("ALREADY_CONFIRMING", "row is mid-confirm");
    }

    // 1. Compare-and-swap.
    if (row.candidate_generated_at !== opts.candidateGeneratedAt) {
      throw new ResolveError("CANDIDATE_DRIFT", "candidate_generated_at mismatch", {
        actual: row.candidate_generated_at,
        provided: opts.candidateGeneratedAt,
        currentRow: row,
      });
    }

    // Evidence cap.
    const evidence = await trxCtx.repo.listEvidenceForResolve(reviewId);
    if (evidence.length > MAX_EVIDENCE_PER_RESOLVE) {
      throw new ResolveError("EVIDENCE_TOO_LARGE", "too many evidence rows", {
        count: evidence.length,
        cap: MAX_EVIDENCE_PER_RESOLVE,
      });
    }

    // 2. Re-resolve before creating.
    const exclusions: string[] = [];
    if (row.candidate_entity_id) exclusions.push(row.candidate_entity_id);
    if (opts.rejectAgainstEntityId) exclusions.push(opts.rejectAgainstEntityId);
    const matches = await findReResolveMatches(trxCtx, row, exclusions);
    if (matches.length > 1) {
      throw new ResolveError(
        "MULTIPLE_RE_RESOLVE_MATCHES",
        "multiple matching entities found during Reject re-resolve",
        {
          ids: matches.map((m) => m.id),
        },
      );
    }

    let target: Entity;
    let createdEntityId: string | null = null;
    const reResolvedToExisting = matches.length === 1;
    if (reResolvedToExisting) {
      target = matches[0];
    } else {
      // 3. Create new entity. Decision recorded in plan §Helpers:
      // - source/sourceId derived from the first evidence row so source_refs
      //   carries honest provenance. When there is no evidence (rare —
      //   ECR-01 always writes at least one), fall back to a synthetic
      //   `entity-review` source.
      const sourceFromEvidence = evidence[0]?.source ?? "entity-review";
      const sourceId = `review:${reviewId}`;
      if (row.entity_type === "person") {
        const personData: {
          name: string;
          email?: string;
          subtype: "internal" | "external";
          source: string;
          sourceId: string;
        } = {
          // Reject-created entities default to 'external'. The user has
          // told us this is a separate identity from the suggested
          // candidate; we don't have a signal that they're internal.
          name: row.proposed_name,
          subtype: "external",
          source: sourceFromEvidence,
          sourceId,
        };
        if (row.proposed_email) personData.email = row.proposed_email;
        const created = await trxCtx.entityRepo.upsertPersonEntity(personData);
        target = created;
      } else {
        // Company (and any other open-ended type) path. upsertEntityFromTool
        // takes source/sourceId; upsertEntity does not. Either way we end
        // with a fresh entity row.
        const created = await trxCtx.entityRepo.upsertEntityFromTool({
          name: row.proposed_name,
          sourceType: row.entity_type,
          source: sourceFromEvidence,
          sourceId,
        });
        target = created;
      }
      createdEntityId = target.id;
      // Self-alias so a future identical proposal hits the exact-name fast-path.
      await trxCtx.entityRepo.appendAlias(target.id, row.proposed_name);
      // Re-fetch so we have the alias-bearing entity below.
      const refreshed = await fetchEntity(trxCtx, target.id);
      if (refreshed) target = refreshed;
    }

    // 4. Held-mention materialization + ACL backfill (confidence='inferred').
    await materializeEvidence(trxCtx, target, evidence, "inferred");

    // 5. Sticky rejection.
    if (row.candidate_entity_id) {
      await trxCtx.repo.addRejection({
        entityId: row.candidate_entity_id,
        rejectedName: row.proposed_name,
        rejectedBy: trxCtx.userId,
      });
    }
    if (opts.rejectAgainstEntityId && opts.rejectAgainstEntityId !== row.candidate_entity_id) {
      await trxCtx.repo.addRejection({
        entityId: opts.rejectAgainstEntityId,
        rejectedName: row.proposed_name,
        rejectedBy: trxCtx.userId,
      });
    }

    // 6. Mark resolved.
    const refreshedRow = await markResolvedOrThrow(trxCtx, row, "rejected", target.id);

    return { row: refreshedRow, targetEntityId: target.id, reResolvedToExisting, createdEntityId, idempotent: false };
  });
}

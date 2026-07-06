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
import type { Logger } from "pino";
import { normalizeName } from "../connectors/name-normalize";
import {
  type EntityContactPointKind,
  type EntityMentionConfidence,
  type EntityMentionRelation,
  createEntityRepository,
  whereLiveEntity,
} from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { type EvidenceRow, type QueueRow, createEntityReviewRepo } from "../db/repositories/entity-review";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB, EntitiesTable, EntityContactPointsTable } from "../db/schema";
import { inferAffiliationFromEmail } from "./affiliations";
import { finalizeLinkedDomainCandidates } from "./domain-promotion";
import { normalizeEntityMatchName } from "./match-normalize";
import {
  type MaterializeResult,
  buildMaterializeDeps,
  materializeFromFact,
  shouldMarkMaterialized,
} from "./materialize";
import { mergeEntitiesInTransaction } from "./merge";

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
  | "TYPE_RECLASSIFY_COLLISION"
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
  logger?: Logger;
}

interface ResolveTxnCtx {
  db: Kysely<DB>;
  repo: ReturnType<typeof createEntityReviewRepo>;
  entityRepo: ReturnType<typeof createEntityRepository>;
  userId: string;
  now: string;
  logger?: Logger;
}

export interface ConfirmOptions {
  /** Pick-a-different-existing target. Omitted → use row.candidate_entity_id. */
  mergeIntoEntityId?: string;
  /** From the client's view of the row — must match row.candidate_generated_at. */
  candidateGeneratedAt: string;
  /**
   * Rename the entity at confirm time (births only). When creating from a seed,
   * the entity is created under this name instead of `proposed_name`, and the
   * original `proposed_name` is preserved as an alias so the connector's name
   * still resolves. Ignored on a merge into an existing target.
   */
  nameOverride?: string;
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

export interface DismissResult {
  row: QueueRow;
  /** True when the 200 is a no-op replay of an already-dismissed row. */
  idempotent: boolean;
}

export type ReclassifyResultKind = "RECLASSIFY" | "TYPE_RECLASSIFY_COLLISION";

export interface ReclassifyResult {
  row: QueueRow;
  result: ReclassifyResultKind;
  collidingRow?: QueueRow;
  mergedFromReviewId?: string | null;
}

/**
 * Evidence `source` → `relation` mapping for held-mention materialization.
 * Used only when `entity_mentions.relation` exists (linkage PR-1 lands).
 * Codified here so the same constants drive both Confirm and Reject. Falls
 * back to `'mentioned'` for unknown sources.
 */
const RELATION_BY_SOURCE: Record<string, EntityMentionRelation> = {
  fireflies: "attended",
  gmail: "corresponded",
  "smart-enrichment": "mentioned",
};

function resolveRelation(source: string): EntityMentionRelation {
  return RELATION_BY_SOURCE[source] ?? "mentioned";
}

function resolveConfidence(confidence: "confirmed" | "inferred"): EntityMentionConfidence {
  return confidence === "confirmed" ? "EXTRACTED" : "INFERRED";
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

function readJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function shouldMarkHeldFactMaterialized(result: MaterializeResult): boolean {
  if (result.kind === "entity_created" || result.kind === "entity_linked" || result.kind === "structural") return true;
  if (result.kind === "queued" || result.kind === "queued_held") return false;
  if (result.kind === "skipped_missing_owner" || result.kind === "deferred_below_threshold") return false;
  if (result.kind === "skipped") {
    return (
      result.reason !== "missing_parent_seed" &&
      result.reason !== "unknown_fact_type" &&
      result.reason !== "missing_or_invalid_mention_type"
    );
  }
  return false;
}

async function fetchRow(ctx: ResolveTxnCtx, reviewId: string): Promise<QueueRow> {
  const row = await ctx.repo.getById(reviewId);
  if (!row) throw new ResolveError("ROW_NOT_FOUND", `queue row ${reviewId} not found`);
  return row;
}

async function fetchEntity(ctx: ResolveTxnCtx, entityId: string): Promise<Entity | undefined> {
  return ctx.db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", entityId)
    .where(whereLiveEntity())
    .executeTakeFirst();
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
 * Insert one entity_mentions row for (entityId, fileId, relation). `chunk_index`
 * and `context_snippet` stay null because held mentions don't carry chunk-level
 * info; here we're only re-creating the entity↔file edge.
 */
async function insertHeldMention(
  ctx: ResolveTxnCtx,
  entityId: string,
  indexedFileId: string,
  source: string,
  confidence: "confirmed" | "inferred",
): Promise<void> {
  const relation = resolveRelation(source);
  const mentionConfidence = resolveConfidence(confidence);
  await sql`
    INSERT INTO entity_mentions (
      id,
      entity_id,
      indexed_file_id,
      chunk_index,
      context_snippet,
      confidence,
      source,
      relation,
      mentioned_at
    )
    VALUES (
      ${randomUUID()},
      ${entityId},
      ${indexedFileId},
      NULL,
      NULL,
      ${mentionConfidence},
      ${source},
      ${relation},
      ${ctx.now}
    )
    ON CONFLICT (entity_id, indexed_file_id, relation) DO NOTHING
  `.execute(ctx.db);
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
    if (ev.source === "llm_extraction") continue;
    if (targetEmail) {
      await ensureFileAccess(ctx, ev.indexed_file_id, targetEmail);
    }
    await insertHeldMention(ctx, target.id, ev.indexed_file_id, ev.source, confidence);
  }
}

async function rematerializeHeldLlmEvidence(ctx: ResolveTxnCtx, row: QueueRow, evidence: EvidenceRow[]): Promise<void> {
  const llmEvidence = evidence.filter((ev) => ev.source === "llm_extraction");
  if (llmEvidence.length === 0) return;
  const deps = await buildMaterializeDeps(ctx.db);
  const fileIds = [...new Set(llmEvidence.map((ev) => ev.indexed_file_id))];
  const facts = await ctx.db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("indexed_file_id", "in", fileIds)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();

  for (const fact of facts) {
    if (!fact.subject_name) continue;
    if (normalizeEntityMatchName(row.entity_type, fact.subject_name) !== row.normalized_name) continue;
    const raw = readJsonObject(fact.raw);
    if (raw.type !== row.entity_type) continue;
    const result = await materializeFromFact(deps, fact);
    if (shouldMarkHeldFactMaterialized(result)) {
      await ctx.db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: ctx.now })
        .where("id", "=", fact.id)
        .where("materialized_at", "is", null)
        .execute();
    }
  }
}

async function reviveDeferredRelationsForEntity(
  ctx: ResolveTxnCtx,
  resolvedEntity: Entity,
): Promise<{ revived: number; overflowed: boolean }> {
  const candidates = [
    normalizeName(resolvedEntity.name),
    ...parseAliases(resolvedEntity.aliases).map((alias) => normalizeName(alias)),
  ].filter((name) => name.length > 0);
  const names = [...new Set(candidates)];
  if (names.length === 0) return { revived: 0, overflowed: false };

  const maxScan = 100;
  const factRepo = createIndexedFileFactRepository(ctx.db);
  const facts = await factRepo.findUnmaterializedRelationFactsByEndpointName(names, maxScan + 1);
  const overflowed = facts.length > maxScan;
  const toRevive = overflowed ? facts.slice(0, maxScan) : facts;
  if (overflowed) {
    ctx.logger?.warn(
      { entityId: resolvedEntity.id, scanCap: maxScan, aliasCount: names.length - 1 },
      "Deferred relation revival cap reached",
    );
  }

  const deps = await buildMaterializeDeps(ctx.db);
  let revived = 0;
  for (const fact of toRevive) {
    const result = await materializeFromFact(deps, fact);
    if (result.kind === "relationship_materialized") {
      await ctx.db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: ctx.now })
        .where("id", "=", fact.id)
        .where("materialized_at", "is", null)
        .execute();
      revived++;
      continue;
    }
    if (shouldMarkMaterialized(result)) {
      await ctx.db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: ctx.now })
        .where("id", "=", fact.id)
        .where("materialized_at", "is", null)
        .execute();
    }
  }

  return { revived, overflowed };
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

function parseSeedAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0);
  } catch {
    return [];
  }
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
    .where(whereLiveEntity())
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
      INSERT INTO entity_mentions (
        id,
        entity_id,
        indexed_file_id,
        chunk_index,
        context_snippet,
        confidence,
        source,
        relation,
        mentioned_at
      )
      VALUES (
        ${randomUUID()},
        ${target.id},
        ${m.indexed_file_id},
        ${m.chunk_index},
        ${m.context_snippet},
        ${m.confidence},
        ${m.source},
        ${m.relation},
        ${m.mentioned_at}
      )
      ON CONFLICT (entity_id, indexed_file_id, relation) DO NOTHING
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

  await transferStaleContactPoints(ctx, stale.id, target.id);

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

type PrimaryContactCandidate = {
  kind: EntityContactPointKind;
  value: string;
  id: string;
  lastContactedAt: string | null;
  verifiedAt: string | null;
};

type ContactPoint = Selectable<EntityContactPointsTable>;

function compareNullableIsoDesc(left: string | null, right: string | null): number {
  if (left && right && left !== right) return left > right ? -1 : 1;
  if (left && !right) return -1;
  if (!left && right) return 1;
  return 0;
}

function comparePrimaryContactCandidates(left: PrimaryContactCandidate, right: PrimaryContactCandidate): number {
  const recency = compareNullableIsoDesc(left.lastContactedAt, right.lastContactedAt);
  if (recency !== 0) return recency;
  const verification = compareNullableIsoDesc(left.verifiedAt, right.verifiedAt);
  if (verification !== 0) return verification;
  return left.id.localeCompare(right.id);
}

/**
 * Move stale contactability facts to the confirmed target before deleting the
 * stale entity. Duplicate contact points collapse through the repository upsert;
 * primary conflicts are resolved per kind by recency, then verification, then
 * stable row id.
 */
async function transferStaleContactPoints(ctx: ResolveTxnCtx, staleId: string, targetId: string): Promise<void> {
  const staleContactPoints = await ctx.db
    .selectFrom("entity_contact_points")
    .selectAll()
    .where("entity_id", "=", staleId)
    .execute();
  if (staleContactPoints.length === 0) return;

  const primaryRows = await ctx.db
    .selectFrom("entity_contact_points")
    .select(["kind", "value"])
    .where("entity_id", "in", [targetId, staleId])
    .where("is_primary", "=", 1)
    .execute();
  const primaryValuesByKind = new Map<EntityContactPointKind, Set<string>>();
  for (const row of primaryRows) {
    const kind = row.kind as EntityContactPointKind;
    primaryValuesByKind.set(kind, (primaryValuesByKind.get(kind) ?? new Set()).add(row.value));
  }

  for (const contactPoint of staleContactPoints) {
    await upsertTransferredContactPoint(ctx, targetId, contactPoint);
  }

  for (const [kind, values] of primaryValuesByKind) {
    const candidates = await ctx.db
      .selectFrom("entity_contact_points")
      .select(["id", "value", "last_contacted_at", "verified_at"])
      .where("entity_id", "=", targetId)
      .where("kind", "=", kind)
      .where("value", "in", [...values])
      .execute();
    const winner = candidates
      .map(
        (row): PrimaryContactCandidate => ({
          kind,
          value: row.value,
          id: row.id,
          lastContactedAt: row.last_contacted_at,
          verifiedAt: row.verified_at,
        }),
      )
      .sort(comparePrimaryContactCandidates)[0];
    if (!winner) continue;

    await ctx.db
      .updateTable("entity_contact_points")
      .set({ is_primary: 0, updated_at: ctx.now })
      .where("entity_id", "=", targetId)
      .where("kind", "=", kind)
      .execute();
    await ctx.db
      .updateTable("entity_contact_points")
      .set({ is_primary: 1, updated_at: ctx.now })
      .where("id", "=", winner.id)
      .execute();
  }
}

async function upsertTransferredContactPoint(ctx: ResolveTxnCtx, targetId: string, contactPoint: ContactPoint) {
  await ctx.db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: targetId,
      kind: contactPoint.kind,
      value: contactPoint.value,
      display_value: contactPoint.display_value,
      label: contactPoint.label,
      is_primary: 0,
      source: contactPoint.source,
      connector_config_id: contactPoint.connector_config_id,
      created_by_user_id: contactPoint.created_by_user_id,
      verified_at: contactPoint.verified_at,
      last_contacted_at: contactPoint.last_contacted_at,
      created_at: ctx.now,
      updated_at: ctx.now,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "kind", "value"]).doUpdateSet({
        display_value: sql`COALESCE(entity_contact_points.display_value, excluded.display_value)`,
        label: sql`COALESCE(excluded.label, entity_contact_points.label)`,
        source: contactPoint.source,
        connector_config_id: sql`COALESCE(excluded.connector_config_id, entity_contact_points.connector_config_id)`,
        created_by_user_id: sql`COALESCE(excluded.created_by_user_id, entity_contact_points.created_by_user_id)`,
        verified_at: sql`CASE
          WHEN entity_contact_points.verified_at IS NULL THEN excluded.verified_at
          WHEN excluded.verified_at IS NULL THEN entity_contact_points.verified_at
          WHEN excluded.verified_at > entity_contact_points.verified_at THEN excluded.verified_at
          ELSE entity_contact_points.verified_at
        END`,
        last_contacted_at: sql`CASE
          WHEN entity_contact_points.last_contacted_at IS NULL THEN excluded.last_contacted_at
          WHEN excluded.last_contacted_at IS NULL THEN entity_contact_points.last_contacted_at
          WHEN excluded.last_contacted_at > entity_contact_points.last_contacted_at THEN excluded.last_contacted_at
          ELSE entity_contact_points.last_contacted_at
        END`,
        updated_at: ctx.now,
      }),
    )
    .execute();
}

export async function confirmReview(ctx: ResolveCtx, reviewId: string, opts: ConfirmOptions): Promise<ConfirmResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const trxCtx: ResolveTxnCtx = {
      db: trx,
      repo: createEntityReviewRepo(trx),
      entityRepo: createEntityRepository(trx),
      userId: ctx.userId,
      now: ctx.now ?? new Date().toISOString(),
      logger: ctx.logger,
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
    if (row.status === "dismissed") {
      throw new ResolveError("CANDIDATE_DRIFT", "row already dismissed", {
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
    const pickedDifferent =
      opts.mergeIntoEntityId !== undefined &&
      row.candidate_entity_id !== null &&
      opts.mergeIntoEntityId !== row.candidate_entity_id;

    // 2. Existence check + type check.
    const createName = opts.nameOverride?.trim() || row.proposed_name;
    const renamed = createName !== row.proposed_name;
    let target: Entity;
    if (!targetId) {
      if (!row.seed_source || !row.seed_source_id) {
        if (row.candidate_reason === "birth-gated" && row.source && row.source_id) {
          target = await trxCtx.entityRepo.upsertEntityFromTool({
            name: createName,
            sourceType: row.entity_type,
            source: row.source,
            sourceId: row.source_id,
            provenanceTier: "human_confirmed",
          });
        } else {
          throw new ResolveError(
            "CANDIDATE_MISSING",
            "row has no candidate_entity_id and no mergeIntoEntityId provided",
            {
              currentRow: row,
            },
          );
        }
      } else {
        target = await trxCtx.entityRepo.upsertEntityFromTool({
          name: createName,
          sourceType: row.entity_type,
          source: row.seed_source,
          sourceId: row.seed_source_id,
          provenanceTier: "human_confirmed",
        });
      }
      if (renamed) await trxCtx.entityRepo.appendAlias(target.id, row.proposed_name);
    } else {
      const fetchedTarget = await fetchEntity(trxCtx, targetId);
      if (!fetchedTarget) {
        throw new ResolveError("TARGET_DELETED", "target entity deleted between candidate-gen and confirm", {
          currentRow: row,
        });
      }
      if (fetchedTarget.source_type !== row.entity_type) {
        throw new ResolveError("TYPE_MISMATCH", "mergeIntoEntityId entity_type does not match queue row", {
          target: fetchedTarget.source_type,
          row: row.entity_type,
        });
      }
      target = fetchedTarget;
    }
    if (row.seed_source && row.seed_source_id) {
      await trxCtx.entityRepo.upsertSourceRef({
        entityId: target.id,
        source: row.seed_source,
        sourceId: row.seed_source_id,
      });
    }
    for (const alias of parseSeedAliases(row.seed_aliases)) {
      await trxCtx.entityRepo.appendAlias(target.id, alias);
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
        await mergeEntitiesInTransaction(trxCtx.db, {
          survivorId: target.id,
          loserId: stales[0].id,
          userId: trxCtx.userId,
        });
        mergedStaleEntityId = stales[0].id;
      }
    }

    // Re-fetch target after alias-append + potential merge so the evidence
    // step sees the latest email / aliases.
    const refreshedTarget = await fetchEntity(trxCtx, target.id);
    if (refreshedTarget) target = refreshedTarget;

    // 6. Held-mention materialization + ACL backfill.
    await materializeEvidence(trxCtx, target, evidence, "confirmed");
    await rematerializeHeldLlmEvidence(trxCtx, row, evidence);

    // Held-email path. Rare in v1 (no caller currently populates proposed_email),
    // but column exists so handle it here.
    if (row.proposed_email && row.entity_type === "person") {
      await trxCtx.entityRepo.attachEmailIfAbsent(target.id, row.proposed_email);
      const evidenceFileId = evidence.find((e) => e.indexed_file_id)?.indexed_file_id ?? null;
      await inferAffiliationFromEmail(
        { db: trxCtx.db, domainsRepo: createEntityDomainsRepository(trxCtx.db) },
        {
          personEntityId: target.id,
          email: row.proposed_email,
          evidenceFileId,
          firstObservedByUserId: trxCtx.userId,
        },
      );
    }

    if (row.entity_type === "company") {
      await finalizeLinkedDomainCandidates(trxCtx.db, row.id, target.id);
    }
    await writeReviewSourceRef(trxCtx, row, target.id);
    await reviveDeferredRelationsForEntity(trxCtx, target);

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
    .where(whereLiveEntity())
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

async function writeReviewSourceRef(ctx: ResolveTxnCtx, row: QueueRow, entityId: string): Promise<void> {
  if (!row.source || !row.source_id) return;
  await ctx.entityRepo.upsertSourceRef({
    entityId,
    source: row.source,
    sourceId: row.source_id,
  });
}

export async function rejectReview(ctx: ResolveCtx, reviewId: string, opts: RejectOptions): Promise<RejectResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const trxCtx: ResolveTxnCtx = {
      db: trx,
      repo: createEntityReviewRepo(trx),
      entityRepo: createEntityRepository(trx),
      userId: ctx.userId,
      now: ctx.now ?? new Date().toISOString(),
      logger: ctx.logger,
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
    if (row.status === "dismissed") {
      throw new ResolveError("CANDIDATE_DRIFT", "row already dismissed", {
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
      // 3. Create new entity. Connector-backed queue rows carry source/sourceId
      // from proposal time; older rows fall back to the evidence source and a
      // synthetic review id.
      const sourceFromEvidence = row.source ?? evidence[0]?.source ?? "entity-review";
      const sourceId = row.source_id ?? `review:${reviewId}`;
      if (row.entity_type === "person") {
        const personData: {
          name: string;
          email?: string;
          subtype: "internal" | "external";
          source: string;
          sourceId: string;
          provenanceTier: "human_confirmed";
        } = {
          // Reject-created entities default to 'external'. The user has
          // told us this is a separate identity from the suggested
          // candidate; we don't have a signal that they're internal.
          name: row.proposed_name,
          subtype: "external",
          source: sourceFromEvidence,
          sourceId,
          provenanceTier: "human_confirmed",
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
          provenanceTier: "human_confirmed",
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
    await rematerializeHeldLlmEvidence(trxCtx, row, evidence);

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

    if (row.entity_type === "company") {
      await finalizeLinkedDomainCandidates(trxCtx.db, row.id, target.id);
    }
    await writeReviewSourceRef(trxCtx, row, target.id);
    await reviveDeferredRelationsForEntity(trxCtx, target);

    // 6. Mark resolved.
    const refreshedRow = await markResolvedOrThrow(trxCtx, row, "rejected", target.id);

    return { row: refreshedRow, targetEntityId: target.id, reResolvedToExisting, createdEntityId, idempotent: false };
  });
}

/**
 * Dismiss a pending review row: drop the proposal WITHOUT creating an entity.
 * Used for birth rows the reviewer judges not real (e.g. a junk structural
 * seed). Mirrors {@link rejectReview}'s terminal/drift guards but writes no
 * entity, no mention, and no alias rejection. The terminal `dismissed` status
 * suppresses the same key from being re-proposed (it is in `TERMINAL_STATUSES`).
 */
export async function dismissReview(
  ctx: ResolveCtx,
  reviewId: string,
  opts: { candidateGeneratedAt: string },
): Promise<DismissResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const trxCtx: ResolveTxnCtx = {
      db: trx,
      repo: createEntityReviewRepo(trx),
      entityRepo: createEntityRepository(trx),
      userId: ctx.userId,
      now: ctx.now ?? new Date().toISOString(),
      logger: ctx.logger,
    };
    const row = await fetchRow(trxCtx, reviewId);

    // Idempotent replay against an already-dismissed row.
    if (row.status === "dismissed") {
      return { row, idempotent: true };
    }
    // Any other terminal status cannot transition to dismissed.
    if (row.status === "confirmed" || row.status === "rejected") {
      throw new ResolveError("CANDIDATE_DRIFT", `row already ${row.status}`, {
        currentStatus: row.status,
        currentRow: row,
      });
    }
    if (row.status === "confirming") {
      throw new ResolveError("ALREADY_CONFIRMING", "row is mid-confirm");
    }

    // Compare-and-swap on the candidate snapshot this request validated.
    if (row.candidate_generated_at !== opts.candidateGeneratedAt) {
      throw new ResolveError("CANDIDATE_DRIFT", "candidate_generated_at mismatch", {
        actual: row.candidate_generated_at,
        provided: opts.candidateGeneratedAt,
        currentRow: row,
      });
    }
    if (!row.candidate_generated_at) {
      throw new ResolveError("CANDIDATE_DRIFT", "row missing candidate_generated_at", { currentRow: row });
    }

    const won = await trxCtx.repo.markDismissed(row.id, ctx.userId, row.candidate_generated_at);
    if (!won) {
      const currentRow = await fetchRow(trxCtx, row.id);
      throw new ResolveError("CANDIDATE_DRIFT", "row was resolved or refreshed by another request", {
        currentStatus: currentRow.status,
        currentRow,
      });
    }
    return { row: await fetchRow(trxCtx, row.id), idempotent: false };
  });
}

export async function reclassifyReview(
  ctx: ResolveCtx,
  reviewId: string,
  opts: { newEntityType: string; candidateGeneratedAt: string },
): Promise<ReclassifyResult> {
  return ctx.db.transaction().execute(async (trx) => {
    const repo = createEntityReviewRepo(trx);
    const row = await repo.getById(reviewId);
    if (!row) throw new ResolveError("ROW_NOT_FOUND", `queue row ${reviewId} not found`);
    if (row.status !== "pending" || row.candidate_generated_at !== opts.candidateGeneratedAt) {
      throw new ResolveError("CANDIDATE_DRIFT", "candidate_generated_at mismatch", {
        actual: row.candidate_generated_at,
        provided: opts.candidateGeneratedAt,
        currentRow: row,
      });
    }
    const result = await repo.reclassifyType(reviewId, opts.newEntityType, opts.candidateGeneratedAt);
    if (!result) throw new ResolveError("ROW_NOT_FOUND", `queue row ${reviewId} not found`);
    if (result.kind === "drift") {
      throw new ResolveError("CANDIDATE_DRIFT", "row changed before reclassify", { currentRow: result.row });
    }
    if (result.kind === "collision") {
      return {
        row: result.row,
        result: "TYPE_RECLASSIFY_COLLISION",
        collidingRow: result.collidingRow,
        mergedFromReviewId: null,
      };
    }
    return {
      row: result.row,
      result: "RECLASSIFY",
      mergedFromReviewId: result.mergedFromReviewId,
    };
  });
}

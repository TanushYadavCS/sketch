/**
 * Centralized entity-creation decision: every seeding path (Fireflies
 * attendees, future LLM extraction, future domain-promotion) calls
 * `proposeEntity` instead of `upsertPersonEntity` directly.
 *
 * The helper decides whether to:
 *   - **link** the proposal to an existing entity (e.g. email match),
 *   - **create** a fresh entity (no fuzzy collision, or email disambiguates), or
 *   - **queue** the proposal for human review (name fuzzy-collides with an
 *     existing entity and we're not confident enough to auto-link).
 *
 * The third branch is what's new in ECR-01 — today the seeding paths
 * always create-or-update, which is how a stale `Saurabh Bothra` row ended
 * up linked to 129 files (see `.planning/files/.../ENTITY_LINKAGE_PROVENANCE.md`).
 *
 * The fuzzy ranker uses an ambiguity-aware lookup. A plain `Map<string, Entity>`
 * silently overwrites duplicates and would cause the multi-candidate branch
 * to misfire as single-candidate — the caller MUST pass a structure that
 * preserves duplicates.
 */
import type { Selectable } from "kysely";
import { normalizeName } from "../connectors/name-normalize";
import type { UpsertPersonEntityData, createEntityRepository } from "../db/repositories/entities";
import type { EntityReviewRepository } from "../db/repositories/entity-review";
import type { EntitiesTable } from "../db/schema";

export type Entity = Selectable<EntitiesTable>;

export type ProposeEntityType = "person" | "company";

export interface ProposeInput {
  name: string;
  email?: string | null;
  entityType: ProposeEntityType;
  source: string;
  /**
   * The connector-level source id to pass through to `upsertPersonEntity`
   * when the proposal becomes `created` or `linked`. Currently only the
   * `person` path uses it; the `company` path will follow in ECR-05.
   */
  sourceId: string;
  /** Free-form subtype for the entity row (e.g. "internal" / "external"). */
  subtype: "internal" | "external";
  /** Files this proposal is observed in. Becomes evidence rows on queue. */
  evidence: Array<{ indexedFileId: string; note?: string }>;
  /** Owner of the sync / call that proposed this entity. Required. */
  triggeredByUserId: string;
}

export type ProposeResult =
  | { kind: "linked"; entity: Entity }
  | { kind: "created"; entity: Entity }
  | { kind: "queued"; reviewId: string; candidateEntityId: string | null };

/**
 * Ambiguity-aware lookup over existing entities, keyed by `normalizeName(entity.name)`.
 * The Fireflies hot-path supplies a pre-built `Map<string, Entity[]>` to
 * avoid per-attendee queries. Cold callers should pass a fresh resolver
 * (per call) backed by a query.
 *
 * The implementation must preserve duplicates: passing a plain `Map<string, Entity>`
 * — which silently overwrites — defeats the multi-candidate detection and
 * yields false single-candidate queue rows.
 */
export type EntityLookup = {
  /** All entities sharing this normalized name. */
  getByNormalizedName(normalized: string): Entity[];
  /** All entities of the given type (used for prefix/token-superset scan). */
  listByType(entityType: ProposeEntityType): Entity[];
};

export interface ProposeDeps {
  entityRepo: ReturnType<typeof createEntityRepository>;
  reviewRepo: EntityReviewRepository;
  lookup: EntityLookup;
  /** Read an entity's email from its metadata JSON. */
  readEmail: (entity: Entity) => string | null;
}

interface RankedCandidate {
  entity: Entity;
  score: number;
  reason: "token-superset" | "prefix";
}

/**
 * Tokenize a name into lowercase word tokens, dropping the trailing initial
 * period if present ("J." → "j"). Single-character tokens are kept — they
 * carry the last-initial signal for the prefix rule.
 */
function tokenize(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .map((t) => t.replace(/\.$/, ""))
    .filter((t) => t.length > 0);
}

function isTokenSupersetOrSubset(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === b.length) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  return shorter.every((t) => longerSet.has(t));
}

/**
 * Prefix match: candidate's tokens start with the same first name AND
 * either match a "first + last-initial" pattern (e.g. proposed "Bob C"
 * matches existing "Bob Chen") or are a strict single-token prefix of the
 * candidate's name (e.g. proposed "Bob" matches "Bob Chen"). Conservative
 * on purpose — broader edit-distance rules are deferred until we measure
 * acceptance rates.
 */
function isPrefixMatch(proposed: string[], existing: string[]): boolean {
  if (proposed.length === 0 || existing.length === 0) return false;
  if (proposed[0] !== existing[0]) return false;
  if (proposed.length === existing.length) return false;

  if (proposed.length === 2 && existing.length >= 2) {
    const lastInitial = proposed[1];
    if (lastInitial.length === 1 && existing[1].startsWith(lastInitial)) return true;
  }
  if (existing.length === 2 && proposed.length >= 2) {
    const lastInitial = existing[1];
    if (lastInitial.length === 1 && proposed[1].startsWith(lastInitial)) return true;
  }

  if (proposed.length === 1) {
    return existing.length > 1 && existing[0] === proposed[0];
  }
  if (existing.length === 1) {
    return proposed.length > 1 && proposed[0] === existing[0];
  }
  return false;
}

/**
 * Apply the two ranker rules in order. Stops at the first tier with ≥1
 * match — multi-candidate at that tier signals "human pick" rather than
 * falling through to a weaker rule.
 */
function rank(name: string, candidates: Entity[]): RankedCandidate[] {
  const proposedTokens = tokenize(name);
  if (proposedTokens.length === 0) return [];

  const tokenSuperset: RankedCandidate[] = [];
  for (const c of candidates) {
    if (isTokenSupersetOrSubset(proposedTokens, tokenize(c.name))) {
      tokenSuperset.push({ entity: c, score: 0.9, reason: "token-superset" });
    }
  }
  if (tokenSuperset.length > 0) return tokenSuperset;

  const prefix: RankedCandidate[] = [];
  for (const c of candidates) {
    if (isPrefixMatch(proposedTokens, tokenize(c.name))) {
      prefix.push({ entity: c, score: 0.7, reason: "prefix" });
    }
  }
  return prefix;
}

export async function proposeEntity(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  const normalized = normalizeName(input.name);

  // 1) Email fast-path — exact match against existing entity's stored email.
  if (input.email) {
    const lowered = input.email.toLowerCase();
    const candidates = deps.lookup.listByType(input.entityType);
    for (const c of candidates) {
      const stored = deps.readEmail(c);
      if (stored && stored.toLowerCase() === lowered) {
        const personData: UpsertPersonEntityData = {
          name: input.name,
          email: input.email,
          subtype: input.subtype,
          source: input.source,
          sourceId: input.sourceId,
        };
        const entity = await deps.entityRepo.upsertPersonEntity(personData);
        return { kind: "linked", entity };
      }
    }

    // 2) Email present but no entity matched it. An email is identity-grade;
    //    a name collision against a different email is a different person.
    //    Auto-create instead of queuing.
    const created = await deps.entityRepo.upsertPersonEntity({
      name: input.name,
      email: input.email,
      subtype: input.subtype,
      source: input.source,
      sourceId: input.sourceId,
    });
    return { kind: "created", entity: created };
  }

  // 3) Fuzzy-rank against same-type entities.
  const candidates = deps.lookup.listByType(input.entityType);
  let ranked = rank(input.name, candidates);

  // 4) Drop candidates that have a sticky rejection for this normalized name.
  if (ranked.length > 0) {
    const filtered: RankedCandidate[] = [];
    for (const r of ranked) {
      const rejected = await deps.reviewRepo.isRejected(r.entity.id, normalized);
      if (!rejected) filtered.push(r);
    }
    ranked = filtered;
  }

  // 5) Decide.
  if (ranked.length === 0) {
    const created = await deps.entityRepo.upsertPersonEntity({
      name: input.name,
      subtype: input.subtype,
      source: input.source,
      sourceId: input.sourceId,
    });
    return { kind: "created", entity: created };
  }

  const isSingle = ranked.length === 1;
  const candidateEntityId = isSingle ? ranked[0].entity.id : null;
  const candidateScore = isSingle ? ranked[0].score : null;
  const candidateReason = ranked[0].reason;

  const upsertResult = await deps.reviewRepo.upsertQueueRow({
    proposedName: input.name,
    normalizedName: normalized,
    entityType: input.entityType,
    proposedEmail: null,
    candidateEntityId,
    candidateScore,
    candidateReason,
    triggeredByUserId: input.triggeredByUserId,
  });

  if (!upsertResult.skipEvidence) {
    for (const e of input.evidence) {
      await deps.reviewRepo.upsertEvidence({
        reviewId: upsertResult.row.id,
        indexedFileId: e.indexedFileId,
        source: input.source,
        note: e.note ?? null,
      });
    }
  }

  return {
    kind: "queued",
    reviewId: upsertResult.row.id,
    candidateEntityId,
  };
}

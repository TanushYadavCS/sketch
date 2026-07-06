/**
 * File-scoped extraction context.
 *
 * For each file, deterministically derives the participants ("anchors") it is
 * about and the initiatives most likely to come up, drawn from existing graph
 * data — no LLM. The result is merged with the org-wide baseline list and
 * passed to the extraction prompt so the model matches existing entities
 * instead of re-inventing them and emits the right Company → Initiative →
 * People relationships.
 *
 * Anchors:
 *   - Attendee emails on `indexed_file_facts` (fact_type = "attendee") →
 *     domain → existing company entity via `entity_domains` (corporate).
 *   - Personal/shared/role-account emails are filtered out (we already have
 *     these helpers in entities/affiliations + entity-domains).
 *
 * Adjacency:
 *   - Self-join `entity_mentions` on indexed_file_id, weight each co-occurrence
 *     by exp(-ageDays / HALF_LIFE_DAYS). Returns top-K projects/products/teams
 *     per anchor.
 *   - "Now" is wall-clock at extraction time, not the file's own date — the
 *     prompt grounds on what's currently active in the corpus.
 *   - Math runs in TypeScript so the query stays portable across SQLite + PG
 *     (no julianday / EXTRACT EPOCH).
 *
 * Pending proposals:
 *   - Review-queue project/product proposals are pulled through their evidence
 *     files when those files also mention the file anchor. This gives the
 *     extractor pre-confirmation canonical names without changing the prompt.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";
import { HIDDEN_ENTITY_SOURCE_TYPES } from "../entities/profile-facts";

export const HALF_LIFE_DAYS = 60;
export const MIN_SCORE = 0.5;
export const MAX_ANCHORS_PER_SIDE = 3;
export const PER_ANCHOR_INITIATIVE_CAP = 8;
export const PER_ANCHOR_TEAM_CAP = 4;
export const RECENTLY_ACTIVE_WINDOW_DAYS = 14;
export const BASELINE_RELEVANCE_CAP = 15;
export const BASELINE_RECENCY_WINDOW_DAYS = 30;
export const MIN_VERBATIM_NAME_LENGTH = 4;
export const MAX_PERSON_ANCHORS = 5;
export const HUB_PERSON_DEGREE_CAP = 30;
export const BASELINE_ALWAYS_INCLUDE_CAP = 50;
export const PENDING_PROPOSAL_MIN_OCCURRENCE = 1;
const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FileScopeDeps {
  db: Kysely<DB>;
  logger?: Logger;
  now?: () => number;
  experimentalFlag?: boolean;
  loadAdjacencyForAnchor?: (deps: FileScopeDeps, anchorId: string) => Promise<AdjacencyEntry[]>;
  loadPendingProposalsForAnchor?: (deps: FileScopeDeps, anchorId: string) => Promise<PendingProposalEntry[]>;
}

export interface AnchorEntity {
  id: string;
  name: string;
  sourceType: string;
  hotness: number;
}

export interface FileAnchors {
  companies: AnchorEntity[];
  persons: AnchorEntity[];
}

export interface AdjacencyEntry {
  id: string;
  name: string;
  sourceType: string;
  score: number;
  mentionCount: number;
  lastSeen: number;
  recentlyActive: boolean;
}

export interface PendingProposalEntry {
  id: string;
  name: string;
  type: "project" | "product";
  score: number;
}

export interface KnownEntityForPrompt {
  id?: string;
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
  hotness?: number;
  mentionCount?: number;
  recentlyActive?: boolean;
}

interface BaselineScore {
  entity: KnownEntityForPrompt;
  anchorOverlap: number;
  recency: number;
  hotness: number;
  score: number;
}

export interface BuildFileScopedKnownEntitiesOptions {
  baselineRelevanceCap?: number;
}

/**
 * Pull attendee emails for the file, classify against known corporate
 * domains, return the matching company entities sorted by hotness (capped).
 */
export async function resolveFileAnchors(deps: FileScopeDeps, fileId: string): Promise<FileAnchors> {
  const domainsRepo = createEntityDomainsRepository(deps.db);
  const attendees = await deps.db
    .selectFrom("indexed_file_facts")
    .select("subject_email")
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "in", PERSON_PARTICIPANT_FACT_TYPES)
    .where("subject_email", "is not", null)
    .execute();

  const companyMap = new Map<string, AnchorEntity>();
  const participantEmails: string[] = [];
  for (const row of attendees) {
    const email = row.subject_email;
    if (!email) continue;
    participantEmails.push(email);
    const domain = domainsRepo.normalizeEmailDomain(email);
    if (!domain) continue;
    if (isRoleAccountEmail(email)) continue;
    if (await domainsRepo.isPersonalOrShared(domain)) continue;
    const company = await domainsRepo.lookupCompanyByDomain(domain);
    if (!company) continue;
    if (companyMap.has(company.id)) continue;
    companyMap.set(company.id, {
      id: company.id,
      name: company.name,
      sourceType: company.source_type,
      hotness: Number(company.hotness ?? 0),
    });
  }

  const companies = Array.from(companyMap.values())
    .sort((a, b) => b.hotness - a.hotness)
    .slice(0, MAX_ANCHORS_PER_SIDE);
  if (!deps.experimentalFlag) return { companies, persons: [] };

  const entityRepo = createEntityRepository(deps.db);
  const personsByEmail = await entityRepo.getPersonEntitiesByEmails(participantEmails);
  const personMap = new Map<string, AnchorEntity>();
  for (const matches of personsByEmail.values()) {
    const candidates = matches.filter((person) => person.id !== TEST_ACCOUNT_ENTITY_ID);
    if (candidates.length !== 1) continue;
    const person = candidates[0];
    if (personMap.has(person.id)) continue;
    personMap.set(person.id, {
      id: person.id,
      name: person.name,
      sourceType: person.source_type,
      hotness: Number(person.hotness ?? 0),
    });
  }

  const nonHubIds = await loadNonHubPersonIds(deps, [...personMap.keys()]);
  const persons = Array.from(personMap.values())
    .filter((person) => nonHubIds.has(person.id))
    .sort((a, b) => b.hotness - a.hotness)
    .slice(0, MAX_PERSON_ANCHORS);
  return { companies, persons };
}

async function loadNonHubPersonIds(deps: FileScopeDeps, personIds: string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await deps.db
    .selectFrom("entity_mentions")
    .select(["entity_id", deps.db.fn.count<number>("indexed_file_id").distinct().as("file_degree")])
    .where("entity_id", "in", personIds)
    .groupBy("entity_id")
    .execute();
  const degreeById = new Map(rows.map((row) => [row.entity_id, Number(row.file_degree)]));
  return new Set(personIds.filter((id) => (degreeById.get(id) ?? 0) <= HUB_PERSON_DEGREE_CAP));
}

/**
 * Top adjacent entities for an anchor, by recency-weighted co-occurrence.
 * Decay: weight = exp(-ageDays / 60). Floor: total score >= 0.5. System
 * source types are excluded. Sorted by score desc.
 */
export async function adjacencyForAnchor(deps: FileScopeDeps, anchorId: string): Promise<AdjacencyEntry[]> {
  const systemTypes = Array.from(HIDDEN_ENTITY_SOURCE_TYPES);
  const rows = await deps.db
    .selectFrom("entity_mentions as em1")
    .innerJoin("entity_mentions as em2", (join) =>
      join.onRef("em2.indexed_file_id", "=", "em1.indexed_file_id").on("em2.entity_id", "!=", anchorId),
    )
    .innerJoin("indexed_files as if", "if.id", "em1.indexed_file_id")
    .innerJoin("entities as e", "e.id", "em2.entity_id")
    .select((eb) => [
      eb.ref("em2.entity_id").as("other_id"),
      eb.ref("e.name").as("other_name"),
      eb.ref("e.source_type").as("other_source_type"),
      sql<string | null>`COALESCE("if".source_updated_at, "if".source_created_at)`.as("file_date"),
    ])
    .where("em1.entity_id", "=", anchorId)
    .where("em1.confidence", "=", "EXTRACTED")
    .where("em2.confidence", "=", "EXTRACTED")
    .where("e.source_type", "not in", systemTypes.length > 0 ? systemTypes : [""])
    .where(whereLiveEntity("e"))
    .execute();

  const now = deps.now ? deps.now() : Date.now();
  const scores = new Map<string, AdjacencyEntry>();
  for (const row of rows) {
    if (!row.file_date) continue;
    const t = new Date(row.file_date).getTime();
    if (!t || Number.isNaN(t)) continue;
    const ageDays = Math.max(0, (now - t) / DAY_MS);
    const weight = Math.exp(-ageDays / HALF_LIFE_DAYS);
    const prev = scores.get(row.other_id) ?? {
      id: row.other_id,
      name: row.other_name,
      sourceType: row.other_source_type,
      score: 0,
      mentionCount: 0,
      lastSeen: 0,
      recentlyActive: false,
    };
    prev.score += weight;
    prev.mentionCount += 1;
    prev.lastSeen = Math.max(prev.lastSeen, t);
    scores.set(row.other_id, prev);
  }

  return Array.from(scores.values())
    .filter((v) => v.score >= MIN_SCORE)
    .map((v) => ({ ...v, recentlyActive: now - v.lastSeen < RECENTLY_ACTIVE_WINDOW_DAYS * DAY_MS }))
    .sort((a, b) => b.score - a.score);
}

function isPendingProposalType(value: string): value is PendingProposalEntry["type"] {
  return value === "project" || value === "product";
}

export async function pendingProposalsForAnchor(
  deps: FileScopeDeps,
  anchorId: string,
): Promise<PendingProposalEntry[]> {
  const rows = await deps.db
    .selectFrom("entity_review_queue as q")
    .innerJoin("entity_review_evidence as ev", "ev.review_id", "q.id")
    .innerJoin("entity_mentions as em", (join) =>
      join.onRef("em.indexed_file_id", "=", "ev.indexed_file_id").on("em.entity_id", "=", anchorId),
    )
    .select(["q.id as id", "q.proposed_name as name", "q.entity_type as type", "q.occurrence_count as score"])
    .where("q.status", "=", "pending")
    .where("q.entity_type", "in", ["project", "product"])
    .where("q.occurrence_count", ">=", PENDING_PROPOSAL_MIN_OCCURRENCE)
    .groupBy(["q.id", "q.proposed_name", "q.entity_type", "q.occurrence_count"])
    .orderBy("q.occurrence_count", "desc")
    .orderBy("q.proposed_name", "asc")
    .execute();

  return rows.flatMap((row) =>
    isPendingProposalType(row.type)
      ? [
          {
            id: row.id,
            name: row.name,
            type: row.type,
            score: Number(row.score),
          },
        ]
      : [],
  );
}

/**
 * Compose the file-scoped knownEntities list passed to the extraction prompt.
 *
 * Layering: anchors → adjacency (initiatives + teams, capped per anchor) →
 * org-wide baseline → pending anchor-cluster proposals. Earlier layers win on
 * duplicate (lowercased name + type). Returns the merged list — caller passes
 * straight to extractEntities.
 */
export async function buildFileScopedKnownEntities(
  deps: FileScopeDeps,
  fileId: string,
  baseline: KnownEntityForPrompt[],
  fileContent?: string,
  opts: BuildFileScopedKnownEntitiesOptions = {},
): Promise<KnownEntityForPrompt[]> {
  const anchors = await resolveFileAnchors(deps, fileId);
  const byKey = new Map<string, KnownEntityForPrompt>();
  const keyOf = (name: string, type: string) => `${type}:${name.toLowerCase()}`;

  for (const a of anchors.companies) {
    const k = keyOf(a.name, a.sourceType);
    if (!byKey.has(k)) byKey.set(k, { name: a.name, type: a.sourceType });
  }

  for (const anchor of [...anchors.companies, ...anchors.persons]) {
    const adj = await (deps.loadAdjacencyForAnchor ?? adjacencyForAnchor)(deps, anchor.id);
    const initiatives = adj
      .filter((x) => x.sourceType === "project" || x.sourceType === "product")
      .slice(0, PER_ANCHOR_INITIATIVE_CAP);
    const teams = adj.filter((x) => x.sourceType === "team").slice(0, PER_ANCHOR_TEAM_CAP);
    for (const x of [...initiatives, ...teams]) {
      const k = keyOf(x.name, x.sourceType);
      if (byKey.has(k)) continue;
      byKey.set(k, {
        name: x.name,
        type: x.sourceType,
        mentionCount: x.mentionCount,
        recentlyActive: x.recentlyActive,
      });
    }
  }

  for (const b of await rankBaselineKnownEntities(deps, baseline, anchors, fileContent ?? "", opts)) {
    const k = keyOf(b.name, b.type);
    if (byKey.has(k)) continue;
    byKey.set(k, stripPromptInternalFields(b));
  }

  if (deps.experimentalFlag) {
    for (const anchor of [...anchors.companies, ...anchors.persons]) {
      const pendingProposals = await (deps.loadPendingProposalsForAnchor ?? pendingProposalsForAnchor)(deps, anchor.id);
      for (const proposal of pendingProposals.slice(0, PER_ANCHOR_INITIATIVE_CAP)) {
        const k = keyOf(proposal.name, proposal.type);
        if (byKey.has(k)) continue;
        byKey.set(k, { name: proposal.name, type: proposal.type });
      }
    }
  }

  return Array.from(byKey.values());
}

function stripPromptInternalFields(entity: KnownEntityForPrompt): KnownEntityForPrompt {
  return {
    name: entity.name,
    type: entity.type,
    description: entity.description,
    mentionCount: entity.mentionCount,
    recentlyActive: entity.recentlyActive,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasVerbatimMention(content: string, entity: KnownEntityForPrompt): boolean {
  if (!content) return false;
  const names = [entity.name, ...(entity.aliases ?? [])].filter(
    (name) => name.trim().length >= MIN_VERBATIM_NAME_LENGTH,
  );
  return names.some((name) => new RegExp(`\\b${escapeRegExp(name.trim())}\\b`, "i").test(content));
}

async function loadBaselineLastSeen(deps: FileScopeDeps, baselineIds: string[]): Promise<Map<string, number>> {
  if (baselineIds.length === 0) return new Map();
  const rows = await deps.db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      "entity_mentions.entity_id",
      sql<
        string | null
      >`MAX(COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at))`.as(
        "last_seen",
      ),
    ])
    .where("entity_mentions.entity_id", "in", baselineIds)
    .groupBy("entity_mentions.entity_id")
    .execute();

  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.last_seen) continue;
    const t = new Date(row.last_seen).getTime();
    if (!Number.isNaN(t)) out.set(row.entity_id, t);
  }
  return out;
}

async function loadBaselineAnchorOverlap(
  deps: FileScopeDeps,
  baselineIds: string[],
  anchorIds: string[],
): Promise<Set<string>> {
  if (baselineIds.length === 0 || anchorIds.length === 0) return new Set();
  const rows = await deps.db
    .selectFrom("entity_mentions as base")
    .innerJoin("entity_mentions as anchor", "anchor.indexed_file_id", "base.indexed_file_id")
    .select("base.entity_id")
    .where("base.entity_id", "in", baselineIds)
    .where("anchor.entity_id", "in", anchorIds)
    .groupBy("base.entity_id")
    .execute();
  return new Set(rows.map((row) => row.entity_id));
}

async function rankBaselineKnownEntities(
  deps: FileScopeDeps,
  baseline: KnownEntityForPrompt[],
  anchors: FileAnchors,
  fileContent: string,
  opts: BuildFileScopedKnownEntitiesOptions,
): Promise<KnownEntityForPrompt[]> {
  const legacy = baseline.filter((entity) => !entity.id);
  const scoredCandidates = baseline.filter((entity) => entity.id);
  if (scoredCandidates.length === 0) return legacy;

  const cap = opts.baselineRelevanceCap ?? BASELINE_RELEVANCE_CAP;
  const alwaysInclude = deps.experimentalFlag
    ? scoredCandidates
        .filter((entity) => hasVerbatimMention(fileContent, entity))
        .sort((a, b) => {
          const hotness = Number(b.hotness ?? 0) - Number(a.hotness ?? 0);
          return hotness !== 0 ? hotness : a.name.localeCompare(b.name);
        })
        .slice(0, BASELINE_ALWAYS_INCLUDE_CAP)
    : scoredCandidates.filter((entity) => hasVerbatimMention(fileContent, entity));
  const alwaysIds = new Set(alwaysInclude.map((entity) => entity.id));
  const candidates = scoredCandidates.filter((entity) => !alwaysIds.has(entity.id));
  const candidateIds = candidates.flatMap((entity) => (entity.id ? [entity.id] : []));
  const anchorIds = [...anchors.companies.map((anchor) => anchor.id), ...anchors.persons.map((anchor) => anchor.id)];
  const [lastSeenById, overlapIds] = await Promise.all([
    loadBaselineLastSeen(deps, candidateIds),
    loadBaselineAnchorOverlap(deps, candidateIds, anchorIds),
  ]);

  const now = deps.now ? deps.now() : Date.now();
  const maxHotness = Math.max(1, ...candidates.map((entity) => Number(entity.hotness ?? 0)));
  const scored: BaselineScore[] = candidates.map((entity) => {
    const lastSeen = entity.id ? lastSeenById.get(entity.id) : undefined;
    const ageDays = lastSeen === undefined ? Number.POSITIVE_INFINITY : Math.max(0, (now - lastSeen) / DAY_MS);
    const recency = ageDays <= BASELINE_RECENCY_WINDOW_DAYS ? Math.exp(-ageDays / BASELINE_RECENCY_WINDOW_DAYS) : 0;
    const anchorOverlap = entity.id && overlapIds.has(entity.id) ? 1 : 0;
    const hotness = Number(entity.hotness ?? 0) / maxHotness;
    return {
      entity,
      anchorOverlap,
      recency,
      hotness,
      score: 0.5 * anchorOverlap + 0.3 * recency + 0.2 * hotness,
    };
  });

  const ranked = scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.hotness !== a.hotness) return b.hotness - a.hotness;
      return a.entity.name.localeCompare(b.entity.name);
    })
    .slice(0, cap)
    .map((entry) => entry.entity);

  return [...legacy, ...alwaysInclude, ...ranked];
}

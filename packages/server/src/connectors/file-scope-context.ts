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
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";
import { SYSTEM_SOURCE_TYPES } from "../entities/profile-facts";

export const HALF_LIFE_DAYS = 60;
export const MIN_SCORE = 0.5;
export const MAX_ANCHORS_PER_SIDE = 5;
export const PER_ANCHOR_INITIATIVE_CAP = 20;
export const PER_ANCHOR_TEAM_CAP = 10;
export const RECENTLY_ACTIVE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FileScopeDeps {
  db: Kysely<DB>;
  logger?: Logger;
  now?: () => number;
}

export interface AnchorEntity {
  id: string;
  name: string;
  sourceType: string;
  hotness: number;
}

export interface FileAnchors {
  companies: AnchorEntity[];
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

export interface KnownEntityForPrompt {
  name: string;
  type: string;
  description?: string;
  mentionCount?: number;
  recentlyActive?: boolean;
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
    .where("fact_type", "=", "attendee")
    .where("subject_email", "is not", null)
    .execute();

  const companyMap = new Map<string, AnchorEntity>();
  for (const row of attendees) {
    const email = row.subject_email;
    if (!email) continue;
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
  return { companies };
}

/**
 * Top adjacent entities for an anchor, by recency-weighted co-occurrence.
 * Decay: weight = exp(-ageDays / 60). Floor: total score >= 0.5. System
 * source types are excluded. Sorted by score desc.
 */
export async function adjacencyForAnchor(deps: FileScopeDeps, anchorId: string): Promise<AdjacencyEntry[]> {
  const systemTypes = Array.from(SYSTEM_SOURCE_TYPES);
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

/**
 * Compose the file-scoped knownEntities list passed to the extraction prompt.
 *
 * Layering: anchors → adjacency (initiatives + teams, capped per anchor) →
 * org-wide baseline. File-scope wins on duplicate (lowercased name + type).
 * Returns the merged list — caller passes straight to extractEntities.
 */
export async function buildFileScopedKnownEntities(
  deps: FileScopeDeps,
  fileId: string,
  baseline: KnownEntityForPrompt[],
): Promise<KnownEntityForPrompt[]> {
  const anchors = await resolveFileAnchors(deps, fileId);
  const byKey = new Map<string, KnownEntityForPrompt>();
  const keyOf = (name: string, type: string) => `${type}:${name.toLowerCase()}`;

  for (const a of anchors.companies) {
    const k = keyOf(a.name, a.sourceType);
    if (!byKey.has(k)) byKey.set(k, { name: a.name, type: a.sourceType });
  }

  for (const anchor of anchors.companies) {
    const adj = await adjacencyForAnchor(deps, anchor.id);
    const initiatives = adj
      .filter((x) => x.sourceType === "project" || x.sourceType === "product" || x.sourceType === "feature")
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

  for (const b of baseline) {
    const k = keyOf(b.name, b.type);
    if (byKey.has(k)) continue;
    byKey.set(k, b);
  }

  return Array.from(byKey.values());
}

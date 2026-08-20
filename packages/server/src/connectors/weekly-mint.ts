import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import {
  createCompanyRelationshipDeclarationRepository,
  resolveDeclaration,
} from "../db/repositories/company-relationship-declarations";
import { whereLiveEntity } from "../db/repositories/entities";
import { createProjectMintingVerdictRepository } from "../db/repositories/project-minting-verdicts";
import type { DB, WeeklyMintRunsTable } from "../db/schema";
import { WEEKLY_PASS_PROJECT_SOURCES, confirmReview } from "../entities/resolve";
import type { GeminiGenerator, GenerateMeta } from "./gemini-generate";
import { normalizeName } from "./name-normalize";
import {
  CADENCE_TOKENS,
  type ClientCluster,
  type ClusterFile,
  type ClusterVerdict,
  type VerdictProject,
  channelMatchesCompany,
  clusterClientFiles,
  fragmentNameTokens,
  normalizeTitleFamily,
  readClusterVerdict,
} from "./project-minting";
import { type TokenRecurrence, scanTokenRecurrence } from "./token-recurrence-scan";

export const WEEKLY_MINT_PROMPT_VERSION = "project-minting-verdict-weekly-v1";

const RUNNING = "running";
const QUEUED = "queued";
const COMPLETED = "completed";
const FAILED = "failed";
const COMPANIES_STAGE = "companies";
const COMPLETED_STAGE = "completed";
const LEASE_DURATION_MS = 30 * 60 * 1000;
const WEEKLY_MINT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RECURRENCE_FLOOR_DAYS = 3;
const AGE_OUT_WEEKS = 8;
const CONTAINMENT_FLOOR = 0.8;
const INTERNAL_CONTAINER_KEY = "internal";
const INTERNAL_COMPANY_NAME = "Internal";
const GITHUB_REPO_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

/**
 * Weekly minting only claims content-extraction project pool rows. The set is
 * intentionally positive and narrow so structural connector seeds,
 * user_entity_link reviews, and any future review source stay invisible until
 * deliberately admitted. `llm_relation` was historically excluded for its
 * leak record, but the weekly pass carries the machinery that era lacked — the
 * recurrence floor, dedup against accepted projects, and a human accept gate —
 * and excluding it dropped real candidates (Traveller Segmentation Dashboard
 * only ever arrived through it).
 *
 * Derived from WEEKLY_PASS_PROJECT_SOURCES in entities/resolve.ts, where the
 * same set gates one-row project births — the rows this pass consumes and the
 * rows the review API refuses to birth must never drift apart.
 */
export const WEEKLY_MINT_REVIEW_SOURCE_ALLOWLIST: readonly string[] = [...WEEKLY_PASS_PROJECT_SOURCES];

type WeeklyMintMode = "shadow" | "live";

export interface WeeklyMintResult {
  status: string;
  stage: string;
  clockWeek: string;
  candidatesGrouped: number;
  verdictsRequested: number;
  verdictsStored: number;
  agedOut: number;
  skippedGroups: number;
  skippedCompanies: number;
}

export type ManualRunOutcome =
  | { started: false; reason: "in_flight" }
  | { started: true; completion: Promise<WeeklyMintResult> };

export interface WeeklyMintService {
  runOnce(clock?: Date): Promise<WeeklyMintResult>;
  tryRunManual(clock?: Date): ManualRunOutcome;
  start(): void;
  stop(): Promise<void>;
}

export class WeeklyMintProcessCrash extends Error {
  constructor(message = "weekly mint process crashed") {
    super(message);
    this.name = "WeeklyMintProcessCrash";
  }
}

type WeeklyMintDeps = {
  db: Kysely<DB>;
  mode: WeeklyMintMode;
  logger: Logger;
  generator?: GeminiGenerator | null;
  model?: string | null;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  afterCompanyBatch?: (companyEntityId: string) => void | Promise<void>;
};

type RunRow = Selectable<WeeklyMintRunsTable>;

type ClaimedCandidate = {
  reviewId: string;
  proposedName: string;
  normalizedName: string;
  candidateEntityId: string | null;
  /** CAS snapshot confirmReview requires; null on old rows → the auto-link falls back to stamping. */
  candidateGeneratedAt: string | null;
  dryStreak: number;
  evidenceFileIds: string[];
};

type CandidateGroup = {
  key: string;
  reviewIds: string[];
  names: string[];
  tokens: string[];
  evidenceFileIds: string[];
  scan: TokenRecurrence | null;
  deterministic: DeterministicDisposition;
};

type ExistingProject = {
  entityId: string;
  name: string;
  aliases: string[];
  fileIds: Set<string>;
};

type StandingProduct = {
  entityId: string;
  name: string;
  aliases: string[];
};

type WeeklyMintContainer = {
  key: string;
  companyEntityId: string | null;
  companyName: string;
  fileIds: string[];
  files: ClusterFile[];
  cluster: ClientCluster | null;
};

type DeterministicDisposition =
  | { action: "new" }
  | { action: "alias_of"; entityId: string; entityName: string }
  | { action: "child_of"; entityId: string; entityName: string };

type ModelDisposition = {
  groupKey: string;
  action: "new" | "alias_of" | "child_of" | "skip";
  projectName: string | null;
  targetEntityId: string | null;
  parentGroupKey: string | null;
};

type WeeklyPromptGroupContext = {
  coMentionedProjects: string[];
  sharedEvidenceWith: string[];
  snippets: string[];
  onlySharedEvidence: boolean;
};

type SharedEvidenceFile = {
  fileName: string;
  citedBy: string[];
  preview: string;
};

type WeeklyPromptContext = {
  groups: Map<string, WeeklyPromptGroupContext>;
  sharedFiles: SharedEvidenceFile[];
};

type EvidenceContent = {
  id: string;
  fileName: string;
  content: string;
};

function timestamp(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function clockWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() - weekday + 1);
  return isoDate(day);
}

function runKey(week: string): string {
  return `weekly-mint:${week}`;
}

function isAtOrBeforeClock(fileDate: string | null, clock: Date): boolean {
  if (!fileDate) return true;
  return fileDate <= clock.toISOString();
}

function resultFromRun(run: RunRow): WeeklyMintResult {
  return {
    status: run.status,
    stage: run.stage,
    clockWeek: run.clock_week,
    candidatesGrouped: run.candidates_grouped,
    verdictsRequested: run.verdicts_requested,
    verdictsStored: run.verdicts_stored,
    agedOut: run.aged_out,
    skippedGroups: 0,
    skippedCompanies: 0,
  };
}

async function ensureRun(db: Kysely<DB>, week: string): Promise<RunRow> {
  const key = runKey(week);
  const existing = await db.selectFrom("weekly_mint_runs").selectAll().where("run_key", "=", key).executeTakeFirst();
  if (existing) return existing;
  await db
    .insertInto("weekly_mint_runs")
    .values({ id: randomUUID(), run_key: key, status: QUEUED, stage: COMPANIES_STAGE, clock_week: week })
    .onConflict((oc) => oc.column("run_key").doNothing())
    .execute();
  return db.selectFrom("weekly_mint_runs").selectAll().where("run_key", "=", key).executeTakeFirstOrThrow();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function loadFileMeta(db: Kysely<DB>, fileIds: string[]): Promise<ClusterFile[]> {
  const files: ClusterFile[] = [];
  for (const fileChunk of chunk([...new Set(fileIds)].sort(), 500)) {
    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "source", "source_created_at", "synced_at"])
      .where("id", "in", fileChunk)
      .execute();
    for (const row of rows) {
      files.push({
        fileId: row.id,
        fileName: row.file_name,
        source: row.source,
        date: row.source_created_at ?? row.synced_at,
        via: [],
      });
    }
  }
  return files.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.fileId.localeCompare(b.fileId));
}

/**
 * External membership is any file emitted by `clusterClientFiles`, whose
 * signals accumulate independently per company: participant corporate domain,
 * dedicated channel, and vocabulary/title-family accretion. There is no
 * exclusive claiming order to reuse or invent here. A multi-claimed file stays
 * external for every claiming company, and the internal pot is exactly the set
 * of indexed files claimed by no cluster.
 */
export async function partitionFiles(
  db: Kysely<DB>,
): Promise<{ external: Map<string, Set<string>>; internal: Set<string> }> {
  const clusters = await clusterClientFiles(db, { minFiles: 1 });
  const external = new Map<string, Set<string>>();
  const claimed = new Set<string>();
  for (const cluster of clusters) {
    const files = new Set<string>();
    for (const file of cluster.files) {
      files.add(file.fileId);
      claimed.add(file.fileId);
    }
    external.set(cluster.companyEntityId, files);
  }
  const rows = await db.selectFrom("indexed_files").select("id").execute();
  return {
    external,
    internal: new Set(rows.map((row) => row.id).filter((fileId) => !claimed.has(fileId))),
  };
}

async function buildWeeklyMintContainers(db: Kysely<DB>, clock: Date): Promise<WeeklyMintContainer[]> {
  const clusters = (await clusterClientFiles(db, { minFiles: 1 }))
    .map((cluster) => ({
      ...cluster,
      files: cluster.files.filter((file) => isAtOrBeforeClock(file.date, clock)),
    }))
    .filter((cluster) => cluster.files.length > 0);
  const claimed = new Set(clusters.flatMap((cluster) => cluster.files.map((file) => file.fileId)));
  const internalRows = await db.selectFrom("indexed_files").select("id").execute();
  const internalFileIds = internalRows.map((row) => row.id).filter((fileId) => !claimed.has(fileId));
  const external = clusters.map((cluster) => ({
    key: cluster.companyEntityId,
    companyEntityId: cluster.companyEntityId,
    companyName: cluster.companyName,
    fileIds: cluster.files.map((file) => file.fileId),
    files: cluster.files,
    cluster,
  }));
  const internal: WeeklyMintContainer = {
    key: INTERNAL_CONTAINER_KEY,
    companyEntityId: null,
    companyName: INTERNAL_COMPANY_NAME,
    fileIds: internalFileIds,
    files: await loadFileMeta(db, internalFileIds),
    cluster: null,
  };
  return [...external, internal].sort((a, b) => a.key.localeCompare(b.key));
}

async function claimCandidatesForCompany(
  db: Kysely<DB>,
  container: WeeklyMintContainer,
  companyKey: string,
  clock: Date,
  now: string,
): Promise<number> {
  const fileIds = container.files.filter((file) => isAtOrBeforeClock(file.date, clock)).map((file) => file.fileId);
  if (fileIds.length === 0) return 0;
  const reviewIds = new Set<string>();
  for (const fileChunk of chunk(fileIds, 500)) {
    const rows = await db
      .selectFrom("entity_review_queue")
      .innerJoin("entity_review_evidence", "entity_review_evidence.review_id", "entity_review_queue.id")
      .select("entity_review_queue.id")
      .distinct()
      .where("entity_review_queue.status", "=", "pending")
      .where("entity_review_queue.entity_type", "=", "project")
      .where("entity_review_queue.source", "in", [...WEEKLY_MINT_REVIEW_SOURCE_ALLOWLIST])
      .where("entity_review_queue.seed_source", "is", null)
      .where("entity_review_evidence.indexed_file_id", "in", fileChunk)
      .execute();
    for (const row of rows) reviewIds.add(row.id);
  }
  for (const reviewId of reviewIds) {
    await db
      .insertInto("weekly_mint_candidates")
      .values({ review_id: reviewId, company_key: companyKey, last_grouped_at: now, updated_at: now })
      .onConflict((oc) =>
        oc.columns(["review_id", "company_key"]).doUpdateSet({ last_grouped_at: now, updated_at: now }),
      )
      .execute();
  }
  return reviewIds.size;
}

async function readClaimedCandidates(
  db: Kysely<DB>,
  companyKey: string,
  container: WeeklyMintContainer,
  clock: Date,
): Promise<ClaimedCandidate[]> {
  const fileIds = new Set(
    container.files.filter((file) => isAtOrBeforeClock(file.date, clock)).map((file) => file.fileId),
  );
  if (fileIds.size === 0) return [];
  const rows = await db
    .selectFrom("weekly_mint_candidates")
    .innerJoin("entity_review_queue", "entity_review_queue.id", "weekly_mint_candidates.review_id")
    .select([
      "entity_review_queue.id as reviewId",
      "entity_review_queue.proposed_name as proposedName",
      "entity_review_queue.normalized_name as normalizedName",
      "entity_review_queue.candidate_entity_id as candidateEntityId",
      "entity_review_queue.candidate_generated_at as candidateGeneratedAt",
      "weekly_mint_candidates.dry_streak as dryStreak",
    ])
    .where("weekly_mint_candidates.company_key", "=", companyKey)
    .where("entity_review_queue.status", "=", "pending")
    .where("entity_review_queue.entity_type", "=", "project")
    .where("entity_review_queue.source", "in", [...WEEKLY_MINT_REVIEW_SOURCE_ALLOWLIST])
    .where("entity_review_queue.seed_source", "is", null)
    .orderBy("entity_review_queue.normalized_name", "asc")
    .execute();
  if (rows.length === 0) return [];
  const evidenceByReview = new Map<string, string[]>();
  for (const idChunk of chunk(
    rows.map((row) => row.reviewId),
    500,
  )) {
    const evidenceRows = await db
      .selectFrom("entity_review_evidence")
      .select(["review_id", "indexed_file_id"])
      .where("review_id", "in", idChunk)
      .execute();
    for (const row of evidenceRows) {
      if (!fileIds.has(row.indexed_file_id)) continue;
      const list = evidenceByReview.get(row.review_id);
      if (list) list.push(row.indexed_file_id);
      else evidenceByReview.set(row.review_id, [row.indexed_file_id]);
    }
  }
  return rows
    .map((row) => ({
      reviewId: row.reviewId,
      proposedName: row.proposedName,
      normalizedName: row.normalizedName,
      candidateEntityId: row.candidateEntityId,
      candidateGeneratedAt: row.candidateGeneratedAt,
      dryStreak: row.dryStreak,
      evidenceFileIds: [...new Set(evidenceByReview.get(row.reviewId) ?? [])].sort(),
    }))
    .filter((row) => row.evidenceFileIds.length > 0);
}

/**
 * Words that describe the shape of a deliverable rather than which one it is.
 * On the Oliver Wyman corpus "dashboard" alone chained War Dashboard, MiZa
 * Impact Dashboard, Budget dashboard, and five more distinct projects into one
 * group; "tool", "report", and "project" behave the same way everywhere.
 */
const GENERIC_PROJECT_TOKENS = new Set([
  "project",
  "projects",
  "dashboard",
  "dashboards",
  "tool",
  "tools",
  "app",
  "apps",
  "portal",
  "platform",
  "system",
  "report",
  "reports",
  "demo",
  "prototype",
  "pilot",
  "poc",
  "internal",
  "backend",
  "frontend",
  "dev",
  "development",
  "engagement",
  "workstream",
  "initiative",
]);

/** Tokens per candidate name are eligible for fusion only past this pool-wide frequency cut. */
const FUSION_TOKEN_MAX_CANDIDATES = 3;

function companyNameTokens(companyName: string): Set<string> {
  const tokens = fragmentNameTokens(companyName);
  const initialism = tokens.length > 1 ? tokens.map((token) => token[0] ?? "").join("") : "";
  return new Set(initialism ? [...tokens, initialism] : tokens);
}

/**
 * The tokens a candidate may fuse or scan on: its name minus cadence words,
 * deliverable-shape words, and the company's own name (including its
 * initialism — "ow" chained every ow-* repo into one group). A name made
 * entirely of filtered words keeps its full token set so it still forms a
 * group of its own instead of vanishing.
 */
function distinctiveTokens(name: string, company: Set<string>): string[] {
  const tokens = fragmentNameTokens(name);
  const filtered = tokens.filter(
    (token) => !CADENCE_TOKENS.has(token) && !GENERIC_PROJECT_TOKENS.has(token) && !company.has(token),
  );
  return filtered.length > 0 ? filtered : tokens;
}

/**
 * Groups candidates by shared distinctive tokens. Fusion is pairwise, not
 * transitive-on-any-token: two names fuse when they share two distinctive
 * tokens, or one when either side has only a single distinctive token
 * ("Saudi" must still join "Saudi Arabia"). Tokens carried by more than
 * FUSION_TOKEN_MAX_CANDIDATES candidates in this pool never fuse — a word
 * that common inside one company's pool is vocabulary, not identity. The old
 * transitive single-token union-find collapsed 26 of Oliver Wyman's 39
 * candidates into one group, which then alias-matched a single existing
 * project and silently swallowed all of them.
 */
function groupClaimedCandidates(candidates: ClaimedCandidate[], companyName: string): CandidateGroup[] {
  const company = companyNameTokens(companyName);
  const tokensByIndex = candidates.map((candidate) => distinctiveTokens(candidate.proposedName, company));
  const poolFrequency = new Map<string, number>();
  for (const tokens of tokensByIndex) {
    for (const token of new Set(tokens)) poolFrequency.set(token, (poolFrequency.get(token) ?? 0) + 1);
  }
  const fusionTokens = tokensByIndex.map(
    (tokens) => new Set(tokens.filter((token) => (poolFrequency.get(token) ?? 0) <= FUSION_TOKEN_MAX_CANDIDATES)),
  );

  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] === index) return index;
    parent[index] = find(parent[index]);
    return parent[index];
  };
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      let shared = 0;
      for (const token of fusionTokens[a]) if (fusionTokens[b].has(token)) shared++;
      const required = fusionTokens[a].size === 1 || fusionTokens[b].size === 1 ? 1 : 2;
      if (shared >= required && shared > 0) parent[find(a)] = find(b);
    }
  }

  const grouped = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(index);
    const list = grouped.get(root);
    if (list) list.push(index);
    else grouped.set(root, [index]);
  });
  const groups: CandidateGroup[] = [];
  for (const memberIndexes of grouped.values()) {
    const members = memberIndexes.map((index) => candidates[index]);
    const reviewIds = members.map((member) => member.reviewId).sort();
    const tokenCounts = new Map<string, number>();
    for (const index of memberIndexes) {
      for (const token of new Set(tokensByIndex[index])) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
    }
    const shared = [...tokenCounts.entries()]
      .filter(([, count]) => count === memberIndexes.length)
      .map(([token]) => token);
    const fallback = tokensByIndex[memberIndexes[0]] ?? [];
    const tokens = (shared.length > 0 ? shared : fallback).sort();
    groups.push({
      key: reviewIds.join("|"),
      reviewIds,
      names: [...new Set(members.map((member) => member.proposedName))].sort(),
      tokens,
      evidenceFileIds: [...new Set(members.flatMap((member) => member.evidenceFileIds))].sort(),
      scan: null,
      deterministic: { action: "new" },
    });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Existing projects offered as alias/nesting targets are scoped to the container's
 * company via engagement_for edges plus their transitive part_of descendants.
 * Unscoped loading put every workspace project in the prompt (567 for one real
 * container), and cross-company entities with broad aliases ("the dashboard",
 * "Canvas") out-competed the correct same-company parent. The internal container
 * has no company to scope by and keeps the full list.
 */
async function loadExistingProjects(
  db: Kysely<DB>,
  clusterFileIds: string[],
  companyEntityId: string | null,
): Promise<ExistingProject[]> {
  let scopedIds: Set<string> | null = null;
  if (companyEntityId !== null) {
    const engaged = await db
      .selectFrom("entity_relationships")
      .select(["source_entity_id"])
      .where("relationship_type", "=", "engagement_for")
      .where("target_entity_id", "=", companyEntityId)
      .execute();
    scopedIds = new Set(engaged.map((row) => row.source_entity_id));
    if (scopedIds.size > 0) {
      const partOf = await db
        .selectFrom("entity_relationships")
        .select(["source_entity_id", "target_entity_id"])
        .where("relationship_type", "=", "part_of")
        .execute();
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of partOf) {
          if (scopedIds.has(row.target_entity_id) && !scopedIds.has(row.source_entity_id)) {
            scopedIds.add(row.source_entity_id);
            grew = true;
          }
        }
      }
    }
    if (scopedIds.size === 0) return [];
  }
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("source_type", "=", "project")
    .where(whereLiveEntity())
    .$if(scopedIds !== null, (qb) => qb.where("id", "in", [...(scopedIds as Set<string>)]))
    .execute();
  const fileSets = new Map<string, Set<string>>();
  if (rows.length > 0) {
    for (const idChunk of chunk(
      rows.map((row) => row.id),
      500,
    )) {
      const mentions = await db
        .selectFrom("entity_mentions")
        .select(["entity_id", "indexed_file_id"])
        .where("entity_id", "in", idChunk)
        .execute();
      for (const mention of mentions) {
        const set = fileSets.get(mention.entity_id);
        if (set) set.add(mention.indexed_file_id);
        else fileSets.set(mention.entity_id, new Set([mention.indexed_file_id]));
      }
    }
  }
  const clusterFiles = new Set(clusterFileIds);
  return rows
    .map((row) => ({
      entityId: row.id,
      name: row.name,
      aliases: parseAliases(row.aliases),
      fileIds: new Set(
        [...(fileSets.get(row.id) ?? new Set<string>()).values()].filter((fileId) => clusterFiles.has(fileId)),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadStandingProducts(db: Kysely<DB>): Promise<StandingProduct[]> {
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("source_type", "=", "product")
    .where("provenance_tier", "in", ["declared", "human_confirmed"])
    .where(whereLiveEntity())
    .execute();
  return rows
    .map((row) => ({ entityId: row.id, name: row.name, aliases: parseAliases(row.aliases) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function matchingStandingProduct(group: CandidateGroup, products: StandingProduct[]): StandingProduct | null {
  const vocabulary = [...group.names, group.tokens.join(" ")].join(" ");
  for (const product of products) {
    if (channelMatchesCompany(vocabulary, [product.name, ...product.aliases])) return product;
  }
  return null;
}

/**
 * Unlike standing products (declared/human_confirmed only), the company guard
 * accepts inferred companies: the entities it must catch (Goosebumps, Beetu,
 * Craft Idea) were all created by extraction, never declared by a human.
 */
async function loadCompanyGuards(db: Kysely<DB>): Promise<StandingProduct[]> {
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("source_type", "=", "company")
    .where("status", "=", "confirmed")
    .where(whereLiveEntity())
    .execute();
  return rows
    .map((row) => ({ entityId: row.id, name: row.name, aliases: parseAliases(row.aliases) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function squashName(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9]/g, "");
}

/**
 * An internal-pot group named after a known company is client work whose
 * discussions happened without a client attendee — not an internal project.
 * The match requires the complete company name (squashed, so "craftidea"
 * equals the "Craft Idea" entity) — token containment over-fires: it killed
 * "AWS-accelerator", a real internal initiative, because the AWS company
 * entity exists. Groups that merely mention a company go to the model, whose
 * guidance already skips demos and engagement overhead. The squash floor of 4
 * keeps short acronyms from swallowing unrelated candidates.
 */
function matchingCompany(group: CandidateGroup, companies: StandingProduct[]): StandingProduct | null {
  const squashedGroupNames = new Set(group.names.map(squashName));
  for (const company of companies) {
    for (const name of [company.name, ...company.aliases]) {
      const squashed = squashName(name);
      if (squashed.length >= 4 && squashedGroupNames.has(squashed)) return company;
    }
  }
  return null;
}

/**
 * Deterministic disposition is containment-only. Exact name/alias matches are
 * handled per candidate before grouping (splitAliasCandidates) — deciding
 * alias at group level let one matching member alias its entire group, which
 * pointed 26 distinct Oliver Wyman candidates at GCC Dashboard.
 */
function chooseDeterministicDisposition(group: CandidateGroup, projects: ExistingProject[]): DeterministicDisposition {
  const scanFiles = group.scan?.files.length ? group.scan.files : group.evidenceFileIds;
  if (scanFiles.length === 0) return { action: "new" };
  let best: { project: ExistingProject; ratio: number } | null = null;
  for (const project of projects) {
    const inside = scanFiles.filter((fileId) => project.fileIds.has(fileId)).length;
    const ratio = inside / scanFiles.length;
    if (!best || ratio > best.ratio) best = { project, ratio };
  }
  if (best && best.ratio >= CONTAINMENT_FLOOR) {
    return { action: "child_of", entityId: best.project.entityId, entityName: best.project.name };
  }
  return { action: "new" };
}

async function updateScanState(
  db: Kysely<DB>,
  companyKey: string,
  groups: CandidateGroup[],
  now: string,
): Promise<void> {
  for (const group of groups) {
    for (const reviewId of group.reviewIds) {
      await db
        .updateTable("weekly_mint_candidates")
        .set({
          scan_days: group.scan?.distinctDays ?? 0,
          scan_first_day: group.scan?.firstDay ?? null,
          scan_last_day: group.scan?.lastDay ?? null,
          updated_at: now,
        })
        .where("review_id", "=", reviewId)
        .where("company_key", "=", companyKey)
        .execute();
    }
  }
}

async function incrementDryStreak(
  db: Kysely<DB>,
  companyKey: string,
  groups: CandidateGroup[],
  now: string,
): Promise<void> {
  for (const group of groups) {
    for (const reviewId of group.reviewIds) {
      const row = await db
        .selectFrom("weekly_mint_candidates")
        .select("dry_streak")
        .where("review_id", "=", reviewId)
        .where("company_key", "=", companyKey)
        .executeTakeFirst();
      await db
        .updateTable("weekly_mint_candidates")
        .set({ dry_streak: (row?.dry_streak ?? 0) + 1, updated_at: now })
        .where("review_id", "=", reviewId)
        .where("company_key", "=", companyKey)
        .execute();
    }
  }
}

async function resetDryStreak(
  db: Kysely<DB>,
  companyKey: string,
  groups: CandidateGroup[],
  now: string,
): Promise<void> {
  for (const group of groups) {
    for (const reviewId of group.reviewIds) {
      await db
        .updateTable("weekly_mint_candidates")
        .set({ dry_streak: 0, updated_at: now })
        .where("review_id", "=", reviewId)
        .where("company_key", "=", companyKey)
        .execute();
    }
  }
}

function groupVocabularyMatchesName(group: CandidateGroup, name: string): boolean {
  return channelMatchesCompany(name, [...group.names, group.tokens.join(" ")]);
}

async function groupHasRepoCoSignal(db: Kysely<DB>, group: CandidateGroup): Promise<boolean> {
  const fileIds = group.scan?.files.length ? group.scan.files : group.evidenceFileIds;
  const repoFiles = new Map<string, Set<string>>();
  for (const fileChunk of chunk(fileIds, 100)) {
    const rows = await db.selectFrom("indexed_files").select(["id", "content"]).where("id", "in", fileChunk).execute();
    for (const row of rows) {
      for (const match of (row.content ?? "").matchAll(GITHUB_REPO_PATTERN)) {
        const repo = `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`.toLowerCase();
        const files = repoFiles.get(repo) ?? new Set<string>();
        files.add(row.id);
        repoFiles.set(repo, files);
      }
    }
  }
  return [...repoFiles.values()].some((files) => files.size >= 2);
}

async function groupHasDedicatedInternalChannelCoSignal(db: Kysely<DB>, group: CandidateGroup): Promise<boolean> {
  const fileIds = group.scan?.files.length ? group.scan.files : group.evidenceFileIds;
  if (fileIds.length === 0) return false;
  const rows = await db
    .selectFrom("indexed_files")
    .select(["source", "source_path"])
    .where("id", "in", fileIds)
    .where("source", "in", ["slack", "whatsapp"])
    .execute();
  const conversationIds = new Set<number>();
  for (const row of rows) {
    const match = row.source_path?.match(/[?&]conversationId=(\d+)/);
    if (match) conversationIds.add(Number(match[1]));
  }
  if (conversationIds.size === 0) return false;
  const channels = await db
    .selectFrom("conversations")
    .leftJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .select(["conversations.id", "conversations.display_name as displayName", "whatsapp_groups.name as groupName"])
    .where("conversations.id", "in", [...conversationIds])
    .where("conversations.kind", "in", ["channel", "group"])
    .execute();
  return channels.some((channel) => groupVocabularyMatchesName(group, channel.groupName ?? channel.displayName ?? ""));
}

async function groupHasTrackerContainerCoSignal(db: Kysely<DB>, group: CandidateGroup): Promise<boolean> {
  const fileIds = group.scan?.files.length ? group.scan.files : group.evidenceFileIds;
  if (fileIds.length === 0) return false;
  const fileRows = await db
    .selectFrom("indexed_files")
    .select(["connector_config_id", "source_path"])
    .where("id", "in", fileIds)
    .execute();
  const connectorIds = [...new Set(fileRows.map((row) => row.connector_config_id))];
  if (connectorIds.length === 0) return false;
  const classifications = await db
    .selectFrom("container_classifications")
    .select(["connector_config_id", "container_name", "proposed_target", "status"])
    .where("connector_config_id", "in", connectorIds)
    .execute();
  const sourcePaths = fileRows.map((row) => row.source_path ?? "");
  return classifications.some((classification) => {
    if (classification.proposed_target === "ignore") return false;
    if (
      classification.status !== "proposed" &&
      classification.status !== "accepted" &&
      classification.status !== "edited"
    ) {
      return false;
    }
    if (!groupVocabularyMatchesName(group, classification.container_name)) return false;
    return sourcePaths.some((path) => path.includes(classification.container_name));
  });
}

/**
 * Internal candidates require recurrence plus a structural co-signal because
 * the no-client pot is the noisiest corpus: one person's own-org files measured
 * at 1,325. A group crosses only when its tokens recur on at least three scan
 * days and the same group also carries a repo repeated across files, a matching
 * dedicated internal channel, or a matching tracker container name.
 */
async function groupHasInternalStructuralCoSignal(db: Kysely<DB>, group: CandidateGroup): Promise<boolean> {
  return (
    (await groupHasRepoCoSignal(db, group)) ||
    (await groupHasDedicatedInternalChannelCoSignal(db, group)) ||
    (await groupHasTrackerContainerCoSignal(db, group))
  );
}

/**
 * A candidate whose name exactly matches an accepted project's name or alias
 * needs no verdict — it is that project. Matching is per candidate so one
 * match can never speak for its group-mates.
 */
function splitAliasCandidates(
  candidates: ClaimedCandidate[],
  projects: ExistingProject[],
): { aliases: Array<{ candidate: ClaimedCandidate; targetEntityId: string }>; rest: ClaimedCandidate[] } {
  const projectByKey = new Map<string, string>();
  for (const project of projects) {
    for (const name of [project.name, ...project.aliases]) {
      const key = normalizeName(name);
      if (!projectByKey.has(key)) projectByKey.set(key, project.entityId);
    }
  }
  const aliases: Array<{ candidate: ClaimedCandidate; targetEntityId: string }> = [];
  const rest: ClaimedCandidate[] = [];
  for (const candidate of candidates) {
    const targetEntityId = projectByKey.get(normalizeName(candidate.proposedName));
    if (targetEntityId) aliases.push({ candidate, targetEntityId });
    else rest.push(candidate);
  }
  return { aliases, rest };
}

async function markAliasCandidates(
  db: Kysely<DB>,
  groups: Array<{ reviewIds: string[]; targetEntityId: string }>,
  now: string,
): Promise<void> {
  for (const { reviewIds, targetEntityId } of groups) {
    for (const reviewId of reviewIds) {
      await db
        .updateTable("entity_review_queue")
        .set({
          candidate_entity_id: targetEntityId,
          candidate_score: 1,
          candidate_reason: "weekly-mint-alias",
          candidate_generated_at: now,
        })
        .where("id", "=", reviewId)
        .where("status", "=", "pending")
        .execute();
    }
  }
}

/**
 * Deterministic exact-name matches are auto-linked through the same
 * confirmReview merge path a human Link click uses (user decision,
 * 2026-08-20). A row the full path cannot take — null CAS snapshot, drift, a
 * guard, an FK — falls back to the candidate stamp, degrading to the old
 * human Link chore rather than ever losing the row. Model-asserted alias
 * groups from the verdict deliberately stay on the stamp path.
 */
async function autoLinkAliasCandidates(
  db: Kysely<DB>,
  logger: Logger,
  aliases: Array<{ candidate: ClaimedCandidate; targetEntityId: string }>,
  now: string,
): Promise<{ linked: number; stamped: number }> {
  let linked = 0;
  let stamped = 0;
  for (const { candidate, targetEntityId } of aliases) {
    const stamp = () =>
      markAliasCandidates(db, [{ reviewIds: [candidate.reviewId], targetEntityId }], now).then(() => {
        stamped += 1;
      });
    if (!candidate.candidateGeneratedAt) {
      await stamp();
      continue;
    }
    try {
      const outcome = await confirmReview(
        { db, userId: "weekly-mint-alias", machineActor: true, logger },
        candidate.reviewId,
        {
          candidateGeneratedAt: candidate.candidateGeneratedAt,
          mergeIntoEntityId: targetEntityId,
        },
      );
      if (outcome.targetEntityId === targetEntityId) linked += 1;
      else {
        logger.warn(
          { reviewId: candidate.reviewId, targetEntityId, resolvedInto: outcome.targetEntityId },
          "Weekly mint alias auto-link replayed into a different target",
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, reviewId: candidate.reviewId, targetEntityId },
        "Weekly mint alias auto-link failed; stamping for manual Link",
      );
      await stamp().catch(() => {});
    }
  }
  return { linked, stamped };
}

async function ageOutStaleCandidates(db: Kysely<DB>, companyKey: string, clock: Date, now: string): Promise<number> {
  const cutoff = new Date(clock.getTime() - AGE_OUT_WEEKS * 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .selectFrom("weekly_mint_candidates")
    .innerJoin("entity_review_queue", "entity_review_queue.id", "weekly_mint_candidates.review_id")
    .select("entity_review_queue.id")
    .where("weekly_mint_candidates.company_key", "=", companyKey)
    .where("entity_review_queue.status", "=", "pending")
    .where("entity_review_queue.last_seen_at", "<", cutoff)
    .execute();
  for (const row of rows) {
    await db
      .updateTable("entity_review_queue")
      .set({ status: "dismissed", resolved_by: "weekly-mint-ageout", resolved_at: now })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .execute();
  }
  return rows.length;
}

/**
 * storePending supersedes ALL of a company's pending verdicts, so a manual
 * re-run that judges only uncovered groups would silently wipe an unreviewed
 * dossier covering other groups. Manual runs skip such companies entirely.
 */
async function hasPendingWeeklyVerdict(db: Kysely<DB>, companyEntityId: string | null): Promise<boolean> {
  const row = await db
    .selectFrom("project_minting_verdicts")
    .select("id")
    .$if(companyEntityId === null, (qb) => qb.where("company_entity_id", "is", null))
    .$if(companyEntityId !== null, (qb) => qb.where("company_entity_id", "=", companyEntityId))
    .where("status", "=", "pending")
    .where("superseded_at", "is", null)
    .executeTakeFirst();
  return row != null;
}

async function coveredByPendingWeeklyVerdict(db: Kysely<DB>, companyEntityId: string | null): Promise<Set<string>> {
  const row = await db
    .selectFrom("project_minting_verdicts")
    .select(["verdict", "prompt_version"])
    .$if(companyEntityId === null, (qb) => qb.where("company_entity_id", "is", null))
    .$if(companyEntityId !== null, (qb) => qb.where("company_entity_id", "=", companyEntityId))
    .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
    .where("status", "=", "pending")
    .where("superseded_at", "is", null)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!row) return new Set();
  const verdict = readClusterVerdict(JSON.parse(row.verdict), { strict: true });
  return new Set(verdict.projects.flatMap((project) => project.coveredReviewIds ?? project.evidenceFragments));
}

function formatCountedList(items: Array<{ name: string; count: number }>): string[] {
  return items
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((item) => `${item.name} (${item.count} files)`);
}

function evidenceCitationCounts(groups: CandidateGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const fileId of new Set(group.evidenceFileIds)) counts.set(fileId, (counts.get(fileId) ?? 0) + 1);
  }
  return counts;
}

function selectEvidenceFileIdsForContent(groups: CandidateGroup[], citationCounts: Map<string, number>): string[] {
  return [...new Set(groups.flatMap((group) => group.evidenceFileIds))]
    .sort((a, b) => (citationCounts.get(b) ?? 0) - (citationCounts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 200);
}

async function loadEvidenceContent(db: Kysely<DB>, fileIds: string[]): Promise<Map<string, EvidenceContent>> {
  const rows: EvidenceContent[] = [];
  for (const fileChunk of chunk(fileIds, 500)) {
    const fileRows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "content"])
      .where("id", "in", fileChunk)
      .execute();
    for (const row of fileRows) {
      rows.push({
        id: row.id,
        fileName: row.file_name,
        content: (row.content ?? "").slice(0, 6000),
      });
    }
  }
  return new Map(rows.map((row) => [row.id, row]));
}

function lowerIncludes(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function snippetAroundMatch(content: string, matchIndex: number, termLength: number): string {
  const start = Math.max(0, matchIndex - 120);
  const end = Math.min(content.length, matchIndex + termLength + 120);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function snippetsForGroup(
  group: CandidateGroup,
  evidenceById: Map<string, EvidenceContent>,
  enumerationFiles: Set<string>,
): string[] {
  const names = group.names.map((name) => name.trim()).filter((name) => name.length >= 4);
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const fileId of group.evidenceFileIds) {
    if (enumerationFiles.has(fileId)) continue;
    const file = evidenceById.get(fileId);
    if (!file?.content) continue;
    for (const name of names) {
      const matchIndex = lowerIncludes(file.content, name);
      if (matchIndex < 0) continue;
      const snippet = snippetAroundMatch(file.content, matchIndex, name.length);
      if (snippet && !seen.has(snippet)) {
        seen.add(snippet);
        snippets.push(snippet);
      }
      break;
    }
    if (snippets.length >= 3) break;
  }
  return snippets.slice(0, 3);
}

function isBareGenericProjectTerm(term: string): boolean {
  const tokens = fragmentNameTokens(term);
  return tokens.length === 1 && GENERIC_PROJECT_TOKENS.has(tokens[0]);
}

function existingProjectMatchTerms(project: ExistingProject): string[] {
  return [...new Set([project.name, ...project.aliases].map((term) => term.trim().toLowerCase()))].filter(
    (term) => term.length >= 5 && !isBareGenericProjectTerm(term),
  );
}

/**
 * Content signals count every evidence file, shared ones included. A recurring
 * standup transcript is shared by every workstream discussed in it, and it is
 * exactly where the parent project's name appears — excluding shared files here
 * silenced the dominant nesting signal. Indiscriminate files still lose on
 * relative counts, and snippets keep the shared-file exclusion.
 */
function contentSignalCountsForGroup(
  group: CandidateGroup,
  projects: ExistingProject[],
  evidenceById: Map<string, EvidenceContent>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const projectTerms = projects.map((project) => ({ project, terms: existingProjectMatchTerms(project) }));
  for (const fileId of group.evidenceFileIds) {
    const file = evidenceById.get(fileId);
    if (!file) continue;
    const haystack = `${file.fileName}\n${file.content}`.toLowerCase();
    for (const { project, terms } of projectTerms) {
      if (terms.length === 0) continue;
      if (terms.some((term) => haystack.includes(term))) {
        counts.set(project.entityId, (counts.get(project.entityId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Files cited by many groups (a recurring standup, an inventory message) are shown
 * to the model as a shared-files section with a content preview instead of being
 * judged by a heuristic. On real data both a parent project's standup and a repo
 * inventory listing look identical by citation count and evidence shape — only
 * the file's own content tells a workstream roster apart from a repo table, so
 * the model reads the preview and decides.
 */
async function buildWeeklyPromptContext(
  db: Kysely<DB>,
  groups: CandidateGroup[],
  projects: ExistingProject[],
): Promise<WeeklyPromptContext> {
  const context = new Map<string, WeeklyPromptGroupContext>(
    groups.map((group) => [
      group.key,
      { coMentionedProjects: [], sharedEvidenceWith: [], snippets: [], onlySharedEvidence: false },
    ]),
  );
  const citationCounts = evidenceCitationCounts(groups);
  const enumerationFiles = new Set(
    [...citationCounts.entries()].filter(([, count]) => count >= 4).map(([fileId]) => fileId),
  );
  const evidenceFileIds = selectEvidenceFileIdsForContent(groups, citationCounts);
  const nonEnumerationEvidenceFileIds = evidenceFileIds.filter((fileId) => !enumerationFiles.has(fileId));
  const evidenceById = await loadEvidenceContent(db, evidenceFileIds);
  const groupEvidence = new Map(groups.map((group) => [group.key, new Set(group.evidenceFileIds)]));
  const groupLabel = (group: CandidateGroup) => `${group.names[0] ?? group.key} [${group.key}]`;
  const sharedCounts = new Map<string, Array<{ name: string; count: number }>>();
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      const left = groups[a];
      const right = groups[b];
      const rightFiles = groupEvidence.get(right.key) ?? new Set<string>();
      let shared = 0;
      for (const fileId of groupEvidence.get(left.key) ?? []) {
        if (rightFiles.has(fileId)) shared++;
      }
      if (shared === 0) continue;
      sharedCounts.set(left.key, [...(sharedCounts.get(left.key) ?? []), { name: groupLabel(right), count: shared }]);
      sharedCounts.set(right.key, [...(sharedCounts.get(right.key) ?? []), { name: groupLabel(left), count: shared }]);
    }
  }
  for (const [groupKey, items] of sharedCounts) {
    const groupContext = context.get(groupKey);
    if (groupContext) groupContext.sharedEvidenceWith = formatCountedList(items);
  }

  for (const group of groups) {
    const groupContext = context.get(group.key);
    if (!groupContext) continue;
    groupContext.onlySharedEvidence =
      group.evidenceFileIds.length > 0 && group.evidenceFileIds.every((fileId) => enumerationFiles.has(fileId));
    groupContext.snippets = snippetsForGroup(group, evidenceById, enumerationFiles);
  }

  const sharedFiles: SharedEvidenceFile[] = [...enumerationFiles]
    .sort((a, b) => (citationCounts.get(b) ?? 0) - (citationCounts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 10)
    .flatMap((fileId) => {
      const file = evidenceById.get(fileId);
      if (!file) return [];
      const citedBy = groups
        .filter((group) => group.evidenceFileIds.includes(fileId))
        .map((group) => group.names[0] ?? group.key);
      return [
        {
          fileName: file.fileName,
          citedBy,
          preview: file.content.slice(0, 300).replace(/\s+/g, " ").trim(),
        },
      ];
    });

  if (nonEnumerationEvidenceFileIds.length > 0 && projects.length > 0) {
    const coMentionRows = await db
      .selectFrom("entity_mentions")
      .select(["entity_id", "indexed_file_id"])
      .where(
        "entity_id",
        "in",
        projects.map((project) => project.entityId),
      )
      .where("indexed_file_id", "in", nonEnumerationEvidenceFileIds)
      .execute();
    const filesByProject = new Map<string, Set<string>>();
    for (const row of coMentionRows) {
      const files = filesByProject.get(row.entity_id) ?? new Set<string>();
      files.add(row.indexed_file_id);
      filesByProject.set(row.entity_id, files);
    }
    for (const group of groups) {
      const files = groupEvidence.get(group.key) ?? new Set<string>();
      const counted = projects
        .map((project) => ({
          name: project.name,
          count: [...(filesByProject.get(project.entityId) ?? new Set<string>())].filter((fileId) => files.has(fileId))
            .length,
        }))
        .filter((item) => item.count > 0);
      const groupContext = context.get(group.key);
      if (groupContext) groupContext.coMentionedProjects = formatCountedList(counted);
    }
  }

  if (projects.length > 0) {
    for (const group of groups) {
      const contentCounts = contentSignalCountsForGroup(group, projects, evidenceById);
      if (contentCounts.size === 0) continue;
      const existing = new Map(
        (context.get(group.key)?.coMentionedProjects ?? []).map((item) => {
          const match = item.match(/^(.*) \((\d+) files\)$/);
          return match ? [match[1], Number(match[2])] : [item, 0];
        }),
      );
      for (const project of projects) {
        const contentCount = contentCounts.get(project.entityId) ?? 0;
        if (contentCount === 0) continue;
        existing.set(project.name, (existing.get(project.name) ?? 0) + contentCount);
      }
      const groupContext = context.get(group.key);
      if (groupContext) {
        groupContext.coMentionedProjects = formatCountedList(
          [...existing.entries()].map(([name, count]) => ({ name, count })).filter((item) => item.count > 0),
        );
      }
    }
  }
  return { groups: context, sharedFiles };
}

async function buildWeeklyPrompt(
  db: Kysely<DB>,
  container: WeeklyMintContainer,
  groups: CandidateGroup[],
  projects: ExistingProject[],
  products: StandingProduct[],
): Promise<string> {
  const promptContext = await buildWeeklyPromptContext(db, groups, projects);
  const contexts = promptContext.groups;
  const groupLines = groups
    .map((group) => {
      const deterministic =
        group.deterministic.action === "new"
          ? "new"
          : `${group.deterministic.action}:${group.deterministic.entityId}:${group.deterministic.entityName}`;
      const groupContext = contexts.get(group.key);
      const lines = [
        `- groupKey: ${group.key}`,
        `  names: ${group.names.join(", ")}`,
        `  tokens: ${group.tokens.join(", ")}`,
        `  scanDays: ${group.scan?.distinctDays ?? 0}`,
        `  scanFiles: ${(group.scan?.files ?? []).join(", ")}`,
        `  deterministicProposal: ${deterministic}`,
      ];
      if (groupContext?.coMentionedProjects.length) {
        lines.push(`  coMentionedProjects: ${groupContext.coMentionedProjects.join(", ")}`);
      }
      if (groupContext?.sharedEvidenceWith.length) {
        lines.push(`  sharedEvidenceWith: ${groupContext.sharedEvidenceWith.join(", ")}`);
      }
      if (groupContext?.onlySharedEvidence) {
        lines.push("  onlySharedEvidence: true");
      }
      if (groupContext?.snippets.length) {
        lines.push(`  snippets: ${groupContext.snippets.map((snippet) => JSON.stringify(snippet)).join("; ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  const projectLines = projects
    .map(
      (project) =>
        `- ${project.entityId}: ${project.name}${project.aliases.length ? ` aliases=${project.aliases.join(", ")}` : ""}`,
    )
    .join("\n");
  const productLines = products
    .map(
      (product) =>
        `- ${product.entityId}: ${product.name}${product.aliases.length ? ` aliases=${product.aliases.join(", ")}` : ""}`,
    )
    .join("\n");
  return `You are reviewing weekly project minting candidates for ${container.companyName}.

For every group, return exactly one action: new, alias_of, child_of, or skip. Prefer the deterministicProposal unless the evidence clearly says otherwise. Use targetEntityId for alias_of and child_of when the parent or alias is an existing accepted project. Use parentGroupKey for child_of when the parent is another group in this same response. Use projectName for new and child_of.

Groups that are the same real-world project under different spellings, transliterations, or names (for example "Inaj" and "INJAZ", a codename and its formal name, a repo and the project it implements) must return the SAME projectName — that is how they merge into one project. Only merge when you are confident they are one piece of work; when unsure, keep them separate.

Choose between child_of and skip carefully — they are not interchangeable:
- child_of is for real delivery work that belongs to a bigger project: a feature track, a data workstream, a recurring sub-topic of a project's standups or reviews. Use targetEntityId when coMentionedProjects or snippets tie the group to an existing accepted project; use parentGroupKey when the parent is another group in this response. A workstream stays child_of even when its own evidence is thin — do NOT skip it.
- skip is only for things that are not delivery work at all: scheduling and logistics chatter, budget or staffing admin, internal trackers for running the engagement itself (budget tracking, RFP pipelines), a demo or presentation and any recording of one, or a name that exists only as a line in an inventory listing.
- A recurring operational stream is also skip: bug reports, form submissions, support tickets, or templated automated artifacts that arrive on a cadence (for example a support channel's "bug report from a form" messages). The stream recurs because operations recur, not because anyone is delivering it. Only the work of BUILDING that pipeline is a project, and its evidence talks about building, not about individual tickets.
- When torn between skip and child_of, choose child_of. A specifically named piece of client work with thin evidence is still a project — thin evidence alone is never a reason to skip.

Never propose a generic placeholder name (e.g. "Different Project", "A Major Project", "New Initiative"). If the evidence does not give the work a specific name, return skip.

If a group is the same thing as an existing accepted project (its name or a close variant appears in that project's name or aliases), return alias_of with that targetEntityId — never mint a duplicate sibling.

A conversation about presenting, demoing, or selling OUR OWN product or open-source work to the client is a sales opportunity, not a delivery project — return skip even if the call series recurs. But a demo, prototype, or tool WE BUILT for the client's own proposal, bid, or deliverable is real delivery work and a real project — a group like "Acme Proposal Demo" with its own build activity (repo, deployment, working sessions) must be new, not skip.

Shared evidence files below are cited by several groups at once. First classify each file from its preview: a MEETING (recurring standup, sync, or review whose summary walks through named workstreams) or a LISTING (a message enumerating repos, URLs, or project names). Then apply: groups whose only evidence is a MEETING are workstreams of the project that meeting serves — child_of that project (find it via the groups' coMentionedProjects or the meeting content; use targetEntityId for an existing accepted project). Groups whose only evidence is LISTINGS are names on a list, not projects — skip.

Do not nest a group under an existing project on a single passing co-mention: nest only when the parent tie covers the group's core evidence (its evidence IS the parent's meeting, or most of its files mention the parent). A group with weeks of its own activity and a one-file co-mention stays top-level.

When one group's name is a qualified extension of another group's name in this response (for example "X CAPEX tool" alongside "X Dashboard"), the qualified one is usually that group's child — return child_of with the broader group's parentGroupKey.

Groups that repeatedly share evidence files and stakeholders (see sharedEvidenceWith, which names the other group and its groupKey) are ONE engagement even when each thread names its own deliverable (a portal here, a support thread there) — return the SAME projectName for all of them rather than one project per thread subject. Pick the most specific engagement-level name among them.

Return only JSON:
{
  "groups": [
    { "groupKey": "exact groupKey", "action": "new | alias_of | child_of | skip", "projectName": "project name or null", "targetEntityId": "existing project entity id or null", "parentGroupKey": "same-verdict parent groupKey or null" }
  ]
}

Existing accepted projects:
${projectLines || "none"}

Standing products:
${productLines || "none"}

Shared evidence files:
${
  promptContext.sharedFiles
    .map((file) => `- ${file.fileName} citedBy=${file.citedBy.join(", ")}\n  preview: ${JSON.stringify(file.preview)}`)
    .join("\n") || "none"
}

Crossing groups:
${groupLines}`;
}

function readModelDispositions(raw: unknown, groups: CandidateGroup[]): Map<string, ModelDisposition> {
  const byKey = new Map<string, CandidateGroup>(groups.map((group) => [group.key, group]));
  const dispositions = new Map<string, ModelDisposition>();
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(record.groups) ? record.groups : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawItem = item as Record<string, unknown>;
    const groupKey = typeof rawItem.groupKey === "string" ? rawItem.groupKey : "";
    if (!byKey.has(groupKey)) continue;
    const action = rawItem.action;
    if (action !== "new" && action !== "alias_of" && action !== "child_of" && action !== "skip") continue;
    const targetEntityId =
      action !== "skip" && typeof rawItem.targetEntityId === "string" && rawItem.targetEntityId.trim()
        ? rawItem.targetEntityId.trim()
        : null;
    const rawParentGroupKey =
      typeof rawItem.parentGroupKey === "string" && rawItem.parentGroupKey.trim()
        ? rawItem.parentGroupKey.trim()
        : null;
    const parentGroupKey =
      action === "child_of" && !targetEntityId && rawParentGroupKey && rawParentGroupKey !== groupKey
        ? rawParentGroupKey
        : null;
    dispositions.set(groupKey, {
      groupKey,
      action,
      projectName:
        action !== "skip" && typeof rawItem.projectName === "string" && rawItem.projectName.trim()
          ? rawItem.projectName.trim()
          : null,
      targetEntityId,
      parentGroupKey: action !== "skip" && parentGroupKey && byKey.has(parentGroupKey) ? parentGroupKey : null,
    });
  }
  for (const group of groups) {
    if (dispositions.has(group.key)) continue;
    dispositions.set(group.key, {
      groupKey: group.key,
      action: group.deterministic.action,
      projectName: null,
      targetEntityId: group.deterministic.action === "new" ? null : group.deterministic.entityId,
      parentGroupKey: null,
    });
  }
  return dispositions;
}

function defaultProjectName(group: CandidateGroup): string {
  return group.names[0] ?? group.tokens.join(" ");
}

function evidenceTitleFamiliesForGroup(container: WeeklyMintContainer, group: CandidateGroup): string[] {
  const fileNames = new Map(container.files.map((file) => [file.fileId, file.fileName]));
  const families = group.evidenceFileIds
    .map((fileId) => fileNames.get(fileId))
    .filter((fileName): fileName is string => fileName != null)
    .map((fileName) => normalizeTitleFamily(fileName).display);
  return [...new Set(families)].sort((a, b) => a.localeCompare(b));
}

function projectForGroup(
  group: CandidateGroup,
  name: string,
  parentName: string | null,
  evidenceTitleFamilies: string[],
  parentEntityId?: string,
): VerdictProject {
  return {
    name,
    status: "active",
    confidence: "medium",
    parentName,
    ...(parentEntityId ? { parentEntityId } : {}),
    evidenceTitleFamilies,
    evidenceRepos: [],
    evidenceFragments: [],
    coveredReviewIds: group.reviewIds,
    evidencePeople: [],
    reasoning: `Weekly recurrence crossed ${group.scan?.distinctDays ?? 0} distinct days.`,
  };
}

/**
 * Two groups the model merged by returning the same projectName must UNION
 * their evidence — overwriting drops the earlier group's review ids, which
 * un-covers those rows for next week's dedup and hides them from absorption
 * at accept (the Inaj/INJAZ merge silently lost Inaj's evidence this way).
 */
function mergeVerdictProjects(a: VerdictProject, b: VerdictProject): VerdictProject {
  return {
    ...a,
    parentName: a.parentName ?? b.parentName,
    ...((a.parentEntityId ?? b.parentEntityId) ? { parentEntityId: a.parentEntityId ?? b.parentEntityId } : {}),
    evidenceTitleFamilies: [...new Set([...a.evidenceTitleFamilies, ...b.evidenceTitleFamilies])],
    evidenceRepos: [...new Set([...a.evidenceRepos, ...b.evidenceRepos])],
    evidenceFragments: [...new Set([...a.evidenceFragments, ...b.evidenceFragments])],
    coveredReviewIds: [...new Set([...(a.coveredReviewIds ?? []), ...(b.coveredReviewIds ?? [])])],
    evidencePeople: [...new Set([...a.evidencePeople, ...b.evidencePeople])],
  };
}

function setOrMergeVerdictProject(map: Map<string, VerdictProject>, project: VerdictProject): void {
  const existing = map.get(project.name.toLowerCase());
  map.set(project.name.toLowerCase(), existing ? mergeVerdictProjects(existing, project) : project);
}

function parentGroupReference(disposition: ModelDisposition): string | null {
  if (disposition.action !== "child_of" || disposition.targetEntityId) return null;
  return disposition.parentGroupKey;
}

function parentGroupChainWouldCycle(groupKey: string, dispositions: Map<string, ModelDisposition>): boolean {
  const seen = new Set<string>([groupKey]);
  let current = groupKey;
  while (true) {
    const disposition = dispositions.get(current);
    if (!disposition) return false;
    const parentGroupKey = parentGroupReference(disposition);
    if (!parentGroupKey) return false;
    if (seen.has(parentGroupKey)) return true;
    seen.add(parentGroupKey);
    current = parentGroupKey;
  }
}

function sameVerdictProjectNameForParent(
  parentGroupKey: string,
  groupsByKey: Map<string, CandidateGroup>,
  dispositions: Map<string, ModelDisposition>,
): string | null {
  const parentGroup = groupsByKey.get(parentGroupKey);
  const parentDisposition = dispositions.get(parentGroupKey);
  if (
    !parentGroup ||
    !parentDisposition ||
    parentDisposition.action === "alias_of" ||
    parentDisposition.action === "skip"
  ) {
    return null;
  }
  return parentDisposition.projectName ?? defaultProjectName(parentGroup);
}

/**
 * The final per-group action the code took, after every fallback and merge —
 * distinct from the model's raw disposition, which loses `new` vs `child_of`
 * conversions and alias fallbacks. Written to the `disposition` trace step so
 * the eval reads actions instead of reconstructing them from verdict JSON.
 */
export type GroupDisposition = {
  groupKey: string;
  names: string[];
  action: "new" | "child_of" | "alias" | "skip";
  projectName?: string;
  parentName?: string;
  targetEntityId?: string;
  reason?: string;
};

function buildStoredVerdict(
  container: WeeklyMintContainer,
  groups: CandidateGroup[],
  dispositions: Map<string, ModelDisposition>,
  projects: ExistingProject[],
  products: StandingProduct[],
): {
  verdict: ClusterVerdict;
  storedGroups: CandidateGroup[];
  aliasGroups: Array<{ group: CandidateGroup; targetEntityId: string }>;
  skippedGroups: number;
  groupDispositions: GroupDisposition[];
} {
  const projectsById = new Map(projects.map((project) => [project.entityId, project]));
  const groupsByKey = new Map(groups.map((group) => [group.key, group]));
  for (const disposition of dispositions.values()) {
    if (disposition.targetEntityId !== null && !projectsById.has(disposition.targetEntityId)) {
      /**
       * Group keys and entity ids are both bare UUIDs in the prompt, and the
       * model sometimes returns a groupKey as targetEntityId. Writing that id
       * to entity_review_queue violates its FK and killed the whole container
       * verdict, so an id that is not a known existing project is dropped: a
       * groupKey meant as a parent still works via parentGroupKey, and an
       * alias with no target leaves the group pooled for next week.
       */
      if (
        disposition.action === "child_of" &&
        disposition.parentGroupKey === null &&
        groupsByKey.has(disposition.targetEntityId)
      ) {
        disposition.parentGroupKey = disposition.targetEntityId;
      }
      disposition.targetEntityId = null;
    }
  }
  const verdictProjects = new Map<string, VerdictProject>();
  const existingEntities: ClusterVerdict["existingEntities"] = [];
  const storedGroups: CandidateGroup[] = [];
  const aliasGroups: Array<{ group: CandidateGroup; targetEntityId: string }> = [];
  const groupDispositions: GroupDisposition[] = [];
  let skippedGroups = 0;

  for (const group of groups) {
    const disposition = dispositions.get(group.key);
    if (!disposition) {
      groupDispositions.push({ groupKey: group.key, names: group.names, action: "skip", reason: "no_disposition" });
      continue;
    }
    if (disposition.action === "skip") {
      skippedGroups += 1;
      groupDispositions.push({ groupKey: group.key, names: group.names, action: "skip", reason: "model_skip" });
      continue;
    }
    if (disposition.action === "alias_of") {
      const targetEntityId =
        disposition.targetEntityId ?? (group.deterministic.action === "alias_of" ? group.deterministic.entityId : null);
      if (targetEntityId) {
        aliasGroups.push({ group, targetEntityId });
        groupDispositions.push({ groupKey: group.key, names: group.names, action: "alias", targetEntityId });
      } else {
        groupDispositions.push({
          groupKey: group.key,
          names: group.names,
          action: "skip",
          reason: "alias_without_target",
        });
      }
      continue;
    }
    if (disposition.action === "child_of") {
      const parentEntityId =
        disposition.targetEntityId ?? (group.deterministic.action === "child_of" ? group.deterministic.entityId : null);
      const parent = parentEntityId ? projectsById.get(parentEntityId) : null;
      const sameVerdictParentName =
        !parentEntityId && disposition.parentGroupKey && !parentGroupChainWouldCycle(group.key, dispositions)
          ? sameVerdictProjectNameForParent(disposition.parentGroupKey, groupsByKey, dispositions)
          : null;
      const fallbackParentName =
        group.deterministic.action === "child_of" && !disposition.parentGroupKey
          ? group.deterministic.entityName
          : null;
      const resolvedParentName = parent?.name ?? sameVerdictParentName ?? fallbackParentName;
      if (!resolvedParentName) {
        const name = disposition.projectName ?? defaultProjectName(group);
        const product = container.companyEntityId === null ? matchingStandingProduct(group, products) : null;
        setOrMergeVerdictProject(
          verdictProjects,
          projectForGroup(group, name, null, evidenceTitleFamiliesForGroup(container, group), product?.entityId),
        );
        storedGroups.push(group);
        groupDispositions.push({
          groupKey: group.key,
          names: group.names,
          action: "new",
          projectName: name,
          reason: "child_without_parent",
        });
        continue;
      }
      const childName = disposition.projectName ?? defaultProjectName(group);
      if (childName.toLowerCase() === resolvedParentName.toLowerCase()) {
        if (parentEntityId) {
          aliasGroups.push({ group, targetEntityId: parentEntityId });
          groupDispositions.push({
            groupKey: group.key,
            names: group.names,
            action: "alias",
            targetEntityId: parentEntityId,
            reason: "child_named_as_parent",
          });
        } else {
          setOrMergeVerdictProject(
            verdictProjects,
            projectForGroup(group, childName, null, evidenceTitleFamiliesForGroup(container, group)),
          );
          storedGroups.push(group);
          groupDispositions.push({
            groupKey: group.key,
            names: group.names,
            action: "new",
            projectName: childName,
            reason: "child_named_as_parent",
          });
        }
        continue;
      }
      if (parentEntityId && !verdictProjects.has(resolvedParentName.toLowerCase())) {
        verdictProjects.set(resolvedParentName.toLowerCase(), {
          name: resolvedParentName,
          status: "active",
          confidence: "high",
          parentName: null,
          evidenceTitleFamilies: [],
          evidenceRepos: [],
          evidenceFragments: [],
          evidencePeople: [],
          reasoning: "Existing accepted project used as the parent container.",
        });
      }
      if (parent) {
        existingEntities.push({
          entityId: parent.entityId,
          name: parent.name,
          disposition: "canonical",
          reasoning: "Existing accepted project is the weekly candidate parent.",
        });
      }
      setOrMergeVerdictProject(
        verdictProjects,
        projectForGroup(group, childName, resolvedParentName, evidenceTitleFamiliesForGroup(container, group)),
      );
      storedGroups.push(group);
      groupDispositions.push({
        groupKey: group.key,
        names: group.names,
        action: "child_of",
        projectName: childName,
        parentName: resolvedParentName,
        ...(parentEntityId ? { targetEntityId: parentEntityId } : {}),
      });
      continue;
    }
    const name = disposition.projectName ?? defaultProjectName(group);
    const product = container.companyEntityId === null ? matchingStandingProduct(group, products) : null;
    setOrMergeVerdictProject(
      verdictProjects,
      projectForGroup(group, name, null, evidenceTitleFamiliesForGroup(container, group), product?.entityId),
    );
    storedGroups.push(group);
    groupDispositions.push({ groupKey: group.key, names: group.names, action: "new", projectName: name });
  }

  const verdict: ClusterVerdict = {
    counterpartyKind: container.companyEntityId === null ? "other" : "client",
    clientStage: container.companyEntityId === null ? null : "active",
    engagement: null,
    projects: [...verdictProjects.values()],
    existingEntities,
    trackerFit: projects.length > 0 ? "containers_hold_clusters" : "no_containers",
    notes: [`Weekly mint pass for ${container.companyName}.`],
  };
  readClusterVerdict(verdict, { strict: true });
  return { verdict, storedGroups, aliasGroups, skippedGroups, groupDispositions };
}

function renderWeeklyDossier(container: WeeklyMintContainer, groups: CandidateGroup[]): string {
  const lines = [
    `# Weekly project mint candidates: ${container.companyName}`,
    "",
    `Company entity: ${container.companyEntityId ?? "internal"}`,
    `Files considered: ${container.fileIds.length}`,
    "",
    "## Crossing groups",
  ];
  for (const group of groups) {
    lines.push(
      `- ${group.key}: ${group.names.join(", ")}; tokens=${group.tokens.join(", ")}; scanDays=${group.scan?.distinctDays ?? 0}; scanFiles=${(group.scan?.files ?? []).join(", ")}`,
    );
  }
  return lines.join("\n");
}

export function createWeeklyMintService(deps: WeeklyMintDeps): WeeklyMintService {
  const intervalMs = deps.intervalMs ?? WEEKLY_MINT_INTERVAL_MS;
  const batchSize = deps.batchSize ?? 100;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<WeeklyMintResult> | null = null;
  let ownedRunId: string | null = null;
  let ownedLeaseToken: string | null = null;

  async function runOnce(clock = deps.now?.() ?? new Date()): Promise<WeeklyMintResult> {
    if (inflight) return inflight;
    inflight = runSweep(clock).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /**
   * Admin "Run now": forces THIS week's run under the same weekly key instead
   * of minting a parallel run identity. A completed row is reset and re-run;
   * a not-yet-run week simply runs early (the scheduled sweep then
   * short-circuits on COMPLETED). The latch is claimed synchronously so a
   * concurrent scheduled sweep can never interleave with the reset.
   */
  function tryRunManual(clock = deps.now?.() ?? new Date()): ManualRunOutcome {
    if (inflight) return { started: false, reason: "in_flight" };
    inflight = (async () => {
      const week = clockWeek(clock);
      const current = await ensureRun(deps.db, week);
      if (current.status === COMPLETED) {
        /**
         * A rerun reuses the same run id, so the previous attempt's events and
         * traces must go — otherwise the feed mixes stale rows and the trace
         * seq unique index rejects the new steps.
         */
        await deps.db.deleteFrom("weekly_mint_traces").where("run_id", "=", current.id).execute();
        await deps.db.deleteFrom("weekly_mint_run_events").where("run_id", "=", current.id).execute();
        await deps.db
          .updateTable("weekly_mint_runs")
          .set({
            status: QUEUED,
            stage: COMPANIES_STAGE,
            company_cursor: null,
            lease_token: null,
            heartbeat_at: null,
            completed_at: null,
            error: null,
            candidates_grouped: 0,
            verdicts_requested: 0,
            verdicts_stored: 0,
            aged_out: 0,
            updated_at: timestamp(deps.now),
          })
          .where("id", "=", current.id)
          .where("status", "=", COMPLETED)
          .execute();
      }
      return runSweep(clock, { skipCompaniesWithPendingVerdicts: true });
    })().finally(() => {
      inflight = null;
    });
    return { started: true, completion: inflight };
  }

  async function runSweep(
    clock: Date,
    opts?: { skipCompaniesWithPendingVerdicts?: boolean },
  ): Promise<WeeklyMintResult> {
    const week = clockWeek(clock);
    const current = await ensureRun(deps.db, week);
    if (current.status === COMPLETED) return resultFromRun(current);
    const cutoff = new Date(Date.now() - LEASE_DURATION_MS).toISOString();
    if (
      current.status === RUNNING &&
      ownedRunId !== current.id &&
      current.heartbeat_at !== null &&
      current.heartbeat_at >= cutoff
    ) {
      return resultFromRun(current);
    }
    const now = timestamp(deps.now);
    const leaseToken = ownedRunId === current.id ? ownedLeaseToken : randomUUID();
    const run =
      ownedRunId === current.id
        ? current
        : await deps.db
            .updateTable("weekly_mint_runs")
            .set({
              lease_token: leaseToken,
              status: RUNNING,
              heartbeat_at: now,
              completed_at: null,
              error: null,
              updated_at: now,
            })
            .where("id", "=", current.id)
            .where((eb) =>
              eb.or([eb("status", "!=", RUNNING), eb("heartbeat_at", "is", null), eb("heartbeat_at", "<", cutoff)]),
            )
            .returningAll()
            .executeTakeFirst();
    if (!run) return resultFromRun(current);
    if (!leaseToken) throw new Error("weekly mint lease token missing");
    const ownedRun = run;
    ownedRunId = ownedRun.id;
    ownedLeaseToken = leaseToken;

    async function updateOwnedRun(values: Record<string, unknown>): Promise<RunRow> {
      const updated = await deps.db
        .updateTable("weekly_mint_runs")
        .set(values)
        .where("id", "=", ownedRun.id)
        .where("lease_token", "=", leaseToken)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new Error("weekly mint lease lost");
      return updated;
    }

    /**
     * Observability writes must never fail the pass — a broken insert loses
     * one feed row, not a week of minting (same posture as the per-company
     * verdict try/catch).
     */
    async function writeRunEvent(
      container: { key: string; companyEntityId: string | null; companyName: string },
      kind: string,
      detail?: Record<string, unknown>,
    ): Promise<void> {
      try {
        await deps.db
          .insertInto("weekly_mint_run_events")
          .values({
            id: randomUUID(),
            run_id: ownedRun.id,
            container_key: container.key,
            company_entity_id: container.companyEntityId,
            company_name: container.companyName,
            kind,
            detail: detail ? JSON.stringify(detail) : null,
            created_at: timestamp(deps.now),
          })
          .execute();
      } catch (error) {
        deps.logger.warn({ err: error, kind, containerKey: container.key }, "Weekly mint event write failed");
      }
    }

    async function writeTrace(containerKey: string, seq: number, kind: string, payload: unknown): Promise<void> {
      try {
        await deps.db
          .insertInto("weekly_mint_traces")
          .values({
            id: randomUUID(),
            run_id: ownedRun.id,
            container_key: containerKey,
            seq,
            kind,
            payload: JSON.stringify(payload),
            created_at: timestamp(deps.now),
          })
          .execute();
      } catch (error) {
        deps.logger.warn({ err: error, kind, containerKey }, "Weekly mint trace write failed");
      }
    }

    const counters = {
      candidatesGrouped: ownedRun.candidates_grouped,
      verdictsRequested: ownedRun.verdicts_requested,
      verdictsStored: ownedRun.verdicts_stored,
      agedOut: ownedRun.aged_out,
      vendorsSkipped: 0,
      skippedGroups: 0,
      companyMatchedSkips: 0,
      skippedCompanies: 0,
    };
    const dbCounters = () => ({
      candidates_grouped: counters.candidatesGrouped,
      verdicts_requested: counters.verdictsRequested,
      verdicts_stored: counters.verdictsStored,
      aged_out: counters.agedOut,
    });

    try {
      const containers = await buildWeeklyMintContainers(deps.db, clock);
      let companyCursor = ownedRun.company_cursor;
      const declaredById = new Map(
        (await createCompanyRelationshipDeclarationRepository(deps.db).list()).map((row) => [
          row.subject_entity_id,
          row,
        ]),
      );
      const standingProducts = await loadStandingProducts(deps.db);
      const companyGuards = await loadCompanyGuards(deps.db);
      for (const container of containers) {
        if (companyCursor && container.key <= companyCursor) continue;
        if (
          opts?.skipCompaniesWithPendingVerdicts &&
          (await hasPendingWeeklyVerdict(deps.db, container.companyEntityId))
        ) {
          counters.skippedCompanies += 1;
          deps.logger.info(
            {
              companyEntityId: container.companyEntityId,
              containerKey: container.key,
              companyName: container.companyName,
            },
            "Weekly mint manual run skipped company with unresolved pending verdict",
          );
          await writeRunEvent(container, "pending_dossier_skip");
          companyCursor = container.key;
          await updateOwnedRun({
            stage: COMPANIES_STAGE,
            company_cursor: companyCursor,
            heartbeat_at: timestamp(deps.now),
            ...dbCounters(),
            updated_at: timestamp(deps.now),
          });
          continue;
        }
        const declaration = container.cluster
          ? resolveDeclaration(
              container.cluster.groupMembers
                .map((member) => declaredById.get(member.entityId))
                .filter((row) => row != null),
            )
          : null;
        const batchNow = timestamp(deps.now);
        const claimed = await claimCandidatesForCompany(deps.db, container, container.key, clock, batchNow);
        counters.candidatesGrouped += claimed;
        await writeRunEvent(container, "claimed", { claimed });
        if (deps.mode === "live") {
          const agedOutNow = await ageOutStaleCandidates(deps.db, container.key, clock, batchNow);
          counters.agedOut += agedOutNow;
          if (agedOutNow > 0) await writeRunEvent(container, "aged_out", { agedOut: agedOutNow });
        }
        if (declaration?.counterparty_kind === "vendor") {
          counters.vendorsSkipped += 1;
          deps.logger.info(
            {
              companyEntityId: container.companyEntityId,
              containerKey: container.key,
              companyName: container.companyName,
              vendorsSkipped: counters.vendorsSkipped,
            },
            "Weekly mint skipped vendor-declared container",
          );
          await writeRunEvent(container, "vendor_skip");
          companyCursor = container.key;
          await updateOwnedRun({
            stage: COMPANIES_STAGE,
            company_cursor: companyCursor,
            heartbeat_at: timestamp(deps.now),
            ...dbCounters(),
            updated_at: timestamp(deps.now),
          });
          await deps.afterCompanyBatch?.(container.key);
          if (batchSize <= 1) await new Promise((resolve) => setTimeout(resolve, 0));
          continue;
        }
        const candidates = await readClaimedCandidates(deps.db, container.key, container, clock);
        const existingProjects = await loadExistingProjects(deps.db, container.fileIds, container.companyEntityId);
        const { aliases: exactAliases, rest } = splitAliasCandidates(candidates, existingProjects);
        if (deps.mode === "live" && exactAliases.length > 0) {
          const { linked, stamped } = await autoLinkAliasCandidates(deps.db, deps.logger, exactAliases, batchNow);
          await writeRunEvent(container, "alias_linked", { linked, stamped });
        }
        const groups = groupClaimedCandidates(rest, container.companyName).filter((group) => group.tokens.length > 0);
        const scanResults = await scanTokenRecurrence(deps.db, {
          candidates: groups.map((group) => ({ key: group.key, tokens: group.tokens })),
          fileIds: container.fileIds,
        });
        for (const group of groups) group.scan = scanResults.get(group.key) ?? null;
        await updateScanState(deps.db, container.key, groups, batchNow);
        const nonCrossing = groups.filter((group) => (group.scan?.distinctDays ?? 0) < RECURRENCE_FLOOR_DAYS);
        await incrementDryStreak(deps.db, container.key, nonCrossing, batchNow);
        if (nonCrossing.length > 0) {
          await writeRunEvent(container, "floor_skip", { groups: nonCrossing.length });
        }
        const recurrenceCrossing = groups.filter((group) => (group.scan?.distinctDays ?? 0) >= RECURRENCE_FLOOR_DAYS);
        const crossing = container.companyEntityId === null ? [] : recurrenceCrossing;
        if (container.companyEntityId === null) {
          for (const group of recurrenceCrossing) {
            const guardCompany =
              matchingStandingProduct(group, standingProducts) === null ? matchingCompany(group, companyGuards) : null;
            if (guardCompany) {
              counters.companyMatchedSkips += 1;
              deps.logger.info(
                {
                  groupKey: group.key,
                  companyEntityId: guardCompany.entityId,
                  companyName: guardCompany.name,
                  companyMatchedSkips: counters.companyMatchedSkips,
                },
                "Weekly mint skipped internal group matching a company entity",
              );
              await writeRunEvent(container, "company_guard_skip", {
                groupKey: group.key,
                companyName: guardCompany.name,
              });
              await incrementDryStreak(deps.db, container.key, [group], batchNow);
              continue;
            }
            if (await groupHasInternalStructuralCoSignal(deps.db, group)) crossing.push(group);
            else await incrementDryStreak(deps.db, container.key, [group], batchNow);
          }
        }
        for (const group of crossing) group.deterministic = chooseDeterministicDisposition(group, existingProjects);
        const covered = await coveredByPendingWeeklyVerdict(deps.db, container.companyEntityId);
        const pendingCrossing = crossing.filter((group) => !group.reviewIds.every((reviewId) => covered.has(reviewId)));
        if (pendingCrossing.length > 0) {
          counters.verdictsRequested += 1;
          if (deps.mode === "shadow") {
            deps.logger.info(
              {
                companyEntityId: container.companyEntityId,
                containerKey: container.key,
                groups: pendingCrossing.length,
              },
              "Weekly mint would request verdict",
            );
          } else {
            if (!deps.generator || !deps.model) throw new Error("weekly mint live mode requires a generator and model");
            const prompt = await buildWeeklyPrompt(
              deps.db,
              container,
              pendingCrossing,
              existingProjects,
              standingProducts,
            );
            await writeTrace(container.key, 1, "prompt", {
              prompt,
              model: deps.model,
              maxTokens: 12_000,
              reasoningEffort: "medium",
              promptVersion: WEEKLY_MINT_PROMPT_VERSION,
            });
            let generateMeta: GenerateMeta | null = null;
            let responseTraceWritten = false;
            /**
             * One company's bad model response must not fail the whole pass:
             * the candidates stay pooled and get another shot next week, while
             * every other company still stores its verdict this week.
             */
            try {
              const raw = await deps.generator.generateJSON<unknown>(prompt, {
                maxTokens: 12_000,
                label: `weeklyMint:${container.companyName.replace(/\s+/g, "-")}`,
                model: deps.model,
                reasoningEffort: "medium",
                thinkingBudget: null,
                onMeta: (meta) => {
                  generateMeta = meta;
                },
              });
              await writeTrace(container.key, 2, "response", generateMeta ?? { outcome: "ok", rawText: "" });
              responseTraceWritten = true;
              const dispositions = readModelDispositions(raw, pendingCrossing);
              const { verdict, storedGroups, aliasGroups, skippedGroups, groupDispositions } = buildStoredVerdict(
                container,
                pendingCrossing,
                dispositions,
                existingProjects,
                standingProducts,
              );
              await writeRunEvent(container, "judged", {
                groups: pendingCrossing.length,
                stored: storedGroups.length,
                aliases: aliasGroups.length,
                skipped: skippedGroups,
              });
              counters.skippedGroups += skippedGroups;
              if (skippedGroups > 0) {
                deps.logger.info(
                  {
                    containerKey: container.key,
                    companyName: container.companyName,
                    skippedGroups,
                    skippedGroupsTotal: counters.skippedGroups,
                  },
                  "Weekly mint skipped model-disposed groups",
                );
              }
              if (aliasGroups.length > 0) {
                await markAliasCandidates(
                  deps.db,
                  aliasGroups.map(({ group, targetEntityId }) => ({ reviewIds: group.reviewIds, targetEntityId })),
                  batchNow,
                );
                await writeRunEvent(container, "alias_marked", { count: aliasGroups.length, phase: "verdict" });
              }
              let verdictId: string | null = null;
              if (verdict.projects.length > 0) {
                const stored = await createProjectMintingVerdictRepository(deps.db).storePending({
                  companyEntityId: container.companyEntityId,
                  companyName: container.companyName,
                  fileCount: container.fileIds.length,
                  dossier: renderWeeklyDossier(container, storedGroups),
                  verdict: JSON.stringify(verdict),
                  model: deps.model,
                  promptVersion: WEEKLY_MINT_PROMPT_VERSION,
                  counterpartyKind: verdict.counterpartyKind,
                  clientStage: verdict.clientStage,
                  declaredCounterpartyKind: declaration?.counterparty_kind ?? null,
                  declaredClientStage: declaration?.client_stage ?? null,
                });
                verdictId = stored.id;
                counters.verdictsStored += 1;
                deps.logger.info(
                  {
                    containerKey: container.key,
                    companyName: container.companyName,
                    projects: verdict.projects.length,
                    skippedGroups: counters.skippedGroups,
                  },
                  "Weekly mint stored verdict",
                );
                await writeRunEvent(container, "verdict_stored", { verdictId, projects: verdict.projects.length });
                await resetDryStreak(deps.db, container.key, storedGroups, batchNow);
              }
              await writeTrace(container.key, 3, "disposition", { groups: groupDispositions, verdictId });
            } catch (error) {
              if (error instanceof WeeklyMintProcessCrash) throw error;
              if (!responseTraceWritten) {
                await writeTrace(
                  container.key,
                  2,
                  "response",
                  generateMeta ?? { outcome: "error", error: error instanceof Error ? error.message : String(error) },
                );
              }
              await writeRunEvent(container, "model_error", {
                error: error instanceof Error ? error.message : String(error),
              });
              deps.logger.warn(
                { err: error, containerKey: container.key, companyName: container.companyName },
                "Weekly mint verdict failed for container; candidates stay pooled",
              );
            }
          }
        }
        companyCursor = container.key;
        await updateOwnedRun({
          stage: COMPANIES_STAGE,
          company_cursor: companyCursor,
          heartbeat_at: timestamp(deps.now),
          ...dbCounters(),
          updated_at: timestamp(deps.now),
        });
        await deps.afterCompanyBatch?.(container.key);
        if (batchSize <= 1) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const completed = await updateOwnedRun({
        status: COMPLETED,
        stage: COMPLETED_STAGE,
        heartbeat_at: timestamp(deps.now),
        completed_at: timestamp(deps.now),
        ...dbCounters(),
        updated_at: timestamp(deps.now),
      });
      ownedRunId = null;
      ownedLeaseToken = null;
      return {
        ...resultFromRun(completed),
        skippedGroups: counters.skippedGroups,
        skippedCompanies: counters.skippedCompanies,
      };
    } catch (error) {
      ownedRunId = null;
      ownedLeaseToken = null;
      if (error instanceof WeeklyMintProcessCrash) throw error;
      await deps.db
        .updateTable("weekly_mint_runs")
        .set({
          status: FAILED,
          error: error instanceof Error ? error.message : "weekly mint failed",
          heartbeat_at: null,
          updated_at: timestamp(deps.now),
        })
        .where("id", "=", ownedRun.id)
        .where("lease_token", "=", leaseToken)
        .execute();
      throw error;
    }
  }

  return {
    runOnce,
    tryRunManual,
    start() {
      if (timer) return;
      void runOnce().catch((error) => deps.logger.error({ err: error }, "Weekly mint pass failed"));
      timer = setInterval(
        () => void runOnce().catch((error) => deps.logger.error({ err: error }, "Weekly mint pass failed")),
        intervalMs,
      );
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
  };
}

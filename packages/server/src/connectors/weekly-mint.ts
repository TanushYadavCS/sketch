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
import type { GeminiGenerator } from "./gemini-generate";
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
 * Weekly minting only claims content-extraction project pool rows. The list is
 * intentionally positive and narrow so structural connector seeds,
 * user_entity_link reviews, and any future review source stay invisible until
 * deliberately admitted here. `llm_relation` was historically excluded for its
 * leak record, but the weekly pass carries the machinery that era lacked — the
 * recurrence floor, dedup against accepted projects, and a human accept gate —
 * and excluding it dropped real candidates (Traveller Segmentation Dashboard
 * only ever arrived through it).
 */
export const WEEKLY_MINT_REVIEW_SOURCE_ALLOWLIST = [
  "llm_extraction",
  "llm_relation",
  "candidate_promotion",
  "entity_candidate_promotion",
] as const;

type WeeklyMintMode = "shadow" | "live";

export interface WeeklyMintResult {
  status: string;
  stage: string;
  clockWeek: string;
  candidatesGrouped: number;
  verdictsRequested: number;
  verdictsStored: number;
  agedOut: number;
}

export interface WeeklyMintService {
  runOnce(clock?: Date): Promise<WeeklyMintResult>;
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
  action: "new" | "alias_of" | "child_of";
  projectName: string | null;
  targetEntityId: string | null;
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

async function loadExistingProjects(db: Kysely<DB>, clusterFileIds: string[]): Promise<ExistingProject[]> {
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "aliases"])
    .where("source_type", "=", "project")
    .where(whereLiveEntity())
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
): { aliases: Array<{ reviewIds: string[]; targetEntityId: string }>; rest: ClaimedCandidate[] } {
  const projectByKey = new Map<string, string>();
  for (const project of projects) {
    for (const name of [project.name, ...project.aliases]) {
      const key = normalizeName(name);
      if (!projectByKey.has(key)) projectByKey.set(key, project.entityId);
    }
  }
  const aliases: Array<{ reviewIds: string[]; targetEntityId: string }> = [];
  const rest: ClaimedCandidate[] = [];
  for (const candidate of candidates) {
    const targetEntityId = projectByKey.get(normalizeName(candidate.proposedName));
    if (targetEntityId) aliases.push({ reviewIds: [candidate.reviewId], targetEntityId });
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
  return new Set(verdict.projects.flatMap((project) => project.evidenceFragments));
}

function buildWeeklyPrompt(
  container: WeeklyMintContainer,
  groups: CandidateGroup[],
  projects: ExistingProject[],
  products: StandingProduct[],
): string {
  const groupLines = groups
    .map((group) => {
      const deterministic =
        group.deterministic.action === "new"
          ? "new"
          : `${group.deterministic.action}:${group.deterministic.entityId}:${group.deterministic.entityName}`;
      return [
        `- groupKey: ${group.key}`,
        `  names: ${group.names.join(", ")}`,
        `  tokens: ${group.tokens.join(", ")}`,
        `  scanDays: ${group.scan?.distinctDays ?? 0}`,
        `  scanFiles: ${(group.scan?.files ?? []).join(", ")}`,
        `  deterministicProposal: ${deterministic}`,
      ].join("\n");
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

For every group, return exactly one action: new, alias_of, or child_of. Prefer the deterministicProposal unless the evidence clearly says otherwise. Use targetEntityId for alias_of and child_of. Use projectName for new and child_of.

Groups that are the same real-world project under different spellings, transliterations, or names (for example "Inaj" and "INJAZ", a codename and its formal name, a repo and the project it implements) must return the SAME projectName — that is how they merge into one project. Only merge when you are confident they are one piece of work; when unsure, keep them separate.

Return only JSON:
{
  "groups": [
    { "groupKey": "exact groupKey", "action": "new | alias_of | child_of", "projectName": "project name or null", "targetEntityId": "existing project entity id or null" }
  ]
}

Existing accepted projects:
${projectLines || "none"}

Standing products:
${productLines || "none"}

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
    if (action !== "new" && action !== "alias_of" && action !== "child_of") continue;
    dispositions.set(groupKey, {
      groupKey,
      action,
      projectName:
        typeof rawItem.projectName === "string" && rawItem.projectName.trim() ? rawItem.projectName.trim() : null,
      targetEntityId:
        typeof rawItem.targetEntityId === "string" && rawItem.targetEntityId.trim()
          ? rawItem.targetEntityId.trim()
          : null,
    });
  }
  for (const group of groups) {
    if (dispositions.has(group.key)) continue;
    dispositions.set(group.key, {
      groupKey: group.key,
      action: group.deterministic.action,
      projectName: null,
      targetEntityId: group.deterministic.action === "new" ? null : group.deterministic.entityId,
    });
  }
  return dispositions;
}

function defaultProjectName(group: CandidateGroup): string {
  return group.names[0] ?? group.tokens.join(" ");
}

function projectForGroup(
  group: CandidateGroup,
  name: string,
  parentName: string | null,
  parentEntityId?: string,
): VerdictProject {
  return {
    name,
    status: "active",
    confidence: "medium",
    parentName,
    ...(parentEntityId ? { parentEntityId } : {}),
    evidenceTitleFamilies: group.names,
    evidenceRepos: [],
    evidenceFragments: group.reviewIds,
    evidencePeople: [],
    reasoning: `Weekly recurrence crossed ${group.scan?.distinctDays ?? 0} distinct days.`,
  };
}

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
} {
  const projectsById = new Map(projects.map((project) => [project.entityId, project]));
  const verdictProjects = new Map<string, VerdictProject>();
  const existingEntities: ClusterVerdict["existingEntities"] = [];
  const storedGroups: CandidateGroup[] = [];
  const aliasGroups: Array<{ group: CandidateGroup; targetEntityId: string }> = [];

  for (const group of groups) {
    const disposition = dispositions.get(group.key);
    if (!disposition) continue;
    if (disposition.action === "alias_of") {
      const targetEntityId =
        disposition.targetEntityId ?? (group.deterministic.action === "alias_of" ? group.deterministic.entityId : null);
      if (targetEntityId) aliasGroups.push({ group, targetEntityId });
      continue;
    }
    if (disposition.action === "child_of") {
      const parentEntityId =
        disposition.targetEntityId ?? (group.deterministic.action === "child_of" ? group.deterministic.entityId : null);
      const parent = parentEntityId ? projectsById.get(parentEntityId) : null;
      const parentName =
        parent?.name ?? (group.deterministic.action === "child_of" ? group.deterministic.entityName : null);
      if (!parentName) continue;
      const childName = disposition.projectName ?? defaultProjectName(group);
      if (childName.toLowerCase() === parentName.toLowerCase()) {
        if (parentEntityId) aliasGroups.push({ group, targetEntityId: parentEntityId });
        continue;
      }
      if (!verdictProjects.has(parentName.toLowerCase())) {
        verdictProjects.set(parentName.toLowerCase(), {
          name: parentName,
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
      verdictProjects.set(childName.toLowerCase(), projectForGroup(group, childName, parentName));
      storedGroups.push(group);
      continue;
    }
    const name = disposition.projectName ?? defaultProjectName(group);
    const product = container.companyEntityId === null ? matchingStandingProduct(group, products) : null;
    verdictProjects.set(name.toLowerCase(), projectForGroup(group, name, null, product?.entityId));
    storedGroups.push(group);
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
  return { verdict, storedGroups, aliasGroups };
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

  async function runSweep(clock: Date): Promise<WeeklyMintResult> {
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

    const counters = {
      candidatesGrouped: ownedRun.candidates_grouped,
      verdictsRequested: ownedRun.verdicts_requested,
      verdictsStored: ownedRun.verdicts_stored,
      agedOut: ownedRun.aged_out,
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
      for (const container of containers) {
        if (companyCursor && container.key <= companyCursor) continue;
        const batchNow = timestamp(deps.now);
        const claimed = await claimCandidatesForCompany(deps.db, container, container.key, clock, batchNow);
        counters.candidatesGrouped += claimed;
        if (deps.mode === "live") {
          counters.agedOut += await ageOutStaleCandidates(deps.db, container.key, clock, batchNow);
        }
        const candidates = await readClaimedCandidates(deps.db, container.key, container, clock);
        const existingProjects = await loadExistingProjects(deps.db, container.fileIds);
        const { aliases: exactAliases, rest } = splitAliasCandidates(candidates, existingProjects);
        if (deps.mode === "live" && exactAliases.length > 0) {
          await markAliasCandidates(deps.db, exactAliases, batchNow);
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
        const recurrenceCrossing = groups.filter((group) => (group.scan?.distinctDays ?? 0) >= RECURRENCE_FLOOR_DAYS);
        const crossing = container.companyEntityId === null ? [] : recurrenceCrossing;
        if (container.companyEntityId === null) {
          for (const group of recurrenceCrossing) {
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
            /**
             * One company's bad model response must not fail the whole pass:
             * the candidates stay pooled and get another shot next week, while
             * every other company still stores its verdict this week.
             */
            try {
              const raw = await deps.generator.generateJSON<unknown>(
                buildWeeklyPrompt(container, pendingCrossing, existingProjects, standingProducts),
                {
                  maxTokens: 12_000,
                  label: `weeklyMint:${container.companyName.replace(/\s+/g, "-")}`,
                  model: deps.model,
                  reasoningEffort: "medium",
                  thinkingBudget: null,
                },
              );
              const dispositions = readModelDispositions(raw, pendingCrossing);
              const { verdict, storedGroups, aliasGroups } = buildStoredVerdict(
                container,
                pendingCrossing,
                dispositions,
                existingProjects,
                standingProducts,
              );
              if (aliasGroups.length > 0) {
                await markAliasCandidates(
                  deps.db,
                  aliasGroups.map(({ group, targetEntityId }) => ({ reviewIds: group.reviewIds, targetEntityId })),
                  batchNow,
                );
              }
              if (verdict.projects.length > 0) {
                const declaration = container.cluster
                  ? resolveDeclaration(
                      container.cluster.groupMembers
                        .map((member) => declaredById.get(member.entityId))
                        .filter((row) => row != null),
                    )
                  : null;
                await createProjectMintingVerdictRepository(deps.db).storePending({
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
                counters.verdictsStored += 1;
                deps.logger.info(
                  {
                    containerKey: container.key,
                    companyName: container.companyName,
                    projects: verdict.projects.length,
                  },
                  "Weekly mint stored verdict",
                );
                await resetDryStreak(deps.db, container.key, storedGroups, batchNow);
              }
            } catch (error) {
              if (error instanceof WeeklyMintProcessCrash) throw error;
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
      return resultFromRun(completed);
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

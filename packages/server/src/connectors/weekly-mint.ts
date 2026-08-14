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
  type ClientCluster,
  type ClusterVerdict,
  type VerdictProject,
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

/**
 * Weekly minting only claims content-extraction project pool rows. The list is
 * intentionally positive and narrow so structural connector seeds,
 * user_entity_link reviews, and any future review source stay invisible until
 * deliberately admitted here.
 */
export const WEEKLY_MINT_REVIEW_SOURCE_ALLOWLIST = [
  "llm_extraction",
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

async function claimCandidatesForCompany(
  db: Kysely<DB>,
  cluster: ClientCluster,
  companyKey: string,
  clock: Date,
  now: string,
): Promise<number> {
  const fileIds = cluster.files.filter((file) => isAtOrBeforeClock(file.date, clock)).map((file) => file.fileId);
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
  cluster: ClientCluster,
  clock: Date,
): Promise<ClaimedCandidate[]> {
  const fileIds = new Set(
    cluster.files.filter((file) => isAtOrBeforeClock(file.date, clock)).map((file) => file.fileId),
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

function groupClaimedCandidates(candidates: ClaimedCandidate[]): CandidateGroup[] {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] === index) return index;
    parent[index] = find(parent[index]);
    return parent[index];
  };
  const firstByToken = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const tokens = fragmentNameTokens(candidate.proposedName);
    for (const token of tokens) {
      const seen = firstByToken.get(token);
      if (seen === undefined) firstByToken.set(token, index);
      else parent[find(index)] = find(seen);
    }
  });
  const grouped = new Map<number, ClaimedCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const list = grouped.get(root);
    if (list) list.push(candidate);
    else grouped.set(root, [candidate]);
  });
  const groups: CandidateGroup[] = [];
  for (const members of grouped.values()) {
    const reviewIds = members.map((member) => member.reviewId).sort();
    const tokenCounts = new Map<string, number>();
    for (const member of members) {
      for (const token of new Set(fragmentNameTokens(member.proposedName))) {
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
    }
    const shared = [...tokenCounts.entries()].filter(([, count]) => count === members.length).map(([token]) => token);
    const fallback = fragmentNameTokens(members[0]?.proposedName ?? "");
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

function chooseDeterministicDisposition(group: CandidateGroup, projects: ExistingProject[]): DeterministicDisposition {
  const nameKeys = new Set(group.names.map((name) => normalizeName(name)));
  for (const project of projects) {
    const projectKeys = [project.name, ...project.aliases].map((name) => normalizeName(name));
    if (projectKeys.some((key) => nameKeys.has(key))) {
      return { action: "alias_of", entityId: project.entityId, entityName: project.name };
    }
  }
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

async function markAliasCandidates(
  db: Kysely<DB>,
  groups: Array<{ group: CandidateGroup; targetEntityId: string }>,
  now: string,
): Promise<void> {
  for (const { group, targetEntityId } of groups) {
    for (const reviewId of group.reviewIds) {
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

async function coveredByPendingWeeklyVerdict(db: Kysely<DB>, companyKey: string): Promise<Set<string>> {
  const row = await db
    .selectFrom("project_minting_verdicts")
    .select(["verdict", "prompt_version"])
    .where("company_entity_id", "=", companyKey)
    .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
    .where("status", "=", "pending")
    .where("superseded_at", "is", null)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!row) return new Set();
  const verdict = readClusterVerdict(JSON.parse(row.verdict), { strict: true });
  return new Set(verdict.projects.flatMap((project) => project.evidenceFragments));
}

function buildWeeklyPrompt(cluster: ClientCluster, groups: CandidateGroup[], projects: ExistingProject[]): string {
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
  return `You are reviewing weekly project minting candidates for ${cluster.companyName}.

For every group, return exactly one action: new, alias_of, or child_of. Prefer the deterministicProposal unless the evidence clearly says otherwise. Use targetEntityId for alias_of and child_of. Use projectName for new and child_of.

Return only JSON:
{
  "groups": [
    { "groupKey": "exact groupKey", "action": "new | alias_of | child_of", "projectName": "project name or null", "targetEntityId": "existing project entity id or null" }
  ]
}

Existing accepted projects:
${projectLines || "none"}

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

function projectForGroup(group: CandidateGroup, name: string, parentName: string | null): VerdictProject {
  return {
    name,
    status: "active",
    confidence: "medium",
    parentName,
    evidenceTitleFamilies: group.names,
    evidenceRepos: [],
    evidenceFragments: group.reviewIds,
    evidencePeople: [],
    reasoning: `Weekly recurrence crossed ${group.scan?.distinctDays ?? 0} distinct days.`,
  };
}

function buildStoredVerdict(
  cluster: ClientCluster,
  groups: CandidateGroup[],
  dispositions: Map<string, ModelDisposition>,
  projects: ExistingProject[],
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
      const name = disposition.projectName ?? defaultProjectName(group);
      verdictProjects.set(name.toLowerCase(), projectForGroup(group, name, parentName));
      storedGroups.push(group);
      continue;
    }
    const name = disposition.projectName ?? defaultProjectName(group);
    verdictProjects.set(name.toLowerCase(), projectForGroup(group, name, null));
    storedGroups.push(group);
  }

  const verdict: ClusterVerdict = {
    counterpartyKind: "client",
    clientStage: "active",
    engagement: null,
    projects: [...verdictProjects.values()],
    existingEntities,
    trackerFit: projects.length > 0 ? "containers_hold_clusters" : "no_containers",
    notes: [`Weekly mint pass for ${cluster.companyName}.`],
  };
  readClusterVerdict(verdict, { strict: true });
  return { verdict, storedGroups, aliasGroups };
}

function renderWeeklyDossier(cluster: ClientCluster, groups: CandidateGroup[]): string {
  const lines = [
    `# Weekly project mint candidates: ${cluster.companyName}`,
    "",
    `Company entity: ${cluster.companyEntityId}`,
    `Files considered: ${cluster.files.length}`,
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
      const clusters = (await clusterClientFiles(deps.db, { minFiles: 1 }))
        .map((cluster) => ({
          ...cluster,
          files: cluster.files.filter((file) => isAtOrBeforeClock(file.date, clock)),
        }))
        .filter((cluster) => cluster.files.length > 0)
        .sort((a, b) => a.companyEntityId.localeCompare(b.companyEntityId));
      let companyCursor = ownedRun.company_cursor;
      const declaredById = new Map(
        (await createCompanyRelationshipDeclarationRepository(deps.db).list()).map((row) => [
          row.subject_entity_id,
          row,
        ]),
      );
      for (const cluster of clusters) {
        if (companyCursor && cluster.companyEntityId <= companyCursor) continue;
        const batchNow = timestamp(deps.now);
        const claimed = await claimCandidatesForCompany(deps.db, cluster, cluster.companyEntityId, clock, batchNow);
        counters.candidatesGrouped += claimed;
        if (deps.mode === "live") {
          counters.agedOut += await ageOutStaleCandidates(deps.db, cluster.companyEntityId, clock, batchNow);
        }
        const candidates = await readClaimedCandidates(deps.db, cluster.companyEntityId, cluster, clock);
        const groups = groupClaimedCandidates(candidates).filter((group) => group.tokens.length > 0);
        const scanResults = await scanTokenRecurrence(deps.db, {
          candidates: groups.map((group) => ({ key: group.key, tokens: group.tokens })),
          fileIds: cluster.files.map((file) => file.fileId),
        });
        for (const group of groups) group.scan = scanResults.get(group.key) ?? null;
        await updateScanState(deps.db, cluster.companyEntityId, groups, batchNow);
        const nonCrossing = groups.filter((group) => (group.scan?.distinctDays ?? 0) < RECURRENCE_FLOOR_DAYS);
        await incrementDryStreak(deps.db, cluster.companyEntityId, nonCrossing, batchNow);
        const crossing = groups.filter((group) => (group.scan?.distinctDays ?? 0) >= RECURRENCE_FLOOR_DAYS);
        const existingProjects = await loadExistingProjects(
          deps.db,
          cluster.files.map((file) => file.fileId),
        );
        for (const group of crossing) group.deterministic = chooseDeterministicDisposition(group, existingProjects);
        const covered = await coveredByPendingWeeklyVerdict(deps.db, cluster.companyEntityId);
        const pendingCrossing = crossing.filter(
          (group) =>
            !group.reviewIds.every((reviewId) => covered.has(reviewId)) && group.deterministic.action !== "alias_of",
        );
        const deterministicAliases = crossing
          .filter((group) => group.deterministic.action === "alias_of")
          .map((group) => ({
            group,
            targetEntityId: group.deterministic.action === "alias_of" ? group.deterministic.entityId : "",
          }))
          .filter((item) => item.targetEntityId);
        if (deps.mode === "live") {
          await markAliasCandidates(deps.db, deterministicAliases, batchNow);
        }
        if (pendingCrossing.length > 0) {
          counters.verdictsRequested += 1;
          if (deps.mode === "shadow") {
            deps.logger.info(
              { companyEntityId: cluster.companyEntityId, groups: pendingCrossing.length },
              "Weekly mint would request verdict",
            );
          } else {
            if (!deps.generator || !deps.model) throw new Error("weekly mint live mode requires a generator and model");
            const raw = await deps.generator.generateJSON<unknown>(
              buildWeeklyPrompt(cluster, pendingCrossing, existingProjects),
              {
                maxTokens: 12_000,
                label: `weeklyMint:${cluster.companyName.replace(/\s+/g, "-")}`,
                model: deps.model,
                reasoningEffort: "medium",
                thinkingBudget: null,
              },
            );
            const dispositions = readModelDispositions(raw, pendingCrossing);
            const { verdict, storedGroups, aliasGroups } = buildStoredVerdict(
              cluster,
              pendingCrossing,
              dispositions,
              existingProjects,
            );
            if (aliasGroups.length > 0) await markAliasCandidates(deps.db, aliasGroups, batchNow);
            if (verdict.projects.length > 0) {
              const declaration = resolveDeclaration(
                cluster.groupMembers.map((member) => declaredById.get(member.entityId)).filter((row) => row != null),
              );
              await createProjectMintingVerdictRepository(deps.db).storePending({
                companyEntityId: cluster.companyEntityId,
                companyName: cluster.companyName,
                fileCount: cluster.files.length,
                dossier: renderWeeklyDossier(cluster, storedGroups),
                verdict: JSON.stringify(verdict),
                model: deps.model,
                promptVersion: WEEKLY_MINT_PROMPT_VERSION,
                counterpartyKind: verdict.counterpartyKind,
                clientStage: verdict.clientStage,
                declaredCounterpartyKind: declaration?.counterparty_kind ?? null,
                declaredClientStage: declaration?.client_stage ?? null,
              });
              counters.verdictsStored += 1;
              await resetDryStreak(deps.db, cluster.companyEntityId, storedGroups, batchNow);
            }
          }
        }
        companyCursor = cluster.companyEntityId;
        await updateOwnedRun({
          stage: COMPANIES_STAGE,
          company_cursor: companyCursor,
          heartbeat_at: timestamp(deps.now),
          ...dbCounters(),
          updated_at: timestamp(deps.now),
        });
        await deps.afterCompanyBatch?.(cluster.companyEntityId);
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

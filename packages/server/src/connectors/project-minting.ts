/**
 * Project minting — a periodic pass that reasons over a whole client
 * relationship at once, replacing per-file project invention by the
 * enrichment LLM (.planning/tasks/to-be-developed/PROJECT_MINTING.md).
 *
 * Stage 1 clusters files by outside-company relationship, stage 2 builds a
 * deterministic dossier per cluster (SQL plus regex, no LLM, no raw file
 * content reaches the model), stage 3 asks one reasoning-tier model call for
 * a verdict per cluster. This module writes nothing to the entity graph:
 * its only write is the verdict row (PR-P2), and only when asked to store.
 *
 * Membership requires evidence of a relationship, not a mention. The Zomato
 * cluster in the earlier validation inherited files that merely named the
 * brand and minted two projects belonging to other clients; entity_mentions
 * are therefore never a membership signal. A file joins a company's cluster
 * on participants with that company's corporate email domain, on a
 * participant being a person with a high-trust works_at edge to the company
 * (participant_affiliation — the domainless-company analogue), on living in a
 * chat channel dedicated to that company by name, or on carrying a title
 * family that already belongs to exactly one cluster (family accretion, one
 * iteration, no fixpoint).
 *
 * Clusters are keyed by company duplicate GROUP, not by company row: the
 * validation found the same real-world client split across shards ("Oliver
 * Wyman" 651 files, "OW" 130 files) producing two competing verdicts.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type ClientStage,
  type CompanyRelationshipDeclarationRow,
  type CounterpartyKind,
  createCompanyRelationshipDeclarationRepository,
  resolveDeclaration,
} from "../db/repositories/company-relationship-declarations";
import { normalizeContactPointValue, whereLiveEntity } from "../db/repositories/entities";
import { normalizeEmailDomain } from "../db/repositories/entity-domains";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import { createProjectMintingVerdictRepository } from "../db/repositories/project-minting-verdicts";
import { resolvePersonEntitiesForEmails } from "../db/repositories/user-entity-resolver";
import type { DB } from "../db/schema";
import { isRoleAccountEmail } from "../entities/affiliations";
import {
  buildCompanyDedupGroups,
  chooseCanonicalCompany,
  loadCompanyDedupMembers,
} from "../entities/company-dedup-groups";
import { isPersonalOrSharedDomain } from "../entities/personal-domains";
import { isEmailProviderName } from "../entities/validators";
import { yieldToEventLoop } from "../lib/event-loop";
import type { GeminiGenerator } from "./gemini-generate";
import { loadAffiliationIndex, loadWhatsAppSenderPersonsByFile } from "./participant-affiliation";
import { type TokenRecurrence, scanTokenRecurrence } from "./token-recurrence-scan";

export const PROJECT_MINTING_PROMPT_VERSION = "project-minting-verdict-v3";

/**
 * Verdict rows written before the one-noun schema carry these prompt
 * versions. They keep the engagement-based parse, accept path and API shape
 * forever; everything newer is the recursive-projects contract.
 */
const LEGACY_MINTING_PROMPT_VERSIONS: ReadonlySet<string> = new Set([
  "project-minting-verdict-v1",
  "project-minting-verdict-v2",
]);

export function isV2MintingVerdict(promptVersion: string | null): boolean {
  if (!promptVersion) return false;
  return !LEGACY_MINTING_PROMPT_VERSIONS.has(promptVersion);
}

const YIELD_EVERY = 500;
const CONTENT_CHUNK = 25;
const PEOPLE_CAP = 25;
const FAMILY_CAP = 40;
const REPO_CAP = 30;
const LINK_CAP = 15;
const EVENT_CAP = 220;
const VERDICT_MAX_TOKENS = 40_000;

export type MembershipSignal =
  | "participant_domain"
  | "participant_affiliation"
  | "dedicated_channel"
  | "family_accretion";

export interface ClusterFile {
  fileId: string;
  fileName: string;
  source: string;
  date: string | null;
  via: MembershipSignal[];
}

export interface ClusterChannel {
  platform: string;
  name: string;
  fileCount: number;
}

export interface ClusterGroupMember {
  entityId: string;
  name: string;
}

export interface ClientCluster {
  /** Canonical entity id of the company duplicate group. */
  companyEntityId: string;
  companyName: string;
  /** Every company shard in the duplicate group, canonical first. */
  groupMembers: ClusterGroupMember[];
  files: ClusterFile[];
  channels: ClusterChannel[];
  triggered: boolean;
}

export interface TitleFamily {
  key: string;
  display: string;
  count: number;
  distinctDays: number;
  activeWeeks: number;
  firstDate: string | null;
  lastDate: string | null;
  sources: string[];
}

export interface DossierPerson {
  name: string;
  email: string | null;
  filesInCluster: number;
  filesAnywhere: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface DossierArtifact {
  ref: string;
  kind: "github_repo" | "link";
  fileCount: number;
}

export interface DossierFragment {
  entityId: string;
  name: string;
  status: string;
  createdAt: string;
  clusterFileCount: number;
  totalFileCount: number;
  parentedTaskCount: number;
}

export interface CandidateWorkstreamMember {
  entityId: string;
  name: string;
  clusterFileCount: number;
}

export interface CandidateWorkstream {
  tokens: string[];
  members: CandidateWorkstreamMember[];
  clusterFileCount: number;
  singletonTitleCount: number;
  /** >=2 fragments, or >=3 files counting singleton-title support. */
  meetsStructuralFloor: boolean;
  /** Content recurrence for this group's tokens; null until scanned. */
  scan: TokenRecurrence | null;
  /** Set when the candidate came from a recurring meeting title with no stored fragment (e.g. Benchmarks). */
  titleFamily?: string;
}

export interface DossierEvent {
  date: string;
  source: string;
  title: string;
}

export type NominationSignal = "dedicated_channel" | "support_channel" | "onboarding_family" | "invoice_family";

export interface ClusterDossier {
  companyEntityId: string;
  companyName: string;
  groupMembers: ClusterGroupMember[];
  declaredRelationship: CompanyRelationshipDeclarationRow | null;
  nominationSignals: NominationSignal[];
  fileCount: number;
  firstDate: string | null;
  lastDate: string | null;
  sourceCounts: Record<string, number>;
  people: DossierPerson[];
  titleFamilies: TitleFamily[];
  artifacts: DossierArtifact[];
  channels: ClusterChannel[];
  fragments: DossierFragment[];
  ownedElsewhere: DossierFragment[];
  candidateWorkstreams: CandidateWorkstream[];
  events: DossierEvent[];
  markdown: string;
}

const TITLE_PREFIX_PATTERNS = [
  /^(re|fw|fwd)\s*:\s*/i,
  /^(invitation|updated invitation|accepted|declined|cancell?ed(?: event)?)\s*:\s*/i,
  /^meet\s*[–—-]\s+/i,
];

const TITLE_SUFFIX_PATTERNS = [
  /\s*[–—-]\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?(?:\s+to\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z?)?\s*$/,
  /\s*[–—|-]\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*$/,
  /\s*[–—|-]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s*$/i,
  /\s*[–—-]\s*\d{1,3}\s*$/,
];

/**
 * Collapses a file name to its recurring family form: reply/forward and
 * calendar-invite prefixes and trailing date or counter suffixes are noise
 * that splits one meeting series or digest into dozens of singleton titles.
 */
export function normalizeTitleFamily(raw: string): { key: string; display: string } {
  let title = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TITLE_PREFIX_PATTERNS) {
      const next = title.replace(pattern, "");
      if (next !== title) {
        title = next.trim();
        changed = true;
      }
    }
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TITLE_SUFFIX_PATTERNS) {
      const next = title.replace(pattern, "");
      if (next !== title && next.trim().length > 0) {
        title = next.trim();
        changed = true;
      }
    }
  }
  const display = title.replace(/\s+/g, " ").trim() || raw.trim();
  return { key: display.toLowerCase(), display };
}

function isoWeekLabel(dateStr: string): string {
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "unknown";
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function computeTitleFamilies(files: Array<{ fileName: string; source: string; date: string | null }>) {
  const families = new Map<
    string,
    { display: string; count: number; days: Set<string>; weeks: Set<string>; sources: Set<string>; dates: string[] }
  >();
  for (const file of files) {
    const { key, display } = normalizeTitleFamily(file.fileName);
    let family = families.get(key);
    if (!family) {
      family = { display, count: 0, days: new Set(), weeks: new Set(), sources: new Set(), dates: [] };
      families.set(key, family);
    }
    family.count += 1;
    family.sources.add(file.source);
    if (file.date) {
      const day = file.date.slice(0, 10);
      family.days.add(day);
      family.weeks.add(isoWeekLabel(day));
      family.dates.push(day);
    }
  }
  const result: TitleFamily[] = [];
  for (const [key, family] of families) {
    family.dates.sort();
    result.push({
      key,
      display: family.display,
      count: family.count,
      distinctDays: family.days.size,
      activeWeeks: family.weeks.size,
      firstDate: family.dates[0] ?? null,
      lastDate: family.dates[family.dates.length - 1] ?? null,
      sources: [...family.sources].sort(),
    });
  }
  result.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  return result;
}

/**
 * The pass trigger is recurrence, not volume: a title family that recurred on
 * a different calendar day. Same-day repeats are mostly email reply chains
 * (the 25th-percentile family gap is zero days), so the different-day
 * condition is what separates a series from a thread.
 */
export function clusterIsTriggered(families: TitleFamily[]): boolean {
  return families.some((family) => family.count >= 2 && family.distinctDays >= 2);
}

function tokenizeName(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * A channel is dedicated to a company when the company's complete name or a
 * complete alias appears as a contiguous token run in the channel name.
 * Complete-name matching only — a self-fragment like "design" inside a longer
 * company name must not claim a channel (the same rule the deterministic
 * entity matcher enforces).
 */
export function channelMatchesCompany(channelName: string, candidateNames: string[]): boolean {
  const channelTokens = tokenizeName(channelName);
  if (channelTokens.length === 0) return false;
  for (const candidate of candidateNames) {
    const tokens = tokenizeName(candidate);
    if (tokens.length === 0 || tokens.join("").length < 2) continue;
    for (let start = 0; start + tokens.length <= channelTokens.length; start++) {
      let matched = true;
      for (let i = 0; i < tokens.length; i++) {
        if (channelTokens[start + i] !== tokens[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}

const FRAGMENT_OWNERSHIP_FLOOR = 0.5;
const CANDIDATE_MIN_FRAGMENTS = 2;
const CANDIDATE_MIN_FILES = 3;
/**
 * Scan-days floor for candidacy. Measured on Redseer: every junk fragment
 * (bulk imports, one-off notes) scanned at exactly 1 distinct day; every
 * real workstream at 2+. Habuild's Langraph — real, user-visible — sits at
 * 2, which is why the floor is "recurred at all", not 3.
 */
export const SCAN_CANDIDACY_MIN_DAYS = 2;

/**
 * Tokens that name meeting cadence or back-office paperwork, not work
 * streams. Used only to keep title-family candidates honest — a recurring
 * "Weekly Standup" family recurs by definition and would otherwise top the
 * candidate ranking.
 */
export const CADENCE_TOKENS = new Set([
  "standup",
  "weekly",
  "daily",
  "monthly",
  "quarterly",
  "biweekly",
  "fortnightly",
  "review",
  "retro",
  "retrospective",
  "catchup",
  "checkin",
  "townhall",
  "huddle",
  "alignment",
  "discussion",
  "intro",
  "introduction",
  "kickoff",
  "demo",
  "walkthrough",
  "onboarding",
  "invoice",
  "invoices",
  "payment",
  "payments",
  "payroll",
  "sprint",
  "planning",
  "remaining",
  "items",
  "next",
  "steps",
  "agenda",
  "notes",
  "minutes",
  "recap",
  "summary",
  "slack",
  "support",
  "connect",
  "with",
  "from",
  "into",
  "about",
  "month",
]);
const FRAGMENT_STOP_TOKENS: ReadonlySet<string> = new Set([
  "project",
  "projects",
  "work",
  "team",
  "the",
  "and",
  "of",
  "for",
  "a",
  "an",
  "app",
  "platform",
  "system",
  "new",
  "update",
  "updates",
  "call",
  "meeting",
  "sync",
  "phase",
  "feature",
  "flow",
  "poc",
  "plan",
]);

export function fragmentNameTokens(name: string): string[] {
  return tokenizeName(name).filter((token) => token.length > 1 && !FRAGMENT_STOP_TOKENS.has(token));
}

/**
 * Deterministic name-token grouping of owned fragments — the "Nutrition
 * Analysis is 4 entities and nothing joins them" fix. Fragments sharing any
 * distinctive token union into one candidate; tokens carried by more than
 * half the fragment names are corpus-generic and never join. The candidacy
 * floor (>=2 fragments or >=3 cluster files) keeps one-file noise out;
 * singleton title families whose tokens echo a group count as support so a
 * stream whose meetings are all singletons still shows its real weight.
 */
export function groupFragmentCandidates(
  fragments: DossierFragment[],
  titleFamilies: TitleFamily[],
): CandidateWorkstream[] {
  if (fragments.length === 0) return [];
  const frequency = new Map<string, number>();
  for (const fragment of fragments) {
    for (const token of new Set(fragmentNameTokens(fragment.name))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const corpusStop = new Set(
    [...frequency.entries()].filter(([, count]) => count > fragments.length / 2).map(([token]) => token),
  );
  const distinctive = (name: string) => fragmentNameTokens(name).filter((token) => !corpusStop.has(token));

  const parent = fragments.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] === index) return index;
    parent[index] = find(parent[index]);
    return parent[index];
  };
  const firstByToken = new Map<string, number>();
  fragments.forEach((fragment, index) => {
    for (const token of distinctive(fragment.name)) {
      const seen = firstByToken.get(token);
      if (seen === undefined) firstByToken.set(token, index);
      else parent[find(index)] = find(seen);
    }
  });

  const groups = new Map<number, DossierFragment[]>();
  fragments.forEach((fragment, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(fragment);
    else groups.set(root, [fragment]);
  });

  const singletonFamilies = titleFamilies.filter((family) => family.count === 1);
  const result: CandidateWorkstream[] = [];
  for (const members of groups.values()) {
    const clusterFileCount = members.reduce((sum, member) => sum + member.clusterFileCount, 0);
    const tokenSets = members.map((member) => new Set(distinctive(member.name)));
    const shared = [...(tokenSets[0] ?? [])].filter((token) => tokenSets.every((set) => set.has(token)));
    const tokens = shared.length > 0 ? shared : [...(tokenSets[0] ?? [])];
    const singletonTitleCount =
      tokens.length > 0
        ? singletonFamilies.filter((family) => {
            const familyTokens = new Set(tokenizeName(family.key));
            return tokens.some((token) => familyTokens.has(token));
          }).length
        : 0;
    result.push({
      tokens,
      members: members.map((member) => ({
        entityId: member.entityId,
        name: member.name,
        clusterFileCount: member.clusterFileCount,
      })),
      clusterFileCount,
      singletonTitleCount,
      meetsStructuralFloor:
        members.length >= CANDIDATE_MIN_FRAGMENTS || clusterFileCount + singletonTitleCount >= CANDIDATE_MIN_FILES,
      scan: null,
    });
  }
  result.sort(
    (a, b) => b.clusterFileCount - a.clusterFileCount || (a.tokens[0] ?? "").localeCompare(b.tokens[0] ?? ""),
  );
  return result;
}

/**
 * Candidacy after the content scan: structural-floor groups stay, and a
 * below-floor group (usually a single fragment with one stored mention) gets
 * a second chance when its own name recurs in content on enough distinct
 * days — stored mentions undercount content 5-6x, so a stream like Langraph
 * (1 fragment, 1 mention, months of recurring discussion) only survives
 * here. Ranking is by scan distinct-days; mention counts never rank.
 */
/**
 * Every group gets scanned — including below-structural-floor singletons,
 * which is the entire point: their second chance rides on the scan. The
 * singleton fragment's own tokens are the candidate; groups whose distinctive
 * tokens all got corpus-stopped scan as nothing and keep scan = null.
 *
 * Recurring title families with no stored fragment also enter as candidates
 * (Benchmarks on Redseer: 0 fragments, 15+ scan days, user-confirmed real —
 * missed by every stored-graph signal). Their tokens are stripped of company
 * names and cadence words so "Weekly Standup" cannot top the ranking, and
 * families whose tokens overlap a fragment group fold into that group
 * instead of duplicating it.
 */
async function scanAndRankCandidates(
  db: Kysely<DB>,
  cluster: ClientCluster,
  groups: CandidateWorkstream[],
  titleFamilies: TitleFamily[],
  people: DossierPerson[],
): Promise<CandidateWorkstream[]> {
  const companyTokens = [
    ...new Set(
      [cluster.companyName, ...cluster.groupMembers.map((member) => member.name)].flatMap((name) => tokenizeName(name)),
    ),
  ];
  const personTokens = new Set(people.flatMap((person) => tokenizeName(person.name)));
  const isCompanyToken = (token: string) =>
    companyTokens.some(
      (companyToken) =>
        token === companyToken ||
        (token.length >= 4 && companyToken.startsWith(token)) ||
        (companyToken.length >= 4 && token.startsWith(companyToken)),
    );
  const groupTokens = new Set(groups.flatMap((group) => group.tokens));
  for (const family of titleFamilies) {
    if (family.count < 2) continue;
    const tokens = fragmentNameTokens(family.key).filter(
      (token) =>
        !isCompanyToken(token) && !personTokens.has(token) && !CADENCE_TOKENS.has(token) && !groupTokens.has(token),
    );
    if (tokens.length === 0) continue;
    for (const token of tokens) groupTokens.add(token);
    groups.push({
      tokens,
      members: [],
      clusterFileCount: family.count,
      singletonTitleCount: 0,
      meetsStructuralFloor: false,
      scan: null,
      titleFamily: family.display,
    });
  }

  const scannable = groups.filter((group) => group.tokens.length > 0);
  if (scannable.length > 0) {
    const results = await scanTokenRecurrence(db, {
      candidates: scannable.map((group, index) => ({ key: String(index), tokens: group.tokens })),
      fileIds: cluster.files.map((file) => file.fileId),
    });
    scannable.forEach((group, index) => {
      group.scan = results.get(String(index)) ?? null;
    });
  }
  return applyCandidacyFloor(groups);
}

export function applyCandidacyFloor(groups: CandidateWorkstream[]): CandidateWorkstream[] {
  return groups
    .filter((group) => group.meetsStructuralFloor || (group.scan?.distinctDays ?? 0) >= SCAN_CANDIDACY_MIN_DAYS)
    .sort(
      (a, b) =>
        (b.scan?.distinctDays ?? 0) - (a.scan?.distinctDays ?? 0) ||
        b.clusterFileCount - a.clusterFileCount ||
        (a.tokens[0] ?? "").localeCompare(b.tokens[0] ?? ""),
    );
}

export interface ClusterClientFilesOptions {
  minFiles?: number;
  logger?: Logger;
}

/**
 * Own-org and outside-company identity both travel at duplicate-group level:
 * a shard with no domain of its own is still our org (or still Oliver Wyman)
 * when it shares a group with the shard holding the domain. Groups come from
 * the deterministic dedup module — same-domain, same-compact-name and exact
 * name↔alias edges, union-find, no LLM.
 */
export async function clusterClientFiles(
  db: Kysely<DB>,
  options?: ClusterClientFilesOptions,
): Promise<ClientCluster[]> {
  const minFiles = options?.minFiles ?? 2;

  const orgDomainRows = await db.selectFrom("organization_domains").select("domain").execute();
  const orgDomains = new Set(orgDomainRows.map((row) => row.domain.toLowerCase()));

  const groups = buildCompanyDedupGroups(await loadCompanyDedupMembers(db));
  const canonicalByMember = new Map<string, string>();
  const clusterGroups = new Map<string, { canonicalName: string; members: ClusterGroupMember[]; names: string[] }>();
  for (const group of groups) {
    if (group.ownOrg) continue;
    const liveMembers = group.members.filter((member) => member.status !== "archived");
    if (liveMembers.length === 0) continue;
    const canonical = chooseCanonicalCompany({ ...group, members: liveMembers });
    if (isEmailProviderName(canonical.name)) continue;
    const orderedMembers = [canonical, ...liveMembers.filter((member) => member.entityId !== canonical.entityId)];
    const names: string[] = [];
    for (const member of orderedMembers) {
      canonicalByMember.set(member.entityId, canonical.entityId);
      if (!isEmailProviderName(member.name)) names.push(member.name, ...member.aliases);
    }
    clusterGroups.set(canonical.entityId, {
      canonicalName: canonical.name,
      members: orderedMembers.map((member) => ({ entityId: member.entityId, name: member.name })),
      names,
    });
  }

  const domainRows = await db.selectFrom("entity_domains").select(["domain", "kind", "entity_id"]).execute();
  const corporateByDomain = new Map<string, string>();
  const personalOrSharedDomains = new Set<string>();
  for (const row of domainRows) {
    const domain = row.domain.toLowerCase();
    if (row.kind === "corporate" && row.entity_id) corporateByDomain.set(domain, row.entity_id);
    if (row.kind === "personal" || row.kind === "shared") personalOrSharedDomains.add(domain);
  }

  const membership = new Map<string, Map<string, Set<MembershipSignal>>>();
  const addMember = (companyId: string, fileId: string, signal: MembershipSignal) => {
    let files = membership.get(companyId);
    if (!files) {
      files = new Map();
      membership.set(companyId, files);
    }
    let signals = files.get(fileId);
    if (!signals) {
      signals = new Set();
      files.set(fileId, signals);
    }
    signals.add(signal);
  };

  const participantRows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id as fileId", "subject_email as email"])
    .where("fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
    .where("deleted_at", "is", null)
    .where("subject_email", "is not", null)
    .execute();
  let processed = 0;
  for (const row of participantRows) {
    processed += 1;
    if (processed % YIELD_EVERY === 0) await yieldToEventLoop();
    if (!row.fileId) continue;
    const email = row.email?.trim();
    if (!email || isRoleAccountEmail(email)) continue;
    const domain = normalizeEmailDomain(email);
    if (!domain) continue;
    if (orgDomains.has(domain)) continue;
    if (isPersonalOrSharedDomain(domain) || personalOrSharedDomains.has(domain)) continue;
    const holder = corporateByDomain.get(domain);
    const canonicalId = holder ? canonicalByMember.get(holder) : undefined;
    if (!canonicalId) continue;
    addMember(canonicalId, row.fileId, "participant_domain");
  }

  /**
   * Fourth signal: a participant who is a person with a high-trust works_at
   * edge to an outside company attaches the file — the domainless-company
   * analogue of participant_domain. Own-org-affiliated people never generate
   * it, targets resolve through canonicalByMember (own-org groups are absent
   * there, so non-outside targets drop before addMember), and everything is
   * batched — no per-file resolver calls. See participant-affiliation.ts for
   * the trust gates.
   */
  const ownOrgCompanyIds = new Set(
    groups.filter((group) => group.ownOrg).flatMap((group) => group.members.map((member) => member.entityId)),
  );
  const affiliation = await loadAffiliationIndex(db, ownOrgCompanyIds);
  if (affiliation.companiesByPerson.size > 0) {
    const emailsByFile = new Map<string, Set<string>>();
    const emailsToResolve = new Set<string>();
    for (const row of participantRows) {
      if (!row.fileId) continue;
      const email = row.email?.trim();
      if (!email || isRoleAccountEmail(email)) continue;
      const domain = normalizeEmailDomain(email);
      if (domain && orgDomains.has(domain)) continue;
      const normalized = normalizeContactPointValue("email", email);
      let set = emailsByFile.get(row.fileId);
      if (!set) {
        set = new Set();
        emailsByFile.set(row.fileId, set);
      }
      set.add(normalized);
      emailsToResolve.add(normalized);
    }
    const personsByEmail = await resolvePersonEntitiesForEmails(db, [...emailsToResolve]);
    const personByEmail = new Map<string, string>();
    for (const [email, matches] of personsByEmail) {
      if (matches.length === 1) personByEmail.set(email, matches[0].id);
    }
    const unresolvedEmails = emailsToResolve.size - personByEmail.size;
    if (options?.logger && unresolvedEmails > 0) {
      options.logger.info(
        { unresolvedParticipantEmails: unresolvedEmails },
        "participant_affiliation: participant emails without a unique person entity",
      );
    }

    const personsByFile = await loadWhatsAppSenderPersonsByFile(db, options?.logger);
    for (const [fileId, emails] of emailsByFile) {
      for (const email of emails) {
        const personId = personByEmail.get(email);
        if (!personId) continue;
        let set = personsByFile.get(fileId);
        if (!set) {
          set = new Set();
          personsByFile.set(fileId, set);
        }
        set.add(personId);
      }
    }

    let affiliationProcessed = 0;
    for (const [fileId, personIds] of personsByFile) {
      affiliationProcessed += 1;
      if (affiliationProcessed % YIELD_EVERY === 0) await yieldToEventLoop();
      for (const personId of personIds) {
        if (affiliation.ownOrgAffiliatedPersonIds.has(personId)) continue;
        const companies = affiliation.companiesByPerson.get(personId);
        if (!companies) continue;
        for (const companyId of companies) {
          const canonicalId = canonicalByMember.get(companyId);
          if (!canonicalId) continue;
          addMember(canonicalId, fileId, "participant_affiliation");
        }
      }
    }
  }

  const conversationRows = await db
    .selectFrom("conversations")
    .leftJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .select([
      "conversations.id as id",
      "conversations.platform as platform",
      "conversations.display_name as displayName",
      "whatsapp_groups.name as groupName",
    ])
    .where("conversations.kind", "in", ["channel", "group"])
    .execute();
  const channelNames = new Map<number, { platform: string; name: string }>();
  for (const row of conversationRows) {
    const name = (row.groupName ?? row.displayName ?? "").trim();
    if (name) channelNames.set(row.id, { platform: row.platform, name });
  }

  /**
   * Archived files stay in scope: entire chat channels sit archived on this
   * corpus (all 107 slack #ow slices), and the pass reads history as evidence
   * of a relationship rather than as live content to act on.
   */
  const chatFileRows = await db
    .selectFrom("indexed_files")
    .select(["id", "source_path"])
    .where("source", "in", ["slack", "whatsapp"])
    .execute();
  const filesByConversation = new Map<number, string[]>();
  for (const row of chatFileRows) {
    const match = row.source_path?.match(/[?&]conversationId=(\d+)/);
    if (!match) continue;
    const conversationId = Number(match[1]);
    const list = filesByConversation.get(conversationId);
    if (list) list.push(row.id);
    else filesByConversation.set(conversationId, [row.id]);
  }

  const dedicatedChannels = new Map<string, Map<number, { platform: string; name: string; fileCount: number }>>();
  for (const [conversationId, channel] of channelNames) {
    const fileIds = filesByConversation.get(conversationId);
    if (!fileIds || fileIds.length === 0) continue;
    for (const [canonicalId, group] of clusterGroups) {
      if (!channelMatchesCompany(channel.name, group.names)) continue;
      for (const fileId of fileIds) addMember(canonicalId, fileId, "dedicated_channel");
      let channels = dedicatedChannels.get(canonicalId);
      if (!channels) {
        channels = new Map();
        dedicatedChannels.set(canonicalId, channels);
      }
      channels.set(conversationId, { platform: channel.platform, name: channel.name, fileCount: fileIds.length });
    }
    await yieldToEventLoop();
  }

  const allFileIds = [...new Set([...membership.values()].flatMap((files) => [...files.keys()]))];
  const fileMeta = new Map<string, { fileName: string; source: string; date: string | null }>();
  for (let i = 0; i < allFileIds.length; i += 1000) {
    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "source", "source_created_at", "synced_at"])
      .where("id", "in", allFileIds.slice(i, i + 1000))
      .execute();
    for (const row of rows) {
      fileMeta.set(row.id, {
        fileName: row.file_name,
        source: row.source,
        date: row.source_created_at ?? row.synced_at,
      });
    }
    await yieldToEventLoop();
  }

  /**
   * Family accretion — the third membership signal. A file whose normalized
   * title family already belongs to exactly one cluster joins that cluster.
   * This recovers files whose participant facts all sit on our side (the
   * "Goosebumps <> Sketch" Fireflies recording) without reopening the mention
   * path. Guards: single-token families never accrete (too generic), a family
   * claimed by two clusters accretes nothing (ambiguous), and the pass runs
   * exactly once — accreted files do not extend the family map.
   */
  const familyOwner = new Map<string, string | null>();
  for (const [canonicalId, fileSignals] of membership) {
    const keys = new Set<string>();
    for (const fileId of fileSignals.keys()) {
      const meta = fileMeta.get(fileId);
      if (!meta) continue;
      keys.add(normalizeTitleFamily(meta.fileName).key);
    }
    for (const key of keys) {
      if (tokenizeName(key).length < 2) continue;
      const existing = familyOwner.get(key);
      if (existing === undefined) familyOwner.set(key, canonicalId);
      else if (existing !== canonicalId) familyOwner.set(key, null);
    }
  }
  if (familyOwner.size > 0) {
    const memberFileIds = new Set(allFileIds);
    const candidateRows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "source", "source_created_at", "synced_at"])
      .execute();
    let scanned = 0;
    for (const row of candidateRows) {
      scanned += 1;
      if (scanned % YIELD_EVERY === 0) await yieldToEventLoop();
      if (memberFileIds.has(row.id)) continue;
      const owner = familyOwner.get(normalizeTitleFamily(row.file_name).key);
      if (!owner) continue;
      addMember(owner, row.id, "family_accretion");
      fileMeta.set(row.id, {
        fileName: row.file_name,
        source: row.source,
        date: row.source_created_at ?? row.synced_at,
      });
    }
  }

  const clusters: ClientCluster[] = [];
  for (const [canonicalId, fileSignals] of membership) {
    const group = clusterGroups.get(canonicalId);
    if (!group) continue;
    const files: ClusterFile[] = [];
    for (const [fileId, signals] of fileSignals) {
      const meta = fileMeta.get(fileId);
      if (!meta) continue;
      files.push({ fileId, fileName: meta.fileName, source: meta.source, date: meta.date, via: [...signals].sort() });
    }
    if (files.length < minFiles) continue;
    files.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.fileId.localeCompare(b.fileId));
    const families = computeTitleFamilies(files);
    const channels = [...(dedicatedChannels.get(canonicalId)?.values() ?? [])].sort(
      (a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name),
    );
    clusters.push({
      companyEntityId: canonicalId,
      companyName: group.canonicalName,
      groupMembers: group.members,
      files,
      channels,
      triggered: clusterIsTriggered(families),
    });
  }
  clusters.sort((a, b) => b.files.length - a.files.length || a.companyName.localeCompare(b.companyName));
  return clusters;
}

const GITHUB_REPO_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
const URL_PATTERN = /https?:\/\/[^\s)>\]"'`]+/g;

const UTILITY_LINK_HOSTS = [
  "meet.google.com",
  "calendar.google.com",
  "mail.google.com",
  "fonts.googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "zoom.us",
  "fireflies.ai",
  "slack.com",
  "whatsapp.com",
  "wa.me",
  "linear.app",
  "teams.microsoft.com",
  "outlook.office.com",
  "schemas.microsoft.com",
  "w3.org",
  "github.com",
  "aka.ms",
  "urldefense.com",
  "cloud.microsoft",
];

const UTILITY_LINK_PATH_PATTERN = /privacy|unsubscribe|safelink/i;

function isUtilityHost(host: string): boolean {
  return UTILITY_LINK_HOSTS.some((utility) => host === utility || host.endsWith(`.${utility}`));
}

function normalizeLink(raw: string): { host: string; ref: string } | null {
  const trimmed = raw.replace(/[.,;:!?)\]}>]+$/, "");
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const ref = `${host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120);
    return { host, ref };
  } catch {
    return null;
  }
}

export interface BuildClusterDossierOptions {
  declaredRelationship?: CompanyRelationshipDeclarationRow | null;
}

const ONBOARDING_FAMILY_PATTERN = /onboard/i;
const INVOICE_FAMILY_PATTERN = /invoice/i;
const SUPPORT_CHANNEL_PATTERN = /support/i;

/**
 * Deterministic nomination signals. They nominate a company for a human (or
 * CRM) declaration and never decide a state themselves: measured across 31
 * clusters, a dedicated channel fires on two leads and a customer — it tracks
 * relationship intensity, not trial.
 */
export function computeNominationSignals(channels: ClusterChannel[], titleFamilies: TitleFamily[]): NominationSignal[] {
  const signals: NominationSignal[] = [];
  if (channels.length > 0) signals.push("dedicated_channel");
  if (channels.some((channel) => SUPPORT_CHANNEL_PATTERN.test(channel.name))) signals.push("support_channel");
  if (titleFamilies.some((family) => ONBOARDING_FAMILY_PATTERN.test(family.display))) signals.push("onboarding_family");
  if (titleFamilies.some((family) => INVOICE_FAMILY_PATTERN.test(family.display))) signals.push("invoice_family");
  return signals;
}

export async function buildClusterDossier(
  db: Kysely<DB>,
  cluster: ClientCluster,
  options?: BuildClusterDossierOptions,
): Promise<ClusterDossier> {
  const fileIds = cluster.files.map((file) => file.fileId);
  const dateByFile = new Map(cluster.files.map((file) => [file.fileId, file.date]));

  const sourceCounts: Record<string, number> = {};
  const dates: string[] = [];
  for (const file of cluster.files) {
    sourceCounts[file.source] = (sourceCounts[file.source] ?? 0) + 1;
    if (file.date) dates.push(file.date.slice(0, 10));
  }
  dates.sort();

  const participantRows = fileIds.length
    ? await db
        .selectFrom("indexed_file_facts")
        .select(["indexed_file_id as fileId", "subject_name as name", "subject_email as email"])
        .where("indexed_file_id", "in", fileIds)
        .where("fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
        .where("deleted_at", "is", null)
        .execute()
    : [];
  interface PersonAccumulator {
    name: string;
    email: string | null;
    files: Set<string>;
    firstSeen: string | null;
    lastSeen: string | null;
  }
  const people = new Map<string, PersonAccumulator>();
  for (const row of participantRows) {
    if (!row.fileId) continue;
    const email = row.email?.trim() || null;
    const name = row.name?.trim() || email;
    if (!name) continue;
    const key = email ? email.toLowerCase() : `name:${name.toLowerCase()}`;
    let person = people.get(key);
    if (!person) {
      person = { name, email, files: new Set(), firstSeen: null, lastSeen: null };
      people.set(key, person);
    }
    person.files.add(row.fileId);
    const day = dateByFile.get(row.fileId)?.slice(0, 10) ?? null;
    if (day) {
      if (!person.firstSeen || day < person.firstSeen) person.firstSeen = day;
      if (!person.lastSeen || day > person.lastSeen) person.lastSeen = day;
    }
  }

  const emails = [...new Set([...people.values()].flatMap((person) => (person.email ? [person.email] : [])))];
  const anywhereByEmail = new Map<string, Set<string>>();
  for (let i = 0; i < emails.length; i += 500) {
    const rows = await db
      .selectFrom("indexed_file_facts")
      .select(["indexed_file_id as fileId", "subject_email as email"])
      .where("subject_email", "in", emails.slice(i, i + 500))
      .where("fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
      .where("deleted_at", "is", null)
      .execute();
    for (const row of rows) {
      if (!row.fileId) continue;
      const key = row.email?.toLowerCase();
      if (!key) continue;
      const set = anywhereByEmail.get(key);
      if (set) set.add(row.fileId);
      else anywhereByEmail.set(key, new Set([row.fileId]));
    }
    await yieldToEventLoop();
  }
  const dossierPeople: DossierPerson[] = [...people.values()]
    .filter((person) => person.files.size >= 2)
    .map((person) => ({
      name: person.name,
      email: person.email,
      filesInCluster: person.files.size,
      filesAnywhere: person.email
        ? Math.max(anywhereByEmail.get(person.email.toLowerCase())?.size ?? 0, person.files.size)
        : person.files.size,
      firstSeen: person.firstSeen,
      lastSeen: person.lastSeen,
    }))
    .sort((a, b) => b.filesInCluster - a.filesInCluster || a.name.localeCompare(b.name))
    .slice(0, PEOPLE_CAP);

  const titleFamilies = computeTitleFamilies(cluster.files).slice(0, FAMILY_CAP);

  const repoFiles = new Map<string, Set<string>>();
  const linkFiles = new Map<string, Set<string>>();
  for (let i = 0; i < fileIds.length; i += CONTENT_CHUNK) {
    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "content"])
      .where("id", "in", fileIds.slice(i, i + CONTENT_CHUNK))
      .execute();
    for (const row of rows) {
      const content = row.content;
      if (!content) continue;
      for (const match of content.matchAll(GITHUB_REPO_PATTERN)) {
        const repo = `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`.toLowerCase();
        const set = repoFiles.get(repo);
        if (set) set.add(row.id);
        else repoFiles.set(repo, new Set([row.id]));
      }
      for (const match of content.matchAll(URL_PATTERN)) {
        const link = normalizeLink(match[0]);
        if (!link || isUtilityHost(link.host) || UTILITY_LINK_PATH_PATTERN.test(link.ref)) continue;
        const set = linkFiles.get(link.ref);
        if (set) set.add(row.id);
        else linkFiles.set(link.ref, new Set([row.id]));
      }
    }
    await yieldToEventLoop();
  }
  const artifacts: DossierArtifact[] = [
    ...[...repoFiles.entries()]
      .map(([ref, files]) => ({ ref, kind: "github_repo" as const, fileCount: files.size }))
      .sort((a, b) => b.fileCount - a.fileCount || a.ref.localeCompare(b.ref))
      .slice(0, REPO_CAP),
    ...[...linkFiles.entries()]
      .map(([ref, files]) => ({ ref, kind: "link" as const, fileCount: files.size }))
      .filter((artifact) => artifact.fileCount >= 2)
      .sort((a, b) => b.fileCount - a.fileCount || a.ref.localeCompare(b.ref))
      .slice(0, LINK_CAP),
  ];

  const fragmentRows = fileIds.length
    ? await db
        .selectFrom("entity_mentions")
        .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
        .select(({ fn }) => [
          "entities.id as entityId",
          "entities.name as name",
          "entities.status as status",
          "entities.created_at as createdAt",
          fn.count<number>("entity_mentions.indexed_file_id").distinct().as("clusterFileCount"),
        ])
        .where("entity_mentions.indexed_file_id", "in", fileIds)
        .where("entities.source_type", "=", "project")
        .where(whereLiveEntity())
        .groupBy(["entities.id", "entities.name", "entities.status", "entities.created_at"])
        .execute()
    : [];
  const fragmentIds = fragmentRows.map((row) => row.entityId);
  const totalsByFragment = new Map<string, number>();
  const tasksByFragment = new Map<string, number>();
  if (fragmentIds.length > 0) {
    const totals = await db
      .selectFrom("entity_mentions")
      .select(({ fn }) => ["entity_id", fn.count<number>("indexed_file_id").distinct().as("total")])
      .where("entity_id", "in", fragmentIds)
      .groupBy("entity_id")
      .execute();
    for (const row of totals) totalsByFragment.set(row.entity_id, Number(row.total));
    const tasks = await db
      .selectFrom("tasks")
      .select(({ fn }) => ["parent_entity_id", fn.countAll<number>().as("total")])
      .where("parent_entity_id", "in", fragmentIds)
      .groupBy("parent_entity_id")
      .execute();
    for (const row of tasks) {
      if (row.parent_entity_id) tasksByFragment.set(row.parent_entity_id, Number(row.total));
    }
  }
  const allFragments: DossierFragment[] = fragmentRows
    .map((row) => ({
      entityId: row.entityId,
      name: row.name,
      status: row.status,
      createdAt: row.createdAt.slice(0, 10),
      clusterFileCount: Number(row.clusterFileCount),
      totalFileCount: totalsByFragment.get(row.entityId) ?? Number(row.clusterFileCount),
      parentedTaskCount: tasksByFragment.get(row.entityId) ?? 0,
    }))
    .sort((a, b) => b.clusterFileCount - a.clusterFileCount || a.name.localeCompare(b.name));
  /**
   * Global fragment ownership: an entity is disposable here only when this
   * cluster holds at least half of its mentioning files. GCC Dashboard sat in
   * Habuild's dossier with 2 of its 21 files and got merged into Habuild work
   * it never belonged to — ownership is what keeps a neighbour's project from
   * being absorbed.
   */
  const fragments = allFragments.filter(
    (fragment) => fragment.clusterFileCount / Math.max(fragment.totalFileCount, 1) >= FRAGMENT_OWNERSHIP_FLOOR,
  );
  const ownedElsewhere = allFragments.filter(
    (fragment) => fragment.clusterFileCount / Math.max(fragment.totalFileCount, 1) < FRAGMENT_OWNERSHIP_FLOOR,
  );

  const seenEvents = new Set<string>();
  const allEvents: DossierEvent[] = [];
  for (const file of cluster.files) {
    const day = file.date?.slice(0, 10) ?? "undated";
    const { key, display } = normalizeTitleFamily(file.fileName);
    const eventKey = `${day}|${file.source}|${key}`;
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);
    allEvents.push({ date: day, source: file.source, title: display });
  }
  allEvents.sort(
    (a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title),
  );
  let events = allEvents;
  if (allEvents.length > EVENT_CAP) {
    events = [];
    const stride = allEvents.length / EVENT_CAP;
    for (let i = 0; i < EVENT_CAP; i++) events.push(allEvents[Math.floor(i * stride)]);
  }

  const dossier: ClusterDossier = {
    companyEntityId: cluster.companyEntityId,
    companyName: cluster.companyName,
    groupMembers: cluster.groupMembers,
    declaredRelationship: options?.declaredRelationship ?? null,
    nominationSignals: computeNominationSignals(cluster.channels, titleFamilies),
    fileCount: cluster.files.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    sourceCounts,
    people: dossierPeople,
    titleFamilies,
    artifacts,
    channels: cluster.channels,
    fragments,
    ownedElsewhere,
    candidateWorkstreams: await scanAndRankCandidates(
      db,
      cluster,
      groupFragmentCandidates(fragments, titleFamilies),
      titleFamilies,
      dossierPeople,
    ),
    events,
    markdown: "",
  };
  dossier.markdown = renderDossierMarkdown(dossier);
  return dossier;
}

export function renderDossierMarkdown(dossier: ClusterDossier): string {
  const lines: string[] = [];
  lines.push(`# Activity dossier — ${dossier.companyName}`);
  lines.push("");
  const sources = Object.entries(dossier.sourceCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, count]) => `${source} ${count}`)
    .join(" · ");
  lines.push(`${dossier.fileCount} files · ${dossier.firstDate ?? "?"} → ${dossier.lastDate ?? "?"} · ${sources}`);
  lines.push("");
  if (dossier.declaredRelationship) {
    const { counterparty_kind: kind, client_stage: stage } = dossier.declaredRelationship;
    lines.push(`DECLARED (from counterparty registry): counterpartyKind = ${kind}; clientStage = ${stage ?? "null"}.`);
    lines.push("");
  }
  if (dossier.nominationSignals.length > 0) {
    lines.push(
      `Deterministic signals (indicative only, never authoritative — they nominate, humans declare): ${dossier.nominationSignals.map((signal) => signal.replace(/_/g, " ")).join(", ")}`,
    );
    lines.push("");
  }
  if (dossier.groupMembers.length > 1) {
    lines.push(
      `Company shards grouped as one real-world company (domain/alias evidence): ${dossier.groupMembers.map((member) => member.name).join(", ")}`,
    );
    lines.push("");
  }

  lines.push("## Recurring people");
  lines.push("Concentration is the share of a person's files that sit inside this cluster.");
  if (dossier.people.length === 0) lines.push("- none with 2+ files");
  for (const person of dossier.people) {
    const share = person.filesAnywhere > 0 ? Math.round((person.filesInCluster / person.filesAnywhere) * 100) : 0;
    lines.push(
      `- ${person.name}${person.email ? ` <${person.email}>` : ""} — ${person.filesInCluster} files here of ${person.filesAnywhere} anywhere (${share}%), seen ${person.firstSeen ?? "?"} → ${person.lastSeen ?? "?"}`,
    );
  }
  lines.push("");

  lines.push("## Title families");
  for (const family of dossier.titleFamilies) {
    lines.push(
      `- "${family.display}" — ${family.count} files, ${family.distinctDays} distinct days, ${family.activeWeeks} active weeks, ${family.firstDate ?? "?"} → ${family.lastDate ?? "?"}, sources: ${family.sources.join(", ")}`,
    );
  }
  lines.push("");

  lines.push("## Artifact references");
  if (dossier.artifacts.length === 0) lines.push("- none found");
  for (const artifact of dossier.artifacts) {
    lines.push(`- ${artifact.kind === "github_repo" ? "repo" : "link"} ${artifact.ref} — ${artifact.fileCount} files`);
  }
  lines.push("");

  lines.push("## Dedicated channels");
  if (dossier.channels.length === 0) lines.push("- none");
  for (const channel of dossier.channels) {
    lines.push(`- ${channel.platform} "${channel.name}" — ${channel.fileCount} files`);
  }
  lines.push("");

  lines.push("## Existing project entities on these files (suspected fragments)");
  if (dossier.fragments.length === 0) lines.push("- none");
  for (const fragment of dossier.fragments) {
    lines.push(
      `- "${fragment.name}" [id: ${fragment.entityId}] — status ${fragment.status}, born ${fragment.createdAt}, on ${fragment.clusterFileCount} files here of ${fragment.totalFileCount} anywhere, ${fragment.parentedTaskCount} tasks parented`,
    );
  }
  lines.push("");

  if (dossier.ownedElsewhere.length > 0) {
    lines.push(
      "Mentioned here but owned elsewhere (most of their files sit in another cluster; no disposition needed, do NOT merge or adopt):",
    );
    for (const fragment of dossier.ownedElsewhere) {
      lines.push(
        `- "${fragment.name}" — ${fragment.clusterFileCount} files here of ${fragment.totalFileCount} anywhere`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Candidate workstreams (name-token groups of the fragments above, ranked by content recurrence — how often the tokens actually appear across file text, which stored mentions undercount)",
  );
  if (dossier.candidateWorkstreams.length === 0) lines.push("- none crossed the candidacy floor");
  for (const candidate of dossier.candidateWorkstreams) {
    const singleton =
      candidate.singletonTitleCount > 0
        ? `, ${candidate.singletonTitleCount} singleton meeting titles echo these tokens`
        : "";
    const scan = candidate.scan;
    const monthly = scan
      ? Object.entries(scan.monthly)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, count]) => `${month}:${count}`)
          .join(" ")
      : "";
    const scanText =
      scan && scan.files.length > 0
        ? `recurs in content on ${scan.distinctDays} distinct days across ${scan.files.length} files (${scan.firstDay ?? "?"} → ${scan.lastDay ?? "?"}${monthly ? `; monthly ${monthly}` : ""}) · `
        : "no content recurrence beyond the stored mentions · ";
    const membership = candidate.titleFamily
      ? `recurring meeting title "${candidate.titleFamily}" (${candidate.clusterFileCount} meetings, no stored fragment)`
      : `${candidate.members.length} fragments, ${candidate.clusterFileCount} cluster files${singleton}: ${candidate.members
          .map((member) => `"${member.name}" [id: ${member.entityId}]`)
          .join(", ")}`;
    lines.push(`- tokens [${candidate.tokens.join(", ")}] — ${scanText}${membership}`);
  }
  lines.push("");

  lines.push(`## Event line (${dossier.events.length} rows, deduped by day and title family)`);
  for (const event of dossier.events) {
    lines.push(`- ${event.date} ${event.source} — ${event.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

export type ProjectLifecycleStatus = "proposed" | "active" | "delivered" | "lost";
export type VerdictConfidence = "high" | "medium" | "low";
export type TrackerFit =
  | "cluster_matches_containers"
  | "cluster_spans_containers"
  | "containers_hold_clusters"
  | "no_containers";

export interface VerdictProject {
  name: string;
  status: ProjectLifecycleStatus;
  confidence: VerdictConfidence;
  /** Exact name of the parent project in the same verdict, null for top-level. v1 rows: always null. */
  parentName: string | null;
  /** Optional entity id of a live standing product parent. External v1/v2 rows never set it. */
  parentEntityId?: string;
  evidenceTitleFamilies: string[];
  evidenceRepos: string[];
  /** Entity ids from the dossier fragments/candidates sections this project absorbs. v1 rows: empty. */
  evidenceFragments: string[];
  /** Weekly-only review rows: dedup bookkeeping and accept-time precise file claims, never fragment anchors. */
  coveredReviewIds?: string[];
  evidencePeople: string[];
  reasoning?: string;
}

export interface VerdictEntityDisposition {
  entityId: string;
  name: string;
  disposition: "canonical" | "merge_into";
  mergeInto?: string;
  reasoning?: string;
}

export interface ClusterVerdict {
  counterpartyKind: CounterpartyKind;
  clientStage: ClientStage | null;
  engagement: { name: string; summary?: string } | null;
  projects: VerdictProject[];
  existingEntities: VerdictEntityDisposition[];
  trackerFit: TrackerFit;
  notes: string[];
}

const COUNTERPARTY_KINDS: ReadonlySet<string> = new Set(["client", "vendor", "investor", "partner", "other"]);
const CLIENT_STAGES: ReadonlySet<string> = new Set(["prospect", "pilot", "active", "dormant", "ended"]);
const PROJECT_STATUSES: ReadonlySet<string> = new Set(["proposed", "active", "delivered", "lost"]);
const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const TRACKER_FITS: ReadonlySet<string> = new Set([
  "cluster_matches_containers",
  "cluster_spans_containers",
  "containers_hold_clusters",
  "no_containers",
]);

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function assertProjectForestIsValid(projects: VerdictProject[]): void {
  const byName = new Map<string, VerdictProject>();
  for (const project of projects) {
    const key = project.name.toLowerCase();
    if (byName.has(key)) throw new Error(`Cluster verdict has duplicate project name: ${project.name}`);
    byName.set(key, project);
  }
  for (const project of projects) {
    if (!project.parentName) continue;
    const parentKey = project.parentName.toLowerCase();
    if (parentKey === project.name.toLowerCase()) {
      throw new Error(`Cluster verdict project "${project.name}" is its own parent`);
    }
    if (!byName.has(parentKey)) {
      throw new Error(`Cluster verdict project "${project.name}" names unknown parent "${project.parentName}"`);
    }
  }
  for (const project of projects) {
    const seen = new Set<string>([project.name.toLowerCase()]);
    let current = project.parentName;
    while (current) {
      const key = current.toLowerCase();
      if (seen.has(key)) throw new Error(`Cluster verdict parent chain cycles at "${current}"`);
      seen.add(key);
      current = byName.get(key)?.parentName ?? null;
    }
  }
}

export interface ReadClusterVerdictOptions {
  /**
   * Strict mode is for newly requested v2 verdicts: duplicate project names,
   * unknown or self parentName, and parent cycles are rejected at parse time
   * because acceptance resolves parents by name. Stored v1 rows are read
   * without it and parse exactly as they always did.
   */
  strict?: boolean;
}

export function readClusterVerdict(value: unknown, options?: ReadClusterVerdictOptions): ClusterVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cluster verdict is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const counterpartyKind = record.counterpartyKind;
  if (typeof counterpartyKind !== "string" || !COUNTERPARTY_KINDS.has(counterpartyKind)) {
    throw new Error(`Cluster verdict has invalid counterpartyKind: ${String(counterpartyKind)}`);
  }
  const rawClientStage = record.clientStage;
  let clientStage: ClientStage | null = null;
  if (counterpartyKind === "client" || counterpartyKind === "partner") {
    if (typeof rawClientStage !== "string" || !CLIENT_STAGES.has(rawClientStage)) {
      throw new Error(`Cluster verdict has invalid clientStage for ${counterpartyKind}: ${String(rawClientStage)}`);
    }
    clientStage = rawClientStage as ClientStage;
  } else if (rawClientStage !== undefined && rawClientStage !== null) {
    throw new Error(`Cluster verdict has clientStage for non-stage counterpartyKind: ${counterpartyKind}`);
  }
  const trackerFit = record.trackerFit;
  if (typeof trackerFit !== "string" || !TRACKER_FITS.has(trackerFit)) {
    throw new Error(`Cluster verdict has invalid trackerFit: ${String(trackerFit)}`);
  }
  let engagement: ClusterVerdict["engagement"] = null;
  if (record.engagement && typeof record.engagement === "object" && !Array.isArray(record.engagement)) {
    const raw = record.engagement as Record<string, unknown>;
    if (typeof raw.name === "string" && raw.name.trim().length > 0) {
      engagement = {
        name: raw.name.trim(),
        ...(typeof raw.summary === "string" && raw.summary.trim() ? { summary: raw.summary.trim() } : {}),
      };
    }
  }
  const projects: VerdictProject[] = [];
  for (const item of Array.isArray(record.projects) ? record.projects : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) continue;
    if (typeof raw.status !== "string" || !PROJECT_STATUSES.has(raw.status)) {
      throw new Error(`Cluster verdict project "${raw.name}" has invalid status: ${String(raw.status)}`);
    }
    const confidence = typeof raw.confidence === "string" && CONFIDENCES.has(raw.confidence) ? raw.confidence : "low";
    const coveredReviewIds = readStringArray(raw.coveredReviewIds);
    projects.push({
      name: raw.name.trim(),
      status: raw.status as ProjectLifecycleStatus,
      confidence: confidence as VerdictConfidence,
      parentName: typeof raw.parentName === "string" && raw.parentName.trim() ? raw.parentName.trim() : null,
      ...(typeof raw.parentEntityId === "string" && raw.parentEntityId.trim()
        ? { parentEntityId: raw.parentEntityId.trim() }
        : {}),
      evidenceTitleFamilies: readStringArray(raw.evidenceTitleFamilies),
      evidenceRepos: readStringArray(raw.evidenceRepos),
      evidenceFragments: [...new Set(readStringArray(raw.evidenceFragments))],
      ...(raw.coveredReviewIds === undefined ? {} : { coveredReviewIds: [...new Set(coveredReviewIds)] }),
      evidencePeople: readStringArray(raw.evidencePeople),
      ...(typeof raw.reasoning === "string" && raw.reasoning.trim() ? { reasoning: raw.reasoning.trim() } : {}),
    });
  }
  if (options?.strict) assertProjectForestIsValid(projects);
  const existingEntities: VerdictEntityDisposition[] = [];
  for (const item of Array.isArray(record.existingEntities) ? record.existingEntities : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.entityId !== "string" || typeof raw.name !== "string") continue;
    if (raw.disposition !== "canonical" && raw.disposition !== "merge_into") {
      throw new Error(`Cluster verdict entity "${raw.name}" has invalid disposition: ${String(raw.disposition)}`);
    }
    existingEntities.push({
      entityId: raw.entityId,
      name: raw.name,
      disposition: raw.disposition,
      ...(typeof raw.mergeInto === "string" && raw.mergeInto.trim() ? { mergeInto: raw.mergeInto.trim() } : {}),
      ...(typeof raw.reasoning === "string" && raw.reasoning.trim() ? { reasoning: raw.reasoning.trim() } : {}),
    });
  }
  return {
    counterpartyKind: counterpartyKind as CounterpartyKind,
    clientStage,
    engagement,
    projects,
    existingEntities,
    trackerFit: trackerFit as TrackerFit,
    notes: readStringArray(record.notes),
  };
}

/**
 * Two axes, deliberately separate: counterparty kind says what this company is
 * to us, client stage says where a client or partner relationship stands, and
 * work containers say what work exists. Stage 3 emits nominations, never
 * declarations. A DECLARED line in the dossier is authoritative over the
 * registry snapshot only; deterministic signals nominate candidates and never
 * substitute for declared stage. The tracker-fit question stays directionally
 * neutral: both failure modes (too coarse, cross-cutting) exist across
 * clients, and the liveness stats travel as data, not editorial framing.
 */
export function buildVerdictPrompt(dossierMarkdown: string): string {
  return `You are auditing how one company's observed activity relates to the organisation running this system, using only the evidence dossier below. The dossier is built deterministically from file metadata: recurring people with concentration, title families, artifact references, dedicated channels, existing tracker entities with their liveness stats, and an event line. No raw document content is included. A dossier may carry a DECLARED line from an operational registry; declared facts are authoritative and override inference. It may also carry a "Deterministic signals" line; those are indicative nominations only, never authority.

Return nominated axes, never declarations.

First nominate COUNTERPARTY KIND — exactly one of:
- "client": a sustained account relationship in which we owe or oversee a body of work, where the work is our own output and not the paperwork of the relationship.
- "partner": a sustained account relationship in which we co-deliver or oversee a body of work, where the work is our own output and not the paperwork of the relationship.
- "vendor": a recurring administrative supplier — payroll, employment verification, banking, benefits. A subcontractor who helps deliver client work is not a vendor by this test; their delivery files sit in the client's cluster as well, where they mint correctly.
- "investor": fundraising, investor relations, data room, diligence or board reporting. These are paperwork of the relationship, not our own output.
- "other": brand mention, admin contact, or no qualifying working relationship in this evidence.

Then, only for counterpartyKind "client" or "partner", nominate CLIENT STAGE — exactly one of:
- "prospect": no container; projects only for a client-side work object, at most one each.
- "pilot": a container project; more only with a client-side work object.
- "active": a container project, plus the projects the evidence supports.
- "dormant": nothing new; existing containers survive untouched.
- "ended": nothing new; still-active children surface for review.

Then decide the WORK CONTAINERS, under these nominated-axis rules:
- client or partner / prospect: mint no projects — with ONE exception: if the dossier shows a client-side scoped work object (a named proposal, cost estimate, statement of work, or product-vision document describing work for THEM), mint that as one project at status "proposed", parentName null. A meeting series named after our own product is not a work object.
- client or partner / pilot: exactly one top-level project named "<Counterparty> deployment" (status "active") where onboarding, operating and support work files. Mint additional projects ONLY if a client-side scoped work object exists beyond operating our product; those nest under the deployment when they are part of operating it.
- client or partner / active: EXACTLY ONE top-level project (parentName null) — the account container named after the counterparty, holding standups, weekly catch-ups, contracting and account operations. EVERY other project you propose must be a descendant of it: distinct work streams as its children, sub-efforts as their children. Never propose a second top-level project.
- client or partner / dormant or ended: mint nothing new; empty projects.
- vendor / investor / other: mint nothing; empty projects.

Rules that apply throughout:
- The absence of delivery artifacts must never be the reason a project is suppressed; it only bounds status: "proposed" until there is delivery evidence, "active" when delivery evidence exists, "delivered" when handover evidence exists, "lost" only on explicit evidence.
- Delivery evidence means artifacts: a repository, a working dashboard or demo link, a handover, reported hours, assigned engineers. Distinct repositories are the sharpest separator between concurrent workstreams.
- Be explicit about tense: a kickoff or plan DESCRIBING future work is planned work, not delivery. Vocabulary lies in both directions; prefer artifacts over verbs.
- Naming: never name a prospect's project after our own product — if the only available name comes from our side, that is evidence the cluster is a prospect. For a pilot, the deployment container IS named "<Counterparty> deployment".
- Projects NEST: when a proposed project is a distinct stream inside a larger proposed project, set its parentName to that parent's exact name (the parent must appear in this same projects list; top-level projects use null). Sub-projects of sub-projects are allowed. A recurring sub-effort with its own identity — its own meeting series, its own fragments, its own people focus — deserves a child project rather than being flattened into its parent.
- The "Candidate workstreams" section lists deterministic groupings of the existing fragments. For each group, either propose a project covering it (usually a child of the stream it belongs to) and cite its member ids in evidenceFragments, or explain in notes why it is not real work. Do not silently flatten a candidate group into a parent.
- Fragments listed as "owned elsewhere" belong to another company's cluster: give them no disposition, never merge or adopt them.
- Every project must carry evidence anchors: which title families, repositories, people, and fragment ids from the dossier support it. Do not propose a project you cannot anchor.

Then classify how the existing tracker entities (the "suspected fragments" section) fit the activity:
- cluster_matches_containers: existing entities already describe this work correctly — adopt them, propose nothing new for those.
- cluster_spans_containers: the activity is one effort that spans several existing containers which are each individually fine.
- containers_hold_clusters: one or more existing containers are too coarse or abandoned relative to the observed activity.
- no_containers: there are no existing entities for this work.
The tracker's accuracy is unknown; judge fit from the liveness stats in the dossier (file counts, birth dates, parented tasks), not from an assumption that it is wrong.

For EVERY existing entity listed in the fragments section, return a disposition:
- "canonical" if it correctly names one of the projects or the engagement you propose (reuse its name in your proposal).
- "merge_into" if it is a fragment that should be folded into one of your proposed projects or the engagement; set mergeInto to that proposal's exact name.

Also note anything suspicious, e.g. evidence that the cluster's company label is wrong (participants and channels pointing at a different company than the header).

Return only JSON:
{
  "counterpartyKind": "client | vendor | investor | partner | other",
  "clientStage": "prospect | pilot | active | dormant | ended" | null,
  "projects": [
    {
      "name": "Project name",
      "status": "proposed | active | delivered | lost",
      "confidence": "high | medium | low",
      "parentName": "exact name of the parent project in this list, or null for top-level",
      "evidenceTitleFamilies": ["exact title family strings from the dossier"],
      "evidenceRepos": ["repo refs from the dossier"],
      "evidenceFragments": ["entity ids from the fragments/candidates sections"],
      "evidencePeople": ["names from the dossier"],
      "reasoning": "one sentence"
    }
  ],
  "existingEntities": [
    { "entityId": "id from the fragments section", "name": "its name", "disposition": "canonical | merge_into", "mergeInto": "proposal name when merge_into", "reasoning": "one sentence" }
  ],
  "trackerFit": "cluster_matches_containers | cluster_spans_containers | containers_hold_clusters | no_containers",
  "notes": ["anything suspicious or worth a human's attention"]
}

If counterpartyKind is vendor, investor or other, return an empty projects array. clientStage must be present only for client and partner; otherwise return null.

Dossier:

${dossierMarkdown}`;
}

/**
 * Every name our own org and product answer to, for the product-name
 * tripwire: own-org duplicate-group member names and aliases, the first
 * label of each organization domain, and the workspace's org and bot names
 * (in this product the bot's name IS the product's name).
 */
export async function loadOwnOrgNames(db: Kysely<DB>): Promise<string[]> {
  const names = new Set<string>();
  const groups = buildCompanyDedupGroups(await loadCompanyDedupMembers(db));
  for (const group of groups) {
    if (!group.ownOrg) continue;
    for (const member of group.members) {
      names.add(member.name);
      for (const alias of member.aliases) names.add(alias);
    }
  }
  const orgDomainRows = await db.selectFrom("organization_domains").select("domain").execute();
  for (const row of orgDomainRows) {
    const label = row.domain.trim().toLowerCase().split(".")[0];
    if (label) names.add(label);
  }
  const settings = await db.selectFrom("settings").select(["org_name", "bot_name"]).executeTakeFirst();
  if (settings?.org_name) names.add(settings.org_name);
  if (settings?.bot_name) names.add(settings.bot_name);
  return [...names]
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .sort();
}

/**
 * Stage-conditional product-name tripwire. A minted project named after our
 * own org or product is forbidden under `prospect` and expected under
 * `pilot`, where the deployment is the work. Undeclared clusters are checked
 * as `prospect` outside this function so a nominated pilot cannot bypass it.
 * Matching reuses the complete-name contiguous-token rule.
 */
export function productNameTripwireFlags(
  stage: ClientStage | null,
  projects: VerdictProject[],
  ownNames: string[],
): string[] {
  if (stage !== "prospect" || ownNames.length === 0) return [];
  const flags: string[] = [];
  for (const project of projects) {
    if (channelMatchesCompany(project.name, ownNames)) {
      flags.push(`product_named_project_under_prospect:${project.name}`);
    }
  }
  return flags;
}

export interface VerdictVoteStats {
  votes: number;
  axisCounts: Record<string, number>;
  chosenCounterpartyKind: CounterpartyKind;
  chosenClientStage: ClientStage | null;
  axisAgreement: number;
  projectSetAgreement: number;
  projectNameCounts: Record<string, number>;
}

/**
 * Self-consistency vote over k stage-3 runs of the same dossier. Majority on
 * the composite nominated axes (ties keep the first axes seen, so the result
 * is deterministic given the run order); the stored verdict is the first run
 * that carries the majority axes. The agreement numbers are metadata for
 * PR-P3's write gate, not a gate themselves — measured, 6 of 31 single-run
 * verdicts flipped between two byte-identical runs.
 */
export function chooseMajorityVerdict(verdicts: ClusterVerdict[]): {
  verdict: ClusterVerdict;
  voteStats: VerdictVoteStats;
} {
  if (verdicts.length === 0) throw new Error("chooseMajorityVerdict needs at least one verdict");
  const axisCounts: Record<string, number> = {};
  const axisKey = (verdict: ClusterVerdict) => `${verdict.counterpartyKind}:${verdict.clientStage ?? ""}`;
  for (const verdict of verdicts) {
    const key = axisKey(verdict);
    axisCounts[key] = (axisCounts[key] ?? 0) + 1;
  }
  let chosenKey = axisKey(verdicts[0]);
  for (const verdict of verdicts) {
    const key = axisKey(verdict);
    if ((axisCounts[key] ?? 0) > (axisCounts[chosenKey] ?? 0)) {
      chosenKey = key;
    }
  }
  const chosen = verdicts.find((verdict) => axisKey(verdict) === chosenKey) as ClusterVerdict;
  const projectNameCounts: Record<string, number> = {};
  for (const verdict of verdicts) {
    for (const project of verdict.projects) {
      projectNameCounts[project.name] = (projectNameCounts[project.name] ?? 0) + 1;
    }
  }
  const projectSetKey = (verdict: ClusterVerdict) =>
    verdict.projects
      .map((project) => project.name.toLowerCase())
      .sort()
      .join("|");
  const chosenProjectSetKey = projectSetKey(chosen);
  const projectSetAgreement =
    verdicts.filter((verdict) => projectSetKey(verdict) === chosenProjectSetKey).length / verdicts.length;
  return {
    verdict: chosen,
    voteStats: {
      votes: verdicts.length,
      axisCounts,
      chosenCounterpartyKind: chosen.counterpartyKind,
      chosenClientStage: chosen.clientStage,
      axisAgreement: (axisCounts[chosenKey] ?? 0) / verdicts.length,
      projectSetAgreement,
      projectNameCounts,
    },
  };
}

export interface RequestClusterVerdictInput {
  dossier: ClusterDossier;
  generator: GeminiGenerator;
  promptVersion?: string;
  dumpDir?: string;
}

export async function requestClusterVerdict(input: RequestClusterVerdictInput): Promise<ClusterVerdict> {
  const raw = await input.generator.generateJSON<unknown>(buildVerdictPrompt(input.dossier.markdown), {
    maxTokens: VERDICT_MAX_TOKENS,
    label: `projectMintingVerdict:${input.dossier.companyName.replace(/\s+/g, "-")}`,
    ...(input.dumpDir ? { dumpDir: input.dumpDir } : {}),
    thinkingBudget: null,
  });
  return readClusterVerdict(raw, { strict: true });
}

export interface RunProjectMintingPassInput {
  db: Kysely<DB>;
  logger: Logger;
  generator: GeminiGenerator;
  model: string;
  promptVersion?: string;
  dumpDir?: string;
  storeVerdicts?: boolean;
  onlyTriggered?: boolean;
  minFiles?: number;
  companyFilter?: (companyName: string) => boolean;
  /** Stage-3 runs per cluster; the majority verdict is kept. Default 1. */
  votes?: number;
}

export interface ClusterPassResult {
  companyEntityId: string;
  companyName: string;
  fileCount: number;
  triggered: boolean;
  dossier: ClusterDossier;
  verdict?: ClusterVerdict;
  verdictId?: string;
  tripwireFlags?: string[];
  voteStats?: VerdictVoteStats;
  error?: string;
}

export interface ProjectMintingPassResult {
  clusters: ClientCluster[];
  results: ClusterPassResult[];
}

/**
 * The real pass: cluster, dossier, verdict, optional verdict storage. It
 * never writes an entity, never mutates an existing project, and a failing
 * cluster is recorded and skipped rather than aborting the portfolio — a
 * periodic pass must survive one bad cluster.
 */
export async function runProjectMintingPass(input: RunProjectMintingPassInput): Promise<ProjectMintingPassResult> {
  const promptVersion = input.promptVersion ?? PROJECT_MINTING_PROMPT_VERSION;
  const onlyTriggered = input.onlyTriggered ?? true;
  const votes = Math.max(1, Math.floor(input.votes ?? 1));
  const clusters = await clusterClientFiles(input.db, { minFiles: input.minFiles, logger: input.logger });
  const verdictRepo = createProjectMintingVerdictRepository(input.db);

  const declaredById = new Map(
    (await createCompanyRelationshipDeclarationRepository(input.db).list()).map((row) => [row.subject_entity_id, row]),
  );
  const ownNames = await loadOwnOrgNames(input.db);

  const results: ClusterPassResult[] = [];
  for (const cluster of clusters) {
    if (onlyTriggered && !cluster.triggered) continue;
    if (input.companyFilter && !input.companyFilter(cluster.companyName)) continue;
    const declaration = resolveDeclaration(
      cluster.groupMembers.map((member) => declaredById.get(member.entityId)).filter((row) => row != null),
    );
    const dossier = await buildClusterDossier(input.db, cluster, { declaredRelationship: declaration });
    const base = {
      companyEntityId: cluster.companyEntityId,
      companyName: cluster.companyName,
      fileCount: cluster.files.length,
      triggered: cluster.triggered,
      dossier,
    };
    try {
      const collected: ClusterVerdict[] = [];
      let lastError: unknown;
      for (let vote = 0; vote < votes; vote++) {
        try {
          collected.push(
            await requestClusterVerdict({
              dossier,
              generator: input.generator,
              promptVersion,
              ...(input.dumpDir ? { dumpDir: input.dumpDir } : {}),
            }),
          );
        } catch (err) {
          lastError = err;
        }
      }
      if (collected.length === 0) throw lastError ?? new Error("No verdicts collected");
      const { verdict, voteStats } = chooseMajorityVerdict(collected);
      const tripwireStage = declaration
        ? declaration.counterparty_kind === "client" || declaration.counterparty_kind === "partner"
          ? (declaration.client_stage as ClientStage | null)
          : null
        : "prospect";
      const tripwireFlags = productNameTripwireFlags(tripwireStage, verdict.projects, ownNames);
      let verdictId: string | undefined;
      if (input.storeVerdicts ?? true) {
        const stored = await verdictRepo.storePending({
          companyEntityId: cluster.companyEntityId,
          companyName: cluster.companyName,
          fileCount: cluster.files.length,
          dossier: dossier.markdown,
          verdict: JSON.stringify(verdict),
          model: input.model,
          promptVersion,
          counterpartyKind: verdict.counterpartyKind,
          clientStage: verdict.clientStage,
          declaredCounterpartyKind: declaration?.counterparty_kind ?? null,
          declaredClientStage: declaration?.client_stage ?? null,
          flags: tripwireFlags,
          ...(votes > 1 ? { voteStats } : {}),
        });
        verdictId = stored.id;
      }
      results.push({
        ...base,
        verdict,
        tripwireFlags,
        ...(votes > 1 ? { voteStats } : {}),
        ...(verdictId ? { verdictId } : {}),
      });
    } catch (err) {
      input.logger.warn(
        { err, companyEntityId: cluster.companyEntityId, companyName: cluster.companyName },
        "Project minting verdict failed for cluster",
      );
      results.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
    await yieldToEventLoop();
  }
  return { clusters, results };
}

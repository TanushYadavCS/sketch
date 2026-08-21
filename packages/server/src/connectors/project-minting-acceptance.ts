import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
  type ClientStage,
  type CounterpartyKind,
  assertStageMatchesKind,
  createCompanyRelationshipDeclarationRepository,
  kindCarriesStage,
  resolveDeclaration,
} from "../db/repositories/company-relationship-declarations";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { PERSON_PARTICIPANT_FACT_TYPES } from "../db/repositories/indexed-file-facts";
import {
  type ProjectMintingVerdictRow,
  createProjectMintingVerdictRepository,
} from "../db/repositories/project-minting-verdicts";
import type { DB } from "../db/schema";
import { withMaterializeReplayQueue } from "../entities/materialize-replay";
import { EntityMergeError, mergeEntities } from "../entities/merge";
import { ProjectBindingError, assertNoPartOfCycle } from "../entities/project-bindings";
import { normalizeName } from "./name-normalize";
import {
  type ClientCluster,
  type ClusterFile,
  type ClusterVerdict,
  type ProjectLifecycleStatus,
  type VerdictConfidence,
  clusterClientFiles,
  fragmentNameTokens,
  isV2MintingVerdict,
  normalizeTitleFamily,
  readClusterVerdict,
} from "./project-minting";
import { scanTokenRecurrence } from "./token-recurrence-scan";
import { partitionFiles } from "./weekly-mint";

const ACCEPT_SOURCE = "project-minting";
const RELATION_SOURCE = "project_minting_acceptance";
const GITHUB_REPO_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
const CONFIDENCE_RANK: Record<VerdictConfidence, number> = { high: 3, medium: 2, low: 1 };

export interface AcceptProjectMintingVerdictInput {
  verdictId: string;
  actorUserId: string;
  confirmedCounterpartyKind: CounterpartyKind;
  confirmedClientStage: ClientStage | null;
  struckProjectNames?: string[];
  renameMap?: Record<string, string>;
  overrideTripwireFlags?: boolean;
  /** Plan without writing: full validation and gate math, zero graph writes, no CAS, no declaration. */
  dryRun?: boolean;
}

export interface AcceptedEntitySummary {
  id: string;
  name: string;
  kind: "engagement" | "project";
  /** Entity id of the parent project (v2 verdicts); null for top-level and every v1 entity. */
  parentId: string | null;
  fileIds: string[];
  /** v2 accepts only: files claimed by the content scan and tasks re-parented because of them. */
  retroClaim?: { filesClaimed: number; tasksReparented: number };
  /**
   * Earliest file day attached to this entity — a left-censored floor, never
   * the project start: connector history routinely begins mid-assignment
   * (Redseer's Fireflies starts 4 months into a 12-month engagement).
   */
  activeSinceAtLeast?: string | null;
}

export interface ProjectMintingAcceptResult {
  verdictId: string;
  status: string;
  entityIds: {
    engagementId: string | null;
    projectIds: string[];
  };
  entities: AcceptedEntitySummary[];
  mergeIds: string[];
  struckProjects: string[];
  droppedByGate: {
    engagement: string | null;
    projects: string[];
    /**
     * Merges the verdict asked for that had no survivor left to merge into,
     * because the gate dropped their target. Reachable only through a
     * correction: a fragment told to fold into the engagement is skipped when
     * the confirmed stage is `prospect` or `pilot`, which carry no engagement.
     * Reported rather than refused — there is no input for redirecting a merge,
     * so refusing would leave the reviewer no path but rejection.
     */
    unmergedFragments: { entityId: string; intoName: string }[];
  };
  /**
   * Anchors the verdict named that matched nothing in the current corpus,
   * usually because the model paraphrased a title family. The accept still
   * went through on the anchors that did resolve; these are reported so the
   * reviewer can see the evidence was thinner than the verdict claimed.
   * Absent on results stored before this was recorded.
   */
  unresolvedAnchors: string[];
  /**
   * Where files matching no accepted project will attach (post-rename name),
   * or null when nothing catches them. Populated on dry runs so the sheet can
   * say it without mirroring the gate; absent on stored accepted results.
   */
  residualTarget?: string | null;
  declaration: {
    subjectEntityId: string;
    counterpartyKind: CounterpartyKind;
    clientStage: ClientStage | null;
  } | null;
  taskParentUpdates: number;
  /** True when the result was computed without any writes. */
  dryRun?: boolean;
  drift: {
    stance: "live_recompute";
    reviewedFileCount: number;
    acceptedFileCount: number;
    addedSinceVerdict: number;
  };
}

export class ProjectMintingAcceptanceError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "NOT_PENDING"
      | "STALE_VERDICT"
      | "TRIPWIRE_BLOCKED"
      | "ANCHOR_NOT_FOUND"
      | "STRIKE_CASCADE"
      | "WOULD_CYCLE"
      | "CLUSTER_NOT_FOUND"
      | "INVALID_ACCEPTANCE_SHAPE"
      | "INVALID_ACCEPTANCE",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectMintingAcceptanceError";
  }
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseStoredAcceptedResult(row: ProjectMintingVerdictRow): ProjectMintingAcceptResult | null {
  if (!row.accepted_result) return null;
  try {
    const parsed = JSON.parse(row.accepted_result);
    return parsed && typeof parsed === "object" ? (parsed as ProjectMintingAcceptResult) : null;
  } catch {
    return null;
  }
}

export function maxProjectConfidence(verdict: ClusterVerdict): number {
  return verdict.projects.reduce((max, project) => Math.max(max, CONFIDENCE_RANK[project.confidence]), 0);
}

function normalizeProjectName(name: string): string {
  return (
    normalizeName(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

function renameFor(name: string, renameMap: Record<string, string>): string {
  const renamed = renameMap[name]?.trim();
  return renamed || name;
}

function shouldWriteNoEntities(kind: CounterpartyKind, stage: ClientStage | null): boolean {
  if (!kindCarriesStage(kind)) return true;
  return stage === "dormant" || stage === "ended";
}

function projectSourceId(companyEntityId: string | null, originalName: string): string {
  return `${ACCEPT_SOURCE}:${companyEntityId ?? "internal"}:project:${normalizeProjectName(originalName)}`;
}

function engagementSourceId(companyEntityId: string | null, originalName: string): string {
  return `${ACCEPT_SOURCE}:${companyEntityId ?? "internal"}:engagement:${normalizeProjectName(originalName)}`;
}

function relationId(sourceId: string, targetId: string, relationType: "engagement_for" | "part_of"): string {
  return `${RELATION_SOURCE}:${relationType}:${sourceId}:${targetId}`;
}

async function currentDeclarationForCluster(
  db: Kysely<DB>,
  container: AcceptanceContainer,
): Promise<{ counterpartyKind: CounterpartyKind; clientStage: ClientStage | null } | null> {
  if (container.companyEntityId === null) return null;
  const declaredById = new Map(
    (await createCompanyRelationshipDeclarationRepository(db).list()).map((row) => [row.subject_entity_id, row]),
  );
  const declaration = resolveDeclaration(
    container.groupMembers.map((member) => declaredById.get(member.entityId)).filter((row) => row != null),
  );
  if (!declaration) return null;
  return {
    counterpartyKind: declaration.counterparty_kind as CounterpartyKind,
    clientStage: declaration.client_stage as ClientStage | null,
  };
}

function assertCurrentDeclarationMatchesSnapshot(
  row: ProjectMintingVerdictRow,
  current: { counterpartyKind: CounterpartyKind; clientStage: ClientStage | null } | null,
): void {
  const snapshotKind = row.declared_counterparty_kind;
  const snapshotStage = row.declared_client_stage;
  const currentKind = current?.counterpartyKind ?? null;
  const currentStage = current?.clientStage ?? null;
  if (currentKind !== snapshotKind || currentStage !== snapshotStage) {
    throw new ProjectMintingAcceptanceError("STALE_VERDICT", "stale verdict — re-run the cluster", {
      storedDeclaration: { counterpartyKind: snapshotKind, clientStage: snapshotStage },
      currentDeclaration: { counterpartyKind: currentKind, clientStage: currentStage },
    });
  }
}

function acceptedProjectsForConfirmedAxes(
  verdict: ClusterVerdict,
  input: { confirmedCounterpartyKind: CounterpartyKind; confirmedClientStage: ClientStage | null },
  struck: Set<string>,
  isV2: boolean,
  isInternal: boolean,
): {
  acceptedProjects: ClusterVerdict["projects"];
  shouldWriteNothing: boolean;
  shouldWriteEngagement: boolean;
  droppedByGate: ProjectMintingAcceptResult["droppedByGate"];
} {
  assertStageMatchesKind(input.confirmedCounterpartyKind, input.confirmedClientStage);
  const projectsAfterStrike = verdict.projects.filter((project) => !struck.has(project.name));
  const engagementName = verdict.engagement?.name ?? null;
  if (isInternal) {
    return {
      acceptedProjects: projectsAfterStrike,
      shouldWriteNothing: false,
      shouldWriteEngagement: false,
      droppedByGate: { engagement: engagementName, projects: [], unmergedFragments: [] },
    };
  }
  if (shouldWriteNoEntities(input.confirmedCounterpartyKind, input.confirmedClientStage)) {
    return {
      acceptedProjects: [],
      shouldWriteNothing: true,
      shouldWriteEngagement: false,
      droppedByGate: {
        engagement: engagementName,
        projects: projectsAfterStrike.map((project) => project.name).sort(),
        unmergedFragments: [],
      },
    };
  }
  if (input.confirmedClientStage === "prospect") {
    return {
      acceptedProjects: projectsAfterStrike,
      shouldWriteNothing: false,
      shouldWriteEngagement: false,
      droppedByGate: { engagement: engagementName, projects: [], unmergedFragments: [] },
    };
  }
  if (input.confirmedClientStage === "pilot") {
    if (projectsAfterStrike.length === 0) {
      throw new ProjectMintingAcceptanceError(
        "INVALID_ACCEPTANCE_SHAPE",
        "pilot acceptance requires at least one project",
      );
    }
    return {
      acceptedProjects: projectsAfterStrike,
      shouldWriteNothing: false,
      shouldWriteEngagement: false,
      droppedByGate: { engagement: engagementName, projects: [], unmergedFragments: [] },
    };
  }
  if (isV2) {
    if (!projectsAfterStrike.some((project) => project.parentName === null)) {
      throw new ProjectMintingAcceptanceError(
        "INVALID_ACCEPTANCE_SHAPE",
        "active acceptance requires the top-level account project",
      );
    }
    return {
      acceptedProjects: projectsAfterStrike,
      shouldWriteNothing: false,
      shouldWriteEngagement: false,
      droppedByGate: { engagement: null, projects: [], unmergedFragments: [] },
    };
  }
  if (!verdict.engagement) {
    throw new ProjectMintingAcceptanceError("INVALID_ACCEPTANCE_SHAPE", "active acceptance requires an engagement");
  }
  return {
    acceptedProjects: projectsAfterStrike,
    shouldWriteNothing: false,
    shouldWriteEngagement: true,
    droppedByGate: { engagement: null, projects: [], unmergedFragments: [] },
  };
}

async function loadClusterFiles(db: Kysely<DB>, fileIds: string[]): Promise<ClusterFile[]> {
  const files: ClusterFile[] = [];
  for (let i = 0; i < fileIds.length; i += 500) {
    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "source", "source_created_at", "synced_at"])
      .where("id", "in", fileIds.slice(i, i + 500))
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

async function findCurrentContainer(
  db: Kysely<DB>,
  verdictRow: ProjectMintingVerdictRow,
): Promise<AcceptanceContainer> {
  if (verdictRow.company_entity_id === null) {
    const partition = await partitionFiles(db);
    return {
      companyEntityId: null,
      companyName: verdictRow.company_name,
      groupMembers: [],
      files: await loadClusterFiles(db, [...partition.internal]),
    };
  }
  const clusters = await clusterClientFiles(db, { minFiles: 1 });
  const cluster = clusters.find((candidate) =>
    candidate.groupMembers.some((member) => member.entityId === verdictRow.company_entity_id),
  );
  if (!cluster) {
    throw new ProjectMintingAcceptanceError(
      "CLUSTER_NOT_FOUND",
      "Current cluster no longer contains the verdict company",
      {
        companyEntityId: verdictRow.company_entity_id,
      },
    );
  }
  return {
    companyEntityId: cluster.companyEntityId,
    companyName: cluster.companyName,
    groupMembers: cluster.groupMembers,
    files: cluster.files,
  };
}

/**
 * Every key here must be a string the dossier actually printed, because the
 * model can only echo back what it was shown. Keying on anything else — a bare
 * name where the dossier rendered `Name <email>`, a different set of fact
 * types than the dossier gathered — makes every anchor of that kind miss, and
 * the miss surfaces as a refusal to accept the whole verdict.
 */
async function buildAnchorMaps(db: Kysely<DB>, cluster: AcceptanceContainer, citedFragmentIds: string[]) {
  const titleFamilies = new Map<string, Set<string>>();
  for (const file of cluster.files) {
    const family = normalizeTitleFamily(file.fileName).key;
    const set = titleFamilies.get(family) ?? new Set<string>();
    set.add(file.fileId);
    titleFamilies.set(family, set);
  }

  const fileIds = cluster.files.map((file) => file.fileId);
  const repos = new Map<string, Set<string>>();
  if (fileIds.length > 0) {
    for (let i = 0; i < fileIds.length; i += 100) {
      const rows = await db
        .selectFrom("indexed_files")
        .select(["id", "content"])
        .where("id", "in", fileIds.slice(i, i + 100))
        .execute();
      for (const row of rows) {
        for (const match of (row.content ?? "").matchAll(GITHUB_REPO_PATTERN)) {
          const repo = `github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`.toLowerCase();
          const set = repos.get(repo) ?? new Set<string>();
          set.add(row.id);
          repos.set(repo, set);
        }
      }
    }
  }

  const people = new Map<string, Set<string>>();
  if (fileIds.length > 0) {
    const rows = await db
      .selectFrom("indexed_file_facts")
      .select(["indexed_file_id as fileId", "subject_name as name", "subject_email as email"])
      .where("indexed_file_id", "in", fileIds)
      .where("fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
      .where("deleted_at", "is", null)
      .where("subject_name", "is not", null)
      .execute();
    for (const row of rows) {
      const name = row.name?.trim();
      if (!row.fileId || !name) continue;
      const email = row.email?.trim();
      for (const key of email ? [`${name} <${email}>`, name] : [name]) {
        const set = people.get(key.toLowerCase()) ?? new Set<string>();
        set.add(row.fileId);
        people.set(key.toLowerCase(), set);
      }
    }
  }

  const fragmentMentions = new Map<string, Set<string>>();
  if (fileIds.length > 0 && citedFragmentIds.length > 0) {
    for (let i = 0; i < citedFragmentIds.length; i += 500) {
      const rows = await db
        .selectFrom("entity_mentions")
        .select(["entity_id as entityId", "indexed_file_id as fileId"])
        .where("entity_id", "in", citedFragmentIds.slice(i, i + 500))
        .where("indexed_file_id", "in", fileIds)
        .execute();
      for (const row of rows) {
        if (!row.fileId) continue;
        const set = fragmentMentions.get(row.entityId) ?? new Set<string>();
        set.add(row.fileId);
        fragmentMentions.set(row.entityId, set);
      }
    }
  }

  return { titleFamilies, repos, people, fragmentMentions };
}

/**
 * A missing anchor is a warning, not a refusal. The model paraphrases — it will
 * write "Mobile App Redesign" for the family "Mobile App Redesign <> Amitesh" —
 * and refusing the whole verdict over one paraphrase leaves the reviewer no
 * path but reject-and-re-run, which costs another model call and can paraphrase
 * again. The anchors that did resolve are still good evidence, and files that
 * match no project already fall back to the residual target.
 *
 * The one case that is still fatal: a project that named anchors and had every
 * one of them miss. Nothing connects it to the corpus, so minting it would
 * create an entity on no evidence. A project that named no anchors at all is
 * left alone — that is a different decision, and today it is allowed.
 */
function resolveProjectAnchors(
  verdict: ClusterVerdict,
  acceptedOriginalNames: Set<string>,
  maps: Awaited<ReturnType<typeof buildAnchorMaps>>,
): { projectFiles: Map<string, Set<string>>; unresolvedAnchors: string[]; groundlessProjects: string[] } {
  const projectFiles = new Map<string, Set<string>>();
  const unresolvedAnchors: string[] = [];
  const groundlessProjects: string[] = [];
  for (const project of verdict.projects) {
    if (!acceptedOriginalNames.has(project.name)) continue;
    const files = new Set<string>();
    let declaredAnchors = 0;
    for (const family of project.evidenceTitleFamilies) {
      declaredAnchors++;
      const matched = maps.titleFamilies.get(normalizeTitleFamily(family).key);
      if (!matched) unresolvedAnchors.push(`title family "${family}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    for (const repo of project.evidenceRepos) {
      declaredAnchors++;
      const matched = maps.repos.get(repo.toLowerCase());
      if (!matched) unresolvedAnchors.push(`repo "${repo}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    for (const person of project.evidencePeople) {
      declaredAnchors++;
      const matched = maps.people.get(person.trim().toLowerCase());
      if (!matched) unresolvedAnchors.push(`person "${person}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    for (const fragmentId of project.evidenceFragments) {
      declaredAnchors++;
      const matched = maps.fragmentMentions.get(fragmentId);
      if (!matched || matched.size === 0) {
        unresolvedAnchors.push(`fragment "${fragmentId}" on project "${project.name}"`);
      } else {
        for (const fileId of matched) files.add(fileId);
      }
    }
    if (declaredAnchors > 0 && files.size === 0) groundlessProjects.push(project.name);
    projectFiles.set(project.name, files);
  }
  return { projectFiles, unresolvedAnchors, groundlessProjects };
}

async function attachSourceRef(db: Kysely<DB>, entityId: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      source: ACCEPT_SOURCE,
      source_id: sourceId,
      source_url: null,
      last_seen_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.columns(["source", "source_id"]).doNothing())
    .execute();
}

async function adoptOrCreateProjectEntity(
  db: Kysely<DB>,
  input: {
    companyEntityId: string | null;
    originalName: string;
    name: string;
    sourceId: string;
    canonicalEntityId?: string;
    subtype: string | null;
    lifecycleStatus: ProjectLifecycleStatus | null;
  },
): Promise<string> {
  if (input.canonicalEntityId) {
    const now = new Date().toISOString();
    await db
      .updateTable("entities")
      .set({
        name: input.name,
        subtype: input.subtype,
        project_lifecycle_status: input.lifecycleStatus,
        status: "confirmed",
        updated_at: now,
      })
      .where("id", "=", input.canonicalEntityId)
      .where("source_type", "=", "project")
      .where(whereLiveEntity())
      .execute();
    await attachSourceRef(db, input.canonicalEntityId, input.sourceId);
    return input.canonicalEntityId;
  }

  const entity = await createEntityRepository(db).upsertEntityFromTool({
    name: input.name,
    sourceType: "project",
    source: ACCEPT_SOURCE,
    sourceId: input.sourceId,
    provenanceTier: "inferred",
    metadata: {
      projectMinting: {
        companyEntityId: input.companyEntityId,
        originalName: input.originalName,
      },
    },
  });
  await db
    .updateTable("entities")
    .set({
      subtype: input.subtype,
      project_lifecycle_status: input.lifecycleStatus,
      status: "confirmed",
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", entity.id)
    .execute();
  return entity.id;
}

async function ensureRelationship(
  db: Kysely<DB>,
  sourceEntityId: string,
  targetEntityId: string,
  relationshipType: "engagement_for" | "part_of",
): Promise<void> {
  if (relationshipType === "part_of") {
    try {
      await assertNoPartOfCycle(db, sourceEntityId, targetEntityId);
    } catch (err) {
      if (err instanceof ProjectBindingError && err.code === "WOULD_CYCLE") {
        throw new ProjectMintingAcceptanceError("WOULD_CYCLE", "Acceptance would create a project hierarchy cycle", {
          sourceEntityId,
          targetEntityId,
        });
      }
      throw err;
    }
  }
  await db
    .insertInto("entity_relationships")
    .values({
      id: relationId(sourceEntityId, targetEntityId, relationshipType),
      source_entity_id: sourceEntityId,
      target_entity_id: targetEntityId,
      relationship_type: relationshipType,
      confidence: "CONFIRMED",
      confidence_score: 1,
      source: RELATION_SOURCE,
      valid_from: "",
      valid_to: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(["source_entity_id", "target_entity_id", "relationship_type", "valid_from"]).doNothing(),
    )
    .execute();
}

async function insertMention(db: Kysely<DB>, entityId: string, fileId: string): Promise<void> {
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
      ${fileId},
      NULL,
      NULL,
      'CONFIRMED',
      ${RELATION_SOURCE},
      'mentioned',
      ${new Date().toISOString()}
    )
    ON CONFLICT (entity_id, indexed_file_id, relation) DO NOTHING
  `.execute(db);
}

async function mergeFragment(
  db: Kysely<DB>,
  input: { survivorId: string; loserId: string; actorUserId: string; survivorName: string; verdictId: string },
): Promise<string | null> {
  try {
    const result = await mergeEntities(db, {
      survivorId: input.survivorId,
      loserId: input.loserId,
      userId: input.actorUserId,
      groupId: `project-minting:${input.verdictId}`,
      mergedBy: RELATION_SOURCE,
      survivorName: input.survivorName,
    });
    return result.mergeId;
  } catch (err) {
    if (err instanceof EntityMergeError && err.code === "ALREADY_MERGED") {
      const loser = await db
        .selectFrom("entities")
        .select("merged_into_entity_id")
        .where("id", "=", input.loserId)
        .executeTakeFirst();
      if (loser?.merged_into_entity_id === input.survivorId) return null;
    }
    throw err;
  }
}

interface AcceptancePlan {
  row: ProjectMintingVerdictRow;
  verdict: ClusterVerdict;
  isV2: boolean;
  container: AcceptanceContainer;
  input: AcceptProjectMintingVerdictInput;
  struckProjects: string[];
  acceptedProjects: ClusterVerdict["projects"];
  shouldWriteNothing: boolean;
  shouldWriteEngagement: boolean;
  droppedByGate: ProjectMintingAcceptResult["droppedByGate"];
  unresolvedAnchors: string[];
  projectFiles: Map<string, Set<string>>;
  canonicalByName: Map<string, string>;
  renameMap: Record<string, string>;
  /** Accepted projects ordered parents-before-children (v1 order = verdict order). */
  orderedProjects: ClusterVerdict["projects"];
  /** Residual files land here; null when nothing should catch them. */
  residualTarget: { kind: "engagement" } | { kind: "project"; originalName: string } | null;
  plannedMerges: { entityId: string; intoOriginalName: string }[];
}

type AcceptanceContainer = {
  companyEntityId: string | null;
  companyName: string;
  groupMembers: ClientCluster["groupMembers"];
  files: ClusterFile[];
};

/**
 * Everything acceptance decides, with zero writes: gates, strikes, anchors,
 * parent ordering, merge routing, residual routing. `applyAcceptancePlan`
 * only executes this plan, which is what makes dryRun honest — the dry run
 * and the real accept share every branch up to the first write.
 */
async function planAcceptance(
  db: Kysely<DB>,
  row: ProjectMintingVerdictRow,
  input: AcceptProjectMintingVerdictInput,
): Promise<AcceptancePlan> {
  const isV2 = isV2MintingVerdict(row.prompt_version);
  const verdict = readClusterVerdict(JSON.parse(row.verdict), { strict: isV2 });
  const flags = parseJsonArray(row.flags);
  if (flags.length > 0 && !input.overrideTripwireFlags) {
    throw new ProjectMintingAcceptanceError("TRIPWIRE_BLOCKED", "Tripwire flags require explicit override", { flags });
  }

  const container = await findCurrentContainer(db, row);
  const currentDeclared = await currentDeclarationForCluster(db, container);
  assertCurrentDeclarationMatchesSnapshot(row, currentDeclared);

  const struckProjects = [...new Set(input.struckProjectNames ?? [])]
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  const struck = new Set(struckProjects);
  for (const disposition of verdict.existingEntities) {
    if (disposition.disposition === "merge_into" && disposition.mergeInto && struck.has(disposition.mergeInto)) {
      throw new ProjectMintingAcceptanceError(
        "STRIKE_CASCADE",
        "Striking a merge target would leave an existing fragment unresolved",
        { projectName: disposition.mergeInto, entityId: disposition.entityId },
      );
    }
  }
  if (isV2) {
    const projectByName = new Map(verdict.projects.map((project) => [project.name, project]));
    for (const project of verdict.projects) {
      if (struck.has(project.name)) continue;
      let ancestor = project.parentName;
      while (ancestor) {
        if (struck.has(ancestor)) {
          throw new ProjectMintingAcceptanceError(
            "STRIKE_CASCADE",
            "Striking a parent project would orphan a surviving child",
            { struckParent: ancestor, survivingChild: project.name },
          );
        }
        ancestor = projectByName.get(ancestor)?.parentName ?? null;
      }
    }
  }

  const renameMap = input.renameMap ?? {};
  const { acceptedProjects, shouldWriteNothing, shouldWriteEngagement, droppedByGate } =
    acceptedProjectsForConfirmedAxes(verdict, input, struck, isV2, container.companyEntityId === null);
  const acceptedOriginalNames = new Set(acceptedProjects.map((project) => project.name));
  const citedFragmentIds = [...new Set(acceptedProjects.flatMap((project) => project.evidenceFragments))];
  const anchorMaps = await buildAnchorMaps(db, container, citedFragmentIds);
  const { projectFiles, unresolvedAnchors, groundlessProjects } = resolveProjectAnchors(
    verdict,
    acceptedOriginalNames,
    anchorMaps,
  );
  if (groundlessProjects.length > 0) {
    throw new ProjectMintingAcceptanceError(
      "ANCHOR_NOT_FOUND",
      "Every anchor on one or more projects resolved to no files",
      { projects: groundlessProjects, anchors: unresolvedAnchors },
    );
  }

  const canonicalByName = new Map<string, string>();
  for (const disposition of verdict.existingEntities) {
    if (disposition.disposition === "canonical") canonicalByName.set(disposition.name, disposition.entityId);
  }

  const orderedProjects: ClusterVerdict["projects"] = [];
  if (isV2) {
    const placed = new Set<string>();
    let remaining = [...acceptedProjects];
    while (remaining.length > 0) {
      const next = remaining.filter(
        (project) =>
          !project.parentName || placed.has(project.parentName) || !acceptedOriginalNames.has(project.parentName),
      );
      if (next.length === 0) {
        throw new ProjectMintingAcceptanceError("WOULD_CYCLE", "Accepted projects do not form a forest");
      }
      for (const project of next) {
        orderedProjects.push(project);
        placed.add(project.name);
      }
      remaining = remaining.filter((project) => !placed.has(project.name));
    }
  } else {
    orderedProjects.push(...acceptedProjects);
  }

  let residualTarget: AcceptancePlan["residualTarget"] = null;
  if (isV2) {
    const topLevel = acceptedProjects.filter(
      (project) => !project.parentName || !acceptedOriginalNames.has(project.parentName),
    );
    if (topLevel.length === 1) residualTarget = { kind: "project", originalName: topLevel[0].name };
  } else if (shouldWriteEngagement && verdict.engagement) {
    residualTarget = { kind: "engagement" };
  } else if (acceptedProjects.length === 1 || (input.confirmedClientStage === "pilot" && acceptedProjects.length > 0)) {
    residualTarget = { kind: "project", originalName: acceptedProjects[0].name };
  }

  const plannedMerges: AcceptancePlan["plannedMerges"] = [];
  if (!shouldWriteNothing) {
    for (const disposition of verdict.existingEntities) {
      if (disposition.disposition !== "merge_into" || !disposition.mergeInto) continue;
      const targetsAcceptedProject = acceptedOriginalNames.has(disposition.mergeInto);
      const targetsEngagement = !isV2 && shouldWriteEngagement && disposition.mergeInto === verdict.engagement?.name;
      if (targetsAcceptedProject || targetsEngagement) {
        plannedMerges.push({ entityId: disposition.entityId, intoOriginalName: disposition.mergeInto });
      } else {
        droppedByGate.unmergedFragments.push({ entityId: disposition.entityId, intoName: disposition.mergeInto });
      }
    }
  } else {
    for (const disposition of verdict.existingEntities) {
      if (disposition.disposition === "merge_into" && disposition.mergeInto) {
        droppedByGate.unmergedFragments.push({ entityId: disposition.entityId, intoName: disposition.mergeInto });
      }
    }
  }

  return {
    row,
    verdict,
    isV2,
    container,
    input,
    struckProjects,
    acceptedProjects,
    shouldWriteNothing,
    shouldWriteEngagement,
    droppedByGate,
    unresolvedAnchors,
    projectFiles,
    canonicalByName,
    renameMap,
    orderedProjects,
    residualTarget,
    plannedMerges,
  };
}

function planResult(
  plan: AcceptancePlan,
): Omit<ProjectMintingAcceptResult, "entityIds" | "entities" | "mergeIds" | "taskParentUpdates"> {
  const declaration =
    plan.container.companyEntityId === null
      ? null
      : {
          subjectEntityId: plan.container.companyEntityId,
          counterpartyKind: plan.input.confirmedCounterpartyKind,
          clientStage: plan.input.confirmedClientStage,
        };
  return {
    verdictId: plan.row.id,
    status: "accepted",
    struckProjects: plan.struckProjects,
    droppedByGate: plan.droppedByGate,
    unresolvedAnchors: plan.unresolvedAnchors,
    declaration,
    drift: {
      stance: "live_recompute",
      reviewedFileCount: plan.row.file_count,
      acceptedFileCount: plan.container.files.length,
      addedSinceVerdict: Math.max(0, plan.container.files.length - plan.row.file_count),
    },
  };
}

/**
 * Dry run: the plan's shape without ids that only exist after writes.
 * Adopted entities show their canonical id; to-be-created ones show null.
 */
function dryRunResult(plan: AcceptancePlan): ProjectMintingAcceptResult {
  const entities: AcceptedEntitySummary[] = [];
  if (plan.shouldWriteEngagement && plan.verdict.engagement) {
    const originalName = plan.verdict.engagement.name;
    entities.push({
      id: plan.canonicalByName.get(originalName) ?? "",
      name: renameFor(originalName, plan.renameMap),
      kind: "engagement",
      parentId: null,
      fileIds: [],
    });
  }
  if (!plan.shouldWriteNothing) {
    for (const project of plan.orderedProjects) {
      entities.push({
        id: plan.canonicalByName.get(project.name) ?? "",
        name: renameFor(project.name, plan.renameMap),
        kind: "project",
        parentId: null,
        fileIds: [...(plan.projectFiles.get(project.name) ?? [])].sort(),
      });
    }
  }
  const residualTarget =
    plan.residualTarget === null
      ? null
      : plan.residualTarget.kind === "engagement"
        ? plan.verdict.engagement
          ? renameFor(plan.verdict.engagement.name, plan.renameMap)
          : null
        : renameFor(plan.residualTarget.originalName, plan.renameMap);
  return {
    ...planResult(plan),
    entityIds: { engagementId: null, projectIds: [] },
    entities,
    mergeIds: [],
    taskParentUpdates: 0,
    residualTarget,
    dryRun: true,
  };
}

async function parentTasksForFiles(db: Kysely<DB>, entityId: string, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await db
    .selectFrom("tasks")
    .select("id")
    .where("parent_entity_id", "is", null)
    .where("id", "in", (eb) =>
      eb.selectFrom("task_evidence").select("task_id").where("kind", "=", "file").where("ref_id", "in", fileIds),
    )
    .execute();
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id).sort();
  await db
    .updateTable("tasks")
    .set({ parent_entity_id: entityId, updated_at: new Date().toISOString() })
    .where("parent_entity_id", "is", null)
    .where("id", "in", ids)
    .execute();
  return ids;
}

/**
 * Retro-claim: after a v2 accept decides which entities exist, scan the
 * cluster's file CONTENT for each accepted project's names (the project name,
 * its renamed form, every fragment merged into it, and every cited evidence
 * fragment) and claim matching files the anchors missed — stored mentions
 * undercount content 5-6x. Children are claimed before parents so an account
 * container named after the company cannot swallow a workstream's files;
 * whatever nothing claims still falls to the residual target afterwards.
 */
async function retroClaimFiles(
  db: Kysely<DB>,
  plan: AcceptancePlan,
  projectIdsByOriginalName: Map<string, string>,
  filesByEntity: Map<string, Set<string>>,
  anchoredToAccepted: Set<string>,
): Promise<Map<string, Set<string>>> {
  const fragmentNameById = new Map(plan.verdict.existingEntities.map((entity) => [entity.entityId, entity.name]));
  const candidates: { key: string; tokens: string[] }[] = [];
  const entityByKey = new Map<string, string>();
  for (const project of plan.orderedProjects) {
    const entityId = projectIdsByOriginalName.get(project.name);
    if (!entityId) continue;
    const names = new Set<string>([project.name, renameFor(project.name, plan.renameMap)]);
    for (const merge of plan.plannedMerges) {
      if (merge.intoOriginalName === project.name) {
        const fragmentName = fragmentNameById.get(merge.entityId);
        if (fragmentName) names.add(fragmentName);
      }
    }
    for (const fragmentId of project.evidenceFragments) {
      const fragmentName = fragmentNameById.get(fragmentId);
      if (fragmentName) names.add(fragmentName);
    }
    for (const name of names) {
      const tokens = fragmentNameTokens(name);
      if (tokens.length === 0) continue;
      const key = `${entityId}:${candidates.length}`;
      candidates.push({ key, tokens });
      entityByKey.set(key, entityId);
    }
  }
  const claimedByEntity = new Map<string, Set<string>>();
  if (candidates.length === 0) return claimedByEntity;

  const scan = await scanTokenRecurrence(db, {
    candidates,
    fileIds: plan.container.files.map((file) => file.fileId),
  });
  const matchesByEntity = new Map<string, Set<string>>();
  for (const [key, recurrence] of scan) {
    const entityId = entityByKey.get(key);
    if (!entityId) continue;
    const set = matchesByEntity.get(entityId) ?? new Set<string>();
    for (const fileId of recurrence.files) set.add(fileId);
    matchesByEntity.set(entityId, set);
  }

  const claimedGlobally = new Set<string>();
  for (const project of [...plan.orderedProjects].reverse()) {
    const entityId = projectIdsByOriginalName.get(project.name);
    if (!entityId) continue;
    const own = filesByEntity.get(entityId) ?? new Set<string>();
    const claimed = new Set<string>();
    for (const fileId of matchesByEntity.get(entityId) ?? []) {
      if (own.has(fileId) || claimedGlobally.has(fileId)) continue;
      own.add(fileId);
      claimed.add(fileId);
      claimedGlobally.add(fileId);
      anchoredToAccepted.add(fileId);
    }
    filesByEntity.set(entityId, own);
    claimedByEntity.set(entityId, claimed);
  }
  return claimedByEntity;
}

/**
 * Tasks re-parented because their evidence sits on a retro-claimed file get
 * a task_evidence row pointing at the project entity — the WHY of the
 * re-parent, recorded where task evidence already lives.
 */
async function recordClaimEvidence(
  db: Kysely<DB>,
  entityId: string,
  reparentedTaskIds: string[],
  claimedFileIds: Set<string>,
): Promise<number> {
  if (reparentedTaskIds.length === 0 || claimedFileIds.size === 0) return 0;
  const rows = await db
    .selectFrom("task_evidence")
    .select("task_id")
    .where("kind", "=", "file")
    .where("ref_id", "in", [...claimedFileIds])
    .where("task_id", "in", reparentedTaskIds)
    .execute();
  const taskIds = [...new Set(rows.map((row) => row.task_id))].sort();
  for (const taskId of taskIds) {
    await db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: "entity", ref_id: entityId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  return taskIds.length;
}

async function earliestFileDay(db: Kysely<DB>, fileIds: string[]): Promise<string | null> {
  if (fileIds.length === 0) return null;
  let earliest: string | null = null;
  for (let i = 0; i < fileIds.length; i += 200) {
    const row = await db
      .selectFrom("indexed_files")
      .select(sql<string | null>`min(coalesce(source_created_at, synced_at))`.as("first"))
      .where("id", "in", fileIds.slice(i, i + 200))
      .executeTakeFirst();
    const value = row?.first ? row.first.slice(0, 10) : null;
    if (value && (!earliest || value < earliest)) earliest = value;
  }
  return earliest;
}

async function resolveStandingProductParent(db: Kysely<DB>, entityId: string): Promise<string | null> {
  const row = await db
    .selectFrom("entities")
    .select("id")
    .where("id", "=", entityId)
    .where("source_type", "=", "product")
    .where("provenance_tier", "in", ["declared", "human_confirmed"])
    .where(whereLiveEntity())
    .executeTakeFirst();
  return row?.id ?? null;
}

async function applyAcceptancePlan(db: Kysely<DB>, plan: AcceptancePlan): Promise<ProjectMintingAcceptResult> {
  const { verdict, container, renameMap, canonicalByName } = plan;
  const projectIdsByOriginalName = new Map<string, string>();
  const parentIdByEntityId = new Map<string, string | null>();
  const projectIds: string[] = [];
  let engagementId: string | null = null;
  const entities: AcceptedEntitySummary[] = [];

  if (plan.shouldWriteEngagement && verdict.engagement) {
    const originalName = verdict.engagement.name;
    const name = renameFor(originalName, renameMap);
    engagementId = await adoptOrCreateProjectEntity(db, {
      companyEntityId: container.companyEntityId,
      originalName,
      name,
      sourceId: engagementSourceId(container.companyEntityId, originalName),
      canonicalEntityId: canonicalByName.get(originalName),
      subtype: "engagement",
      lifecycleStatus: null,
    });
    parentIdByEntityId.set(engagementId, null);
    if (container.companyEntityId)
      await ensureRelationship(db, engagementId, container.companyEntityId, "engagement_for");
  }

  if (!plan.shouldWriteNothing) {
    for (const project of plan.orderedProjects) {
      const name = renameFor(project.name, renameMap);
      const entityId = await adoptOrCreateProjectEntity(db, {
        companyEntityId: container.companyEntityId,
        originalName: project.name,
        name,
        sourceId: projectSourceId(container.companyEntityId, project.name),
        canonicalEntityId: canonicalByName.get(project.name),
        subtype: null,
        lifecycleStatus: project.status,
      });
      projectIdsByOriginalName.set(project.name, entityId);
      projectIds.push(entityId);
      const parentEntityId =
        plan.isV2 && project.parentName ? (projectIdsByOriginalName.get(project.parentName) ?? null) : null;
      const productParentEntityId =
        !parentEntityId && container.companyEntityId === null && project.parentEntityId
          ? await resolveStandingProductParent(db, project.parentEntityId)
          : null;
      if (parentEntityId) {
        try {
          await assertNoPartOfCycle(db, entityId, parentEntityId);
        } catch {
          throw new ProjectMintingAcceptanceError(
            "WOULD_CYCLE",
            `Parenting "${project.name}" under "${project.parentName}" would create a cycle`,
            { childId: entityId, parentId: parentEntityId },
          );
        }
        await ensureRelationship(db, entityId, parentEntityId, "part_of");
        parentIdByEntityId.set(entityId, parentEntityId);
      } else if (productParentEntityId) {
        await ensureRelationship(db, entityId, productParentEntityId, "part_of");
        parentIdByEntityId.set(entityId, productParentEntityId);
      } else if (project.parentEntityId && container.companyEntityId === null) {
        plan.unresolvedAnchors.push(`standing product "${project.parentEntityId}" on project "${project.name}"`);
        parentIdByEntityId.set(entityId, null);
      } else if (plan.isV2 && container.companyEntityId) {
        await ensureRelationship(db, entityId, container.companyEntityId, "engagement_for");
        parentIdByEntityId.set(entityId, null);
      } else if (engagementId) {
        await ensureRelationship(db, entityId, engagementId, "part_of");
        parentIdByEntityId.set(entityId, engagementId);
      } else if (container.companyEntityId) {
        await ensureRelationship(db, entityId, container.companyEntityId, "engagement_for");
        parentIdByEntityId.set(entityId, null);
      } else {
        parentIdByEntityId.set(entityId, null);
      }
    }
  }

  const anchoredToAccepted = new Set<string>();
  const filesByEntity = new Map<string, Set<string>>();
  for (const project of plan.acceptedProjects) {
    const entityId = projectIdsByOriginalName.get(project.name);
    if (!entityId) continue;
    const files = plan.projectFiles.get(project.name) ?? new Set<string>();
    filesByEntity.set(entityId, files);
    for (const fileId of files) anchoredToAccepted.add(fileId);
  }

  const retroClaimByEntity = plan.isV2
    ? await retroClaimFiles(db, plan, projectIdsByOriginalName, filesByEntity, anchoredToAccepted)
    : new Map<string, Set<string>>();

  const residualTargetId =
    plan.residualTarget === null
      ? null
      : plan.residualTarget.kind === "engagement"
        ? engagementId
        : (projectIdsByOriginalName.get(plan.residualTarget.originalName) ?? null);
  if (residualTargetId) {
    const residual = filesByEntity.get(residualTargetId) ?? new Set<string>();
    for (const file of container.files) {
      if (!anchoredToAccepted.has(file.fileId)) residual.add(file.fileId);
    }
    filesByEntity.set(residualTargetId, residual);
  }

  const mergeIds: string[] = [];
  for (const merge of plan.plannedMerges) {
    const survivorId =
      projectIdsByOriginalName.get(merge.intoOriginalName) ??
      (engagementId && merge.intoOriginalName === verdict.engagement?.name ? engagementId : null);
    if (!survivorId) {
      plan.droppedByGate.unmergedFragments.push({ entityId: merge.entityId, intoName: merge.intoOriginalName });
      continue;
    }
    const mergeId = await mergeFragment(db, {
      survivorId,
      loserId: merge.entityId,
      actorUserId: plan.input.actorUserId,
      survivorName: renameFor(merge.intoOriginalName, renameMap),
      verdictId: plan.row.id,
    });
    if (mergeId) mergeIds.push(mergeId);
  }

  let taskParentUpdates = 0;
  for (const [entityId, fileIds] of filesByEntity) {
    const orderedFileIds = [...fileIds].sort();
    for (const fileId of orderedFileIds) await insertMention(db, entityId, fileId);
    const reparentedTaskIds = await parentTasksForFiles(db, entityId, orderedFileIds);
    taskParentUpdates += reparentedTaskIds.length;
    const claimed = retroClaimByEntity.get(entityId) ?? new Set<string>();
    const tasksReparentedByClaim = await recordClaimEvidence(db, entityId, reparentedTaskIds, claimed);
    const kind = entityId === engagementId ? "engagement" : "project";
    const entity = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("id", "=", entityId)
      .executeTakeFirstOrThrow();
    entities.push({
      id: entity.id,
      name: entity.name,
      kind,
      parentId: parentIdByEntityId.get(entityId) ?? null,
      fileIds: orderedFileIds,
      ...(plan.isV2
        ? {
            retroClaim: { filesClaimed: claimed.size, tasksReparented: tasksReparentedByClaim },
            activeSinceAtLeast: await earliestFileDay(db, orderedFileIds),
          }
        : {}),
    });
  }

  return {
    ...planResult(plan),
    entityIds: { engagementId, projectIds },
    entities: entities.sort((a, b) => a.name.localeCompare(b.name)),
    mergeIds: mergeIds.sort(),
    taskParentUpdates,
  };
}

async function computeAcceptance(
  db: Kysely<DB>,
  row: ProjectMintingVerdictRow,
  input: AcceptProjectMintingVerdictInput,
): Promise<ProjectMintingAcceptResult> {
  if (row.status !== "pending" || row.superseded_at !== null) {
    const stored = parseStoredAcceptedResult(row);
    if (stored) return stored;
    throw new ProjectMintingAcceptanceError("NOT_PENDING", "Verdict has already been decided", { status: row.status });
  }
  const plan = await planAcceptance(db, row, input);
  if (input.dryRun) return dryRunResult(plan);
  return applyAcceptancePlan(db, plan);
}

export async function acceptProjectMintingVerdict(
  db: Kysely<DB>,
  input: AcceptProjectMintingVerdictInput,
): Promise<ProjectMintingAcceptResult> {
  return withMaterializeReplayQueue(async () => {
    const repo = createProjectMintingVerdictRepository(db);
    const row = await repo.findById(input.verdictId);
    if (!row) throw new ProjectMintingAcceptanceError("NOT_FOUND", "Project minting verdict not found");
    const result = await computeAcceptance(db, row, input);
    if (input.dryRun) return result;
    if (row.status === "pending" && row.superseded_at === null) {
      /**
       * Keep this order: read the registry in `planAcceptance`, check
       * staleness, gate the confirmed shape, write the graph, win the verdict
       * CAS, then declare. Declaring before staleness makes a verdict stale
       * against its own row; declaring before the CAS lets a losing concurrent
       * accept overwrite the winner's confirmed axes.
       */
      const won = await repo.markAccepted({
        id: row.id,
        actorUserId: input.actorUserId,
        struckProjects: result.struckProjects,
        result,
      });
      if (won && result.declaration) {
        await createCompanyRelationshipDeclarationRepository(db).declare({
          subjectEntityId: result.declaration.subjectEntityId,
          counterpartyKind: result.declaration.counterpartyKind,
          clientStage: result.declaration.clientStage,
        });
      }
      if (!won) {
        const current = await repo.findById(input.verdictId);
        if (current) {
          const stored = parseStoredAcceptedResult(current);
          if (stored) return stored;
        }
      }
    }
    return result;
  });
}

export async function rejectProjectMintingVerdict(
  db: Kysely<DB>,
  input: { verdictId: string; actorUserId: string },
): Promise<ProjectMintingVerdictRow> {
  const repo = createProjectMintingVerdictRepository(db);
  const row = await repo.findById(input.verdictId);
  if (!row) throw new ProjectMintingAcceptanceError("NOT_FOUND", "Project minting verdict not found");
  if (row.status === "pending" && row.superseded_at === null) {
    await repo.markRejected({ id: row.id, actorUserId: input.actorUserId });
  }
  const current = await repo.findById(input.verdictId);
  if (!current) throw new ProjectMintingAcceptanceError("NOT_FOUND", "Project minting verdict not found");
  return current;
}

import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
  type DeclaredRelationshipState,
  createCompanyRelationshipDeclarationRepository,
  isDeclaredRelationshipState,
} from "../db/repositories/company-relationship-declarations";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import {
  type ProjectMintingVerdictRow,
  createProjectMintingVerdictRepository,
} from "../db/repositories/project-minting-verdicts";
import type { DB } from "../db/schema";
import { withMaterializeReplayQueue } from "../entities/materialize-replay";
import { EntityMergeError, mergeEntities } from "../entities/merge";
import { normalizeName } from "./name-normalize";
import {
  type ClientCluster,
  type ClusterVerdict,
  type ProjectLifecycleStatus,
  type RelationshipState,
  type VerdictConfidence,
  clusterClientFiles,
  normalizeTitleFamily,
  readClusterVerdict,
} from "./project-minting";

const ACCEPT_SOURCE = "project-minting";
const RELATION_SOURCE = "project_minting_acceptance";
const GITHUB_REPO_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
const CONFIDENCE_RANK: Record<VerdictConfidence, number> = { high: 3, medium: 2, low: 1 };

export interface AcceptProjectMintingVerdictInput {
  verdictId: string;
  actorUserId: string;
  struckProjectNames?: string[];
  renameMap?: Record<string, string>;
  overrideTripwireFlags?: boolean;
}

export interface AcceptedEntitySummary {
  id: string;
  name: string;
  kind: "engagement" | "project";
  fileIds: string[];
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
  taskParentUpdates: number;
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
      | "CLUSTER_NOT_FOUND"
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

function mapDeclarationToRelationshipState(state: DeclaredRelationshipState): RelationshipState {
  return state === "paying" ? "customer" : "trial";
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

function isNoWriteState(state: RelationshipState): boolean {
  return state === "vendor" || state === "investor" || state === "none";
}

function projectSourceId(companyEntityId: string, originalName: string): string {
  return `${ACCEPT_SOURCE}:${companyEntityId}:project:${normalizeProjectName(originalName)}`;
}

function engagementSourceId(companyEntityId: string, originalName: string): string {
  return `${ACCEPT_SOURCE}:${companyEntityId}:engagement:${normalizeProjectName(originalName)}`;
}

function relationId(sourceId: string, targetId: string, relationType: "engagement_for" | "part_of"): string {
  return `${RELATION_SOURCE}:${relationType}:${sourceId}:${targetId}`;
}

function updatedCount(result: { numUpdatedRows?: bigint | number | string } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

async function currentDeclaredStateForCluster(
  db: Kysely<DB>,
  cluster: ClientCluster,
): Promise<DeclaredRelationshipState | null> {
  const declaredById = new Map<string, DeclaredRelationshipState>();
  for (const row of await createCompanyRelationshipDeclarationRepository(db).list()) {
    if (isDeclaredRelationshipState(row.declared_state)) declaredById.set(row.company_entity_id, row.declared_state);
  }
  return cluster.groupMembers.map((member) => declaredById.get(member.entityId)).find((state) => state != null) ?? null;
}

async function findCurrentCluster(db: Kysely<DB>, verdictRow: ProjectMintingVerdictRow): Promise<ClientCluster> {
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
  return cluster;
}

async function buildAnchorMaps(db: Kysely<DB>, cluster: ClientCluster) {
  const titleFamilies = new Map<string, Set<string>>();
  for (const file of cluster.files) {
    const family = normalizeTitleFamily(file.fileName).display;
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
      .select(["indexed_file_id as fileId", "subject_name as name"])
      .where("indexed_file_id", "in", fileIds)
      .where("fact_type", "in", ["attendee", "participant", "sender", "recipient", "cc"])
      .where("deleted_at", "is", null)
      .where("subject_name", "is not", null)
      .execute();
    for (const row of rows) {
      if (!row.fileId || !row.name?.trim()) continue;
      const set = people.get(row.name.trim()) ?? new Set<string>();
      set.add(row.fileId);
      people.set(row.name.trim(), set);
    }
  }

  return { titleFamilies, repos, people };
}

function resolveProjectAnchors(
  verdict: ClusterVerdict,
  acceptedOriginalNames: Set<string>,
  maps: Awaited<ReturnType<typeof buildAnchorMaps>>,
): { projectFiles: Map<string, Set<string>>; errors: string[] } {
  const projectFiles = new Map<string, Set<string>>();
  const errors: string[] = [];
  for (const project of verdict.projects) {
    if (!acceptedOriginalNames.has(project.name)) continue;
    const files = new Set<string>();
    for (const family of project.evidenceTitleFamilies) {
      const matched = maps.titleFamilies.get(family);
      if (!matched) errors.push(`title family "${family}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    for (const repo of project.evidenceRepos) {
      const matched = maps.repos.get(repo.toLowerCase());
      if (!matched) errors.push(`repo "${repo}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    for (const person of project.evidencePeople) {
      const matched = maps.people.get(person);
      if (!matched) errors.push(`person "${person}" on project "${project.name}"`);
      else for (const fileId of matched) files.add(fileId);
    }
    projectFiles.set(project.name, files);
  }
  return { projectFiles, errors };
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
    companyEntityId: string;
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

async function parentTasksForFiles(db: Kysely<DB>, entityId: string, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const result = await db
    .updateTable("tasks")
    .set({ parent_entity_id: entityId, updated_at: new Date().toISOString() })
    .where("parent_entity_id", "is", null)
    .where("id", "in", (eb) =>
      eb.selectFrom("task_evidence").select("task_id").where("kind", "=", "file").where("ref_id", "in", fileIds),
    )
    .executeTakeFirst();
  return updatedCount(result);
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

  const verdict = readClusterVerdict(JSON.parse(row.verdict));
  const flags = parseJsonArray(row.flags);
  if (flags.length > 0 && !input.overrideTripwireFlags) {
    throw new ProjectMintingAcceptanceError("TRIPWIRE_BLOCKED", "Tripwire flags require explicit override", { flags });
  }

  const cluster = await findCurrentCluster(db, row);
  const currentDeclared = await currentDeclaredStateForCluster(db, cluster);
  if (currentDeclared) {
    const currentState = mapDeclarationToRelationshipState(currentDeclared);
    if (currentState !== verdict.relationshipState) {
      throw new ProjectMintingAcceptanceError("STALE_VERDICT", "stale verdict — re-run the cluster", {
        storedRelationshipState: verdict.relationshipState,
        currentRelationshipState: currentState,
      });
    }
  }

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

  const renameMap = input.renameMap ?? {};
  const shouldWriteNothing = isNoWriteState(verdict.relationshipState);
  const acceptedProjects = shouldWriteNothing ? [] : verdict.projects.filter((project) => !struck.has(project.name));
  const acceptedOriginalNames = new Set(acceptedProjects.map((project) => project.name));
  const anchorMaps = await buildAnchorMaps(db, cluster);
  const { projectFiles, errors } = resolveProjectAnchors(verdict, acceptedOriginalNames, anchorMaps);
  if (errors.length > 0) {
    throw new ProjectMintingAcceptanceError("ANCHOR_NOT_FOUND", "One or more verdict anchors resolved to no files", {
      anchors: errors,
    });
  }

  const canonicalByName = new Map<string, string>();
  for (const disposition of verdict.existingEntities) {
    if (disposition.disposition === "canonical") canonicalByName.set(disposition.name, disposition.entityId);
  }

  const projectIdsByOriginalName = new Map<string, string>();
  const projectIds: string[] = [];
  let engagementId: string | null = null;
  const entities: AcceptedEntitySummary[] = [];

  if (!shouldWriteNothing && verdict.relationshipState === "customer" && verdict.engagement) {
    const originalName = verdict.engagement.name;
    const name = renameFor(originalName, renameMap);
    engagementId = await adoptOrCreateProjectEntity(db, {
      companyEntityId: cluster.companyEntityId,
      originalName,
      name,
      sourceId: engagementSourceId(cluster.companyEntityId, originalName),
      canonicalEntityId: canonicalByName.get(originalName),
      subtype: "engagement",
      lifecycleStatus: null,
    });
    await ensureRelationship(db, engagementId, cluster.companyEntityId, "engagement_for");
  }

  if (!shouldWriteNothing) {
    for (const project of acceptedProjects) {
      const name = renameFor(project.name, renameMap);
      const entityId = await adoptOrCreateProjectEntity(db, {
        companyEntityId: cluster.companyEntityId,
        originalName: project.name,
        name,
        sourceId: projectSourceId(cluster.companyEntityId, project.name),
        canonicalEntityId: canonicalByName.get(project.name),
        subtype: null,
        lifecycleStatus: project.status,
      });
      projectIdsByOriginalName.set(project.name, entityId);
      projectIds.push(entityId);
      if (engagementId) await ensureRelationship(db, entityId, engagementId, "part_of");
      else await ensureRelationship(db, entityId, cluster.companyEntityId, "engagement_for");
    }
  }

  const anchoredToAccepted = new Set<string>();
  const filesByEntity = new Map<string, Set<string>>();
  for (const project of acceptedProjects) {
    const entityId = projectIdsByOriginalName.get(project.name);
    if (!entityId) continue;
    const files = projectFiles.get(project.name) ?? new Set<string>();
    filesByEntity.set(entityId, files);
    for (const fileId of files) anchoredToAccepted.add(fileId);
  }

  const residualTargetId =
    engagementId ??
    (projectIds.length === 1 ? projectIds[0] : verdict.relationshipState === "trial" ? projectIds[0] : null);
  if (residualTargetId) {
    const residual = filesByEntity.get(residualTargetId) ?? new Set<string>();
    for (const file of cluster.files) {
      if (!anchoredToAccepted.has(file.fileId)) residual.add(file.fileId);
    }
    filesByEntity.set(residualTargetId, residual);
  }

  const mergeIds: string[] = [];
  for (const disposition of verdict.existingEntities) {
    if (disposition.disposition !== "merge_into" || !disposition.mergeInto) continue;
    const survivorId =
      projectIdsByOriginalName.get(disposition.mergeInto) ??
      (engagementId && disposition.mergeInto === verdict.engagement?.name ? engagementId : null);
    if (!survivorId) continue;
    const mergeId = await mergeFragment(db, {
      survivorId,
      loserId: disposition.entityId,
      actorUserId: input.actorUserId,
      survivorName: renameFor(disposition.mergeInto, renameMap),
      verdictId: row.id,
    });
    if (mergeId) mergeIds.push(mergeId);
  }

  let taskParentUpdates = 0;
  for (const [entityId, fileIds] of filesByEntity) {
    const orderedFileIds = [...fileIds].sort();
    for (const fileId of orderedFileIds) await insertMention(db, entityId, fileId);
    taskParentUpdates += await parentTasksForFiles(db, entityId, orderedFileIds);
    const kind = entityId === engagementId ? "engagement" : "project";
    const entity = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("id", "=", entityId)
      .executeTakeFirstOrThrow();
    entities.push({ id: entity.id, name: entity.name, kind, fileIds: orderedFileIds });
  }

  return {
    verdictId: row.id,
    status: "accepted",
    entityIds: { engagementId, projectIds },
    entities: entities.sort((a, b) => a.name.localeCompare(b.name)),
    mergeIds: mergeIds.sort(),
    struckProjects,
    taskParentUpdates,
    drift: {
      stance: "live_recompute",
      reviewedFileCount: row.file_count,
      acceptedFileCount: cluster.files.length,
      addedSinceVerdict: Math.max(0, cluster.files.length - row.file_count),
    },
  };
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
    if (row.status === "pending" && row.superseded_at === null) {
      const won = await repo.markAccepted({
        id: row.id,
        actorUserId: input.actorUserId,
        struckProjects: result.struckProjects,
        result,
      });
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

import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { EMBEDDING_DIMENSIONS, isSqliteVecAvailable } from "../db/index";
import type { FileViewer } from "../db/repositories/connectors";
import { entityVisibilityPredicate, whereLiveEntity } from "../db/repositories/entities";
import {
  PERSON_PARTICIPANT_FACT_TYPES,
  buildLlmTaskCandidateId,
  upsertLlmTaskFact,
} from "../db/repositories/indexed-file-facts";
import {
  TEST_ACCOUNT_ENTITY_ID,
  countOpenVisibleTasksByEvidenceFilesOrAssignees,
  createTaskRepository,
} from "../db/repositories/tasks";
import type { TaskAccessOptions } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { buildMaterializeDeps, shouldMarkMaterialized } from "../entities/materialize";
import { materializeLlmTask } from "../entities/materialize-llm-task";
import type { StageOutcome, StageReporter } from "./enrichment-stage-report";
import type { GeminiGenerator } from "./gemini-generate";
import { LLM_TASK_CONTENT_LIMIT, LLM_TASK_PROMPT_VERSION, extractLlmTaskCandidates } from "./llm-task-extraction";
import { normalizeName } from "./name-normalize";

export const TASK_MINTING_PROJECT_CAP = 100;
export const TASK_MINTING_EXISTING_TASK_CAP = 60;
const TASK_MINTING_ATTENDEE_TASK_CAP = 15;
const TASK_MINTING_NEAREST_FILE_COUNT = 20;
const PRIOR_TITLE_CAP = 50;

export const TASK_MINTING_PROJECT_SELECTION =
  "All live projects visible to you (short ids; projects mentioned in the 20 nearest indexed files listed first, then A–Z); capped at 100.";
export const TASK_MINTING_EXISTING_TASK_SELECTION =
  "Open tasks visible to you with evidence in the 20 nearest indexed files by embedding (including this file), plus open tasks assigned to this file's attendees; capped at 60.";
export const TASK_MINTING_NO_EMBEDDING_SELECTION =
  "This file has no embedding, so only tasks evidenced on this file and tasks assigned to its attendees are shown; capped at 60.";
export const TASK_MINTING_VECTOR_UNAVAILABLE_SELECTION =
  "Vector search is unavailable in this deployment, so only tasks evidenced on this file and tasks assigned to its attendees are shown; capped at 60.";

export interface MintContextBlock {
  key: string;
  label: string;
  selection: string;
  total: number;
  items: string[];
  truncated?: boolean;
  via: "prompt" | "tool";
}

export interface MintedTaskCandidate {
  title: string;
  owner?: { name?: string | null; email?: string | null } | null;
  dueDate?: string | null;
  hasOwnerVerbObject: boolean;
  sourceExcerpt?: string | null;
  projectName?: string | null;
  taskId?: string | null;
}

export interface SimilarFile {
  fileId: string;
  fileName: string;
  similarity: number;
}

export interface MintTasksResult {
  fileId: string;
  fileName: string;
  model: string;
  contentLength: number;
  truncated: boolean;
  context: MintContextBlock[];
  similarFiles: SimilarFile[];
  candidates: MintedTaskCandidate[];
  written: number;
  dumpDir?: string | null;
}

interface MintTasksFromFileInput {
  db: Kysely<DB>;
  logger: Logger;
  file: {
    id: string;
    connectorConfigId: string;
    fileName: string;
    source: string;
    content: string;
    contentHash: string | null;
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
  };
  userId: string;
  viewer: FileViewer;
  taskAccess: TaskAccessOptions;
  generator: GeminiGenerator;
  model: string;
  dumpDir: string;
  llmTaskCorroborationThreshold?: number;
  /** Set only by the dev trace route. Reports each stage as it completes. */
  stageReport?: StageReporter;
}

interface NearestFile {
  fileId: string;
  similarity: number;
}

type FileNeighbourhood =
  | { kind: "available"; files: NearestFile[] }
  | { kind: "missing_embedding"; files: [] }
  | { kind: "vector_unavailable"; files: [] };

export async function mintTasksFromFile(input: MintTasksFromFileInput): Promise<MintTasksResult> {
  const neighbourhood = await loadNearestFiles(input.db, input.file.id);
  const neighbourhoodFileIds =
    neighbourhood.kind === "available" ? neighbourhood.files.map((file) => file.fileId) : [input.file.id];
  const [attendees, parentRefs, priorTitles, projects, existingTasks, similarFiles] = await Promise.all([
    loadAttendees(input.db, input.file.id),
    loadParentRefs(input.db, input.file.id),
    loadPriorTitles(input.db, input.file.id, input.userId),
    loadProjects(input.db, input.viewer, input.file.id, neighbourhoodFileIds),
    loadExistingTasks(input.db, input.file.id, neighbourhood, input.taskAccess),
    loadSimilarFiles(input.db, input.file.id, neighbourhood),
  ]);
  const sentContent = input.file.content.slice(0, LLM_TASK_CONTENT_LIMIT);
  const truncated = input.file.content.length > sentContent.length;
  const sourceDate = input.file.sourceCreatedAt ?? input.file.sourceUpdatedAt;

  const context = buildMintContext({
    file: input.file,
    sentContent,
    sourceDate,
    attendees,
    parentRefs,
    priorTitles,
    projects,
    existingTasks,
  });

  input.stageReport?.({
    stage: "neighbourhood",
    label: "Nearest files",
    kind: "code",
    status: "done",
    outcomes: similarFiles.map((file) => ({
      subject: file.fileName,
      kind: "file",
      result: "kept" as const,
      reason: `similarity ${file.similarity.toFixed(3)}`,
    })),
    summary: { source: neighbourhood.kind, nearestCount: neighbourhood.files.length },
  });
  input.stageReport?.({
    stage: "gatherContext",
    label: "Gather context",
    kind: "code",
    status: "done",
    context,
    summary: {
      projectCount: projects.total,
      existingTaskCount: existingTasks.total,
      attendeeCount: attendees.total,
    },
  });

  let candidates: Awaited<ReturnType<typeof extractLlmTaskCandidates>>;
  try {
    candidates = await extractLlmTaskCandidates({
      content: sentContent,
      sourceDate: sourceDate ?? undefined,
      attendees: attendees.items,
      parentRefs: parentRefs.items,
      priorTitles: priorTitles.items,
      projects: projects.items,
      existingTasks: existingTasks.items,
      generator: input.generator,
      promptVersion: LLM_TASK_PROMPT_VERSION,
      dumpDir: input.dumpDir,
    });
  } catch (err) {
    input.stageReport?.({
      stage: "extractCandidates",
      label: "Extract candidates",
      kind: "model",
      status: "failed",
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  input.stageReport?.({
    stage: "extractCandidates",
    label: "Extract candidates",
    kind: "model",
    status: "done",
    context,
    outcomes: candidates.map((candidate) => ({
      subject: candidate.title,
      kind: "candidate",
      result: "kept" as const,
      reason: candidate.hasOwnerVerbObject ? undefined : "model did not claim owner, verb and object",
    })),
    summary: { candidateCount: candidates.length },
  });
  const materializeDeps = await buildMaterializeDeps(input.db, {
    logger: input.logger,
    llmTaskCorroborationThreshold: input.llmTaskCorroborationThreshold,
  });
  const responseCandidates: MintedTaskCandidate[] = [];
  const writeOutcomes: StageOutcome[] = [];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    let taskId: string | undefined;
    try {
      const candidateId = buildLlmTaskCandidateId(input.file.id, `${input.userId}:${candidate.title}`);
      const upserted = await upsertLlmTaskFact(input.db, {
        indexedFileId: input.file.id,
        connectorConfigId: input.file.connectorConfigId,
        createdByUserId: input.userId,
        contentHash: input.file.contentHash,
        source: input.file.source,
        candidate,
        candidateId,
        corroborationKey: [normalizeName(candidate.title), candidate.parentEntityId ?? "global"].join("|"),
        parentEntityId: candidate.parentEntityId,
        evidence: {
          fileIds: [input.file.id],
          entityIds: candidate.parentEntityId ? [candidate.parentEntityId] : [],
        },
        promptVersion: LLM_TASK_PROMPT_VERSION,
      });
      const fact = await input.db
        .selectFrom("indexed_file_facts")
        .selectAll()
        .where("fact_key", "=", upserted.factKey ?? "")
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      const result = await materializeLlmTask(materializeDeps, fact);
      if (shouldMarkMaterialized(result)) {
        await input.db
          .updateTable("indexed_file_facts")
          .set({ materialized_at: new Date().toISOString(), materialization_attempts: 0 })
          .where("id", "=", fact.id)
          .execute();
      }
      if (result.kind === "task_materialized") taskId = result.taskId;
      writeOutcomes.push(mintWriteOutcome(candidate.title, result));
    } catch (err) {
      input.logger.warn({ err, fileId: input.file.id, candidateIndex }, "Minted task materialization failed");
      writeOutcomes.push({
        subject: candidate.title,
        kind: "candidate",
        result: "deferred",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    responseCandidates.push({
      title: candidate.title,
      owner: candidate.owner,
      dueDate: candidate.dueDate,
      hasOwnerVerbObject: candidate.hasOwnerVerbObject,
      sourceExcerpt: candidate.sourceExcerpt,
      projectName: candidate.projectName ?? null,
      ...(taskId ? { taskId } : {}),
    });
  }

  input.stageReport?.({
    stage: "writeCandidates",
    label: "Write candidates",
    kind: "code",
    status: "done",
    outcomes: writeOutcomes,
    summary: {
      candidateCount: candidates.length,
      written: writeOutcomes.filter((outcome) => outcome.result === "created").length,
    },
  });

  return {
    fileId: input.file.id,
    fileName: input.file.fileName,
    model: input.model,
    contentLength: sentContent.length,
    truncated,
    context,
    similarFiles,
    candidates: responseCandidates,
    written: responseCandidates.filter((candidate) => candidate.taskId).length,
    dumpDir: input.dumpDir,
  };
}

/**
 * The context blocks, in prompt order. Built before the model call so the trace
 * can show what was assembled even when the call itself fails.
 */
/**
 * What the fact pipeline actually did with one candidate. Every branch other
 * than `task_materialized` used to vanish — the caller kept only the task id,
 * so a candidate that was suppressed or held below the corroboration threshold
 * looked identical to one the model never proposed.
 */
function mintWriteOutcome(title: string, result: Awaited<ReturnType<typeof materializeLlmTask>>): StageOutcome {
  const base = { subject: title, kind: "candidate" };
  if (result.kind === "task_materialized") {
    return { ...base, result: result.created ? "created" : "linked" };
  }
  if (result.kind === "deferred_below_threshold") {
    return { ...base, result: "deferred", reason: result.reason };
  }
  if (result.kind === "skipped_missing_owner" || result.kind === "skipped") {
    return { ...base, result: "suppressed", reason: result.reason };
  }
  return { ...base, result: "deferred", reason: result.kind };
}

function buildMintContext(args: {
  file: { content: string };
  sentContent: string;
  sourceDate: string | null;
  attendees: { total: number; labels: string[] };
  parentRefs: { total: number; labels: string[] };
  priorTitles: { total: number; items: string[] };
  /** `items` is the model-facing shape; only its length is read here, for the truncation flag. */
  projects: { total: number; labels: string[]; items: readonly unknown[] };
  existingTasks: { total: number; items: string[]; selection: string };
}): MintContextBlock[] {
  const { file, sentContent, sourceDate, attendees, parentRefs, priorTitles, projects, existingTasks } = args;
  return [
    {
      key: "content",
      label: "Content",
      selection: `The first ${sentContent.length.toLocaleString()} of ${file.content.length.toLocaleString()} characters from the file body.`,
      total: 1,
      items: [sentContent],
      via: "prompt",
    },
    {
      key: "source_date",
      label: "Source date",
      selection: "The file's source-created timestamp, falling back to its source-updated timestamp.",
      total: sourceDate ? 1 : 0,
      items: sourceDate ? [sourceDate] : [],
      via: "prompt",
    },
    {
      key: "attendees",
      label: "Attendees",
      selection: "Distinct attendees and correspondents recorded for this file.",
      total: attendees.total,
      items: attendees.labels,
      via: "prompt",
    },
    {
      key: "parent_refs",
      label: "Parent refs",
      selection: "Distinct structural parent references recorded for this file.",
      total: parentRefs.total,
      items: parentRefs.labels,
      via: "prompt",
    },
    {
      key: "prior_titles",
      label: "Prior titles",
      selection:
        "Active LLM task titles previously extracted by this caller from this file, oldest first; capped at 50.",
      total: priorTitles.total,
      items: priorTitles.items,
      ...(priorTitles.total > priorTitles.items.length ? { truncated: true } : {}),
      via: "prompt",
    },
    {
      key: "projects",
      label: "Projects",
      selection: TASK_MINTING_PROJECT_SELECTION,
      total: projects.total,
      items: projects.labels,
      ...(projects.total > projects.items.length ? { truncated: true } : {}),
      via: "prompt",
    },
    {
      key: "existing_tasks",
      label: "Existing tasks",
      selection: existingTasks.selection,
      total: existingTasks.total,
      items: existingTasks.items,
      ...(existingTasks.total > existingTasks.items.length ? { truncated: true } : {}),
      via: "prompt",
    },
  ];
}

async function loadNearestFiles(db: Kysely<DB>, fileId: string): Promise<FileNeighbourhood> {
  if (isPg(db)) {
    const dims = EMBEDDING_DIMENSIONS;
    const result = await sql<{ indexed_file_id: string; similarity: number }>`
      SELECT fe2.indexed_file_id,
             1 - (fe2.embedding::halfvec(${sql.lit(dims)}) <=> fe1.embedding::halfvec(${sql.lit(dims)})) AS similarity
      FROM file_embeddings fe1
      JOIN file_embeddings fe2 ON true
      WHERE fe1.indexed_file_id = ${fileId}
      ORDER BY fe2.embedding::halfvec(${sql.lit(dims)}) <=> fe1.embedding::halfvec(${sql.lit(dims)})
      LIMIT ${TASK_MINTING_NEAREST_FILE_COUNT}
    `.execute(db);
    if (result.rows.length === 0) return { kind: "missing_embedding", files: [] };
    return {
      kind: "available",
      files: result.rows.map((row) => ({ fileId: row.indexed_file_id, similarity: Number(row.similarity) })),
    };
  }

  if (!isSqliteVecAvailable()) return { kind: "vector_unavailable", files: [] };
  const target = await sql<{ embedding: string }>`
    SELECT vec_to_json(embedding) AS embedding
    FROM file_embeddings
    WHERE indexed_file_id = ${fileId}
  `.execute(db);
  const embedding = target.rows[0]?.embedding;
  if (!embedding) return { kind: "missing_embedding", files: [] };
  const result = await sql<{ indexed_file_id: string; distance: number }>`
    SELECT fe.indexed_file_id, fe.distance
    FROM file_embeddings fe
    WHERE fe.embedding MATCH ${embedding}
      AND k = ${TASK_MINTING_NEAREST_FILE_COUNT}
    ORDER BY fe.distance ASC
  `.execute(db);
  return {
    kind: "available",
    files: result.rows.map((row) => {
      const distance = Number(row.distance);
      return { fileId: row.indexed_file_id, similarity: 1 - (distance * distance) / 2 };
    }),
  };
}

/**
 * Names the KNN neighbours with no visibility filter. Minting is a global pipeline with
 * full read access — the control that matters is on what it writes, not what it reads.
 */
async function loadSimilarFiles(
  db: Kysely<DB>,
  fileId: string,
  neighbourhood: FileNeighbourhood,
): Promise<SimilarFile[]> {
  if (neighbourhood.kind !== "available") return [];
  const neighbours = neighbourhood.files.filter((file) => file.fileId !== fileId);
  if (neighbours.length === 0) return [];
  const rows = await db
    .selectFrom("indexed_files")
    .select(["id", "file_name"])
    .where(
      "id",
      "in",
      neighbours.map((file) => file.fileId),
    )
    .execute();
  const namesById = new Map(rows.map((row) => [row.id, row.file_name]));
  return neighbours.flatMap((file) => {
    const fileName = namesById.get(file.fileId);
    return fileName === undefined ? [] : [{ fileId: file.fileId, fileName, similarity: file.similarity }];
  });
}

async function loadAttendees(db: Kysely<DB>, fileId: string) {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "subject_email"])
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "in", [...PERSON_PARTICIPANT_FACT_TYPES])
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .execute();
  const deduped = [
    ...new Map(
      rows
        .filter((row) => row.subject_name || row.subject_email)
        .map((row) => [
          `${row.subject_name?.trim().toLowerCase() ?? ""}\0${row.subject_email?.trim().toLowerCase() ?? ""}`,
          { name: row.subject_name ?? undefined, email: row.subject_email ?? undefined },
        ]),
    ).values(),
  ];
  return {
    items: deduped,
    labels: deduped.map((attendee) => `${attendee.name ?? "Unknown"}${attendee.email ? ` <${attendee.email}>` : ""}`),
    total: deduped.length,
  };
}

async function loadParentRefs(db: Kysely<DB>, fileId: string) {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_source", "subject_source_id"])
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "parent_entity")
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .execute();
  const refs = [
    ...new Map(
      rows.flatMap((row) => {
        if (!row.subject_source || !row.subject_source_id) return [];
        const ref = { source: row.subject_source, sourceId: row.subject_source_id };
        return [[`${ref.source}:${ref.sourceId}`, ref] as const];
      }),
    ).values(),
  ];
  return { items: refs, labels: refs.map((ref) => `${ref.source}:${ref.sourceId}`), total: refs.length };
}

async function loadPriorTitles(db: Kysely<DB>, fileId: string, userId: string) {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select("subject_name")
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_task")
    .where("created_by_user_id", "=", userId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .execute();
  const titles = [
    ...new Map(
      rows.flatMap((row) => {
        const title = row.subject_name?.trim();
        return title ? [[title, title] as const] : [];
      }),
    ).values(),
  ];
  return { items: titles.slice(0, PRIOR_TITLE_CAP), total: titles.length };
}

async function loadProjects(db: Kysely<DB>, viewer: FileViewer, fileId: string, nearestFileIds: string[]) {
  const mentionRows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entity_mentions.entity_id", "entity_mentions.indexed_file_id"])
    .where("entity_mentions.indexed_file_id", "in", nearestFileIds)
    .where("entities.source_type", "=", "project")
    .where("entities.id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .execute();
  const mentionedOnFile = new Set(
    mentionRows.filter((row) => row.indexed_file_id === fileId).map((row) => row.entity_id),
  );
  const mentionedOnNeighbours = new Set(
    mentionRows.filter((row) => row.indexed_file_id !== fileId).map((row) => row.entity_id),
  );
  const base = db
    .selectFrom("entities")
    .where("source_type", "=", "project")
    .where("status", "!=", "archived")
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .where(entityVisibilityPredicate(viewer));
  const totalRow = await base.select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();
  const projects = await base.select(["id", "name"]).execute();
  projects.sort((a, b) => {
    const tierA = mentionedOnFile.has(a.id) ? 0 : mentionedOnNeighbours.has(a.id) ? 1 : 2;
    const tierB = mentionedOnFile.has(b.id) ? 0 : mentionedOnNeighbours.has(b.id) ? 1 : 2;
    if (tierA !== tierB) return tierA - tierB;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  const items = projects.slice(0, TASK_MINTING_PROJECT_CAP).map((project, index) => ({
    ...project,
    shortId: `P${index + 1}`,
  }));
  return {
    items,
    labels: items.map((project) => `${project.name} [id: ${project.shortId}]`),
    total: Number(totalRow?.count ?? 0),
  };
}

async function loadMentionedAttendeeEntityIds(db: Kysely<DB>, fileId: string, viewerEntityIds: string[]) {
  const rows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select("entity_mentions.entity_id")
    .distinct()
    .where("entity_mentions.indexed_file_id", "=", fileId)
    .where("entities.source_type", "=", "person")
    .where(whereLiveEntity())
    .execute();
  const viewerIds = new Set(viewerEntityIds);
  return rows.map((row) => row.entity_id).filter((entityId) => !viewerIds.has(entityId));
}

async function loadExistingTasks(
  db: Kysely<DB>,
  fileId: string,
  neighbourhood: FileNeighbourhood,
  access: TaskAccessOptions,
) {
  const fileSimilarities = new Map(
    neighbourhood.kind === "available"
      ? neighbourhood.files.map((file) => [file.fileId, file.similarity] as const)
      : [[fileId, 1] as const],
  );
  const evidenceFileIds = [...fileSimilarities.keys()];
  const attendeeEntityIds = await loadMentionedAttendeeEntityIds(db, fileId, access.assigneeEntityIds ?? []);
  const repo = createTaskRepository(db);
  const [tierAResult, tierBResult, total] = await Promise.all([
    repo.listOpenVisibleTasksByEvidenceFiles(evidenceFileIds, access, TASK_MINTING_EXISTING_TASK_CAP),
    repo.listOpenVisibleTasksByAssignees(attendeeEntityIds, access, TASK_MINTING_ATTENDEE_TASK_CAP),
    countOpenVisibleTasksByEvidenceFilesOrAssignees(db, evidenceFileIds, attendeeEntityIds, access),
  ]);
  tierAResult.tasks.sort((a, b) => {
    const similarityA = Math.max(
      ...a.matchingEvidenceRefIds.map((refId) => fileSimilarities.get(refId) ?? Number.NEGATIVE_INFINITY),
    );
    const similarityB = Math.max(
      ...b.matchingEvidenceRefIds.map((refId) => fileSimilarities.get(refId) ?? Number.NEGATIVE_INFINITY),
    );
    if (similarityA !== similarityB) return similarityB - similarityA;
    return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
  });
  const tasksById = new Map<string, (typeof tierAResult.tasks)[number] | (typeof tierBResult.tasks)[number]>();
  for (const task of tierAResult.tasks) tasksById.set(task.id, task);
  for (const task of tierBResult.tasks) {
    if (!tasksById.has(task.id)) tasksById.set(task.id, task);
  }
  const tasks = [...tasksById.values()].slice(0, TASK_MINTING_EXISTING_TASK_CAP);
  return {
    items: tasks.map(formatExistingTask),
    total,
    selection:
      neighbourhood.kind === "available"
        ? TASK_MINTING_EXISTING_TASK_SELECTION
        : neighbourhood.kind === "missing_embedding"
          ? TASK_MINTING_NO_EMBEDDING_SELECTION
          : TASK_MINTING_VECTOR_UNAVAILABLE_SELECTION,
  };
}

function formatExistingTask(task: { title: string; status: string; assignee_name: string | null }) {
  const clauses = [
    ...(task.status === "in_progress" ? ["in_progress"] : []),
    ...(task.assignee_name?.trim() ? [`owner: ${task.assignee_name.trim()}`] : []),
  ];
  return clauses.length > 0 ? `${task.title} [${clauses.join("; ")}]` : task.title;
}

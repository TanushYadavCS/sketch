import { createTaskActivityRepository } from "../db/repositories/task-activity";
import { TEST_ACCOUNT_ENTITY_ID, type TaskStatus, createTaskRepository } from "../db/repositories/tasks";
import { assignMembership, closeOpenMembershipForTask, upsertWorkCycle } from "../db/repositories/work-cycles";
import { readJsonObject } from "./materialize-json";
import type { IndexEntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { normalizeName } from "./name-keys";

const STATUS_TYPE_MAP: Record<string, Record<string, TaskStatus>> = {
  linear: {
    backlog: "open",
    unstarted: "open",
    triage: "open",
    started: "in_progress",
    completed: "done",
    canceled: "dropped",
  },
  clickup: {
    open: "open",
    custom: "in_progress",
    closed: "done",
    done: "done",
  },
};

export async function materializeStructuralTask(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const task = readTask(raw.task);
  const indexedFileId = typeof raw.indexedFileId === "string" ? raw.indexedFileId : fact.indexed_file_id;
  if (!task || !indexedFileId) return { kind: "skipped", reason: "invalid_structural_task" };

  const parent = resolveProject(deps, task.project);
  const assignee = resolveAssignee(deps, task.assignee);
  const repo = createTaskRepository(deps.db);
  const parentSourceRef = task.project ? `${task.project.source}:${task.project.sourceId}` : null;
  const result = await repo.upsertTask({
    parentEntityId: parent?.id ?? null,
    parentSourceRef,
    parentName: task.project?.name ?? null,
    source: fact.source,
    externalRef: task.externalRef ?? null,
    title: task.title,
    status: normalizeStatus(fact.source, task.statusType),
    statusRaw: task.statusRaw ?? null,
    statusAuthority: "external",
    assigneeEntityId: assignee?.id ?? null,
    priority: task.priority ?? null,
    dueAt: task.dueAt ?? null,
    provenance: "structural",
    sourceTaskId: task.sourceTaskId,
  });
  await repo.upsertEvidence(result.taskId, "file", indexedFileId);
  if (result.created) {
    await createTaskActivityRepository(deps.db).append({
      taskId: result.taskId,
      eventKind: "created",
      actorType: "system",
      surface: "sync",
      identityParts: [result.taskId],
      occurredAt: new Date().toISOString(),
    });
  }
  const now = new Date().toISOString();
  if (task.cycle?.isSprint) {
    if (!fact.connector_config_id) throw new Error("Work cycle materialization requires connector_config_id");
    const scopeEntityId = resolveCycleScope(deps, task.cycle.scopeRef)?.id ?? null;
    const cycle = await upsertWorkCycle(deps.db, {
      scopeEntityId,
      connectorConfigId: fact.connector_config_id,
      source: fact.source,
      externalRef: task.cycle.externalRef,
      name: task.cycle.name,
      sequence: task.cycle.sequence ?? deriveSprintSequence(task.cycle.name),
      startsAt: task.cycle.startsAt ?? null,
      endsAt: task.cycle.endsAt ?? null,
      state: "active",
      lastSeenSyncRunId: fact.last_seen_sync_run_id,
    });
    await assignMembership(deps.db, {
      taskId: result.taskId,
      cycleId: cycle.cycleId,
      sourceFactId: fact.id,
      at: now,
    });
  } else {
    await closeOpenMembershipForTask(deps.db, { taskId: result.taskId, at: now });
  }
  return { kind: "task_materialized", taskId: result.taskId, created: result.created };
}

function normalizeStatus(source: string, statusType: string): TaskStatus {
  return STATUS_TYPE_MAP[source]?.[statusType] ?? "in_progress";
}

function resolveProject(
  deps: MaterializeDeps,
  project: { name: string; source: string; sourceId: string } | undefined,
): IndexEntityRow | null {
  if (!project) return null;
  const byRef = deps.index.bySourceRef.get(`${project.source}:${project.sourceId}`);
  if (byRef && byRef.source_type === "project" && byRef.id !== TEST_ACCOUNT_ENTITY_ID) return byRef;
  const matches = deps.index.byNormalizedName.get(normalizeName(project.name)) ?? [];
  return matches.find((entity) => entity.source_type === "project" && entity.id !== TEST_ACCOUNT_ENTITY_ID) ?? null;
}

function resolveAssignee(
  deps: MaterializeDeps,
  assignee: { name: string; email?: string; source?: string; sourceId?: string } | undefined,
): IndexEntityRow | null {
  if (!assignee) return null;
  if (assignee.source && assignee.sourceId) {
    const byRef = deps.index.bySourceRef.get(`${assignee.source}:${assignee.sourceId}`);
    if (byRef && byRef.source_type === "person" && byRef.id !== TEST_ACCOUNT_ENTITY_ID) return byRef;
  }
  const matches = deps.index.byNormalizedName.get(normalizeName(assignee.name)) ?? [];
  return matches.find((entity) => entity.source_type === "person" && entity.id !== TEST_ACCOUNT_ENTITY_ID) ?? null;
}

function resolveCycleScope(
  deps: MaterializeDeps,
  scopeRef: { source: string; sourceId: string } | undefined,
): IndexEntityRow | null {
  if (!scopeRef) return null;
  return deps.index.bySourceRef.get(`${scopeRef.source}:${scopeRef.sourceId}`) ?? null;
}

function deriveSprintSequence(name: string): number | undefined {
  const match = /\bSprint\s+(\d+)\b/i.exec(name);
  if (!match) return undefined;
  return Number(match[1]);
}

function readTask(value: unknown): {
  sourceTaskId: string;
  externalRef?: string;
  title: string;
  statusType: string;
  statusRaw?: string;
  priority?: string;
  dueAt?: string;
  project?: { name: string; source: string; sourceId: string };
  assignee?: { name: string; email?: string; source?: string; sourceId?: string };
  cycle?: {
    source: string;
    externalRef: string;
    name: string;
    scopeRef?: { source: string; sourceId: string };
    startsAt?: string;
    endsAt?: string;
    sequence?: number;
    isSprint: boolean;
  };
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sourceTaskId !== "string" ||
    typeof record.title !== "string" ||
    typeof record.statusType !== "string"
  ) {
    return null;
  }
  return {
    sourceTaskId: record.sourceTaskId,
    externalRef: readOptionalString(record.externalRef),
    title: record.title,
    statusType: record.statusType,
    statusRaw: readOptionalString(record.statusRaw),
    priority: readOptionalString(record.priority),
    dueAt: readOptionalString(record.dueAt),
    project: readProject(record.project),
    assignee: readAssignee(record.assignee),
    cycle: readCycle(record.cycle),
  };
}

function readProject(value: unknown): { name: string; source: string; sourceId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.source !== "string" || typeof record.sourceId !== "string") {
    return undefined;
  }
  return { name: record.name, source: record.source, sourceId: record.sourceId };
}

function readAssignee(
  value: unknown,
): { name: string; email?: string; source?: string; sourceId?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") return undefined;
  return {
    name: record.name,
    email: readOptionalString(record.email),
    source: readOptionalString(record.source),
    sourceId: readOptionalString(record.sourceId),
  };
}

function readCycle(value: unknown):
  | {
      source: string;
      externalRef: string;
      name: string;
      scopeRef?: { source: string; sourceId: string };
      startsAt?: string;
      endsAt?: string;
      sequence?: number;
      isSprint: boolean;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.source !== "string" ||
    typeof record.externalRef !== "string" ||
    typeof record.name !== "string" ||
    typeof record.isSprint !== "boolean"
  ) {
    return undefined;
  }
  return {
    source: record.source,
    externalRef: record.externalRef,
    name: record.name,
    scopeRef: readScopeRef(record.scopeRef),
    startsAt: readOptionalString(record.startsAt),
    endsAt: readOptionalString(record.endsAt),
    sequence: typeof record.sequence === "number" ? record.sequence : undefined,
    isSprint: record.isSprint,
  };
}

function readScopeRef(value: unknown): { source: string; sourceId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.sourceId !== "string") return undefined;
  return { source: record.source, sourceId: record.sourceId };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

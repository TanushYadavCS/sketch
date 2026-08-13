import type { Context } from "hono";
import type { Kysely, Selectable } from "kysely";
import { createEntityRepository } from "../db/repositories/entities";
import { createUserRepository } from "../db/repositories/users";
import type { DB, TasksTable } from "../db/schema";
import { type FileViewer, getContentViewer, isAdmin } from "./auth-helpers";

export const TASK_STATUSES = new Set(["open", "in_progress", "done", "dropped"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface TaskAccessContext {
  userId: string;
  viewer: FileViewer;
  assigneeEntityIds: string[];
  canReadAllLocalTasks: boolean;
  canEditAllLocalTasks: boolean;
}

export function parseTaskLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function canEditTaskStatus(
  task: Selectable<TasksTable>,
  access: Pick<TaskAccessContext, "userId" | "assigneeEntityIds" | "canEditAllLocalTasks">,
): boolean {
  const isCreator = task.created_by_user_id === access.userId;
  const isAssignee = Boolean(task.assignee_entity_id && access.assigneeEntityIds.includes(task.assignee_entity_id));
  const isAdminEditable = access.canEditAllLocalTasks && task.status_authority === "local";
  const canEditCreatorOwnedLlm = isCreator && task.provenance === "llm";
  return (
    task.status_authority === "local" &&
    (canEditCreatorOwnedLlm ||
      ((isCreator || isAssignee || isAdminEditable) && (task.provenance === "brief" || task.provenance === "summary")))
  );
}

export function readonlyReason(
  task: Selectable<TasksTable>,
  access: Pick<TaskAccessContext, "userId" | "assigneeEntityIds" | "canEditAllLocalTasks">,
): "not_owner" | "external_authority" | null {
  if (canEditTaskStatus(task, access)) return null;
  if (task.status_authority === "external" || task.provenance === "structural") return "external_authority";
  if (task.provenance === "brief" || task.provenance === "summary" || task.provenance === "llm") return "not_owner";
  return "external_authority";
}

type TaskCreator = { name: string; email: string | null };

export async function loadTaskCreators(
  db: Kysely<DB>,
  tasks: Selectable<TasksTable>[],
): Promise<Map<string, TaskCreator>> {
  const ids = [...new Set(tasks.flatMap((task) => (task.created_by_user_id ? [task.created_by_user_id] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("users")
    .select(["id", "name", "email"])
    .where("id", "in", ids)
    .limit(ids.length)
    .execute();
  return new Map(rows.map((row) => [row.id, { name: row.name, email: row.email }]));
}

export function toTaskDto(
  task: Selectable<TasksTable>,
  access: Pick<TaskAccessContext, "userId" | "assigneeEntityIds" | "canEditAllLocalTasks">,
  creators: Map<string, TaskCreator> = new Map(),
) {
  const creator = task.created_by_user_id ? (creators.get(task.created_by_user_id) ?? null) : null;
  return {
    id: task.id,
    parentEntityId: task.parent_entity_id,
    parentSourceRef: task.parent_source_ref,
    parentName: task.parent_name,
    source: task.source,
    externalRef: task.external_ref,
    title: task.title,
    status: task.status,
    statusRaw: task.status_raw,
    statusAuthority: task.status_authority,
    assigneeEntityId: task.assignee_entity_id,
    assigneeName: task.assignee_name,
    proposedAssigneeName: task.proposed_assignee_name,
    priority: task.priority,
    dueAt: task.due_at,
    provenance: task.provenance,
    sourceTaskId: task.source_task_id,
    createdByUserId: task.created_by_user_id,
    createdByUserName: creator?.name ?? null,
    createdByUserEmail: creator?.email ?? null,
    isOwnedByViewer: task.created_by_user_id === access.userId,
    readonlyReason: readonlyReason(task, access),
    completedAt: task.completed_at,
    updatedAt: task.updated_at,
    canEditStatus: canEditTaskStatus(task, access),
  };
}

export async function loadViewerPersonEntityIds(
  db: Kysely<DB>,
  userId: string,
  fallbackEmail: string | null,
): Promise<string[]> {
  const entityRepo = createEntityRepository(db);
  const userRepo = createUserRepository(db);
  const verifiedEmails = await userRepo.getVerifiedEmailsForUser(userId).catch(() => []);
  const emails = [...new Set([...verifiedEmails, ...(fallbackEmail ? [fallbackEmail] : [])])];
  if (emails.length === 0) return [];
  const peopleByEmail = await Promise.all(
    emails.map((email) => entityRepo.getPersonEntitiesByEmail(email).catch(() => [])),
  );
  return [...new Set(peopleByEmail.flat().map((person) => person.id))];
}

export async function resolveTaskAccessContext(
  db: Kysely<DB>,
  c: Context,
  resolvedUserId?: string,
): Promise<TaskAccessContext> {
  const userId = resolvedUserId ?? c.get("sub");
  const viewer = getContentViewer(c);
  const admin = isAdmin(c);
  return {
    userId,
    viewer,
    assigneeEntityIds: await loadViewerPersonEntityIds(db, userId, viewer.email),
    canReadAllLocalTasks: admin,
    canEditAllLocalTasks: admin,
  };
}

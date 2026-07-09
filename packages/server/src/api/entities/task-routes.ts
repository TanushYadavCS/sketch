import { Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import { createEntityRepository } from "../../db/repositories/entities";
import { type TaskStatus, createTaskRepository } from "../../db/repositories/tasks";
import { createUserRepository } from "../../db/repositories/users";
import type { DB, TasksTable } from "../../db/schema";
import { getContentViewer, getFileViewer, isAdmin } from "../auth-helpers";

const TASK_STATUSES = new Set(["open", "in_progress", "done", "dropped"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function parseTaskLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function canEditTaskStatus(
  task: Selectable<TasksTable>,
  userId: string | undefined,
  assigneeEntityIds: string[] = [],
): boolean {
  const isCreator = Boolean(userId && task.created_by_user_id === userId);
  const isAssignee = Boolean(task.assignee_entity_id && assigneeEntityIds.includes(task.assignee_entity_id));
  return (
    (isCreator || isAssignee) &&
    task.status_authority === "local" &&
    (task.provenance === "brief" || task.provenance === "summary")
  );
}

type TaskCreator = { name: string; email: string | null };

function readonlyReason(
  task: Selectable<TasksTable>,
  userId: string | undefined,
  assigneeEntityIds: string[] = [],
): "not_owner" | "external_authority" | null {
  if (canEditTaskStatus(task, userId, assigneeEntityIds)) return null;
  if (task.status_authority === "external" || task.provenance === "structural") return "external_authority";
  if (task.provenance === "brief" || task.provenance === "summary") return "not_owner";
  return "external_authority";
}

async function loadTaskCreators(db: Kysely<DB>, tasks: Selectable<TasksTable>[]): Promise<Map<string, TaskCreator>> {
  const ids = [...new Set(tasks.flatMap((task) => (task.created_by_user_id ? [task.created_by_user_id] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom("users").select(["id", "name", "email"]).where("id", "in", ids).execute();
  return new Map(rows.map((row) => [row.id, { name: row.name, email: row.email }]));
}

function toTaskDto(
  task: Selectable<TasksTable>,
  userId: string | undefined,
  creators: Map<string, TaskCreator> = new Map(),
  assigneeEntityIds: string[] = [],
) {
  const creator = task.created_by_user_id ? (creators.get(task.created_by_user_id) ?? null) : null;
  const isOwnedByViewer = Boolean(userId && task.created_by_user_id === userId);
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
    isOwnedByViewer,
    readonlyReason: readonlyReason(task, userId, assigneeEntityIds),
    completedAt: task.completed_at,
    updatedAt: task.updated_at,
    canEditStatus: canEditTaskStatus(task, userId, assigneeEntityIds),
  };
}

async function loadViewerPersonEntityIds(
  entityRepo: Pick<ReturnType<typeof createEntityRepository>, "getPersonEntitiesByEmail">,
  userRepo: Pick<ReturnType<typeof createUserRepository>, "getVerifiedEmailsForUser">,
  userId: string | undefined,
  fallbackEmail: string | null,
): Promise<string[]> {
  const verifiedEmails = userId ? await userRepo.getVerifiedEmailsForUser(userId).catch(() => []) : [];
  const emails = [...new Set([...verifiedEmails, ...(fallbackEmail ? [fallbackEmail] : [])])];
  if (emails.length === 0) return [];
  const peopleByEmail = await Promise.all(
    emails.map((email) => entityRepo.getPersonEntitiesByEmail(email).catch(() => [])),
  );
  return [...new Set(peopleByEmail.flat().map((person) => person.id))];
}

export function createTaskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const entityRepo = createEntityRepository(db);
  const taskRepo = createTaskRepository(db);
  const userRepo = createUserRepository(db);

  routes.get("/:id/tasks", async (c) => {
    const userId = c.get("sub");
    const parentViewer = getFileViewer(c);
    const taskViewer = getContentViewer(c);
    const entity = await entityRepo.getEntity(c.req.param("id"), parentViewer);
    if (!entity) return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    const status = c.req.query("status");
    if (status && !TASK_STATUSES.has(status)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid status" } }, 400);
    }
    const limit = parseTaskLimit(c.req.query("limit"));
    const assigneeEntityIds = await loadViewerPersonEntityIds(entityRepo, userRepo, userId, taskViewer.email);
    const tasks = await taskRepo.listTasksByParent(entity.id, {
      viewer: taskViewer,
      userId,
      assigneeEntityIds,
      canReadAllLocalTasks: isAdmin(c),
      status: status as TaskStatus | undefined,
      limit,
    });
    const creators = await loadTaskCreators(db, tasks);
    return c.json({ tasks: tasks.map((task) => toTaskDto(task, userId, creators, assigneeEntityIds)) });
  });

  routes.patch("/:id/tasks/:taskId", async (c) => {
    const userId = c.get("sub");
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const parentViewer = getFileViewer(c);
    const entity = await entityRepo.getEntity(c.req.param("id"), parentViewer);
    if (!entity) return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
    if (typeof body.status !== "string" || !TASK_STATUSES.has(body.status)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid status" } }, 400);
    }
    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", c.req.param("taskId"))
      .where("valid_to", "is", null)
      .executeTakeFirst();
    if (!task || task.parent_entity_id !== entity.id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    }
    const assigneeEntityIds = await loadViewerPersonEntityIds(entityRepo, userRepo, userId, getContentViewer(c).email);
    if (!canEditTaskStatus(task, userId, assigneeEntityIds)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    }
    const updated = await taskRepo.updateLocalTaskStatus({
      taskId: task.id,
      userId,
      assigneeEntityIds,
      status: body.status as TaskStatus,
    });
    if (!updated) return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    const creators = await loadTaskCreators(db, [updated]);
    return c.json({ task: toTaskDto(updated, userId, creators, assigneeEntityIds) });
  });

  return routes;
}

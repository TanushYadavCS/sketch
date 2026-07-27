import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createEntityRepository } from "../../db/repositories/entities";
import { createLocalTaskMutationPolicy } from "../../db/repositories/local-task-mutations";
import { type TaskStatus, createTaskRepository } from "../../db/repositories/tasks";
import type { DB } from "../../db/schema";
import { getFileViewer } from "../auth-helpers";
import {
  TASK_STATUSES,
  canEditTaskStatus,
  loadTaskCreators,
  loadTaskProtectedFields,
  parseTaskLimit,
  resolveTaskAccessContext,
  toTaskDto,
} from "../task-access";
import { readTaskEditRequest } from "../task-edit-request";

export function createTaskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const entityRepo = createEntityRepository(db);
  const taskRepo = createTaskRepository(db);
  const mutationPolicy = createLocalTaskMutationPolicy(db);

  routes.get("/:id/tasks", async (c) => {
    const parentViewer = getFileViewer(c);
    const entity = await entityRepo.getEntity(c.req.param("id"), parentViewer);
    if (!entity) return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    const status = c.req.query("status");
    if (status && !TASK_STATUSES.has(status)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid status" } }, 400);
    }
    const limit = parseTaskLimit(c.req.query("limit"));
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listTasksByParent(entity.id, {
      viewer: access.viewer,
      userId: access.userId,
      assigneeEntityIds: access.assigneeEntityIds,
      canReadAllLocalTasks: access.canReadAllLocalTasks,
      status: status as TaskStatus | undefined,
      limit,
    });
    const creators = await loadTaskCreators(db, tasks);
    const protectedFields = await loadTaskProtectedFields(db, tasks);
    return c.json({
      tasks: tasks.map((task) => toTaskDto(task, access, creators, protectedFields.get(task.id))),
    });
  });

  routes.patch("/:id/tasks/:taskId", async (c) => {
    const userId = c.get("sub");
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const parentViewer = getFileViewer(c);
    const entity = await entityRepo.getEntity(c.req.param("id"), parentViewer);
    if (!entity) return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    const request = await readTaskEditRequest(c);
    if (!request.ok) {
      return c.json({ error: { code: request.code, message: request.message } }, request.status);
    }
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listVisibleTasksByIds([c.req.param("taskId")], access);
    const task = tasks[0];
    if (!task || task.parent_entity_id !== entity.id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    }
    if (!canEditTaskStatus(task, access)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    }
    const result = await mutationPolicy.mutateHumanTask({
      taskId: task.id,
      userId,
      assigneeEntityIds: access.assigneeEntityIds,
      canEditAllLocalTasks: access.canEditAllLocalTasks,
      expectedRevision: request.value.expectedRevision,
      changes: request.value.changes,
      surface: "web",
    });
    if (result.status === "not_editable") {
      return c.json({ error: { code: "FORBIDDEN", message: "Task is read-only" } }, 403);
    }
    if (result.status === "conflict") {
      return c.json({ error: { code: "TASK_CHANGED", message: "Task changed since it was loaded" } }, 409);
    }
    const updated = result.task;
    const creators = await loadTaskCreators(db, [updated]);
    const protectedFields = await loadTaskProtectedFields(db, [updated]);
    return c.json({ task: toTaskDto(updated, access, creators, protectedFields.get(updated.id)) });
  });

  return routes;
}

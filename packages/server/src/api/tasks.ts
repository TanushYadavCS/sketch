import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createLocalTaskMutationPolicy } from "../db/repositories/local-task-mutations";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import {
  canEditTaskStatus,
  loadTaskCreators,
  loadTaskProtectedFields,
  resolveTaskAccessContext,
  toTaskDto,
} from "./task-access";
import { readTaskEditRequest } from "./task-edit-request";

export function taskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const taskRepo = createTaskRepository(db);
  const mutationPolicy = createLocalTaskMutationPolicy(db);

  routes.get("/:taskId", async (c) => {
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listVisibleTasksByIds([c.req.param("taskId")], access);
    const task = tasks[0];
    if (!task) return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    const creators = await loadTaskCreators(db, [task]);
    const protectedFields = await loadTaskProtectedFields(db, [task]);
    return c.json({ task: toTaskDto(task, access, creators, protectedFields.get(task.id)) });
  });

  routes.patch("/:taskId", async (c) => {
    const request = await readTaskEditRequest(c);
    if (!request.ok) {
      return c.json({ error: { code: request.code, message: request.message } }, request.status);
    }
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listVisibleTasksByIds([c.req.param("taskId")], access);
    const task = tasks[0];
    if (!task) return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    if (!canEditTaskStatus(task, access)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    }
    const result = await mutationPolicy.mutateHumanTask({
      taskId: task.id,
      userId: access.userId,
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

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createEntityRepository } from "../../db/repositories/entities";
import { type TaskStatus, createTaskRepository } from "../../db/repositories/tasks";
import type { DB } from "../../db/schema";
import { getFileViewer } from "../auth-helpers";
import {
  TASK_STATUSES,
  canEditTaskStatus,
  loadTaskCreators,
  parseTaskLimit,
  resolveTaskAccessContext,
  toTaskDto,
} from "../task-access";

export function createTaskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const entityRepo = createEntityRepository(db);
  const taskRepo = createTaskRepository(db);

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
    return c.json({
      tasks: tasks.map((task) => toTaskDto(task, access, creators)),
    });
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
    const access = await resolveTaskAccessContext(db, c);
    if (!canEditTaskStatus(task, access)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    }
    const updated = await taskRepo.updateLocalTaskStatus({
      taskId: task.id,
      userId,
      assigneeEntityIds: access.assigneeEntityIds,
      canEditAllLocalTasks: access.canEditAllLocalTasks,
      status: body.status as TaskStatus,
      surface: "web",
    });
    if (!updated) return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    const creators = await loadTaskCreators(db, [updated]);
    return c.json({ task: toTaskDto(updated, access, creators) });
  });

  return routes;
}

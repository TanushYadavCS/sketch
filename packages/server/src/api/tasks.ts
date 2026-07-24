import { Hono } from "hono";
import type { Kysely } from "kysely";
import { type TaskStatus, createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { TASK_STATUSES, canEditTaskStatus, loadTaskCreators, resolveTaskAccessContext, toTaskDto } from "./task-access";

export function taskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const taskRepo = createTaskRepository(db);

  routes.get("/:taskId", async (c) => {
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listVisibleTasksByIds([c.req.param("taskId")], access);
    const task = tasks[0];
    if (!task) return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    const creators = await loadTaskCreators(db, [task]);
    return c.json({ task: toTaskDto(task, access, creators) });
  });

  routes.patch("/:taskId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
    if (typeof body.status !== "string" || !TASK_STATUSES.has(body.status)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid status" } }, 400);
    }
    const access = await resolveTaskAccessContext(db, c);
    const tasks = await taskRepo.listVisibleTasksByIds([c.req.param("taskId")], access);
    const task = tasks[0];
    if (!task) return c.json({ error: { code: "NOT_FOUND", message: "Task not found" } }, 404);
    if (!canEditTaskStatus(task, access)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Task status is read-only" } }, 403);
    }
    const updated = await taskRepo.updateLocalTaskStatus({
      taskId: task.id,
      userId: access.userId,
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

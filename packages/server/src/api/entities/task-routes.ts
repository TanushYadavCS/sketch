import { Hono } from "hono";
import type { Kysely } from "kysely";
import { createEntityRepository } from "../../db/repositories/entities";
import { type TaskStatus, createTaskRepository } from "../../db/repositories/tasks";
import type { DB } from "../../db/schema";
import { getContentViewer } from "../auth-helpers";

const TASK_STATUSES = new Set(["open", "in_progress", "done", "dropped"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function parseTaskLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function createTaskRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const entityRepo = createEntityRepository(db);
  const taskRepo = createTaskRepository(db);

  routes.get("/:id/tasks", async (c) => {
    const viewer = getContentViewer(c);
    const entity = await entityRepo.getEntity(c.req.param("id"), viewer);
    if (!entity) return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    const status = c.req.query("status");
    if (status && !TASK_STATUSES.has(status)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid status" } }, 400);
    }
    const limit = parseTaskLimit(c.req.query("limit"));
    const tasks = await taskRepo.listTasksByParent(entity.id, {
      viewer,
      status: status as TaskStatus | undefined,
      limit,
    });
    return c.json({ tasks });
  });

  return routes;
}

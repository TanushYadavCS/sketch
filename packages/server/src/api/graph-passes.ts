import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { getPostSyncCoordinator } from "../connectors/post-sync-coordinator";
import { type GraphPassRun, createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import type { DB } from "../db/schema";

function requireAdmin(c: Context) {
  if (c.get("role") !== "admin") {
    return { error: { code: "FORBIDDEN", message: "Admin access required" } };
  }
  return null;
}

function serializeRun(run: GraphPassRun) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    errorMessage: run.errorMessage,
    inputSnapshot: run.inputSnapshot,
  };
}

export function graphPassRoutes(db: Kysely<DB>, logger: Logger) {
  const routes = new Hono();
  const runs = createGraphPassRunRepository(db);

  routes.post("/runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const running = await runs.getRunning();
    getPostSyncCoordinator(db)
      .drain({ db, logger })
      .catch((err) => {
        logger.error({ err }, "Manual graph pass drain failed");
      });

    return c.json(
      {
        run: running ? serializeRun(running) : null,
        joined: Boolean(running),
        status: running ? "joined" : "queued",
      },
      201,
    );
  });

  routes.get("/runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = await runs.list(limit);
    return c.json({ runs: rows.map(serializeRun) });
  });

  routes.get("/runs/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = await runs.get(c.req.param("id"));
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: "Graph pass run not found" } }, 404);
    }
    return c.json({ run: serializeRun(run) });
  });

  return routes;
}

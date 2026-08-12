import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { getPostSyncCoordinator } from "../connectors/post-sync-coordinator";
import { type GraphPassRun, createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import type { DB } from "../db/schema";
import { runQueuePasses } from "../entities/queue-run";

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

  /**
   * The queue passes cannot ride the existing `/runs` endpoint: that one drains
   * the post-sync coordinator, which does nothing when no file is dirty. These
   * passes are queue-wide and have no dirty input to key off.
   *
   * No lock is taken. The projection is idempotent and neither pass writes to
   * the graph, so two overlapping runs converge.
   */
  routes.post("/queue-runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const runId = await runs.start({
      kind: "queue",
      scannedRows: 0,
      set: {},
      cleared: 0,
      frozen: 0,
      candidatesRepointed: 0,
      candidatesCleared: 0,
    });

    try {
      const snapshot = await runQueuePasses(db);
      await runs.updateSnapshot(runId, snapshot);
      await runs.complete(runId);
      logger.info({ runId, ...snapshot }, "Queue graph pass complete");
    } catch (err) {
      await runs.fail(runId, err instanceof Error ? err.message : "queue graph pass failed");
      logger.error({ err, runId }, "Queue graph pass failed");
      const failed = await runs.get(runId);
      return c.json({ run: failed ? serializeRun(failed) : null }, 500);
    }

    const run = await runs.get(runId);
    return c.json({ run: run ? serializeRun(run) : null }, 201);
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

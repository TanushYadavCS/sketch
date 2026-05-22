import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { DB } from "../db/schema";
import {
  type RecreateSummary,
  type ReplayFactsSummary,
  type ResetSummary,
  getRecreateConflict,
  recreateEntityGraph,
  resetDerivedEntityData,
} from "../entities/recreate";
import { beginRecreateLock, endRecreateLock, isRecreateActive } from "../entities/recreate-state";
import { denyIfNotAdmin } from "./auth-helpers";

const CONFIRM_TOKEN = "RESET_AND_RECREATE";

type RecreatePhase = "idle" | "resetting" | "reset_done" | "replaying_facts" | "enriching" | "done" | "failed";

interface RecreateJob {
  id: string;
  phase: RecreatePhase;
  startedAt: string;
  finishedAt: string | null;
  reset?: ResetSummary;
  replay?: ReplayFactsSummary;
  recreate?: RecreateSummary;
  error?: string;
}

// Single in-memory job controller. The app is a single-process node server,
// so this is sufficient for v1. If the process restarts mid-job the DB state
// remains safe — each phase is idempotent and the recreate-state lock is
// reclaimed at process start.
let currentJob: RecreateJob | null = null;
let latestJob: RecreateJob | null = null;

function newJob(): RecreateJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

export function entityRecreateRoutes(db: Kysely<DB>, logger: Logger) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    return c.json({
      active: currentJob !== null || isRecreateActive(),
      currentJob,
      latestJob,
      blockedBy: currentJob ? null : conflict,
    });
  });

  routes.post("/reset", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string; dryRun?: boolean };
    if (!body.dryRun && body.confirm !== CONFIRM_TOKEN) {
      return c.json({ error: { code: "BAD_REQUEST", message: `confirm must be ${CONFIRM_TOKEN}` } }, 400);
    }

    const conflict = await getRecreateConflict(db);
    if (conflict) {
      return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }

    try {
      if (body.dryRun) {
        const reset = await resetDerivedEntityData(db, logger, { dryRun: true });
        return c.json({ reset });
      }

      const triggeredByUserId = (c.get("sub") as string | undefined) ?? null;
      if (!triggeredByUserId) {
        return c.json({ error: { code: "BAD_REQUEST", message: "Missing user context" } }, 400);
      }

      const job = newJob();
      job.phase = "resetting";
      beginRecreateLock();
      currentJob = job;
      const reset = await resetDerivedEntityData(db, logger.child({ jobId: job.id }), { lockAlreadyHeld: true });
      job.reset = reset;
      job.phase = "reset_done";
      return c.json({ reset });
    } catch (err) {
      if (currentJob?.phase === "resetting") {
        currentJob.error = err instanceof Error ? err.message : String(err);
        currentJob.phase = "failed";
        currentJob.finishedAt = new Date().toISOString();
        latestJob = currentJob;
        currentJob = null;
        endRecreateLock();
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: "RESET_FAILED", message } }, 500);
    }
  });

  routes.post("/run", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { skipLlm?: boolean };

    if (currentJob && currentJob.phase !== "reset_done") {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Recreate job already active" } }, 409);
    }
    if (!currentJob) {
      const conflict = await getRecreateConflict(db);
      if (conflict) return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }

    const triggeredByUserId = (c.get("sub") as string | undefined) ?? null;
    if (!triggeredByUserId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing user context" } }, 400);
    }

    // Replay-only: caller already reset. Detect by checking for any existing
    // entities — if non-zero we'd duplicate; fail loudly so caller resets first.
    const existingEntities = await db.selectFrom("entities").select("id").limit(1).executeTakeFirst();
    if (existingEntities) {
      return c.json(
        {
          error: {
            code: "RESET_REQUIRED",
            message: "Run /reset before /run, or use POST /api/entities/recreate to do both.",
          },
        },
        409,
      );
    }

    const job = currentJob ?? newJob();
    job.phase = "replaying_facts";
    currentJob = job;

    // Fire-and-forget — do not block the HTTP request.
    void (async () => {
      try {
        const summary = await recreateEntityGraph({
          db,
          logger: logger.child({ jobId: job.id }),
          triggeredByUserId,
          skipReset: true,
          skipLlm: body.skipLlm ?? false,
          lockAlreadyHeld: isRecreateActive(),
        });
        job.replay = summary.replay;
        job.recreate = summary;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        logger.error({ err, jobId: job.id }, "Recreate /run failed");
      } finally {
        latestJob = job;
        currentJob = null;
        if (isRecreateActive()) endRecreateLock();
      }
    })();

    return c.json({ job: { id: job.id, phase: job.phase, startedAt: job.startedAt } }, 202);
  });

  // Combined endpoint: reset, then run. Same body shape (confirm token required).
  routes.post("/", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string; dryRun?: boolean; skipLlm?: boolean };
    if (body.confirm !== CONFIRM_TOKEN) {
      return c.json({ error: { code: "BAD_REQUEST", message: `confirm must be ${CONFIRM_TOKEN}` } }, 400);
    }
    if (currentJob) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Recreate job already active" } }, 409);
    }
    const conflict = await getRecreateConflict(db);
    if (conflict) return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);

    if (body.dryRun) {
      try {
        const reset = await resetDerivedEntityData(db, logger, { dryRun: true });
        return c.json({ reset });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: { code: "RESET_FAILED", message } }, 500);
      }
    }

    const triggeredByUserId = (c.get("sub") as string | undefined) ?? null;
    if (!triggeredByUserId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing user context" } }, 400);
    }

    const job = newJob();
    job.phase = "resetting";
    currentJob = job;

    void (async () => {
      try {
        const summary = await recreateEntityGraph({
          db,
          logger: logger.child({ jobId: job.id }),
          triggeredByUserId,
          skipLlm: body.skipLlm ?? false,
        });
        job.reset = summary.reset;
        job.replay = summary.replay;
        job.recreate = summary;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        logger.error({ err, jobId: job.id }, "Recreate combined run failed");
      } finally {
        latestJob = job;
        currentJob = null;
      }
    })();

    return c.json({ job: { id: job.id, phase: job.phase, startedAt: job.startedAt } }, 202);
  });

  return routes;
}

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import { getRecreateConflict, recreateEntityGraph } from "../../entities/recreate";
import {
  beginPendingRebuild,
  beginRecreateLock,
  cancelPendingRebuild,
  endRecreateLock,
  getPendingRebuild,
  isRecreateActive,
  promotePendingRebuild,
} from "../../entities/recreate-state";
import {
  AI_EXTRACTION_FACT_TYPES,
  type ReenrichScope,
  computeReenrichDryRun,
  resolveReenrichFileIds,
  runReenrichJob,
  tombstoneActiveLlmFacts,
} from "../../entities/reenrich";
import { denyIfNotAdmin } from "../auth-helpers";
import {
  getCurrentRebuildJob,
  getCurrentReenrichJob,
  getCurrentResetJob,
  getLatestRebuildJob,
  getLatestReenrichJob,
  getLatestResetJob,
  newRebuildJob,
  newReenrichJob,
  newResetJob,
  setCurrentRebuildJob,
  setCurrentReenrichJob,
  setCurrentResetJob,
  setLatestRebuildJob,
  setLatestReenrichJob,
  setLatestResetJob,
} from "./jobs";
import {
  FACT_TYPES_BY_CATEGORY,
  type ResetCategory,
  computeResetCounts,
  parseReenrichScope,
  performReset,
} from "./reset-service";
import type { EntityRoutesDeps } from "./types";

const RESET_CONFIRM_TOKEN = "RESET_AND_RECREATE";
const REENRICH_CONFIRM_TOKEN = "REENRICH";

export function createEntityMaintenanceRoutes(db: Kysely<DB>, deps: EntityRoutesDeps) {
  const routes = new Hono();
  const { logger, config } = deps;

  const ORG_SOURCE_TYPES = ["person", "company", "product", "team", "project"];

  /**
   * GET /api/entities/resets/jobs
   * Current + most-recently-finished reset+rebuild job.
   */
  routes.get("/resets/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    const currentResetJob = getCurrentResetJob();
    return c.json({
      active: currentResetJob !== null || isRecreateActive(),
      currentJob: currentResetJob,
      latestJob: getLatestResetJob(),
      blockedBy: currentResetJob ? null : conflict,
    });
  });

  /**
   * GET /api/entities/resets/jobs/:id
   */
  routes.get("/resets/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const currentResetJob = getCurrentResetJob();
    const latestResetJob = getLatestResetJob();
    if (currentResetJob?.id === id) return c.json(currentResetJob);
    if (latestResetJob?.id === id) return c.json(latestResetJob);
    return c.json({ error: { code: "NOT_FOUND", message: "Reset job not found" } }, 404);
  });

  routes.get("/reenrichments/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    const currentReenrichJob = getCurrentReenrichJob();
    return c.json({
      active: currentReenrichJob !== null || isRecreateActive(),
      currentJob: currentReenrichJob,
      latestJob: getLatestReenrichJob(),
      blockedBy: currentReenrichJob ? null : conflict,
    });
  });

  routes.get("/reenrichments/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const currentReenrichJob = getCurrentReenrichJob();
    const latestReenrichJob = getLatestReenrichJob();
    if (currentReenrichJob?.id === id) return c.json(currentReenrichJob);
    if (latestReenrichJob?.id === id) return c.json(latestReenrichJob);
    return c.json({ error: { code: "NOT_FOUND", message: "Re-enrich job not found" } }, 404);
  });

  routes.delete("/reenrichments/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const currentReenrichJob = getCurrentReenrichJob();
    if (!currentReenrichJob || currentReenrichJob.id !== id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Active re-enrich job not found" } }, 404);
    }
    currentReenrichJob.cancelRequested = true;
    currentReenrichJob.error = "Stop requested";
    return c.json({ message: "Stop requested.", job: currentReenrichJob }, 202);
  });

  /**
   * GET /api/entities/rebuilds/jobs
   * Active/most-recent rebuild job (step 2 of two-step replay path).
   */
  routes.get("/rebuilds/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    const currentRebuildJob = getCurrentRebuildJob();
    return c.json({
      active: currentRebuildJob !== null || isRecreateActive(),
      currentJob: currentRebuildJob,
      latestJob: getLatestRebuildJob(),
      blockedBy: currentRebuildJob ? null : conflict,
    });
  });

  routes.get("/rebuilds/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const currentRebuildJob = getCurrentRebuildJob();
    const latestRebuildJob = getLatestRebuildJob();
    if (currentRebuildJob?.id === id) return c.json(currentRebuildJob);
    if (latestRebuildJob?.id === id) return c.json(latestRebuildJob);
    return c.json({ error: { code: "NOT_FOUND", message: "Rebuild job not found" } }, 404);
  });

  /**
   * POST /api/entities/rebuilds
   * Step 2 (replay path) of the two-step rebuild. Requires a pendingRebuildId
   * returned by a prior /resets call. Replays existing facts only — does not
   * call the LLM. Use /reenrichments for the re-extract path.
   *
   * Body: { pendingRebuildId: string }
   */
  routes.post("/rebuilds", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { pendingRebuildId?: string };
    if (typeof body.pendingRebuildId !== "string" || body.pendingRebuildId.length === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "pendingRebuildId is required" } }, 400);
    }
    const pendingRebuildId = body.pendingRebuildId;

    if (getCurrentResetJob() || getCurrentReenrichJob() || getCurrentRebuildJob()) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Another job is already active" } }, 409);
    }

    const promote = promotePendingRebuild(pendingRebuildId);
    if (promote !== "promoted") {
      return c.json(
        {
          error: {
            code: promote === "expired" ? "PENDING_REBUILD_EXPIRED" : "PENDING_REBUILD_INVALID",
            message: `pendingRebuildId ${promote.replace(/_/g, " ")}`,
          },
        },
        409,
      );
    }

    const job = newRebuildJob({ pendingRebuildId });
    job.phase = "replaying_facts";
    setCurrentRebuildJob(job);
    const triggeredByUserId = (c.get("sub") as string | undefined) ?? "system";

    void (async () => {
      try {
        const result = await recreateEntityGraph({
          db,
          logger: logger.child({ jobId: job.id, component: "entity-rebuild" }),
          triggeredByUserId,
          skipReset: true,
          lockAlreadyHeld: true,
          llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
          coMentionContributesToThreshold: config.CO_MENTION_CONTRIBUTES_TO_THRESHOLD,
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
        job.recreate = result;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        logger.error({ err, jobId: job.id }, "Rebuild job failed");
      } finally {
        setLatestRebuildJob(job);
        setCurrentRebuildJob(null);
        if (isRecreateActive()) endRecreateLock();
      }
    })();

    return c.json(
      {
        message: "Rebuild started.",
        job: { id: job.id, phase: job.phase, startedAt: job.startedAt },
      },
      202,
    );
  });

  /**
   * DELETE /api/entities/rebuilds/pending/:id
   * Release a pending recreate lock (caller hit Cancel on step 2). Idempotent
   * from the UI perspective:
   *   - 204 when the lock was pending under this id and released.
   *   - 409 when the lock was already promoted into an active rebuild.
   *   - 404 otherwise (no pending lock or id mismatch — expired counts too).
   */
  routes.delete("/rebuilds/pending/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const result = cancelPendingRebuild(id);
    if (result === "released") return c.body(null, 204);
    if (result === "already_promoted") {
      return c.json({ error: { code: "PENDING_REBUILD_INVALID", message: "pendingRebuildId already promoted" } }, 409);
    }
    return c.json({ error: { code: "NOT_FOUND", message: `pendingRebuildId ${result.replace(/_/g, " ")}` } }, 404);
  });

  /**
   * GET /api/entities/rebuilds/pending
   * Inspect the current pending lock (used by the dialog when the page is
   * refreshed mid-flow to recover step state).
   */
  routes.get("/rebuilds/pending", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const pending = getPendingRebuild();
    if (!pending) return c.json({ pending: null });
    return c.json({
      pending: {
        pendingRebuildId: pending.pendingRebuildId,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        createdAt: new Date(pending.createdAt).toISOString(),
      },
    });
  });

  /**
   * POST /api/entities/reenrichments
   * Re-extract entity facts for a file scope and optionally rebuild afterward.
   * Rejects category-shaped reset payloads so a misrouted reset request cannot
   * silently re-extract the whole graph. When given a pendingRebuildId from
   * /resets, promotes that lock before normal recreate conflict checks because
   * the caller's own pending lock would otherwise look like RECREATE_ACTIVE.
   */
  routes.post("/reenrichments", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: ReenrichScope;
      confirm?: string;
      dryRun?: boolean;
      runAfter?: boolean;
      pendingRebuildId?: string;
      categories?: unknown;
    };
    if (body.categories !== undefined) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "/reenrichments does not accept categories; use /resets" } },
        400,
      );
    }

    const scope = parseReenrichScope(body.scope);
    if (!scope) {
      return c.json({ error: { code: "BAD_REQUEST", message: "scope is required" } }, 400);
    }
    const dryRun = body.dryRun === true;
    const allScope = "all" in scope && scope.all === true;
    if (allScope && !dryRun && body.confirm !== REENRICH_CONFIRM_TOKEN) {
      return c.json({ error: { code: "BAD_REQUEST", message: `confirm must be ${REENRICH_CONFIRM_TOKEN}` } }, 400);
    }

    const resolved = await resolveReenrichFileIds(db, scope);
    if (dryRun) {
      const summary = await computeReenrichDryRun(db, resolved.fileIds, resolved.missingFileIds);
      return c.json({ dryRun: true, ...summary });
    }
    if (resolved.fileIds.length === 0) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "No non-archived files matched the requested scope" } },
        400,
      );
    }

    const pendingRebuildId = typeof body.pendingRebuildId === "string" ? body.pendingRebuildId : undefined;
    let lockAlreadyHeld = false;
    if (pendingRebuildId) {
      const promote = promotePendingRebuild(pendingRebuildId);
      if (promote !== "promoted") {
        return c.json(
          {
            error: {
              code: promote === "expired" ? "PENDING_REBUILD_EXPIRED" : "PENDING_REBUILD_INVALID",
              message: `pendingRebuildId ${promote.replace(/_/g, " ")}`,
            },
          },
          409,
        );
      }
      lockAlreadyHeld = true;
    } else {
      const conflict = await getRecreateConflict(db);
      if (conflict) {
        return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
      }
    }
    if (getCurrentResetJob()) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Reset job already active" } }, 409);
    }
    if (getCurrentReenrichJob()) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Re-enrich job already active" } }, 409);
    }
    if (getCurrentRebuildJob()) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Rebuild job already active" } }, 409);
    }

    const runAfter = body.runAfter !== false;
    const job = newReenrichJob({ scope, runAfter });
    job.phase = "wiping";
    setCurrentReenrichJob(job);

    /**
     * Runs the re-enrichment job after the HTTP response returns. A promoted
     * pending lock becomes active, and runReenrichJob does not release that
     * caller-held lock, so the cleanup path releases it here.
     */
    void (async () => {
      try {
        job.phase = "wiping";
        const summary = await runReenrichJob({
          db,
          logger: logger.child({ jobId: job.id, component: "entity-reenrich" }),
          triggeredByUserId: (c.get("sub") as string | undefined) ?? "system",
          fileIds: resolved.fileIds,
          missingFileIds: resolved.missingFileIds,
          runAfter,
          lockAlreadyHeld,
          llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
          coMentionContributesToThreshold: config.CO_MENTION_CONTRIBUTES_TO_THRESHOLD,
          geminiMaxRpm: config.GEMINI_MAX_RPM,
          geminiMaxRetries: config.GEMINI_MAX_RETRIES,
          onPhase: (phase) => {
            job.phase = phase;
          },
          onProgress: (progress) => {
            job.progress = progress;
          },
          shouldCancel: () => job.cancelRequested === true,
        });
        job.summary = summary;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = job.cancelRequested ? "cancelled" : "failed";
        job.finishedAt = new Date().toISOString();
        if (job.cancelRequested) {
          logger.warn({ jobId: job.id }, "Re-enrich job stopped");
        } else {
          logger.error({ err, jobId: job.id }, "Re-enrich job failed");
        }
      } finally {
        setLatestReenrichJob(job);
        setCurrentReenrichJob(null);
        if (lockAlreadyHeld && isRecreateActive()) endRecreateLock();
      }
    })();

    return c.json(
      {
        message: "Re-enrich started.",
        files: resolved.fileIds.length,
        missingFileIds: resolved.missingFileIds,
        factTypes: AI_EXTRACTION_FACT_TYPES,
        job: { id: job.id, phase: job.phase, startedAt: job.startedAt },
      },
      202,
    );
  });

  /**
   * POST /api/entities/resets
   * Delete entities by category, optionally clearing related fact flags and
   * rebuilding the entity graph via materialize+deterministic linking.
   *
   * Body: {
   *   categories: ("manual" | "connectors" | "ai")[],
   *   runAfter?: boolean,
   *   dryRun?: boolean,
   *   confirm?: string,
   *   wipeLlmFacts?: boolean,
   * }
   *
   * confirm is required when runAfter=true or all categories are selected.
   * wipeLlmFacts tombstones llm_extracted/llm_relation facts after the
   * category purge in step 1 of the two-step rebuild flow.
   * Rejects scope-shaped re-enrichment payloads so a misrouted re-enrich
   * request cannot silently succeed as a category reset.
   *
   * When `runAfter=false`, the server begins a pending recreate lock and
   * returns `pendingRebuildId` + `pendingRebuildExpiresAt` so the caller can
   * present them to /rebuilds or /reenrichments for step 2.
   * When `runAfter=true`, the server begins an active lock for the legacy
   * single-shot reset+rebuild path.
   */
  routes.post("/resets", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      categories?: string[];
      runAfter?: boolean;
      dryRun?: boolean;
      confirm?: string;
      wipeLlmFacts?: boolean;
      scope?: unknown;
    };
    if (body.scope !== undefined) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "/resets does not accept scope; use /reenrichments" } },
        400,
      );
    }
    const categoriesIn = Array.isArray(body.categories) ? body.categories : [];
    const categories = new Set<ResetCategory>(
      categoriesIn.filter((c): c is ResetCategory => c === "manual" || c === "connectors" || c === "ai"),
    );

    if (categories.size === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "At least one category is required" } }, 400);
    }

    const runAfter = body.runAfter === true;
    const dryRun = body.dryRun === true;
    const wipeLlmFacts = body.wipeLlmFacts === true;
    const allCategoriesSelected = categories.size === 3;

    if ((runAfter || allCategoriesSelected) && !dryRun && body.confirm !== RESET_CONFIRM_TOKEN) {
      return c.json({ error: { code: "BAD_REQUEST", message: `confirm must be ${RESET_CONFIRM_TOKEN}` } }, 400);
    }

    if (runAfter && categories.size === 1 && categories.has("manual")) {
      return c.json(
        {
          error: { code: "BAD_REQUEST", message: "runAfter requires connectors or ai — manual has no facts to replay" },
        },
        400,
      );
    }

    const includeConnectors = categories.has("connectors");
    const includeAi = categories.has("ai");
    const includeManual = categories.has("manual");

    const factTypes = Array.from(new Set([...categories].flatMap((cat) => FACT_TYPES_BY_CATEGORY[cat] ?? [])));

    if (dryRun) {
      const counts = await computeResetCounts(db, { includeConnectors, includeAi, includeManual }, ORG_SOURCE_TYPES);
      let dryRunFactsMarked = 0;
      if (factTypes.length > 0) {
        const row = await db
          .selectFrom("indexed_file_facts")
          .select(db.fn.countAll<number>().as("c"))
          .where("fact_type", "in", factTypes)
          .where("deleted_at", "is", null)
          .where("materialized_at", "is not", null)
          .executeTakeFirst();
        dryRunFactsMarked = Number(row?.c ?? 0);
      }
      return c.json({
        message: `Would delete ${counts.entitiesDeleted} entities.`,
        dryRun: true,
        entitiesDeleted: counts.entitiesDeleted,
        candidatesCleared: counts.candidatesCleared,
        reviewQueueCleared: counts.reviewQueueCleared,
        reviewEvidenceCleared: counts.reviewEvidenceCleared,
        rejectionsCleared: counts.rejectionsCleared,
        factsMarkedUnmaterialized: dryRunFactsMarked,
      });
    }

    const conflict = await getRecreateConflict(db);
    if (conflict) {
      return c.json({ error: { code: conflict.code, message: conflict.message } }, 409);
    }
    if (getCurrentResetJob()) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Reset job already active" } }, 409);
    }
    if (getCurrentReenrichJob()) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Re-enrich job already active" } }, 409);
    }
    if (getCurrentRebuildJob()) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Rebuild job already active" } }, 409);
    }

    const job = newResetJob({ categories: [...categories], runAfter, wipeLlmFacts });
    job.phase = "resetting";

    let pendingRebuildId: string | null = null;
    let pendingExpiresAtIso: string | null = null;
    if (runAfter) {
      beginRecreateLock();
    } else {
      pendingRebuildId = randomUUID();
      const { expiresAt } = beginPendingRebuild({ pendingRebuildId });
      pendingExpiresAtIso = new Date(expiresAt).toISOString();
      job.pendingRebuildId = pendingRebuildId;
      job.pendingRebuildExpiresAt = pendingExpiresAtIso;
    }
    setCurrentResetJob(job);
    const triggeredByUserId = (c.get("sub") as string | undefined) ?? "system";

    /**
     * Runs reset after the HTTP response returns. Failed step-1 resets release
     * their pending lock so sync and enrichment do not remain blocked behind a
     * graph the operator never got; successful pending resets keep the lock for
     * step 2, while single-shot resets release their active lock here.
     */
    void (async () => {
      try {
        job.progress = { phase: "resetting", completed: 0, total: 1 };
        const summary = await performReset(db, {
          includeConnectors,
          includeAi,
          includeManual,
          orgSourceTypes: ORG_SOURCE_TYPES,
          factTypes,
        });
        job.reset = summary.resetSummary;
        if (wipeLlmFacts) {
          const tomb = await tombstoneActiveLlmFacts(db, logger.child({ jobId: job.id, phase: "tombstone-llm" }));
          job.llmFactsWiped = tomb;
        }
        job.progress = { phase: "resetting", completed: 1, total: 1 };
        if (!runAfter) {
          job.phase = "done";
          job.finishedAt = new Date().toISOString();
          return;
        }
        job.phase = "replaying_facts";
        const result = await recreateEntityGraph({
          db,
          logger: logger.child({ jobId: job.id }),
          triggeredByUserId,
          skipReset: true,
          lockAlreadyHeld: true,
          llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
          coMentionContributesToThreshold: config.CO_MENTION_CONTRIBUTES_TO_THRESHOLD,
          materializeFactTypes: factTypes.length > 0 ? factTypes : undefined,
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
        job.replay = result.replay;
        job.recreate = result;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        logger.error({ err, jobId: job.id, runAfter, wipeLlmFacts }, "Reset job failed");
        if (!runAfter && pendingRebuildId) {
          cancelPendingRebuild(pendingRebuildId);
        }
      } finally {
        setLatestResetJob(job);
        setCurrentResetJob(null);
        if (runAfter && isRecreateActive()) endRecreateLock();
      }
    })();

    return c.json(
      {
        message: runAfter ? "Reset started, rebuild will follow." : "Reset started.",
        job: {
          id: job.id,
          phase: job.phase,
          startedAt: job.startedAt,
          ...(pendingRebuildId ? { pendingRebuildId, pendingRebuildExpiresAt: pendingExpiresAtIso ?? undefined } : {}),
        },
        ...(pendingRebuildId ? { pendingRebuildId, pendingRebuildExpiresAt: pendingExpiresAtIso } : {}),
      },
      202,
    );
  });

  return routes;
}

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import type { Config } from "../config";
import { isPg } from "../db/dialect";
import { fileVisibilityPredicate } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import type { MaterializeFactsSummary } from "../entities/materialize";
import {
  type RecreateSummary,
  type ResetSummary,
  getRecreateConflict,
  recreateEntityGraph,
} from "../entities/recreate";
import {
  beginPendingRebuild,
  beginRecreateLock,
  cancelPendingRebuild,
  endRecreateLock,
  getPendingRebuild,
  isRecreateActive,
  promotePendingRebuild,
} from "../entities/recreate-state";
import {
  AI_EXTRACTION_FACT_TYPES,
  type ReenrichDryRunSummary,
  type ReenrichScope,
  type ReenrichSummary,
  computeReenrichDryRun,
  resolveReenrichFileIds,
  runReenrichJob,
  tombstoneActiveLlmFacts,
} from "../entities/reenrich";
import { denyIfNotAdmin, getFileViewer } from "./auth-helpers";

const RESET_CONFIRM_TOKEN = "RESET_AND_RECREATE";
const REENRICH_CONFIRM_TOKEN = "REENRICH";

type ResetCategory = "manual" | "connectors" | "ai";
type ResetJobPhase = "idle" | "resetting" | "reset_done" | "replaying_facts" | "enriching" | "done" | "failed";
type ReenrichJobPhase = "idle" | "wiping" | "enriching" | "rebuilding" | "done" | "failed";
type RebuildJobPhase = "idle" | "replaying_facts" | "enriching" | "done" | "failed";

interface JobProgress {
  phase: string;
  completed: number;
  total: number;
}

interface ResetRequest {
  categories: ResetCategory[];
  runAfter: boolean;
  wipeLlmFacts?: boolean;
}

interface ReenrichRequest {
  scope: ReenrichScope;
  runAfter: boolean;
}

interface RebuildRequest {
  pendingRebuildId: string;
}

interface ResetJob {
  id: string;
  phase: ResetJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: ResetRequest;
  progress?: JobProgress;
  reset?: ResetSummary;
  replay?: MaterializeFactsSummary;
  recreate?: RecreateSummary;
  pendingRebuildId?: string;
  pendingRebuildExpiresAt?: string;
  llmFactsWiped?: {
    factsTombstoned: number;
    relationshipEvidenceDeleted: number;
    relationshipsDeleted: number;
  };
  error?: string;
}

interface ReenrichJob {
  id: string;
  phase: ReenrichJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: ReenrichRequest;
  progress?: JobProgress;
  dryRun?: ReenrichDryRunSummary;
  summary?: ReenrichSummary;
  error?: string;
}

interface RebuildJob {
  id: string;
  phase: RebuildJobPhase;
  startedAt: string;
  finishedAt: string | null;
  request: RebuildRequest;
  progress?: JobProgress;
  recreate?: RecreateSummary;
  error?: string;
}

const FACT_TYPES_BY_CATEGORY: Record<ResetCategory, IndexedFileFactType[]> = {
  connectors: ["structural_seed", "person_seed", "attendee", "assignee", "author", "parent_entity"],
  ai: ["llm_extracted", "llm_relation"],
  manual: [],
};

let currentResetJob: ResetJob | null = null;
let latestResetJob: ResetJob | null = null;
let currentReenrichJob: ReenrichJob | null = null;
let latestReenrichJob: ReenrichJob | null = null;
let currentRebuildJob: RebuildJob | null = null;
let latestRebuildJob: RebuildJob | null = null;

function newResetJob(request: ResetRequest): ResetJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

function newReenrichJob(request: ReenrichRequest): ReenrichJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

function newRebuildJob(request: RebuildRequest): RebuildJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    request,
  };
}

interface EntityRoutesDeps {
  logger: Logger;
  config: Config;
}

export function entityRoutes(db: Kysely<DB>, deps: EntityRoutesDeps) {
  const routes = new Hono();
  const repo = createEntityRepository(db);
  const { logger, config } = deps;

  /**
   * GET /api/entities
   *   ?type=person,clickup_space     — filter by source_type (comma-separated)
   *   &source=clickup,linear          — filter by source (from entity_source_refs)
   *   &search=beetu                   — name/alias search
   *   &sort=hotness|mentions|name     — sort field (default: hotness)
   *   &limit=50&offset=0
   */
  /**
   * POST /api/entities
   * Create a new entity manually.
   */
  routes.post("/", async (c) => {
    const body = (await c.req.json()) as {
      name: string;
      sourceType: string;
      subtype?: string;
      aliases?: string[];
    };

    if (!body.name?.trim() || !body.sourceType?.trim()) {
      return c.json({ error: { code: "BAD_REQUEST", message: "name and sourceType are required" } }, 400);
    }

    const entity = await repo.upsertEntity({
      name: body.name.trim(),
      sourceType: body.sourceType.trim(),
      subtype: body.subtype,
      aliases: body.aliases,
      status: "confirmed",
    });

    return c.json({
      entity: {
        id: entity.id,
        name: entity.name,
        sourceType: entity.source_type,
        subtype: entity.subtype,
        aliases: entity.aliases ? JSON.parse(entity.aliases) : [],
        status: entity.status,
      },
    });
  });

  routes.get("/", async (c) => {
    const typeFilter = c.req.query("type")?.split(",").filter(Boolean);
    const sourceFilter = c.req.query("source")?.split(",").filter(Boolean);
    const search = c.req.query("search");
    const sort = c.req.query("sort") ?? "hotness";
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Number(c.req.query("offset")) || 0;

    let query = db
      .selectFrom("entities")
      .selectAll("entities")
      .select(
        sql<number>`(SELECT count(*) FROM entity_mentions WHERE entity_mentions.entity_id = entities.id)`.as(
          "mention_count",
        ),
      )
      .select(
        sql<string>`(SELECT COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at) FROM entity_mentions INNER JOIN indexed_files ON indexed_files.id = entity_mentions.indexed_file_id WHERE entity_mentions.entity_id = entities.id ORDER BY COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at) DESC LIMIT 1)`.as(
          "last_mention_at",
        ),
      );

    if (typeFilter && typeFilter.length > 0) {
      query = query.where("entities.source_type", "in", typeFilter);
    }

    if (sourceFilter && sourceFilter.length > 0) {
      query = query.where(
        "entities.id",
        "in",
        db.selectFrom("entity_source_refs").select("entity_id").where("source", "in", sourceFilter),
      );
    }

    if (search) {
      const pattern = `%${search}%`;
      query = query.where((eb) =>
        eb.or([eb("entities.name", "like", pattern), eb("entities.aliases", "like", pattern)]),
      );
    }

    // Default: exclude archived unless explicitly filtered
    if (!typeFilter) {
      query = query.where("entities.status", "!=", "archived");
    }

    if (sort === "mentions") {
      query = query.orderBy("mention_count", "desc");
    } else if (sort === "name") {
      query = query.orderBy("entities.name", "asc");
    } else {
      query = query.orderBy("entities.hotness", "desc");
    }

    query = query.limit(limit).offset(offset);

    const entities = await query.execute();

    // Total count for pagination
    let countQuery = db.selectFrom("entities").select(db.fn.count("id").as("total"));
    if (typeFilter && typeFilter.length > 0) {
      countQuery = countQuery.where("source_type", "in", typeFilter);
    }
    if (search) {
      const pattern = `%${search}%`;
      countQuery = countQuery.where((eb) => eb.or([eb("name", "like", pattern), eb("aliases", "like", pattern)]));
    }
    if (!typeFilter) {
      countQuery = countQuery.where("status", "!=", "archived");
    }
    const countResult = await countQuery.executeTakeFirst();

    return c.json({
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        sourceType: e.source_type,
        subtype: e.subtype,
        aliases: e.aliases ? JSON.parse(e.aliases) : [],
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        status: e.status,
        hotness: e.hotness,
        mentionCount: Number(e.mention_count ?? 0),
        lastMentionAt: e.last_mention_at ?? null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
      total: Number(countResult?.total ?? 0),
    });
  });

  const ORG_SOURCE_TYPES = ["person", "company", "product", "team", "project"];

  /**
   * GET /api/entities/resets/jobs
   * Current + most-recently-finished reset+rebuild job.
   */
  routes.get("/resets/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    return c.json({
      active: currentResetJob !== null || isRecreateActive(),
      currentJob: currentResetJob,
      latestJob: latestResetJob,
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
    if (currentResetJob?.id === id) return c.json(currentResetJob);
    if (latestResetJob?.id === id) return c.json(latestResetJob);
    return c.json({ error: { code: "NOT_FOUND", message: "Reset job not found" } }, 404);
  });

  routes.get("/reenrichments/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    return c.json({
      active: currentReenrichJob !== null || isRecreateActive(),
      currentJob: currentReenrichJob,
      latestJob: latestReenrichJob,
      blockedBy: currentReenrichJob ? null : conflict,
    });
  });

  routes.get("/reenrichments/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (currentReenrichJob?.id === id) return c.json(currentReenrichJob);
    if (latestReenrichJob?.id === id) return c.json(latestReenrichJob);
    return c.json({ error: { code: "NOT_FOUND", message: "Re-enrich job not found" } }, 404);
  });

  /**
   * GET /api/entities/rebuilds/jobs
   * Active/most-recent rebuild job (step 2 of two-step replay path).
   */
  routes.get("/rebuilds/jobs", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const conflict = await getRecreateConflict(db);
    return c.json({
      active: currentRebuildJob !== null || isRecreateActive(),
      currentJob: currentRebuildJob,
      latestJob: latestRebuildJob,
      blockedBy: currentRebuildJob ? null : conflict,
    });
  });

  routes.get("/rebuilds/jobs/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const id = c.req.param("id");
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

    if (currentResetJob || currentReenrichJob || currentRebuildJob) {
      // We promoted ourselves into the active slot but another job
      // already owns its own state; release and bail.
      endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Another job is already active" } }, 409);
    }

    const job = newRebuildJob({ pendingRebuildId });
    job.phase = "replaying_facts";
    currentRebuildJob = job;
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
        latestRebuildJob = job;
        currentRebuildJob = null;
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

  routes.post("/reenrichments", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: ReenrichScope;
      confirm?: string;
      dryRun?: boolean;
      runAfter?: boolean;
      pendingRebuildId?: string;
      // Guard rail: /reenrichments never accepts categories. A misrouted
      // reset payload landing here would silently re-extract on the entire
      // graph (the original silent-discard regression).
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

    // Two-step rebuild: the caller already holds a pending recreate lock from
    // a prior /resets call. Promote it; only then are the standard sync/
    // enrichment/in-flight-job conflicts checked (because our own pending
    // lock would otherwise read as RECREATE_ACTIVE).
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
    if (currentResetJob) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Reset job already active" } }, 409);
    }
    if (currentReenrichJob) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Re-enrich job already active" } }, 409);
    }
    if (currentRebuildJob) {
      if (lockAlreadyHeld) endRecreateLock();
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Rebuild job already active" } }, 409);
    }

    const runAfter = body.runAfter !== false;
    const job = newReenrichJob({ scope, runAfter });
    job.phase = "wiping";
    currentReenrichJob = job;

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
          onPhase: (phase) => {
            job.phase = phase;
          },
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
        job.summary = summary;
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        logger.error({ err, jobId: job.id }, "Re-enrich job failed");
      } finally {
        latestReenrichJob = job;
        currentReenrichJob = null;
        // Promoted pending → active; runReenrichJob doesn't release the
        // caller-held lock, so we release it here.
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
   *   confirm?: string,  // required when runAfter=true OR all categories
   *   wipeLlmFacts?: boolean,  // tombstone llm_extracted/llm_relation facts after the category purge (step-1 two-step rebuild)
   * }
   *
   * When `runAfter=false`, the server begins a pending recreate lock and
   * returns `pendingRebuildId` + `pendingRebuildExpiresAt` so the caller can
   * present them to /rebuilds or /reenrichments for step 2.
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
      // Guard rail: /resets never accepts scope. Reject explicitly so a
      // misrouted reenrich payload doesn't silently succeed as a category
      // reset (regression for the silent-discard bug that landed in prod).
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
    if (currentResetJob) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Reset job already active" } }, 409);
    }
    if (currentReenrichJob) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Re-enrich job already active" } }, 409);
    }
    if (currentRebuildJob) {
      return c.json({ error: { code: "RECREATE_ACTIVE", message: "Rebuild job already active" } }, 409);
    }

    const job = newResetJob({ categories: [...categories], runAfter, wipeLlmFacts });
    job.phase = "resetting";

    // Lock acquisition:
    //   runAfter=true  → active (legacy single-shot reset+rebuild)
    //   runAfter=false → pending (step 1 of two-step rebuild: hold the lane
    //                   until step 2 promotes or TTL expires)
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
    currentResetJob = job;
    const triggeredByUserId = (c.get("sub") as string | undefined) ?? "system";

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
        // When the step-1 reset itself fails, release the pending lock so sync
        // and enrichment aren't stuck behind a graph the operator never got.
        if (!runAfter && pendingRebuildId) {
          cancelPendingRebuild(pendingRebuildId);
        }
      } finally {
        latestResetJob = job;
        currentResetJob = null;
        // runAfter=true: release the active lock we held.
        // runAfter=false: pending lock stays for step 2 (or TTL releases it).
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

  /**
   * DELETE /api/entities/tentative
   * Delete all tentative entities and their mentions.
   * Must be registered before /:id to prevent "tentative" matching as an ID.
   */
  routes.delete("/tentative", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const typeFilter = c.req.query("type")?.split(",").filter(Boolean);

    let query = db.selectFrom("entities").select("id").where("status", "=", "tentative");
    if (typeFilter && typeFilter.length > 0) {
      query = query.where("source_type", "in", typeFilter);
    }
    const entities = await query.execute();

    if (entities.length === 0) {
      return c.json({ message: "No tentative entities to delete.", count: 0 });
    }

    const ids = entities.map((e) => e.id);
    await db.deleteFrom("entities").where("id", "in", ids).execute();

    return c.json({
      message: `Deleted ${ids.length} tentative entities and their mentions.`,
      count: ids.length,
    });
  });

  /**
   * GET /api/entities/:id
   */
  routes.get("/:id", async (c) => {
    const entity = await repo.getEntity(c.req.param("id"));
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const sourceRefs = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", entity.id)
      .execute();

    return c.json({
      entity: {
        id: entity.id,
        name: entity.name,
        sourceType: entity.source_type,
        subtype: entity.subtype,
        aliases: entity.aliases ? JSON.parse(entity.aliases) : [],
        metadata: entity.metadata ? JSON.parse(entity.metadata) : null,
        status: entity.status,
        hotness: entity.hotness,
        createdAt: entity.created_at,
        updatedAt: entity.updated_at,
      },
      sourceRefs: sourceRefs.map((r) => ({
        id: r.id,
        source: r.source,
        sourceId: r.source_id,
        sourceUrl: r.source_url,
        lastSeenAt: r.last_seen_at,
      })),
    });
  });

  /**
   * PATCH /api/entities/:id
   * Update entity name, source_type, status, or aliases.
   */
  routes.patch("/:id", async (c) => {
    const entity = await repo.getEntity(c.req.param("id"));
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const body = (await c.req.json()) as {
      name?: string;
      sourceType?: string;
      status?: string;
      aliases?: string[];
    };

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.sourceType !== undefined) updates.source_type = body.sourceType;
    if (body.status !== undefined) updates.status = body.status;
    if (body.aliases !== undefined) updates.aliases = JSON.stringify(body.aliases);

    if (Object.keys(updates).length > 0) {
      await repo.updateEntity(entity.id, updates);
    }

    const updated = await repo.getEntity(entity.id);
    if (!updated) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found after update" } }, 404);
    }
    return c.json({
      entity: {
        id: updated.id,
        name: updated.name,
        sourceType: updated.source_type,
        subtype: updated.subtype,
        aliases: updated.aliases ? JSON.parse(updated.aliases) : [],
        status: updated.status,
      },
    });
  });

  /**
   * DELETE /api/entities/:id
   * Delete an entity and its mentions/source refs (cascade).
   */
  routes.delete("/:id", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entity = await repo.getEntity(c.req.param("id"));
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    await db.deleteFrom("entities").where("id", "=", entity.id).execute();
    return c.json({ success: true });
  });

  /**
   * GET /api/entities/:id/mentions
   *   ?source=clickup,fireflies       — filter by indexed_file source
   *   &since=2026-03-01               — date filter
   *   &limit=20&offset=0
   */
  routes.get("/:id/mentions", async (c) => {
    const entityId = c.req.param("id");
    const sourceFilter = c.req.query("source")?.split(",").filter(Boolean);
    const since = c.req.query("since");
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const offset = Number(c.req.query("offset")) || 0;
    const viewer = getFileViewer(c);

    const entity = await repo.getEntity(entityId);
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    let query = db
      .selectFrom("entity_mentions")
      .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
      .select([
        "entity_mentions.id",
        "entity_mentions.context_snippet",
        "entity_mentions.chunk_index",
        "entity_mentions.mentioned_at",
        "indexed_files.id as file_id",
        "indexed_files.file_name",
        "indexed_files.file_type",
        "indexed_files.source",
        "indexed_files.source_path",
        "indexed_files.provider_url",
        "indexed_files.source_updated_at",
        "indexed_files.source_created_at",
      ])
      .where("entity_mentions.entity_id", "=", entityId)
      .orderBy(
        sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
        "desc",
      );

    if (sourceFilter && sourceFilter.length > 0) {
      query = query.where("indexed_files.source", "in", sourceFilter);
    }
    if (since) {
      query = query.where(
        sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
        ">=",
        since,
      );
    }
    if (!viewer.isAdmin) {
      query = query.where(fileVisibilityPredicate(viewer));
    }

    query = query.limit(limit).offset(offset);
    const mentions = await query.execute();

    const buildCountQuery = (gated: boolean) => {
      let q = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select(sql<number>`count(entity_mentions.id)`.as("total"))
        .where("entity_mentions.entity_id", "=", entityId);
      if (sourceFilter && sourceFilter.length > 0) {
        q = q.where("indexed_files.source", "in", sourceFilter);
      }
      if (since) {
        q = q.where(
          sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
          ">=",
          since,
        );
      }
      if (gated) q = q.where(fileVisibilityPredicate(viewer));
      return q;
    };

    const visibleCount = Number((await buildCountQuery(!viewer.isAdmin).executeTakeFirst())?.total ?? 0);
    const hiddenCount = viewer.isAdmin
      ? 0
      : Math.max(0, Number((await buildCountQuery(false).executeTakeFirst())?.total ?? 0) - visibleCount);

    return c.json({
      mentions: mentions.map((m) => ({
        id: m.id,
        contextSnippet: m.context_snippet,
        chunkIndex: m.chunk_index,
        mentionedAt: m.mentioned_at,
        sourceDate: m.source_updated_at ?? m.source_created_at ?? m.mentioned_at,
        file: {
          id: m.file_id,
          fileName: m.file_name,
          fileType: m.file_type,
          source: m.source,
          sourcePath: m.source_path,
          providerUrl: m.provider_url,
        },
      })),
      total: visibleCount,
      hiddenCount,
    });
  });

  /**
   * POST /api/entities/backfill
   * Mark enriched files that have no entity mentions for re-enrichment.
   * The next enrichment run will process them with entity linking enabled.
   * Optional: ?source=clickup,fireflies to limit to specific sources.
   */
  routes.post("/backfill", async (c) => {
    const sourceFilter = c.req.query("source")?.split(",").filter(Boolean);

    // Find files that are enriched but have no entity mentions
    let query = db
      .selectFrom("indexed_files")
      .select(["indexed_files.id"])
      .where("indexed_files.embedding_status", "=", "done")
      .where("indexed_files.is_archived", "=", 0)
      .where("indexed_files.id", "not in", db.selectFrom("entity_mentions").select("indexed_file_id"));

    if (sourceFilter && sourceFilter.length > 0) {
      query = query.where("indexed_files.source", "in", sourceFilter);
    }

    const files = await query.execute();

    if (files.length === 0) {
      return c.json({ message: "No files need entity backfill.", count: 0 });
    }

    // Reset their embedding_status to pending so enrichment picks them up
    const fileIds = files.map((f) => f.id);
    await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "in", fileIds).execute();

    return c.json({
      message: `Marked ${fileIds.length} files for re-enrichment with entity linking.`,
      count: fileIds.length,
    });
  });

  return routes;
}

interface ResetExecutionOptions {
  includeConnectors: boolean;
  includeAi: boolean;
  includeManual: boolean;
  orgSourceTypes: string[];
  factTypes: IndexedFileFactType[];
}

function parseReenrichScope(scope: unknown): ReenrichScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const value = scope as Record<string, unknown>;
  if (value.all === true) return { all: true };
  if (Array.isArray(value.fileIds)) {
    return { fileIds: value.fileIds.filter((id): id is string => typeof id === "string") };
  }
  if (Array.isArray(value.sources)) {
    return { sources: value.sources.filter((source): source is string => typeof source === "string") };
  }
  return null;
}

interface ResetExecutionResult {
  entitiesDeleted: number;
  resetSummary: ResetSummary;
}

const AI_ORIGIN_EXPR = (db: Kysely<DB>) =>
  isPg(db) ? sql`(metadata::jsonb ->> 'origin')` : sql`json_extract(metadata, '$.origin')`;

async function computeResetCounts(
  db: Kysely<DB>,
  flags: { includeConnectors: boolean; includeAi: boolean; includeManual: boolean },
  orgSourceTypes: string[],
): Promise<{
  entitiesDeleted: number;
  candidatesCleared: number;
  reviewQueueCleared: number;
  reviewEvidenceCleared: number;
  rejectionsCleared: number;
}> {
  const toDelete = await selectEntitiesForCategories(db, flags, orgSourceTypes).execute();
  const candidates =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_candidates").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const queue =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_review_queue").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const evidence =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_review_evidence").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  const rejections =
    flags.includeConnectors || flags.includeAi
      ? await db.selectFrom("entity_alias_rejections").select(db.fn.countAll<number>().as("c")).executeTakeFirst()
      : null;
  return {
    entitiesDeleted: toDelete.length,
    candidatesCleared: Number(candidates?.c ?? 0),
    reviewQueueCleared: Number(queue?.c ?? 0),
    reviewEvidenceCleared: Number(evidence?.c ?? 0),
    rejectionsCleared: Number(rejections?.c ?? 0),
  };
}

function selectEntitiesForCategories(
  db: Kysely<DB>,
  flags: { includeConnectors: boolean; includeAi: boolean; includeManual: boolean },
  orgSourceTypes: string[],
) {
  const aiOrigin = AI_ORIGIN_EXPR(db);
  return db
    .selectFrom("entities as e")
    .select([
      "e.id as id",
      sql<number>`(SELECT COUNT(*) FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source = 'llm_extraction')`.as(
        "llm_ref_count",
      ),
      sql<number>`(SELECT COUNT(*) FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source != 'llm_extraction')`.as(
        "other_ref_count",
      ),
      sql<string | null>`${aiOrigin}`.as("ai_origin"),
      "e.source_type as source_type",
    ])
    .where((eb) => {
      const parts = [];
      if (flags.includeConnectors) {
        parts.push(
          eb.or([
            eb("e.source_type", "not in", orgSourceTypes),
            sql<boolean>`EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source != 'llm_extraction')`,
          ]),
        );
      }
      if (flags.includeAi) {
        parts.push(
          eb.or([
            eb(aiOrigin, "=", "ai"),
            sql<boolean>`EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id AND entity_source_refs.source = 'llm_extraction')`,
          ]),
        );
      }
      if (flags.includeManual) {
        parts.push(
          eb.and([
            eb("e.source_type", "in", orgSourceTypes),
            sql<boolean>`NOT EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = e.id)`,
            eb.or([eb(aiOrigin, "is", null), eb(aiOrigin, "!=", "ai")]),
          ]),
        );
      }
      return parts.length === 1 ? parts[0] : eb.or(parts);
    });
}

async function performReset(db: Kysely<DB>, opts: ResetExecutionOptions): Promise<ResetExecutionResult> {
  const rows = await selectEntitiesForCategories(
    db,
    { includeConnectors: opts.includeConnectors, includeAi: opts.includeAi, includeManual: opts.includeManual },
    opts.orgSourceTypes,
  ).execute();

  // Resolve category membership for each candidate. An entity may match more
  // than one selected category — apply precedence: connector-owned wins over
  // ai-only, so connector entities aren't accidentally wiped by an AI reset.
  const idsForDeletion: string[] = [];
  const preservedConnectorIds: string[] = [];
  const preservedAiOnlyIds: string[] = [];
  for (const row of rows) {
    const llmRefs = Number(row.llm_ref_count ?? 0);
    const otherRefs = Number(row.other_ref_count ?? 0);
    const isConnectorOwned = otherRefs > 0 || !opts.orgSourceTypes.includes(row.source_type);
    const isAiOnly = !isConnectorOwned && (row.ai_origin === "ai" || llmRefs > 0);

    if (isConnectorOwned && opts.includeConnectors) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (isAiOnly && opts.includeAi) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (!isConnectorOwned && !isAiOnly && opts.includeManual) {
      idsForDeletion.push(row.id);
      continue;
    }
    if (isConnectorOwned && opts.includeAi) preservedConnectorIds.push(row.id);
    if (isAiOnly && opts.includeConnectors) preservedAiOnlyIds.push(row.id);
  }

  let candidatesCleared = 0;
  let reviewQueueCleared = 0;
  let reviewEvidenceCleared = 0;
  let rejectionsCleared = 0;

  if (opts.includeConnectors || opts.includeAi) {
    const candidatesResult = await db.deleteFrom("entity_candidates").execute();
    candidatesCleared = Number(candidatesResult[0]?.numDeletedRows ?? 0);

    if (opts.includeConnectors) {
      const evidenceCount = await db
        .selectFrom("entity_review_evidence")
        .select(db.fn.count<number>("id").as("c"))
        .executeTakeFirst();
      reviewEvidenceCleared = Number(evidenceCount?.c ?? 0);

      const queueResult = await db.deleteFrom("entity_review_queue").execute();
      reviewQueueCleared = Number(queueResult[0]?.numDeletedRows ?? 0);

      const rejectionsResult = await db.deleteFrom("entity_alias_rejections").execute();
      rejectionsCleared = Number(rejectionsResult[0]?.numDeletedRows ?? 0);
    } else if (opts.includeAi) {
      // AI-only reset: scrub only LLM-sourced review evidence and any queue
      // rows whose evidence is now empty. Leave connector-driven review state
      // and alias rejections intact.
      const evidenceDeleted = await db
        .deleteFrom("entity_review_evidence")
        .where("source", "=", "llm_extraction")
        .execute();
      reviewEvidenceCleared = Number(evidenceDeleted[0]?.numDeletedRows ?? 0);
      const emptyQueueRows = await db
        .selectFrom("entity_review_queue")
        .select("id")
        .where("id", "not in", db.selectFrom("entity_review_evidence").select("review_id"))
        .execute();
      if (emptyQueueRows.length > 0) {
        const queueIds = emptyQueueRows.map((r) => r.id);
        await db.deleteFrom("entity_review_queue").where("id", "in", queueIds).execute();
        reviewQueueCleared = queueIds.length;
      }
    }
  }

  // Scrub stale source-scoped rows on preserved entities so the post-replay
  // graph matches what the materializer will produce.
  if (preservedConnectorIds.length > 0) {
    // AI reset preserved a connector-owned entity that picked up LLM evidence —
    // drop its llm_extraction mentions/refs so replay can recreate them.
    await db
      .deleteFrom("entity_mentions")
      .where("entity_id", "in", preservedConnectorIds)
      .where("source", "=", "llm_extraction")
      .execute();
    await db
      .deleteFrom("entity_source_refs")
      .where("entity_id", "in", preservedConnectorIds)
      .where("source", "=", "llm_extraction")
      .execute();
  }
  if (preservedAiOnlyIds.length > 0) {
    // Connector reset preserved an LLM-only entity — drop its connector-sourced
    // mentions (rare but possible if a connector fact arrived after promotion).
    await db
      .deleteFrom("entity_mentions")
      .where("entity_id", "in", preservedAiOnlyIds)
      .where("source", "!=", "llm_extraction")
      .execute();
    await db
      .deleteFrom("entity_source_refs")
      .where("entity_id", "in", preservedAiOnlyIds)
      .where("source", "!=", "llm_extraction")
      .execute();
  }

  if (idsForDeletion.length > 0) {
    await db.deleteFrom("entity_mentions").where("entity_id", "in", idsForDeletion).execute();
    await db.deleteFrom("entity_source_refs").where("entity_id", "in", idsForDeletion).execute();
    await db.deleteFrom("entities").where("id", "in", idsForDeletion).execute();
  }

  let factsMarkedUnmaterialized = 0;
  if (opts.factTypes.length > 0) {
    const result = await db
      .updateTable("indexed_file_facts")
      .set({ materialized_at: null, updated_at: new Date().toISOString() })
      .where("fact_type", "in", opts.factTypes)
      .where("deleted_at", "is", null)
      .where("materialized_at", "is not", null)
      .executeTakeFirst();
    factsMarkedUnmaterialized = Number(result.numUpdatedRows ?? 0);
  }

  const resetSummary: ResetSummary = {
    dryRun: false,
    deleted: {
      entities: idsForDeletion.length,
      entity_candidates: candidatesCleared,
      entity_review_queue: reviewQueueCleared,
      entity_review_evidence: reviewEvidenceCleared,
      entity_alias_rejections: rejectionsCleared,
    },
    filesMarkedPending: 0,
    factsMarkedUnmaterialized,
    warnings: [],
  };

  return { entitiesDeleted: idsForDeletion.length, resetSummary };
}

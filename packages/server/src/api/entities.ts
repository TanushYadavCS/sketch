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
import { beginRecreateLock, endRecreateLock, isRecreateActive } from "../entities/recreate-state";
import {
  AI_EXTRACTION_FACT_TYPES,
  type ReenrichDryRunSummary,
  type ReenrichScope,
  type ReenrichSummary,
  computeReenrichDryRun,
  resolveReenrichFileIds,
  runReenrichJob,
} from "../entities/reenrich";
import { denyIfNotAdmin, getFileViewer } from "./auth-helpers";

const RESET_CONFIRM_TOKEN = "RESET_AND_RECREATE";
const REENRICH_CONFIRM_TOKEN = "REENRICH";

type ResetCategory = "manual" | "connectors" | "ai";
type ResetJobPhase = "idle" | "resetting" | "reset_done" | "replaying_facts" | "enriching" | "done" | "failed";
type ReenrichJobPhase = "idle" | "wiping" | "enriching" | "rebuilding" | "done" | "failed";

interface ResetJob {
  id: string;
  phase: ResetJobPhase;
  startedAt: string;
  finishedAt: string | null;
  reset?: ResetSummary;
  replay?: MaterializeFactsSummary;
  recreate?: RecreateSummary;
  error?: string;
}

interface ReenrichJob {
  id: string;
  phase: ReenrichJobPhase;
  startedAt: string;
  finishedAt: string | null;
  dryRun?: ReenrichDryRunSummary;
  summary?: ReenrichSummary;
  error?: string;
}

const FACT_TYPES_BY_CATEGORY: Record<ResetCategory, IndexedFileFactType[]> = {
  connectors: ["structural_seed", "person_seed", "attendee", "assignee", "author", "parent_entity"],
  ai: ["llm_extracted"],
  manual: [],
};

let currentResetJob: ResetJob | null = null;
let latestResetJob: ResetJob | null = null;
let currentReenrichJob: ReenrichJob | null = null;
let latestReenrichJob: ReenrichJob | null = null;

function newResetJob(): ResetJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function newReenrichJob(): ReenrichJob {
  return {
    id: randomUUID(),
    phase: "idle",
    startedAt: new Date().toISOString(),
    finishedAt: null,
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

  routes.post("/reenrichments", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: ReenrichScope;
      confirm?: string;
      dryRun?: boolean;
      runAfter?: boolean;
    };

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

    const job = newReenrichJob();
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
          runAfter: body.runAfter !== false,
          llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
          onPhase: (phase) => {
            job.phase = phase;
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
        if (isRecreateActive()) endRecreateLock();
      } finally {
        latestReenrichJob = job;
        currentReenrichJob = null;
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
   * }
   */
  routes.post("/resets", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      categories?: string[];
      runAfter?: boolean;
      dryRun?: boolean;
      confirm?: string;
    };
    const categoriesIn = Array.isArray(body.categories) ? body.categories : [];
    const categories = new Set<ResetCategory>(
      categoriesIn.filter((c): c is ResetCategory => c === "manual" || c === "connectors" || c === "ai"),
    );

    if (categories.size === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "At least one category is required" } }, 400);
    }

    const runAfter = body.runAfter === true;
    const dryRun = body.dryRun === true;
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

    if (runAfter) {
      const job = newResetJob();
      job.phase = "resetting";
      beginRecreateLock();
      currentResetJob = job;
      try {
        const summary = await performReset(db, {
          includeConnectors,
          includeAi,
          includeManual,
          orgSourceTypes: ORG_SOURCE_TYPES,
          factTypes,
        });
        job.reset = summary.resetSummary;
        job.phase = "replaying_facts";
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        latestResetJob = job;
        currentResetJob = null;
        endRecreateLock();
        return c.json({ error: { code: "RESET_FAILED", message: job.error } }, 500);
      }

      void (async () => {
        try {
          const result = await recreateEntityGraph({
            db,
            logger: logger.child({ jobId: job.id }),
            triggeredByUserId: (c.get("sub") as string | undefined) ?? "system",
            skipReset: true,
            lockAlreadyHeld: true,
            llmPromotionThreshold: config.LLM_PROMOTION_THRESHOLD,
            materializeFactTypes: factTypes.length > 0 ? factTypes : undefined,
          });
          job.replay = result.replay;
          job.recreate = result;
          job.phase = "done";
          job.finishedAt = new Date().toISOString();
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.phase = "failed";
          job.finishedAt = new Date().toISOString();
          logger.error({ err, jobId: job.id }, "Reset+rebuild job failed");
        } finally {
          latestResetJob = job;
          currentResetJob = null;
          if (isRecreateActive()) endRecreateLock();
        }
      })();

      return c.json(
        {
          message: "Reset complete, rebuild started.",
          entitiesDeleted: job.reset?.deleted.entities ?? 0,
          candidatesCleared: job.reset?.deleted.entity_candidates ?? 0,
          reviewQueueCleared: job.reset?.deleted.entity_review_queue ?? 0,
          reviewEvidenceCleared: job.reset?.deleted.entity_review_evidence ?? 0,
          rejectionsCleared: job.reset?.deleted.entity_alias_rejections ?? 0,
          factsMarkedUnmaterialized: job.reset?.factsMarkedUnmaterialized ?? 0,
          job: { id: job.id, phase: job.phase, startedAt: job.startedAt },
        },
        202,
      );
    }

    const summary = await performReset(db, {
      includeConnectors,
      includeAi,
      includeManual,
      orgSourceTypes: ORG_SOURCE_TYPES,
      factTypes,
    });
    return c.json({
      message: summary.entitiesDeleted > 0 ? `Deleted ${summary.entitiesDeleted} entities.` : "No entities matched.",
      entitiesDeleted: summary.entitiesDeleted,
      candidatesCleared: summary.resetSummary.deleted.entity_candidates ?? 0,
      reviewQueueCleared: summary.resetSummary.deleted.entity_review_queue ?? 0,
      reviewEvidenceCleared: summary.resetSummary.deleted.entity_review_evidence ?? 0,
      rejectionsCleared: summary.resetSummary.deleted.entity_alias_rejections ?? 0,
      factsMarkedUnmaterialized: summary.resetSummary.factsMarkedUnmaterialized,
    });
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

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { isPg } from "../db/dialect";
import { fileVisibilityPredicate } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { denyIfNotAdmin, getFileViewer } from "./auth-helpers";

export function entityRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const repo = createEntityRepository(db);

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

  /**
   * POST /api/entities/reset
   * Delete entities by category. Body: { categories: ["manual", "connectors", "ai"] }
   * - connectors: came from a sync — non-org source_types (clickup_*, notion_*, …)
   *   OR an org-typed entity with at least one entity_source_refs row (e.g. person
   *   entities seeded from Fireflies attendee mapping).
   * - ai: entities with metadata.origin = "ai".
   * - manual: org-typed entities with no entity_source_refs and no AI origin —
   *   genuinely created by hand.
   * Must be registered before /:id to prevent param capture.
   */
  const ORG_SOURCE_TYPES = ["person", "company", "product", "team", "project"];

  routes.post("/reset", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json()) as { categories?: string[] };
    const categories = new Set(body.categories ?? []);

    if (categories.size === 0) {
      return c.json({ error: { code: "BAD_REQUEST", message: "At least one category is required" } }, 400);
    }

    const includeConnectors = categories.has("connectors");
    const includeAi = categories.has("ai");
    const includeManual = categories.has("manual");

    const hasSourceRef = sql<boolean>`EXISTS (SELECT 1 FROM entity_source_refs WHERE entity_source_refs.entity_id = entities.id)`;
    const toDelete = await db
      .selectFrom("entities")
      .select("id")
      .where((eb) => {
        const parts = [];
        if (includeConnectors) {
          parts.push(eb.or([eb("source_type", "not in", ORG_SOURCE_TYPES), hasSourceRef]));
        }
        if (includeAi) {
          parts.push(
            eb(isPg(db) ? sql`(metadata::jsonb ->> 'origin')` : sql`json_extract(metadata, '$.origin')`, "=", "ai"),
          );
        }
        if (includeManual) {
          parts.push(
            eb.and([
              eb("source_type", "in", ORG_SOURCE_TYPES),
              eb.not(hasSourceRef),
              eb.or([
                eb(
                  isPg(db) ? sql`(metadata::jsonb ->> 'origin')` : sql`json_extract(metadata, '$.origin')`,
                  "is",
                  null,
                ),
                eb(
                  isPg(db) ? sql`(metadata::jsonb ->> 'origin')` : sql`json_extract(metadata, '$.origin')`,
                  "!=",
                  "ai",
                ),
              ]),
            ]),
          );
        }
        return parts.length === 1 ? parts[0] : eb.or(parts);
      })
      .execute();

    /**
     * Clear candidates + ECR review state when connectors or AI selected.
     *
     * Candidates get re-discovered on the next sync. Queue, evidence, and
     * rejections are tied to the connector-driven proposeEntity path; leaving
     * them in place would mean a fresh sync hits stale review state. This must
     * run even when no entities currently match the reset category.
     */
    let candidatesCleared = 0;
    let reviewQueueCleared = 0;
    let reviewEvidenceCleared = 0;
    let rejectionsCleared = 0;
    if (includeConnectors || includeAi) {
      const candidatesResult = await db.deleteFrom("entity_candidates").execute();
      candidatesCleared = Number(candidatesResult[0]?.numDeletedRows ?? 0);

      // Capture counts before delete — evidence cascades on queue delete,
      // so we can't observe its count via the queue's numDeletedRows.
      const evidenceCount = await db
        .selectFrom("entity_review_evidence")
        .select(db.fn.count<number>("id").as("c"))
        .executeTakeFirst();
      reviewEvidenceCleared = Number(evidenceCount?.c ?? 0);

      const queueResult = await db.deleteFrom("entity_review_queue").execute();
      reviewQueueCleared = Number(queueResult[0]?.numDeletedRows ?? 0);

      const rejectionsResult = await db.deleteFrom("entity_alias_rejections").execute();
      rejectionsCleared = Number(rejectionsResult[0]?.numDeletedRows ?? 0);
    }

    if (toDelete.length === 0) {
      return c.json({
        message: "No entities matched.",
        entitiesDeleted: 0,
        candidatesCleared,
        reviewQueueCleared,
        reviewEvidenceCleared,
        rejectionsCleared,
      });
    }

    const ids = toDelete.map((e) => e.id);

    await db.deleteFrom("entity_mentions").where("entity_id", "in", ids).execute();
    await db.deleteFrom("entity_source_refs").where("entity_id", "in", ids).execute();
    await db.deleteFrom("entities").where("id", "in", ids).execute();

    return c.json({
      message: `Deleted ${ids.length} entities.`,
      entitiesDeleted: ids.length,
      candidatesCleared,
      reviewQueueCleared,
      reviewEvidenceCleared,
      rejectionsCleared,
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

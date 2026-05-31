import { Hono } from "hono";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { type FileViewer, fileVisibilityPredicate } from "../../db/repositories/connectors";
import { createEntityRepository, entityVisibilityPredicate } from "../../db/repositories/entities";
import {
  type RelationListEntry,
  createEntityRelationshipsRepository,
} from "../../db/repositories/entity-relationships";
import { createEntitySharesRepository } from "../../db/repositories/entity-shares";
import { createEntityTimelineRepository } from "../../db/repositories/entity-timeline";
import type { DB } from "../../db/schema";
import { type EntityProfileFacts, SYSTEM_SOURCE_TYPES, mapSourceTypeToEntityType } from "../../entities/profile-facts";
import { denyIfNotAdmin, getContentViewer, getFileViewer } from "../auth-helpers";
import type { EntityRoutesDeps } from "./types";

function countByType(rows: RelationListEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.relationshipType] = (out[r.relationshipType] ?? 0) + 1;
  }
  return out;
}

/**
 * Loads the structured facts shape the drawer Summary block consumes.
 * Returns null when the entity doesn't exist.
 */
async function loadEntityFactsForId(
  db: Kysely<DB>,
  entityId: string,
  viewer: FileViewer,
): Promise<EntityProfileFacts | null> {
  const repo = createEntityRepository(db);
  const relRepo = createEntityRelationshipsRepository(db);
  const entity = await repo.getEntity(entityId, viewer);
  if (!entity) return null;
  const [aggregates, relations] = await Promise.all([
    repo.getEntityProfileAggregates(entity.id, viewer),
    relRepo.listRelationsForEntity(entity.id, { limit: 50 }),
  ]);
  const parsedMetadata = entity.metadata ? (JSON.parse(entity.metadata) as Record<string, unknown>) : null;
  const topRelationships = [...relations.outgoing, ...relations.incoming].sort(relationCompare).slice(0, 10);
  return {
    entityId: entity.id,
    name: entity.name,
    sourceType: entity.source_type,
    entityType: mapSourceTypeToEntityType(entity.source_type),
    metadata: parsedMetadata,
    mentionCount: aggregates.mentionCount,
    sourceCounts: aggregates.sourceCounts,
    firstSeenAt: aggregates.firstSeenAt,
    lastSeenAt: aggregates.lastSeenAt,
    domainsForCompany: aggregates.domainsForCompany,
    topRelationships,
    incomingCounts: countByType(relations.incoming),
    outgoingCounts: countByType(relations.outgoing),
  };
}

interface ActivityStats {
  fileCount: number;
  distinctDays: number;
  topCoAttendees: string[];
}

/**
 * Aggregate activity stats for the deterministic Summary: how many files
 * mention this entity, how many distinct calendar days that spans, and the
 * top 3 people who co-attend the same files. Two queries, both portable
 * across SQLite/Postgres. File-derived details are filtered through the
 * same viewer predicate as timeline/evidence routes.
 */
async function loadActivityStats(db: Kysely<DB>, entityId: string, viewer: FileViewer): Promise<ActivityStats> {
  let fileQuery = db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("file_count"),
      sql<number>`COUNT(DISTINCT substr(COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at), 1, 10))`.as(
        "distinct_days",
      ),
    ])
    .where("entity_mentions.entity_id", "=", entityId);
  if (!viewer.isAdmin) {
    fileQuery = fileQuery.where(fileVisibilityPredicate(viewer));
  }
  const fileRow = await fileQuery.executeTakeFirst();

  let coAttendeeQuery = db
    .selectFrom("entity_mentions as em1")
    .innerJoin("indexed_files", "indexed_files.id", "em1.indexed_file_id")
    .innerJoin("entity_mentions as em2", (join) =>
      join.onRef("em2.indexed_file_id", "=", "em1.indexed_file_id").on(sql`em2.entity_id <> em1.entity_id`),
    )
    .innerJoin("entities as e2", "e2.id", "em2.entity_id")
    .select(["e2.id as id", "e2.name as name", sql<number>`COUNT(DISTINCT em1.indexed_file_id)`.as("files")])
    .where("em1.entity_id", "=", entityId)
    .where("e2.source_type", "=", "person")
    .groupBy(["e2.id", "e2.name"])
    .orderBy("files", "desc")
    .limit(3);
  if (!viewer.isAdmin) {
    coAttendeeQuery = coAttendeeQuery.where(fileVisibilityPredicate(viewer));
  }
  const coAttendeeRows = await coAttendeeQuery.execute();

  return {
    fileCount: Number(fileRow?.file_count ?? 0),
    distinctDays: Number(fileRow?.distinct_days ?? 0),
    topCoAttendees: coAttendeeRows.map((r) => r.name),
  };
}

/**
 * Deterministic prose summary: an identity sentence + an activity sentence.
 * Built entirely from relationships + aggregates — no LLM, no shimmer. The
 * idea is to render facts we already know are true rather than synthesizing
 * narrative from action-item facts.
 */
function buildSummary(facts: EntityProfileFacts, activity: ActivityStats): { identity: string; activity: string } {
  const identity = buildIdentitySentence(facts);
  const activitySentence = buildActivitySentence(facts, activity);
  return { identity, activity: activitySentence };
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function buildIdentitySentence(facts: EntityProfileFacts): string {
  const typeWord = formatEntityType(facts.entityType, facts.sourceType);
  const email = typeof facts.metadata?.email === "string" ? facts.metadata.email : null;
  const role = typeof facts.metadata?.role === "string" ? facts.metadata.role : null;
  const outgoing = facts.topRelationships.filter((r) => r.sourceEntityId === facts.entityId);
  const employers = uniqueNames(outgoing.filter((r) => r.relationshipType === "works_at").map((r) => r.other.name));
  const clients = uniqueNames(outgoing.filter((r) => r.relationshipType === "engaged_with").map((r) => r.other.name));

  const parts: string[] = [typeWord];

  if (facts.entityType === "person") {
    if (role) parts.push(role);
    if (employers.length > 0) parts.push(`works at ${joinList(employers)}`);
    if (email) parts.push(`(${email})`);
  } else if (facts.entityType === "company") {
    const primary = facts.domainsForCompany.find((d) => d.isPrimary)?.domain;
    const others = facts.domainsForCompany.filter((d) => !d.isPrimary).map((d) => d.domain);
    if (primary) parts.push(primary);
    if (others.length > 0) parts.push(`also: ${joinList(others.slice(0, 3))}`);
  }

  let sentence = parts.join(" · ");
  if (sentence.length > 0) sentence = `${sentence}.`;

  if (facts.entityType === "person" && clients.length > 0) {
    sentence = `${sentence} Engaged with ${joinList(clients.slice(0, 4))}.`;
  }

  return sentence;
}

function buildActivitySentence(facts: EntityProfileFacts, activity: ActivityStats): string {
  const pieces: string[] = [];
  if (activity.fileCount > 0) {
    const fileTerm = pluralize(activity.fileCount, "file");
    const mentionsTerm = pluralize(facts.mentionCount, "mention");
    if (activity.distinctDays > 0) {
      pieces.push(`Active in ${fileTerm} (${mentionsTerm}) across ${pluralize(activity.distinctDays, "day")}`);
    } else {
      pieces.push(`Active in ${fileTerm} (${mentionsTerm})`);
    }
  }
  if (facts.entityType === "person" && activity.topCoAttendees.length > 0) {
    pieces.push(`most-frequent collaborators: ${joinList(activity.topCoAttendees)}`);
  }
  if (pieces.length === 0) return "";
  return `${pieces.join(". ")}.`;
}

function formatEntityType(entityType: string, sourceType: string): string {
  switch (entityType) {
    case "person":
      return "Person";
    case "company":
      return "Company";
    case "product":
      return "Product";
    case "project":
      return "Project";
    case "team":
      return "Team";
    case "system":
      return capitalize(sourceType);
    default:
      return capitalize(sourceType);
  }
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const CONFIDENCE_ORDER: Record<string, number> = { AMBIGUOUS: 0, EXTRACTED: 1, INFERRED: 2 };

function relationCompare(a: RelationListEntry, b: RelationListEntry): number {
  const ac = CONFIDENCE_ORDER[a.confidence] ?? 3;
  const bc = CONFIDENCE_ORDER[b.confidence] ?? 3;
  if (ac !== bc) return ac - bc;
  if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
  if (a.confidenceScore !== b.confidenceScore) return b.confidenceScore - a.confidenceScore;
  const byName = a.other.name.localeCompare(b.other.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

export function createEntityProfileRoutes(db: Kysely<DB>, deps: EntityRoutesDeps) {
  const routes = new Hono();
  const repo = createEntityRepository(db);
  const relRepo = createEntityRelationshipsRepository(db);
  const timelineRepo = createEntityTimelineRepository(db);
  const sharesRepo = createEntitySharesRepository(db);
  const { config } = deps;

  const RELATIONS_LIMIT = 200;
  const EVIDENCE_LIMIT = 100;
  const TIMELINE_LIMIT = 100;

  /**
   * GET /api/entities
   *   ?type=person,clickup_space     — filter by source_type (comma-separated)
   *   &source=clickup,linear          — filter by source (from entity_source_refs)
   *   &search=beetu                   — name/alias search
   *   &sort=hotness|mentions|name     — sort field (default: hotness)
   *   &limit=50&offset=0
   *
   * Hides container/system entities such as clickup_workspace and clickup_space
   * unless the caller opts in. Explicit type filters always win so deep links
   * and the "Show system entities" toggle keep working.
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
    const includeSystem = c.req.query("includeSystem") === "true";
    const includeArchived = c.req.query("includeArchived") === "true";
    const systemTypes = [...SYSTEM_SOURCE_TYPES];
    const viewer = getFileViewer(c);

    // For non-admin viewers, the mention_count and last_mention_at subqueries
    // must only count mentions in files the viewer can actually see —
    // otherwise an entity row that's visible (via manual share, etc.) leaks
    // activity from hidden files.
    const mentionCountSql = viewer.isAdmin
      ? sql<number>`(SELECT count(*) FROM entity_mentions WHERE entity_mentions.entity_id = entities.id)`
      : sql<number>`(SELECT count(*) FROM entity_mentions
                     INNER JOIN indexed_files ON indexed_files.id = entity_mentions.indexed_file_id
                     WHERE entity_mentions.entity_id = entities.id
                       AND ${fileVisibilityPredicate(viewer)})`;
    const lastMentionSql = viewer.isAdmin
      ? sql<string>`(SELECT COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)
                     FROM entity_mentions
                     INNER JOIN indexed_files ON indexed_files.id = entity_mentions.indexed_file_id
                     WHERE entity_mentions.entity_id = entities.id
                     ORDER BY COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at) DESC
                     LIMIT 1)`
      : sql<string>`(SELECT COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)
                     FROM entity_mentions
                     INNER JOIN indexed_files ON indexed_files.id = entity_mentions.indexed_file_id
                     WHERE entity_mentions.entity_id = entities.id
                       AND ${fileVisibilityPredicate(viewer)}
                     ORDER BY COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at) DESC
                     LIMIT 1)`;

    let query = db
      .selectFrom("entities")
      .selectAll("entities")
      .select(mentionCountSql.as("mention_count"))
      .select(lastMentionSql.as("last_mention_at"));

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

    if (!includeArchived) {
      query = query.where("entities.status", "!=", "archived");
    }

    if (!typeFilter && !includeSystem && systemTypes.length > 0) {
      query = query.where("entities.source_type", "not in", systemTypes);
    }

    if (!viewer.isAdmin) {
      query = query.where(entityVisibilityPredicate(viewer));
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

    let countQuery = db.selectFrom("entities").select(db.fn.count("entities.id").as("total"));
    if (typeFilter && typeFilter.length > 0) {
      countQuery = countQuery.where("entities.source_type", "in", typeFilter);
    }
    if (search) {
      const pattern = `%${search}%`;
      countQuery = countQuery.where((eb) =>
        eb.or([eb("entities.name", "like", pattern), eb("entities.aliases", "like", pattern)]),
      );
    }
    if (!includeArchived) {
      countQuery = countQuery.where("entities.status", "!=", "archived");
    }
    if (!typeFilter && !includeSystem && systemTypes.length > 0) {
      countQuery = countQuery.where("entities.source_type", "not in", systemTypes);
    }
    if (!viewer.isAdmin) {
      countQuery = countQuery.where(entityVisibilityPredicate(viewer));
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
   * POST /api/entities/backfill
   * Mark enriched files that have no entity mentions for re-enrichment.
   * The next enrichment run will process them with entity linking enabled.
   * Optional: ?source=clickup,fireflies to limit to specific sources.
   * Selects done, non-archived files without entity mentions and marks their
   * embedding_status pending so the enrichment scheduler picks them up.
   */
  routes.post("/backfill", async (c) => {
    const sourceFilter = c.req.query("source")?.split(",").filter(Boolean);

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

    const fileIds = files.map((f) => f.id);
    await db.updateTable("indexed_files").set({ embedding_status: "pending" }).where("id", "in", fileIds).execute();

    return c.json({
      message: `Marked ${fileIds.length} files for re-enrichment with entity linking.`,
      count: fileIds.length,
    });
  });

  /**
   * GET /api/entities/:id
   *
   * Backwards-compatible: existing callers keep getting `{ entity, sourceRefs }`
   * with the same field names. The drawer surface receives an additional
   * `entity.profile` block (aggregates + a deterministic summary) so the
   * open-feel is a single round-trip. The profile block is always present so
   * the web layer can rely on it; the experimental flag gates the drawer UI,
   * not the response shape.
   */
  routes.get("/:id", async (c) => {
    const viewer = getFileViewer(c);
    const entity = await repo.getEntity(c.req.param("id"), viewer);
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const [sourceRefs, facts, manualShares] = await Promise.all([
      db.selectFrom("entity_source_refs").selectAll().where("entity_id", "=", entity.id).execute(),
      loadEntityFactsForId(db, entity.id, viewer),
      db
        .selectFrom("entity_share_emails")
        .select(["email", "granted_at"])
        .where("entity_id", "=", entity.id)
        .orderBy("granted_at", "desc")
        .execute(),
    ]);
    if (!facts) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }

    const parsedAliases = entity.aliases ? (JSON.parse(entity.aliases) as string[]) : [];
    const activity = await loadActivityStats(db, entity.id, viewer);
    const summary = buildSummary(facts, activity);

    return c.json({
      entity: {
        id: entity.id,
        name: entity.name,
        sourceType: entity.source_type,
        subtype: entity.subtype,
        aliases: parsedAliases,
        metadata: facts.metadata,
        status: entity.status,
        hotness: entity.hotness,
        shareWithEveryone: entity.share_with_everyone === 1,
        manualShares: manualShares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
        createdAt: entity.created_at,
        updatedAt: entity.updated_at,
        profile: {
          entityType: facts.entityType,
          mentionCount: facts.mentionCount,
          sourceCounts: facts.sourceCounts,
          firstSeenAt: facts.firstSeenAt,
          lastSeenAt: facts.lastSeenAt,
          domainsForCompany: facts.domainsForCompany,
          summary,
        },
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
   * GET /api/entities/:id/relations
   * Drawer Relationships section. Caps each side at 200; sets `truncated`
   * when more rows exist. Gated by EXPERIMENTAL_FLAG (drawer UI is flagged).
   */
  routes.get("/:id/relations", async (c) => {
    if (!config.EXPERIMENTAL_FLAG) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    const viewer = getFileViewer(c);
    const entity = await repo.getEntity(c.req.param("id"), viewer);
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const result = await relRepo.listRelationsForEntity(entity.id, { limit: RELATIONS_LIMIT });
    return c.json({
      outgoing: result.outgoing.sort(relationCompare),
      incoming: result.incoming.sort(relationCompare),
      truncated: result.truncated,
      totalCount: result.totalCount,
    });
  });

  /**
   * GET /api/entities/:id/relations/:rid/evidence
   * Evidence rows for a single relation, filtered by file-level RBAC.
   * `visibleCount < totalCount` is the "N more not visible to you" signal —
   * we expose that hidden evidence exists, not its content (file names and
   * snippets are filtered out for hidden rows).
   */
  routes.get("/:id/relations/:rid/evidence", async (c) => {
    if (!config.EXPERIMENTAL_FLAG) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    const entityId = c.req.param("id");
    const relationshipId = c.req.param("rid");
    const viewer = getFileViewer(c);
    const entity = await repo.getEntity(entityId, viewer);
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const relation = await relRepo.getRelationship(relationshipId);
    if (!relation || (relation.source_entity_id !== entityId && relation.target_entity_id !== entityId)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Relation not found" } }, 404);
    }
    const result = await relRepo.listEvidenceForRelation(relationshipId, { limit: EVIDENCE_LIMIT, viewer });
    return c.json(result);
  });

  /**
   * GET /api/entities/:id/timeline
   * File mentions for an entity, grouped by month newest-first. File RBAC
   * applied; capped at 100 visible rows.
   */
  routes.get("/:id/timeline", async (c) => {
    if (!config.EXPERIMENTAL_FLAG) {
      return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
    }
    const viewer = getFileViewer(c);
    const entity = await repo.getEntity(c.req.param("id"), viewer);
    if (!entity) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const result = await timelineRepo.listTimelineForEntity(entity.id, { limit: TIMELINE_LIMIT, viewer });
    return c.json(result);
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
    const contentViewer = getContentViewer(c);

    const entity = await repo.getEntity(entityId, viewer);
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
    if (!contentViewer.isAdmin) {
      query = query.where(fileVisibilityPredicate(contentViewer));
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
      if (gated) q = q.where(fileVisibilityPredicate(contentViewer));
      return q;
    };

    const visibleCount = Number((await buildCountQuery(!contentViewer.isAdmin).executeTakeFirst())?.total ?? 0);
    const hiddenCount = contentViewer.isAdmin
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
   * Manual entity share management.
   *
   * Authz: all routes are admin-only. Entities have no single owner (unlike
   * connectors), so members cannot grant or revoke shares.
   */
  const shareEmailBodySchema = z.object({ email: z.string().email().toLowerCase() });
  const shareEveryoneBodySchema = z.object({ enabled: z.boolean() });
  const shareBatchBodySchema = z.object({
    emails: z.array(z.string().email().toLowerCase()),
    shareWithEveryone: z.boolean().optional(),
  });

  async function entityExists(entityId: string): Promise<boolean> {
    const row = await db.selectFrom("entities").select("id").where("id", "=", entityId).executeTakeFirst();
    return !!row;
  }

  routes.get("/:id/shares", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entityId = c.req.param("id");
    if (!(await entityExists(entityId))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const [shares, shareWithEveryone] = await Promise.all([
      sharesRepo.listForEntity(entityId),
      sharesRepo.getOrgWide(entityId),
    ]);
    return c.json({
      shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
      shareWithEveryone,
    });
  });

  routes.post("/:id/shares", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entityId = c.req.param("id");
    if (!(await entityExists(entityId))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareEmailBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    const grantedBy = c.get("sub") as string;
    await sharesRepo.grantToEmail(entityId, parsed.data.email, grantedBy);
    const shares = await sharesRepo.listForEntity(entityId);
    return c.json({ shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })) });
  });

  routes.delete("/:id/shares/:email", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entityId = c.req.param("id");
    const email = decodeURIComponent(c.req.param("email"));
    if (!(await entityExists(entityId))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    await sharesRepo.revokeFromEmail(entityId, email);
    return c.json({ success: true });
  });

  routes.put("/:id/share-everyone", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entityId = c.req.param("id");
    if (!(await entityExists(entityId))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareEveryoneBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    await sharesRepo.setOrgWide(entityId, parsed.data.enabled);
    return c.json({ shareWithEveryone: parsed.data.enabled });
  });

  routes.put("/:id/shares", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const entityId = c.req.param("id");
    if (!(await entityExists(entityId))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Entity not found" } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = shareBatchBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
    const grantedBy = c.get("sub") as string;
    const targetEmails = new Set(parsed.data.emails);
    await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("entity_share_emails")
        .select("email")
        .where("entity_id", "=", entityId)
        .execute();
      const existingSet = new Set(existing.map((r) => r.email));
      const toAdd = [...targetEmails].filter((e) => !existingSet.has(e));
      const toRemove = [...existingSet].filter((e) => !targetEmails.has(e));
      if (toAdd.length > 0) {
        await trx
          .insertInto("entity_share_emails")
          .values(
            toAdd.map((email) => ({
              entity_id: entityId,
              email,
              granted_by_user_id: grantedBy,
            })),
          )
          .onConflict((oc) => oc.columns(["entity_id", "email"]).doNothing())
          .execute();
      }
      if (toRemove.length > 0) {
        await trx
          .deleteFrom("entity_share_emails")
          .where("entity_id", "=", entityId)
          .where("email", "in", toRemove)
          .execute();
      }
      if (parsed.data.shareWithEveryone !== undefined) {
        await trx
          .updateTable("entities")
          .set({ share_with_everyone: parsed.data.shareWithEveryone ? 1 : 0 })
          .where("id", "=", entityId)
          .execute();
      }
    });
    const [shares, shareWithEveryone] = await Promise.all([
      sharesRepo.listForEntity(entityId),
      sharesRepo.getOrgWide(entityId),
    ]);
    return c.json({
      shares: shares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
      shareWithEveryone,
    });
  });

  return routes;
}

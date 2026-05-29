import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { isPg } from "../dialect";
import type { DB, EntitiesTable } from "../schema";
import { type FileViewer, fileVisibilityPredicate } from "./connectors";

/**
 * Predicate matching entities visible to `viewer`. Composed into queries via `.where(...)`.
 *
 *   admin              = bypasses RBAC (single OR branch resolves to true)
 *   org-wide           = entities.share_with_everyone = 1
 *   manual share       = caller's email is in entity_share_emails for the entity
 *   file co-mention    = caller can see at least one file mentioning the entity
 *                        (delegates to fileVisibilityPredicate via EXISTS)
 *
 * Acyclic: this calls fileVisibilityPredicate. fileVisibilityPredicate must
 * never call back into entityVisibilityPredicate — entity-share propagation
 * to files is expressed directly there against entity_share_emails / entities.
 *
 * `alias` is the SQL identifier for `entities` at the call site (default
 * "entities"). Pass a different name when the entity table is aliased.
 */
export function entityVisibilityPredicate(viewer: FileViewer, alias = "entities") {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    throw new Error(`entityVisibilityPredicate: invalid table alias "${alias}"`);
  }
  if (viewer.isAdmin) {
    return sql<boolean>`(1 = 1)`;
  }
  const t = sql.raw(alias);
  const email = viewer.email ?? "";
  const fileVis = fileVisibilityPredicate(viewer, "ifs_inner");
  return sql<boolean>`(
    ${t}.share_with_everyone = 1
    OR EXISTS (SELECT 1 FROM entity_share_emails ese
               WHERE ese.entity_id = ${t}.id
                 AND ese.email = ${email})
    OR EXISTS (
      SELECT 1 FROM entity_mentions em_vis
      INNER JOIN indexed_files AS ifs_inner ON ifs_inner.id = em_vis.indexed_file_id
      WHERE em_vis.entity_id = ${t}.id
        AND ifs_inner.is_archived = 0
        AND ${fileVis}
    )
  )`;
}

export interface UpsertEntityData {
  name: string;
  sourceType: string;
  subtype?: string | null;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  sourceRefId?: string | null;
  status?: string;
}

export interface UpsertEntityFromToolData {
  name: string;
  sourceType: string;
  source: string;
  sourceId: string;
  sourceUrl?: string;
  sourceRefId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertPersonEntityData {
  name: string;
  email?: string;
  subtype: "internal" | "external";
  source: string;
  sourceId: string;
}

export type EntityMentionConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type EntityMentionRelation = "mentioned" | "attended" | "authored" | "assigned" | "organized" | "corresponded";

export interface CreateMentionData {
  entityId: string;
  indexedFileId: string;
  chunkIndex?: number | null;
  contextSnippet?: string | null;
  confidence: EntityMentionConfidence;
  source: string;
  relation: EntityMentionRelation;
}

export function createEntityRepository(db: Kysely<DB>) {
  return {
    // ── CRUD ──

    async upsertEntity(data: UpsertEntityData) {
      const existing = await db
        .selectFrom("entities")
        .selectAll()
        .where("name", "=", data.name)
        .where("source_type", "=", data.sourceType)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable("entities")
          .set({
            subtype: data.subtype ?? existing.subtype,
            aliases: data.aliases ? JSON.stringify(data.aliases) : existing.aliases,
            metadata: data.metadata ? JSON.stringify(data.metadata) : existing.metadata,
            source_ref_id: data.sourceRefId ?? existing.source_ref_id,
            status: data.status ?? existing.status,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", existing.id)
          .execute();
        return { ...existing, updated_at: new Date().toISOString() };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      await db
        .insertInto("entities")
        .values({
          id,
          name: data.name,
          source_type: data.sourceType,
          subtype: data.subtype ?? null,
          aliases: data.aliases ? JSON.stringify(data.aliases) : null,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          source_ref_id: data.sourceRefId ?? null,
          status: data.status ?? "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      return await db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    /**
     * Fetch an entity. When `viewer` is omitted the entity is returned without
     * RBAC — internal/server callers use this to operate on entities directly
     * (e.g. enrichment, materialization). API handlers must pass a viewer so
     * callers without access get null (which maps to 404).
     */
    async getEntity(id: string, viewer?: FileViewer) {
      let query = db.selectFrom("entities").selectAll().where("id", "=", id);
      if (viewer) {
        query = query.where(entityVisibilityPredicate(viewer));
      }
      return query.executeTakeFirst();
    },

    async getEntities(ids: string[]) {
      if (ids.length === 0) return [];
      return db.selectFrom("entities").selectAll().where("id", "in", ids).execute();
    },

    async getEntitiesBySourceType(sourceType: string) {
      return db.selectFrom("entities").selectAll().where("source_type", "=", sourceType).execute();
    },

    async getEntitiesByStatus(status: string) {
      return db.selectFrom("entities").selectAll().where("status", "=", status).execute();
    },

    async updateEntity(
      id: string,
      updates: Partial<{
        name: string;
        subtype: string;
        aliases: string;
        metadata: string;
        status: string;
        hotness: number;
      }>,
    ) {
      await db
        .updateTable("entities")
        .set({ ...updates, updated_at: new Date().toISOString() })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Append a name to entity.aliases (JSON string array) if it's not already
     * present (case-insensitive on the stored alias values). No-op when the
     * alias is already present. Used by ECR-02's Confirm flow (alias-append
     * on the resolved target) and the Reject flow's self-alias step. The
     * aliases column is stored as a JSON string, not jsonb — read, parse,
     * mutate, stringify, write. Touches `updated_at`.
     */
    async appendAlias(entityId: string, aliasName: string) {
      const trimmed = aliasName.trim();
      if (!trimmed) return;
      const row = await db.selectFrom("entities").select(["aliases"]).where("id", "=", entityId).executeTakeFirst();
      if (!row) return;
      const aliases: string[] = row.aliases ? JSON.parse(row.aliases) : [];
      if (aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return;
      aliases.push(trimmed);
      await db
        .updateTable("entities")
        .set({ aliases: JSON.stringify(aliases), updated_at: new Date().toISOString() })
        .where("id", "=", entityId)
        .execute();
    },

    /**
     * Write `email` into entity.metadata.email if metadata.email is currently
     * absent or empty. No-op if metadata.email is already set — the existing
     * value is the source of truth, this helper does not overwrite. Used by
     * ECR-02's Confirm-time held-email materialization. Email lives inside
     * the `metadata` JSON column (see upsertPersonEntity above); this helper
     * does a read-modify-write rather than reaching into dialect-specific
     * `json_set` / `jsonb_set` so the same code path works on SQLite and
     * Postgres.
     */
    async attachEmailIfAbsent(entityId: string, email: string) {
      const trimmed = email.trim();
      if (!trimmed) return;
      const row = await db.selectFrom("entities").select(["metadata"]).where("id", "=", entityId).executeTakeFirst();
      if (!row) return;
      const meta: Record<string, unknown> = row.metadata ? JSON.parse(row.metadata) : {};
      if (typeof meta.email === "string" && meta.email.length > 0) return;
      meta.email = trimmed;
      await db
        .updateTable("entities")
        .set({ metadata: JSON.stringify(meta), updated_at: new Date().toISOString() })
        .where("id", "=", entityId)
        .execute();
    },

    // ── Source Refs ──

    async upsertSourceRef(data: { entityId: string; source: string; sourceId: string; sourceUrl?: string }) {
      const existing = await db
        .selectFrom("entity_source_refs")
        .selectAll()
        .where("source", "=", data.source)
        .where("source_id", "=", data.sourceId)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable("entity_source_refs")
          .set({
            entity_id: data.entityId,
            source_url: data.sourceUrl ?? existing.source_url,
            last_seen_at: new Date().toISOString(),
          })
          .where("id", "=", existing.id)
          .execute();
        return;
      }

      await db
        .insertInto("entity_source_refs")
        .values({
          id: randomUUID(),
          entity_id: data.entityId,
          source: data.source,
          source_id: data.sourceId,
          source_url: data.sourceUrl ?? null,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
    },

    async getEntityBySourceRef(source: string, sourceId: string) {
      const ref = await db
        .selectFrom("entity_source_refs")
        .select("entity_id")
        .where("source", "=", source)
        .where("source_id", "=", sourceId)
        .executeTakeFirst();

      if (!ref) return null;
      return db.selectFrom("entities").selectAll().where("id", "=", ref.entity_id).executeTakeFirst() ?? null;
    },

    // ── Mentions ──

    async createMention(data: CreateMentionData) {
      let insert = db.insertInto("entity_mentions").values({
        id: randomUUID(),
        entity_id: data.entityId,
        indexed_file_id: data.indexedFileId,
        chunk_index: data.chunkIndex ?? null,
        context_snippet: data.contextSnippet ?? null,
        confidence: data.confidence,
        source: data.source,
        relation: data.relation,
        mentioned_at: new Date().toISOString(),
      });

      if (data.confidence === "EXTRACTED") {
        insert = insert.onConflict((oc) =>
          oc.columns(["entity_id", "indexed_file_id", "relation"]).doUpdateSet({
            chunk_index: data.chunkIndex ?? null,
            context_snippet: data.contextSnippet ?? null,
            confidence: data.confidence,
            source: data.source,
            mentioned_at: new Date().toISOString(),
          }),
        );
      } else {
        insert = insert.onConflict((oc) => oc.columns(["entity_id", "indexed_file_id", "relation"]).doNothing());
      }

      await insert.execute();
    },

    async getMentionsForEntity(entityId: string, opts?: { limit?: number; since?: string }) {
      let query = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select([
          "entity_mentions.id",
          "entity_mentions.entity_id",
          "entity_mentions.indexed_file_id",
          "entity_mentions.chunk_index",
          "entity_mentions.context_snippet",
          "entity_mentions.mentioned_at",
          "indexed_files.source_updated_at",
          "indexed_files.source_created_at",
        ])
        .where("entity_mentions.entity_id", "=", entityId)
        .orderBy(
          sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
          "desc",
        );

      if (opts?.since) {
        query = query.where(
          sql`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
          ">=",
          opts.since,
        );
      }
      if (opts?.limit) {
        query = query.limit(opts.limit);
      }
      return query.execute();
    },

    async getMentionsForFile(indexedFileId: string) {
      return db.selectFrom("entity_mentions").selectAll().where("indexed_file_id", "=", indexedFileId).execute();
    },

    /**
     * Delete content-derived mentions for a file. EXTRACTED rows survive
     * because they come from durable connector facts (attendee/assignee/
     * parent_entity), not from re-runnable content extraction. Wiping them
     * here would destroy the fact-driven graph every time enrichment
     * re-runs (content change, manual re-trigger, recreate orchestrator).
     */
    async deleteMentionsForFile(indexedFileId: string) {
      await db
        .deleteFrom("entity_mentions")
        .where("indexed_file_id", "=", indexedFileId)
        .where("confidence", "!=", "EXTRACTED")
        .execute();
    },

    // ── Search ──

    async searchEntities(
      query: string,
      opts?: { sourceTypes?: string[]; limit?: number; sortBy?: "relevance" | "recency" },
    ) {
      const pattern = `%${query}%`;
      let q = db
        .selectFrom("entities")
        .selectAll()
        .where((eb) => eb.or([eb("name", "like", pattern), eb("aliases", "like", pattern)]));

      if (opts?.sourceTypes && opts.sourceTypes.length > 0) {
        q = q.where("source_type", "in", opts.sourceTypes);
      }

      if (opts?.sortBy === "recency") {
        // Most-recent activity per entity. LEFT JOIN against the aggregated
        // derived table so entities with zero mentions still appear; coalesce
        // the timestamp to '' so DESC ordering puts them last in both SQLite
        // (NULLS-last default) and Postgres (NULLS-first default) without
        // resorting to dialect-specific NULLS LAST syntax.
        const lastActivityByEntity = db
          .selectFrom("entity_mentions")
          .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
          .select((eb) => [
            "entity_mentions.entity_id",
            eb.fn
              .max(
                sql<string>`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`,
              )
              .as("last_activity"),
          ])
          .groupBy("entity_mentions.entity_id")
          .as("la");

        q = q
          .leftJoin(lastActivityByEntity, "la.entity_id", "entities.id")
          .orderBy(sql`COALESCE(la.last_activity, '')`, "desc")
          .orderBy("entities.name", "asc");
      }

      q = q.limit(opts?.limit ?? 50);
      return q.execute();
    },

    // ── Hotness ──

    async getHotEntities(limit: number) {
      return db
        .selectFrom("entities")
        .selectAll()
        .where("status", "!=", "archived")
        .orderBy("hotness", "desc")
        .limit(limit)
        .execute();
    },

    async updateHotness(entityId: string) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const mentionCount = await db
        .selectFrom("entity_mentions")
        .where("entity_id", "=", entityId)
        .where("mentioned_at", ">=", thirtyDaysAgo)
        .select(db.fn.count("id").as("count"))
        .executeTakeFirst();

      const lastMention = await db
        .selectFrom("entity_mentions")
        .where("entity_id", "=", entityId)
        .orderBy("mentioned_at", "desc")
        .select("mentioned_at")
        .limit(1)
        .executeTakeFirst();

      const count = Number(mentionCount?.count ?? 0);
      const daysSince = lastMention
        ? (Date.now() - new Date(lastMention.mentioned_at).getTime()) / (24 * 60 * 60 * 1000)
        : 30;

      const hotness = (1 / (1 + Math.exp(-Math.log1p(count)))) * Math.exp(-0.1 * daysSince);

      await db
        .updateTable("entities")
        .set({ hotness, updated_at: new Date().toISOString() })
        .where("id", "=", entityId)
        .execute();
    },

    async recomputeAllHotness() {
      const entities = await db.selectFrom("entities").select("id").where("status", "!=", "archived").execute();
      for (const entity of entities) {
        await this.updateHotness(entity.id);
      }
      return entities.length;
    },

    // ── Profile aggregates (entity drawer) ──

    /**
     * One-shot aggregates for the drawer's profile section. Returns mention
     * count + source breakdown, first/last-seen timestamps, and company
     * domains. Mention-derived aggregates are filtered to files visible to
     * `viewer` when provided and non-admin — otherwise the entity row itself
     * can be visible (via manual share / share_with_everyone) while leaking
     * activity from files the viewer cannot see. Server-internal callers may
     * omit `viewer` for unfiltered aggregates.
     */
    async getEntityProfileAggregates(
      entityId: string,
      viewer?: FileViewer,
    ): Promise<{
      mentionCount: number;
      sourceCounts: Record<string, number>;
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      domainsForCompany: Array<{ domain: string; confidence: number; isPrimary: boolean }>;
    }> {
      const filterByVisibility = viewer !== undefined && !viewer.isAdmin;

      let mentionQuery = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select(sql<number>`count(*)`.as("c"))
        .where("entity_mentions.entity_id", "=", entityId);
      if (filterByVisibility) {
        mentionQuery = mentionQuery.where(fileVisibilityPredicate(viewer));
      }
      const mentionRow = await mentionQuery.executeTakeFirst();
      const mentionCount = Number(mentionRow?.c ?? 0);

      let bySourceQuery = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select(["indexed_files.source", sql<number>`count(*)`.as("c")])
        .where("entity_mentions.entity_id", "=", entityId)
        .groupBy("indexed_files.source");
      if (filterByVisibility) {
        bySourceQuery = bySourceQuery.where(fileVisibilityPredicate(viewer));
      }
      const bySource = await bySourceQuery.execute();
      const sourceCounts: Record<string, number> = {};
      for (const row of bySource) {
        sourceCounts[row.source] = Number(row.c ?? 0);
      }

      let rangeQuery = db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .select([
          sql<
            string | null
          >`MIN(COALESCE(indexed_files.source_created_at, indexed_files.source_updated_at, entity_mentions.mentioned_at))`.as(
            "first_seen",
          ),
          sql<
            string | null
          >`MAX(COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at))`.as(
            "last_seen",
          ),
        ])
        .where("entity_mentions.entity_id", "=", entityId);
      if (filterByVisibility) {
        rangeQuery = rangeQuery.where(fileVisibilityPredicate(viewer));
      }
      const range = await rangeQuery.executeTakeFirst();

      const domainRows = await db
        .selectFrom("entity_domains")
        .select(["domain", "confidence", "is_primary"])
        .where("entity_id", "=", entityId)
        .orderBy("is_primary", "desc")
        .orderBy("confidence", "desc")
        .execute();

      return {
        mentionCount,
        sourceCounts,
        firstSeenAt: range?.first_seen ?? null,
        lastSeenAt: range?.last_seen ?? null,
        domainsForCompany: domainRows.map((d) => ({
          domain: d.domain,
          confidence: Number(d.confidence ?? 0),
          isPrimary: d.is_primary === 1,
        })),
      };
    },

    // ── Seeding Helpers ──

    async upsertEntityFromTool(data: UpsertEntityFromToolData) {
      const existing = await db
        .selectFrom("entity_source_refs")
        .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
        .selectAll("entities")
        .where("entity_source_refs.source", "=", data.source)
        .where("entity_source_refs.source_id", "=", data.sourceId)
        .executeTakeFirst();

      if (existing) {
        // If name changed, add old name as alias
        const updates: Record<string, unknown> = {
          name: data.name,
          metadata: data.metadata ? JSON.stringify(data.metadata) : existing.metadata,
          source_ref_id: data.sourceRefId ?? existing.source_ref_id,
          updated_at: new Date().toISOString(),
        };

        if (existing.name !== data.name) {
          const aliases: string[] = JSON.parse(existing.aliases || "[]");
          if (!aliases.some((a) => a.toLowerCase() === existing.name.toLowerCase())) {
            aliases.push(existing.name);
            updates.aliases = JSON.stringify(aliases);
          }
        }

        await db.updateTable("entities").set(updates).where("id", "=", existing.id).execute();

        await db
          .updateTable("entity_source_refs")
          .set({
            source_url: data.sourceUrl ?? null,
            last_seen_at: new Date().toISOString(),
          })
          .where("source", "=", data.source)
          .where("source_id", "=", data.sourceId)
          .execute();

        return existing;
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      await db
        .insertInto("entities")
        .values({
          id,
          name: data.name,
          source_type: data.sourceType,
          subtype: null,
          aliases: null,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          source_ref_id: data.sourceRefId ?? null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await db
        .insertInto("entity_source_refs")
        .values({
          id: randomUUID(),
          entity_id: id,
          source: data.source,
          source_id: data.sourceId,
          source_url: data.sourceUrl ?? null,
          last_seen_at: now,
        })
        .execute();

      return await db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    /**
     * Narrow upsert for LLM-extracted non-person entities. Keys by
     * (normalizeName(name), source_type) with case-insensitive comparison
     * done client-side so the same path works on SQLite and Postgres.
     * Returns whether the row was newly created so materialization summaries
     * don't count updates as new entities.
     */
    async upsertLlmExtractedEntity(
      data: UpsertEntityData,
    ): Promise<{ entity: Selectable<EntitiesTable>; created: boolean }> {
      const targetKey = normalizeName(data.name);
      const candidates = await db
        .selectFrom("entities")
        .selectAll()
        .where("source_type", "=", data.sourceType)
        .execute();
      const match = candidates.find((c) => normalizeName(c.name) === targetKey);

      if (match) {
        const now = new Date().toISOString();
        await db
          .updateTable("entities")
          .set({
            aliases: data.aliases ? JSON.stringify(data.aliases) : match.aliases,
            metadata: data.metadata ? JSON.stringify(data.metadata) : match.metadata,
            status: data.status ?? match.status,
            updated_at: now,
          })
          .where("id", "=", match.id)
          .execute();
        const fresh = await db.selectFrom("entities").selectAll().where("id", "=", match.id).executeTakeFirstOrThrow();
        return { entity: fresh, created: false };
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      await db
        .insertInto("entities")
        .values({
          id,
          name: data.name,
          source_type: data.sourceType,
          subtype: data.subtype ?? null,
          aliases: data.aliases ? JSON.stringify(data.aliases) : null,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          source_ref_id: null,
          status: data.status ?? "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      const entity = await db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return { entity, created: true };
    },

    async upsertPersonEntity(data: UpsertPersonEntityData) {
      // Match by email first (most reliable dedup for people)
      if (data.email) {
        const byEmail = await db
          .selectFrom("entities")
          .selectAll()
          .where("source_type", "=", "person")
          .where(
            isPg(db) ? sql`(metadata::jsonb ->> 'email')` : sql`json_extract(metadata, '$.email')`,
            "=",
            data.email,
          )
          .executeTakeFirst();

        if (byEmail) {
          const aliases: string[] = JSON.parse(byEmail.aliases || "[]");
          let canonicalName = byEmail.name;
          let changed = false;

          // Promote a real name when the stored canonical is the email itself —
          // legacy seeds set name = email; once we learn a real name, upgrade.
          const storedLooksLikeEmail = byEmail.name.includes("@");
          const incomingLooksLikeEmail = data.name.includes("@");
          if (storedLooksLikeEmail && !incomingLooksLikeEmail) {
            canonicalName = data.name;
            if (!aliases.some((a) => a.toLowerCase() === byEmail.name.toLowerCase())) {
              aliases.push(byEmail.name);
            }
            changed = true;
          } else if (
            byEmail.name.toLowerCase() !== data.name.toLowerCase() &&
            !aliases.some((a) => a.toLowerCase() === data.name.toLowerCase())
          ) {
            aliases.push(data.name);
            changed = true;
          }

          if (data.email && !aliases.some((a) => a.toLowerCase() === data.email?.toLowerCase())) {
            aliases.push(data.email);
            changed = true;
          }
          if (changed) {
            await db
              .updateTable("entities")
              .set({ name: canonicalName, aliases: JSON.stringify(aliases), updated_at: new Date().toISOString() })
              .where("id", "=", byEmail.id)
              .execute();
          }

          // Ensure source ref exists
          const existingRef = await db
            .selectFrom("entity_source_refs")
            .select("id")
            .where("source", "=", data.source)
            .where("source_id", "=", data.sourceId)
            .executeTakeFirst();

          if (!existingRef) {
            await db
              .insertInto("entity_source_refs")
              .values({
                id: randomUUID(),
                entity_id: byEmail.id,
                source: data.source,
                source_id: data.sourceId,
                source_url: null,
                last_seen_at: new Date().toISOString(),
              })
              .execute();
          }

          return byEmail;
        }
      }

      // Match by exact name
      const byName = await db
        .selectFrom("entities")
        .selectAll()
        .where("source_type", "=", "person")
        .where("name", "=", data.name)
        .executeTakeFirst();

      if (byName) {
        // Update email in metadata + aliases if we have one and they don't
        if (data.email) {
          const meta = JSON.parse(byName.metadata || "{}");
          const aliases: string[] = JSON.parse(byName.aliases || "[]");
          let changed = false;
          if (!meta.email) {
            meta.email = data.email;
            changed = true;
          }
          if (!aliases.some((a) => a.toLowerCase() === data.email?.toLowerCase())) {
            aliases.push(data.email);
            changed = true;
          }
          if (changed) {
            await db
              .updateTable("entities")
              .set({
                metadata: JSON.stringify(meta),
                aliases: JSON.stringify(aliases),
                updated_at: new Date().toISOString(),
              })
              .where("id", "=", byName.id)
              .execute();
          }
        }

        const existingRef = await db
          .selectFrom("entity_source_refs")
          .select("id")
          .where("source", "=", data.source)
          .where("source_id", "=", data.sourceId)
          .executeTakeFirst();

        if (!existingRef) {
          await db
            .insertInto("entity_source_refs")
            .values({
              id: randomUUID(),
              entity_id: byName.id,
              source: data.source,
              source_id: data.sourceId,
              source_url: null,
              last_seen_at: new Date().toISOString(),
            })
            .execute();
        }

        return byName;
      }

      // No match — create new person entity
      const id = randomUUID();
      const now = new Date().toISOString();
      const metadata = data.email ? { email: data.email } : {};
      const initialAliases = data.email ? JSON.stringify([data.email]) : null;

      await db
        .insertInto("entities")
        .values({
          id,
          name: data.name,
          source_type: "person",
          subtype: data.subtype,
          aliases: initialAliases,
          metadata: JSON.stringify(metadata),
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await db
        .insertInto("entity_source_refs")
        .values({
          id: randomUUID(),
          entity_id: id,
          source: data.source,
          source_id: data.sourceId,
          source_url: null,
          last_seen_at: now,
        })
        .execute();

      return await db.selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    // ── Archive / Cleanup ──

    async archiveEntitiesForArchivedFiles() {
      await db
        .updateTable("entities")
        .set({ status: "archived", updated_at: new Date().toISOString() })
        .where("source_ref_id", "is not", null)
        .where("status", "!=", "archived")
        .where("source_ref_id", "in", db.selectFrom("indexed_files").select("id").where("is_archived", "=", 1))
        .execute();
    },

    /**
     * Count entities associated with a connector's files.
     * Includes entities sourced from those files (source_ref_id) and entities
     * only mentioned in those files (entity_mentions).
     */
    async countEntitiesForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;

      // Entities whose source_ref_id points to one of these files
      const bySourceRef = db.selectFrom("entities").select("id").where("source_ref_id", "in", fileIds);

      // Entities that are only mentioned in these files (no mentions in other files)
      const byMentionOnly = db
        .selectFrom("entity_mentions")
        .select("entity_id as id")
        .where("indexed_file_id", "in", fileIds)
        .where(
          "entity_id",
          "not in",
          db.selectFrom("entity_mentions").select("entity_id").where("indexed_file_id", "not in", fileIds),
        );

      const result = await db
        .selectFrom(bySourceRef.union(byMentionOnly).as("combined"))
        .select(db.fn.count<number>("id").as("count"))
        .executeTakeFirst();

      return Number(result?.count ?? 0);
    },

    /**
     * Delete entities associated with a connector's files.
     * Removes entities sourced from those files and entities only mentioned in those files.
     * Cascade deletes handle entity_source_refs and entity_mentions.
     */
    async deleteEntitiesForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;

      // Entities whose source_ref_id points to one of these files
      const bySourceRef = db.selectFrom("entities").select("id").where("source_ref_id", "in", fileIds);

      // Entities that are only mentioned in these files
      const byMentionOnly = db
        .selectFrom("entity_mentions")
        .select("entity_id as id")
        .where("indexed_file_id", "in", fileIds)
        .where(
          "entity_id",
          "not in",
          db.selectFrom("entity_mentions").select("entity_id").where("indexed_file_id", "not in", fileIds),
        );

      const toDelete = await bySourceRef.union(byMentionOnly).execute();
      const ids = [...new Set(toDelete.map((r) => r.id))];

      if (ids.length === 0) return 0;

      await db.deleteFrom("entities").where("id", "in", ids).execute();
      return ids.length;
    },
  };
}

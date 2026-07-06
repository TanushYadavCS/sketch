import { randomUUID } from "node:crypto";
import type { Kysely, RawBuilder, Selectable } from "kysely";
import { sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { HIDDEN_ENTITY_SOURCE_TYPES } from "../../entities/profile-facts";
import type { ProvenanceTier } from "../../entities/provenance";
import { resolveLiveEntity, resolveLiveEntityId, resolveSourceRefToLiveEntityId } from "../../entities/redirect";
import { parseTimestampMs } from "../../timestamps";
import { isPg } from "../dialect";
import type { DB, EntitiesTable, EntityContactPointsTable } from "../schema";
import { type FileViewer, fileVisibilityPredicate } from "./connectors";

const SYSTEM_ENTITY_SOURCE_TYPES = ["clickup_workspace", "clickup_space"];
const PROTECTED_ENTITY_SOURCES = ["team", "team_directory"];
const HOTNESS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CANONICAL_TIMESTAMP_LIKE = "____-__-__T__:__:__.___Z";
const TIMESTAMP_DIGIT_POSITIONS = [1, 2, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 23];

type MentionActivityRow = {
  mentioned_at: string;
  source_updated_at: string | null;
  source_created_at: string | null;
};

function mentionActivityMs(row: MentionActivityRow): number | null {
  return (
    parseTimestampMs(row.source_updated_at) ??
    parseTimestampMs(row.source_created_at) ??
    parseTimestampMs(row.mentioned_at)
  );
}

function canonicalHotnessActivityExpr() {
  return sql<string>`COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at)`;
}

function timestampDigitPredicate(expr: RawBuilder<string | null>) {
  return sql.join(
    TIMESTAMP_DIGIT_POSITIONS.map((position) => sql<boolean>`SUBSTR(${expr}, ${position}, 1) BETWEEN '0' AND '9'`),
    sql` AND `,
  );
}

function canonicalTimestampPredicate(expr: RawBuilder<string | null>) {
  return sql<boolean>`(
    ${expr} LIKE ${CANONICAL_TIMESTAMP_LIKE}
    AND ${timestampDigitPredicate(expr)}
    AND SUBSTR(${expr}, 6, 2) BETWEEN '01' AND '12'
    AND SUBSTR(${expr}, 9, 2) BETWEEN '01' AND '31'
    AND SUBSTR(${expr}, 12, 2) BETWEEN '00' AND '23'
    AND SUBSTR(${expr}, 15, 2) BETWEEN '00' AND '59'
    AND SUBSTR(${expr}, 18, 2) BETWEEN '00' AND '59'
  )`;
}

function nullableCanonicalTimestampPredicate(expr: RawBuilder<string | null>) {
  return sql<boolean>`(${expr} IS NULL OR ${canonicalTimestampPredicate(expr)})`;
}

function canonicalHotnessActivityPredicate() {
  const sourceUpdatedAt = sql<string | null>`indexed_files.source_updated_at`;
  const sourceCreatedAt = sql<string | null>`indexed_files.source_created_at`;
  const mentionedAt = sql<string | null>`entity_mentions.mentioned_at`;
  return sql<boolean>`(
    ${nullableCanonicalTimestampPredicate(sourceUpdatedAt)}
    AND ${nullableCanonicalTimestampPredicate(sourceCreatedAt)}
    AND ${canonicalTimestampPredicate(mentionedAt)}
  )`;
}

/**
 * Predicate matching entities visible to `viewer`. Composed into queries via `.where(...)`.
 *
 *   admin              = bypasses RBAC (single OR branch resolves to true)
 *   system entity      = org-curated entities visible to all members
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
    ${t}.source_type IN (${sql.join(
      SYSTEM_ENTITY_SOURCE_TYPES.map((sourceType) => sql`${sourceType}`),
      sql`,`,
    )})
    OR ${t}.share_with_everyone = 1
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

export function whereLiveEntity(alias = "entities") {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    throw new Error(`whereLiveEntity: invalid table alias "${alias}"`);
  }
  const t = sql.raw(alias);
  return sql<boolean>`(${t}.deleted_at IS NULL AND ${t}.merged_into_entity_id IS NULL)`;
}

export interface UpsertEntityData {
  name: string;
  sourceType: string;
  subtype?: string | null;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  sourceRefId?: string | null;
  status?: string;
  provenanceTier?: ProvenanceTier;
}

export interface UpsertEntityFromToolData {
  name: string;
  sourceType: string;
  source: string;
  sourceId: string;
  sourceUrl?: string;
  sourceRefId?: string;
  metadata?: Record<string, unknown>;
  provenanceTier?: ProvenanceTier;
}

export interface UpsertPersonEntityData {
  name: string;
  email?: string;
  subtype: "internal" | "external";
  source: string;
  sourceId: string;
  provenanceTier?: ProvenanceTier;
}

export type EntityContactPointKind = "email" | "phone" | "linkedin" | "whatsapp";

export interface UpsertContactPointData {
  entityId: string;
  kind: EntityContactPointKind;
  value: string;
  displayValue?: string | null;
  label?: string | null;
  source: string;
  connectorConfigId?: string | null;
  createdByUserId?: string | null;
  verifiedAt?: string | null;
  lastContactedAt?: string | null;
  makePrimary?: boolean;
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

function normalizePhoneLike(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(withPlus)) {
    throw new Error("Phone contact points must be E.164, for example +14155551234");
  }
  return withPlus;
}

function normalizeLinkedin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("LinkedIn contact point cannot be empty");
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const urlish = withoutAt.includes("linkedin.com") ? withoutAt : null;
  if (!urlish) return withoutAt.replace(/^\/+|\/+$/g, "").toLowerCase();

  const url = new URL(urlish.startsWith("http://") || urlish.startsWith("https://") ? urlish : `https://${urlish}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const inIndex = parts.findIndex((part) => part.toLowerCase() === "in");
  if (inIndex === -1 || !parts[inIndex + 1]) {
    throw new Error("LinkedIn contact point must be a public identifier or /in/ profile URL");
  }
  return decodeURIComponent(parts[inIndex + 1]).toLowerCase();
}

export function normalizeContactPointValue(kind: EntityContactPointKind, value: string): string {
  if (kind === "email") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) {
      throw new Error("Email contact point must be a valid email-like value");
    }
    return normalized;
  }
  if (kind === "phone" || kind === "whatsapp") return normalizePhoneLike(value);
  return normalizeLinkedin(value);
}

export interface EntityCrmActivityBrief {
  summary: string;
  activityCount: number;
  updatedAt: string;
}

const CRM_BRIEF_SOURCE_ID_PREFIXES = ["Accounts:", "Deals:", "Contacts:"];

function isCrmObjectSourceId(sourceId: string): boolean {
  return CRM_BRIEF_SOURCE_ID_PREFIXES.some((prefix) => sourceId.startsWith(prefix));
}

async function loadCrmActivityBrief(db: Kysely<DB>, entityId: string): Promise<EntityCrmActivityBrief | null> {
  const configs = await db
    .selectFrom("connector_configs")
    .select("id")
    .where("connector_type", "=", "zoho_crm")
    .execute();
  if (configs.length !== 1) return null;

  const refs = await db
    .selectFrom("entity_source_refs")
    .select("source_id")
    .where("entity_id", "=", entityId)
    .where("source", "=", "zoho_crm")
    .execute();
  const groupIds = refs.map((ref) => ref.source_id).filter(isCrmObjectSourceId);
  if (groupIds.length === 0) return null;

  const row = await db
    .selectFrom("crm_object_summaries")
    .select(["summary", "activity_count", "updated_at"])
    .where("connector_config_id", "=", configs[0].id)
    .where("group_id", "in", groupIds)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();

  return row
    ? {
        summary: row.summary,
        activityCount: Number(row.activity_count),
        updatedAt: row.updated_at,
      }
    : null;
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
        .where(whereLiveEntity())
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
          provenance_tier: data.provenanceTier ?? "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      return await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
    },

    async createEntity(data: UpsertEntityData) {
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
          provenance_tier: data.provenanceTier ?? "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      return await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
    },

    /**
     * Fetch an entity. When `viewer` is omitted the entity is returned without
     * RBAC — internal/server callers use this to operate on entities directly
     * (e.g. enrichment, materialization). API handlers must pass a viewer so
     * callers without access get null (which maps to 404).
     */
    async getEntity(id: string, viewer?: FileViewer) {
      let query = db.selectFrom("entities").selectAll().where("id", "=", id).where(whereLiveEntity());
      if (viewer) {
        query = query.where(entityVisibilityPredicate(viewer));
      }
      return query.executeTakeFirst();
    },

    async getEntities(ids: string[]) {
      if (ids.length === 0) return [];
      return db.selectFrom("entities").selectAll().where("id", "in", ids).where(whereLiveEntity()).execute();
    },

    async getEntitiesBySourceType(sourceType: string) {
      return db
        .selectFrom("entities")
        .selectAll()
        .where("source_type", "=", sourceType)
        .where(whereLiveEntity())
        .execute();
    },

    async getEntitiesByStatus(status: string, opts?: { excludeSourceTypes?: string[] }) {
      let query = db.selectFrom("entities").selectAll().where("status", "=", status).where(whereLiveEntity());
      if (opts?.excludeSourceTypes && opts.excludeSourceTypes.length > 0) {
        query = query.where("source_type", "not in", opts.excludeSourceTypes);
      }
      return query.execute();
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
      const entityId = await resolveLiveEntityId(db, id);
      await db
        .updateTable("entities")
        .set({ ...updates, updated_at: new Date().toISOString() })
        .where("id", "=", entityId)
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
      const targetEntityId = await resolveLiveEntityId(db, entityId);
      const trimmed = aliasName.trim();
      if (!trimmed) return;
      const row = await db
        .selectFrom("entities")
        .select(["aliases"])
        .where("id", "=", targetEntityId)
        .where(whereLiveEntity())
        .executeTakeFirst();
      if (!row) return;
      const aliases: string[] = row.aliases ? JSON.parse(row.aliases) : [];
      if (aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return;
      aliases.push(trimmed);
      await db
        .updateTable("entities")
        .set({ aliases: JSON.stringify(aliases), updated_at: new Date().toISOString() })
        .where("id", "=", targetEntityId)
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
      const targetEntityId = await resolveLiveEntityId(db, entityId);
      const trimmed = email.trim();
      if (!trimmed) return;
      const row = await db
        .selectFrom("entities")
        .select(["metadata"])
        .where("id", "=", targetEntityId)
        .where(whereLiveEntity())
        .executeTakeFirst();
      if (!row) return;
      const meta: Record<string, unknown> = row.metadata ? JSON.parse(row.metadata) : {};
      if (typeof meta.email === "string" && meta.email.length > 0) return;
      meta.email = trimmed;
      await db
        .updateTable("entities")
        .set({ metadata: JSON.stringify(meta), updated_at: new Date().toISOString() })
        .where("id", "=", targetEntityId)
        .execute();
    },

    // ── Source Refs ──

    async upsertSourceRef(data: { entityId: string; source: string; sourceId: string; sourceUrl?: string }) {
      const entityId = await resolveLiveEntityId(db, data.entityId);
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
            entity_id: entityId,
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
          entity_id: entityId,
          source: data.source,
          source_id: data.sourceId,
          source_url: data.sourceUrl ?? null,
          last_seen_at: new Date().toISOString(),
        })
        .execute();
    },

    async getEntityBySourceRef(source: string, sourceId: string) {
      const entityId = await resolveSourceRefToLiveEntityId(db, source, sourceId);
      if (!entityId) return null;
      return resolveLiveEntity(db, entityId);
    },

    // ── Mentions ──

    async createMention(data: CreateMentionData) {
      const entityId = await resolveLiveEntityId(db, data.entityId);
      let insert = db.insertInto("entity_mentions").values({
        id: randomUUID(),
        entity_id: entityId,
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

    /**
     * Upsert a normalized contact point. On conflict, `source` is the last writer
     * that refreshed the row, while `connector_config_id` and `created_by_user_id`
     * preserve the first non-null observation so the row keeps its original
     * ingestion anchor even when later manual/system refreshes omit connector
     * context. Callers ingesting external phone-like values must catch
     * normalization errors; only E.164-style values are accepted.
     */
    async upsertContactPoint(data: UpsertContactPointData): Promise<Selectable<EntityContactPointsTable>> {
      const entityId = await resolveLiveEntityId(db, data.entityId);
      const value = normalizeContactPointValue(data.kind, data.value);
      const now = new Date().toISOString();

      await db.transaction().execute(async (trx) => {
        if (data.makePrimary) {
          await trx
            .updateTable("entity_contact_points")
            .set({ is_primary: 0, updated_at: now })
            .where("entity_id", "=", entityId)
            .where("kind", "=", data.kind)
            .execute();
        }

        await trx
          .insertInto("entity_contact_points")
          .values({
            id: randomUUID(),
            entity_id: entityId,
            kind: data.kind,
            value,
            display_value: data.displayValue ?? null,
            label: data.label ?? null,
            is_primary: data.makePrimary ? 1 : 0,
            source: data.source,
            connector_config_id: data.connectorConfigId ?? null,
            created_by_user_id: data.createdByUserId ?? null,
            verified_at: data.verifiedAt ?? null,
            last_contacted_at: data.lastContactedAt ?? null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.columns(["entity_id", "kind", "value"]).doUpdateSet({
              display_value: sql`COALESCE(entity_contact_points.display_value, excluded.display_value)`,
              label: sql`COALESCE(excluded.label, entity_contact_points.label)`,
              is_primary: data.makePrimary ? 1 : sql`entity_contact_points.is_primary`,
              source: data.source,
              connector_config_id: sql`COALESCE(excluded.connector_config_id, entity_contact_points.connector_config_id)`,
              created_by_user_id: sql`COALESCE(excluded.created_by_user_id, entity_contact_points.created_by_user_id)`,
              verified_at: sql`CASE
                WHEN entity_contact_points.verified_at IS NULL THEN excluded.verified_at
                WHEN excluded.verified_at IS NULL THEN entity_contact_points.verified_at
                WHEN excluded.verified_at > entity_contact_points.verified_at THEN excluded.verified_at
                ELSE entity_contact_points.verified_at
              END`,
              last_contacted_at: sql`CASE
                WHEN entity_contact_points.last_contacted_at IS NULL THEN excluded.last_contacted_at
                WHEN excluded.last_contacted_at IS NULL THEN entity_contact_points.last_contacted_at
                WHEN excluded.last_contacted_at > entity_contact_points.last_contacted_at THEN excluded.last_contacted_at
                ELSE entity_contact_points.last_contacted_at
              END`,
              updated_at: now,
            }),
          )
          .execute();
      });

      return db
        .selectFrom("entity_contact_points")
        .selectAll()
        .where("entity_id", "=", entityId)
        .where("kind", "=", data.kind)
        .where("value", "=", value)
        .executeTakeFirstOrThrow();
    },

    async getContactPointsForEntity(entityId: string): Promise<Selectable<EntityContactPointsTable>[]> {
      return db
        .selectFrom("entity_contact_points")
        .selectAll()
        .where("entity_id", "=", entityId)
        .orderBy("kind", "asc")
        .orderBy("is_primary", "desc")
        .orderBy(sql`COALESCE(last_contacted_at, '')`, "desc")
        .orderBy("id", "asc")
        .execute();
    },

    async getEntityByContactPoint(kind: EntityContactPointKind, rawValue: string) {
      const value = normalizeContactPointValue(kind, rawValue);
      const rows = await db
        .selectFrom("entity_contact_points")
        .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
        .selectAll("entities")
        .where("entity_contact_points.kind", "=", kind)
        .where("entity_contact_points.value", "=", value)
        .where(whereLiveEntity())
        .limit(2)
        .execute();
      return rows.length === 1 ? rows[0] : null;
    },

    async getEntitiesByContactPoint(
      kind: EntityContactPointKind,
      rawValue: string,
    ): Promise<Selectable<EntitiesTable>[]> {
      const value = normalizeContactPointValue(kind, rawValue);
      return db
        .selectFrom("entity_contact_points")
        .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
        .selectAll("entities")
        .where("entity_contact_points.kind", "=", kind)
        .where("entity_contact_points.value", "=", value)
        .where(whereLiveEntity())
        .orderBy("entities.id", "asc")
        .execute();
    },

    async getPersonEntitiesByEmail(rawEmail: string): Promise<Selectable<EntitiesTable>[]> {
      const email = normalizeContactPointValue("email", rawEmail);
      const byContactPoint = await db
        .selectFrom("entity_contact_points")
        .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
        .selectAll("entities")
        .where("entity_contact_points.kind", "=", "email")
        .where("entity_contact_points.value", "=", email)
        .where("entities.source_type", "=", "person")
        .where(whereLiveEntity())
        .execute();
      const byMetadata = await db
        .selectFrom("entities")
        .selectAll()
        .where("source_type", "=", "person")
        .where(whereLiveEntity())
        .where(isPg(db) ? sql`(metadata::jsonb ->> 'email')` : sql`json_extract(metadata, '$.email')`, "=", email)
        .execute();

      const byId = new Map<string, Selectable<EntitiesTable>>();
      for (const entity of [...byContactPoint, ...byMetadata]) byId.set(entity.id, entity);
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    async getPersonEntitiesByEmails(rawEmails: string[]): Promise<Map<string, Selectable<EntitiesTable>[]>> {
      const emails = Array.from(new Set(rawEmails.map((email) => normalizeContactPointValue("email", email))));
      const out = new Map<string, Selectable<EntitiesTable>[]>();
      if (emails.length === 0) return out;

      const byContactPoint = await db
        .selectFrom("entity_contact_points")
        .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
        .selectAll("entities")
        .select("entity_contact_points.value as matched_email")
        .where("entity_contact_points.kind", "=", "email")
        .where("entity_contact_points.value", "in", emails)
        .where("entities.source_type", "=", "person")
        .where(whereLiveEntity())
        .execute();
      const byMetadata = await db
        .selectFrom("entities")
        .selectAll()
        .select(
          (isPg(db) ? sql<string>`(metadata::jsonb ->> 'email')` : sql<string>`json_extract(metadata, '$.email')`).as(
            "matched_email",
          ),
        )
        .where("source_type", "=", "person")
        .where(whereLiveEntity())
        .where(isPg(db) ? sql`(metadata::jsonb ->> 'email')` : sql`json_extract(metadata, '$.email')`, "in", emails)
        .execute();

      const byEmailAndId = new Map<string, Map<string, Selectable<EntitiesTable>>>();
      for (const row of [...byContactPoint, ...byMetadata]) {
        const matchedEmail = row.matched_email;
        if (!matchedEmail) continue;
        const normalized = normalizeContactPointValue("email", matchedEmail);
        const entities = byEmailAndId.get(normalized) ?? new Map<string, Selectable<EntitiesTable>>();
        entities.set(row.id, row);
        byEmailAndId.set(normalized, entities);
      }
      for (const [email, entities] of byEmailAndId) {
        out.set(
          email,
          [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
        );
      }
      return out;
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
        .where(whereLiveEntity())
        .where((eb) => eb.or([eb("name", "like", pattern), eb("aliases", "like", pattern)]));

      if (opts?.sourceTypes && opts.sourceTypes.length > 0) {
        q = q.where("source_type", "in", opts.sourceTypes);
      } else {
        const hiddenTypes = Array.from(HIDDEN_ENTITY_SOURCE_TYPES);
        if (hiddenTypes.length > 0) q = q.where("source_type", "not in", hiddenTypes);
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
      const hiddenTypes = Array.from(HIDDEN_ENTITY_SOURCE_TYPES);
      return db
        .selectFrom("entities")
        .selectAll()
        .where("status", "!=", "archived")
        .where(whereLiveEntity())
        .where("source_type", "not in", hiddenTypes.length > 0 ? hiddenTypes : [""])
        .orderBy("hotness", "desc")
        .limit(limit)
        .execute();
    },

    async updateHotness(entityId: string) {
      const thirtyDaysAgoMs = Date.now() - HOTNESS_WINDOW_DAYS * DAY_MS;
      const thirtyDaysAgo = new Date(thirtyDaysAgoMs).toISOString();
      const canonicalActivity = await db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .where("entity_id", "=", entityId)
        .where(canonicalHotnessActivityPredicate())
        .select([
          sql<number>`SUM(CASE WHEN ${canonicalHotnessActivityExpr()} >= ${thirtyDaysAgo} THEN 1 ELSE 0 END)`.as(
            "active_count",
          ),
          sql<string | null>`MAX(${canonicalHotnessActivityExpr()})`.as("latest_activity_at"),
        ])
        .executeTakeFirst();
      const fallbackMentions = await db
        .selectFrom("entity_mentions")
        .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
        .where("entity_id", "=", entityId)
        .where(sql<boolean>`NOT ${canonicalHotnessActivityPredicate()}`)
        .select(["entity_mentions.mentioned_at", "indexed_files.source_updated_at", "indexed_files.source_created_at"])
        .execute();

      let count = Number(canonicalActivity?.active_count ?? 0);
      let latestActivityMs = parseTimestampMs(canonicalActivity?.latest_activity_at);
      for (const mention of fallbackMentions) {
        const activityMs = mentionActivityMs(mention);
        if (activityMs === null) continue;
        if (activityMs >= thirtyDaysAgoMs) count++;
        if (latestActivityMs === null || activityMs > latestActivityMs) latestActivityMs = activityMs;
      }
      const daysSince = latestActivityMs === null ? HOTNESS_WINDOW_DAYS : (Date.now() - latestActivityMs) / DAY_MS;

      const hotness = (1 / (1 + Math.exp(-Math.log1p(count)))) * Math.exp(-0.1 * daysSince);

      await db
        .updateTable("entities")
        .set({ hotness, updated_at: new Date().toISOString() })
        .where("id", "=", entityId)
        .execute();
    },

    async recomputeAllHotness() {
      const entities = await db
        .selectFrom("entities")
        .select("id")
        .where("status", "!=", "archived")
        .where(whereLiveEntity())
        .execute();
      for (const entity of entities) {
        await this.updateHotness(entity.id);
      }
      return entities.length;
    },

    async recomputeHotnessBatch(opts: { cursor?: string | null; limit: number }) {
      const rows = await db
        .selectFrom("entities")
        .select("id")
        .where("status", "!=", "archived")
        .where(whereLiveEntity())
        .$if(Boolean(opts.cursor), (qb) => qb.where("id", ">", opts.cursor as string))
        .orderBy("id", "asc")
        .limit(opts.limit + 1)
        .execute();
      const batch = rows.slice(0, opts.limit);
      for (const entity of batch) {
        await this.updateHotness(entity.id);
      }
      return {
        processed: batch.length,
        nextCursor: rows.length > opts.limit ? (batch.at(-1)?.id ?? null) : null,
        done: rows.length <= opts.limit,
      };
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
      crmActivityBrief: EntityCrmActivityBrief | null;
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
      const crmActivityBrief = await loadCrmActivityBrief(db, entityId);

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
        crmActivityBrief,
      };
    },

    // ── Seeding Helpers ──

    async upsertEntityFromTool(data: UpsertEntityFromToolData) {
      const existingRefEntityId = await resolveSourceRefToLiveEntityId(db, data.source, data.sourceId);
      const existing = existingRefEntityId
        ? await db
            .selectFrom("entities")
            .selectAll()
            .where("id", "=", existingRefEntityId)
            .where(whereLiveEntity())
            .executeTakeFirst()
        : undefined;

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
            entity_id: existing.id,
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
          provenance_tier: data.provenanceTier ?? "inferred",
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

      return await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
    },

    /**
     * Narrow upsert for LLM-extracted non-person entities. Keys by
     * (normalizeName(name), source_type) with case-insensitive comparison
     * done client-side so the same path works on SQLite and Postgres.
     * Returns whether the row was newly created so materialization summaries
     * don't count updates as new entities.
     *
     * Dormant legacy helper retained for compatibility; new materializers
     * should route through the reviewed/propose paths and pass an explicit
     * provenance tier.
     */
    async upsertLlmExtractedEntity(
      data: UpsertEntityData,
    ): Promise<{ entity: Selectable<EntitiesTable>; created: boolean }> {
      const targetKey = normalizeName(data.name);
      const candidates = await db
        .selectFrom("entities")
        .selectAll()
        .where("source_type", "=", data.sourceType)
        .where(whereLiveEntity())
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
        const fresh = await db
          .selectFrom("entities")
          .selectAll()
          .where("id", "=", match.id)
          .where(whereLiveEntity())
          .executeTakeFirstOrThrow();
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
          provenance_tier: data.provenanceTier ?? "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      const entity = await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
      return { entity, created: true };
    },

    async upsertPersonEntity(data: UpsertPersonEntityData) {
      const sourceRefEntityId = await resolveSourceRefToLiveEntityId(db, data.source, data.sourceId);
      if (sourceRefEntityId) {
        const bySourceRef = await db
          .selectFrom("entities")
          .selectAll()
          .where("id", "=", sourceRefEntityId)
          .where("source_type", "=", "person")
          .where(whereLiveEntity())
          .executeTakeFirst();
        if (bySourceRef) {
          await db
            .updateTable("entity_source_refs")
            .set({ entity_id: bySourceRef.id, last_seen_at: new Date().toISOString() })
            .where("source", "=", data.source)
            .where("source_id", "=", data.sourceId)
            .execute();
          return bySourceRef;
        }
      }

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
          .where(whereLiveEntity())
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
          const existingRefEntityId = await resolveSourceRefToLiveEntityId(db, data.source, data.sourceId);

          if (existingRefEntityId) {
            await db
              .updateTable("entity_source_refs")
              .set({ entity_id: byEmail.id, last_seen_at: new Date().toISOString() })
              .where("source", "=", data.source)
              .where("source_id", "=", data.sourceId)
              .execute();
          }

          const existingRef = existingRefEntityId
            ? { id: existingRefEntityId }
            : await db
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
        .where(whereLiveEntity())
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

        const existingRefEntityId = await resolveSourceRefToLiveEntityId(db, data.source, data.sourceId);

        if (existingRefEntityId) {
          await db
            .updateTable("entity_source_refs")
            .set({ entity_id: byName.id, last_seen_at: new Date().toISOString() })
            .where("source", "=", data.source)
            .where("source_id", "=", data.sourceId)
            .execute();
        }

        const existingRef = existingRefEntityId
          ? { id: existingRefEntityId }
          : await db
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
          provenance_tier: data.provenanceTier ?? "inferred",
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

      return await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
    },

    async createPersonEntity(data: UpsertPersonEntityData) {
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
          provenance_tier: data.provenanceTier ?? "inferred",
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

      return await db
        .selectFrom("entities")
        .selectAll()
        .where("id", "=", id)
        .where(whereLiveEntity())
        .executeTakeFirstOrThrow();
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

    async countEntitiesForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;
      return (await getEntityIdsSupportedOnlyByFiles(db, fileIds)).length;
    },

    /**
     * Delete entities whose complete file support is contained in `fileIds`.
     *
     * File support includes direct mentions, relationship evidence endpoints,
     * and source_ref_id values that point to real indexed files. Directory seeds
     * are retained even if a deleted connector is their only file support.
     */
    async deleteEntitiesForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;

      const ids = await getEntityIdsSupportedOnlyByFiles(db, fileIds);
      if (ids.length === 0) return 0;

      await db.deleteFrom("entities").where("id", "in", ids).execute();
      return ids.length;
    },
  };
}

async function getEntityIdsSupportedOnlyByFiles(db: Kysely<DB>, fileIds: string[]): Promise<string[]> {
  const fileIdSql = sql.join(
    fileIds.map((id) => sql`${id}`),
    sql`,`,
  );
  const protectedSourceSql = sql.join(
    PROTECTED_ENTITY_SOURCES.map((source) => sql`${source}`),
    sql`,`,
  );

  const rows = await sql<{ id: string }>`
    WITH file_support(entity_id, indexed_file_id) AS (
      SELECT entity_id, indexed_file_id
      FROM entity_mentions
      UNION
      SELECT r.source_entity_id AS entity_id, ev.indexed_file_id
      FROM entity_relationship_evidence ev
      INNER JOIN entity_relationships r ON r.id = ev.relationship_id
      UNION
      SELECT r.target_entity_id AS entity_id, ev.indexed_file_id
      FROM entity_relationship_evidence ev
      INNER JOIN entity_relationships r ON r.id = ev.relationship_id
      UNION
      SELECT e.id AS entity_id, e.source_ref_id AS indexed_file_id
      FROM entities e
      INNER JOIN indexed_files f ON f.id = e.source_ref_id
    ),
    candidates AS (
      SELECT DISTINCT entity_id
      FROM file_support
      WHERE indexed_file_id IN (${fileIdSql})
    ),
    survivors AS (
      SELECT DISTINCT entity_id
      FROM file_support
      WHERE indexed_file_id NOT IN (${fileIdSql})
      UNION
      SELECT id AS entity_id
      FROM entities
      WHERE source_type IN (${protectedSourceSql})
      UNION
      SELECT entity_id
      FROM entity_source_refs
      WHERE source IN (${protectedSourceSql})
    ),
    to_delete AS (
      SELECT entity_id FROM candidates
      EXCEPT
      SELECT entity_id FROM survivors
    )
    SELECT entity_id AS id
    FROM to_delete
  `.execute(db);

  return rows.rows.map((row) => row.id);
}

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { normalizeName } from "../connectors/name-normalize";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createEntitySuppressionRepository } from "../db/repositories/entity-suppressions";
import type { DB } from "../db/schema";
import { type MentionType, normalizeMentionType } from "./graph";
import { parseAliasesString, readJsonObject, readPersonEmailFromMetadata } from "./materialize-json";
import type { EntityRow, IndexedFileFactRow, LookupIndex, MaterializeDeps } from "./materialize-types";
import {
  type CandidatePoolEntry,
  addToCandidatePool,
  buildCandidatePool,
  findFuzzyMatches,
  findStrictMatches,
  removeFromCandidatePool,
} from "./name-dedup";
import type { Entity, EntityLookup, ProposeEntityType } from "./propose";

const DEFAULT_LLM_PROMOTION_THRESHOLD = 2;
let configuredLlmPromotionThreshold = DEFAULT_LLM_PROMOTION_THRESHOLD;

/**
 * Set the default `llmPromotionThreshold` used by entry points
 * (`materializeUnmaterializedFacts`, `replaySourceFacts`,
 * `buildMaterializeDeps`) when the caller doesn't pass one. Production
 * callers should invoke this once at boot with `config.LLM_PROMOTION_THRESHOLD`.
 */
export function configureMaterializeDefaults(opts: { llmPromotionThreshold?: number }): void {
  if (typeof opts.llmPromotionThreshold === "number" && opts.llmPromotionThreshold >= 1) {
    configuredLlmPromotionThreshold = Math.floor(opts.llmPromotionThreshold);
  }
}

export function normalizeEntityMatchName(entityType: string, name: string): string {
  if (entityType !== "product") return normalizeName(name);
  return normalizeName(
    name
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " "),
  );
}

async function buildLookupIndex(db: Kysely<DB>): Promise<LookupIndex> {
  const supportedTypes: ProposeEntityType[] = ["person", "company", "product", "project", "team", "deal"];
  const entities = await db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "in", supportedTypes)
    .where(whereLiveEntity())
    .execute();
  const entitiesByType = new Map<ProposeEntityType, EntityRow[]>();
  for (const t of supportedTypes) entitiesByType.set(t, []);
  const byNormalizedName = new Map<string, EntityRow[]>();
  const byNormalizedAlias = new Map<string, EntityRow[]>();
  const dedupEntriesByType = new Map<ProposeEntityType, CandidatePoolEntry[]>();
  for (const t of supportedTypes) dedupEntriesByType.set(t, []);
  for (const e of entities) {
    const entityType = e.source_type as ProposeEntityType;
    entitiesByType.get(entityType)?.push(e);
    dedupEntriesByType.get(entityType)?.push({ entityId: e.id, valueKind: "name", value: e.name });
    const nameKey = normalizeEntityMatchName(entityType, e.name);
    if (nameKey) {
      const bucket = byNormalizedName.get(nameKey);
      if (bucket) bucket.push(e);
      else byNormalizedName.set(nameKey, [e]);
    }
    for (const alias of parseAliasesString(e.aliases)) {
      dedupEntriesByType.get(entityType)?.push({ entityId: e.id, valueKind: "alias", value: alias });
      const aliasKey = normalizeEntityMatchName(entityType, alias);
      if (!aliasKey) continue;
      const bucket = byNormalizedAlias.get(aliasKey);
      if (bucket) bucket.push(e);
      else byNormalizedAlias.set(aliasKey, [e]);
    }
  }

  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
    .select(["entity_source_refs.source as source", "entity_source_refs.source_id as source_id"])
    .selectAll("entities")
    .where(whereLiveEntity())
    .execute();
  const bySourceRef = new Map<string, EntityRow>();
  for (const row of sourceRefs) {
    bySourceRef.set(`${row.source}:${row.source_id}`, row as unknown as EntityRow);
  }
  const domainRows = await db
    .selectFrom("entity_domains")
    .select(["domain", "entity_id"])
    .where("kind", "=", "corporate")
    .where("entity_id", "is not", null)
    .execute();
  const companyIdsByDomain = new Map<string, string[]>();
  for (const row of domainRows) {
    if (!row.entity_id) continue;
    const domain = row.domain.toLowerCase();
    const bucket = companyIdsByDomain.get(domain);
    if (bucket) bucket.push(row.entity_id);
    else companyIdsByDomain.set(domain, [row.entity_id]);
  }
  const dedupPoolsByType = new Map<ProposeEntityType, ReturnType<typeof buildCandidatePool>>();
  for (const t of supportedTypes) dedupPoolsByType.set(t, buildCandidatePool(dedupEntriesByType.get(t) ?? []));
  return { entitiesByType, byNormalizedName, byNormalizedAlias, dedupPoolsByType, bySourceRef, companyIdsByDomain };
}

export function registerEntity(index: LookupIndex, entity: EntityRow): void {
  unregisterEntity(index, entity.id);
  const entityType = entity.source_type as ProposeEntityType;
  const typeBucket = index.entitiesByType.get(entityType);
  if (typeBucket && !typeBucket.some((p) => p.id === entity.id)) typeBucket.push(entity);
  const nameKey = normalizeEntityMatchName(entityType, entity.name);
  if (nameKey) {
    const bucket = index.byNormalizedName.get(nameKey);
    if (bucket) {
      if (!bucket.some((b) => b.id === entity.id)) bucket.push(entity);
    } else {
      index.byNormalizedName.set(nameKey, [entity]);
    }
  }
  for (const alias of parseAliasesString(entity.aliases)) {
    const aliasKey = normalizeEntityMatchName(entityType, alias);
    if (!aliasKey) continue;
    const bucket = index.byNormalizedAlias.get(aliasKey);
    if (bucket) {
      if (!bucket.some((b) => b.id === entity.id)) bucket.push(entity);
    } else {
      index.byNormalizedAlias.set(aliasKey, [entity]);
    }
  }
  const pool = index.dedupPoolsByType.get(entityType);
  if (pool) {
    addToCandidatePool(pool, [
      { entityId: entity.id, valueKind: "name", value: entity.name },
      ...parseAliasesString(entity.aliases).map((value) => ({
        entityId: entity.id,
        valueKind: "alias" as const,
        value,
      })),
    ]);
  }
}

function removeEntityFromMapBuckets<T extends EntityRow>(map: Map<string, T[]>, entityId: string): void {
  for (const [key, bucket] of map) {
    const filtered = bucket.filter((entity) => entity.id !== entityId);
    if (filtered.length === 0) map.delete(key);
    else if (filtered.length !== bucket.length) map.set(key, filtered);
  }
}

function unregisterEntity(index: LookupIndex, entityId: string): void {
  for (const [type, bucket] of index.entitiesByType) {
    const filtered = bucket.filter((entity) => entity.id !== entityId);
    if (filtered.length !== bucket.length) index.entitiesByType.set(type, filtered);
  }
  removeEntityFromMapBuckets(index.byNormalizedName, entityId);
  removeEntityFromMapBuckets(index.byNormalizedAlias, entityId);
  for (const pool of index.dedupPoolsByType.values()) {
    removeFromCandidatePool(pool, entityId);
  }
}

function llmFileCountKey(normalizedName: string, mentionType: MentionType): string {
  return `${mentionType}\u0000${normalizedName}`;
}

async function buildActiveLlmFileCounts(db: Kysely<DB>): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id", "subject_name", "raw"])
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .where("subject_name", "is not", null)
    .execute();
  const filesByName = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.indexed_file_id || !row.subject_name) continue;
    const mentionType = normalizeMentionType(readJsonObject(row.raw).type);
    if (!mentionType) continue;
    const normalizedName = normalizeEntityMatchName(mentionType, row.subject_name);
    if (!normalizedName) continue;
    const key = llmFileCountKey(normalizedName, mentionType);
    const files = filesByName.get(key);
    if (files) files.add(row.indexed_file_id);
    else filesByName.set(key, new Set([row.indexed_file_id]));
  }
  return new Map([...filesByName.entries()].map(([key, files]) => [key, files.size]));
}

export async function refreshResolvedEntityIndex(db: Kysely<DB>, index: LookupIndex, entity: Entity): Promise<void> {
  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .select(["source", "source_id"])
    .where("entity_id", "=", entity.id)
    .execute();
  const refreshed = await db.selectFrom("entities").selectAll().where("id", "=", entity.id).executeTakeFirst();
  const row = (refreshed ?? entity) as EntityRow;
  for (const [key, indexedEntity] of index.bySourceRef) {
    if (indexedEntity.id === entity.id) index.bySourceRef.delete(key);
  }
  registerEntity(index, row);
  for (const ref of sourceRefs) {
    index.bySourceRef.set(`${ref.source}:${ref.source_id}`, row);
  }
}

export interface BuildMaterializeDepsOptions {
  llmPromotionThreshold?: number;
  logger?: Logger;
}

export async function buildMaterializeDeps(
  db: Kysely<DB>,
  opts: BuildMaterializeDepsOptions = {},
): Promise<MaterializeDeps> {
  const entityRepo = createEntityRepository(db);
  const reviewRepo = createEntityReviewRepo(db);
  const suppressionRepo = createEntitySuppressionRepository(db);
  const domainsRepo = createEntityDomainsRepository(db);
  const index = await buildLookupIndex(db);
  const llmPromotionThreshold =
    typeof opts.llmPromotionThreshold === "number" && opts.llmPromotionThreshold >= 1
      ? Math.floor(opts.llmPromotionThreshold)
      : configuredLlmPromotionThreshold;
  let activeLlmFileCounts: Promise<Map<string, number>> | null = null;

  const lookup: EntityLookup = {
    getByNormalizedName: (n) => index.byNormalizedName.get(n) ?? [],
    getByAlias: (n) => index.byNormalizedAlias.get(n) ?? [],
    listByType: (t: ProposeEntityType) => index.entitiesByType.get(t) ?? [],
    findNameDedupCandidates: (entityType, name) => {
      const pool = index.dedupPoolsByType.get(entityType);
      if (!pool) return [];
      const entitiesById = new Map((index.entitiesByType.get(entityType) ?? []).map((entity) => [entity.id, entity]));
      const strict = findStrictMatches(name, pool);
      const strictEntityIds = new Set(strict.map((match) => match.entityId));
      const fuzzy = findFuzzyMatches(name, pool);
      const byEntity = new Map<
        string,
        {
          entity: EntityRow;
          score: number;
          reason: "strict-normalized" | "minhash";
        }
      >();
      for (const match of [...strict, ...fuzzy]) {
        const entity = entitiesById.get(match.entityId);
        if (!entity) continue;
        const reason = strictEntityIds.has(match.entityId) ? "strict-normalized" : "minhash";
        const existing = byEntity.get(match.entityId);
        if (!existing || match.score > existing.score)
          byEntity.set(match.entityId, { entity, score: match.score, reason });
      }
      return [...byEntity.values()].sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
    },
    getCompanyIdsByDomain: (domain) => index.companyIdsByDomain.get(domain.toLowerCase()) ?? [],
  };

  const fileToConnector = new Map<string, string>();
  const connectorOwners = new Map<string, string>();
  const allFiles = await db.selectFrom("indexed_files").select(["id", "connector_config_id"]).execute();
  for (const f of allFiles) fileToConnector.set(f.id, f.connector_config_id);
  const allConfigs = await db.selectFrom("connector_configs").select(["id", "created_by"]).execute();
  for (const c of allConfigs) connectorOwners.set(c.id, c.created_by);

  return {
    db,
    logger: opts.logger,
    entityRepo,
    reviewRepo,
    suppressionRepo,
    domainsRepo,
    lookup,
    index,
    llmPromotionThreshold,
    readEmail: (e: Entity) => readPersonEmailFromMetadata(e.metadata),
    onEntityResolved: (entity: Entity) => refreshResolvedEntityIndex(db, index, entity),
    resolveOwner: (fact: IndexedFileFactRow) => {
      if (fact.created_by_user_id) return fact.created_by_user_id;
      const indexedFileId = fact.indexed_file_id;
      if (!indexedFileId) return null;
      if (indexedFileId) {
        const cfg = fileToConnector.get(indexedFileId);
        if (cfg) {
          const owner = connectorOwners.get(cfg);
          if (owner) return owner;
        }
      }
      return null;
    },
    countActiveLlmFilesForName: async (normalizedName, mentionType) => {
      activeLlmFileCounts ??= buildActiveLlmFileCounts(db);
      const counts = await activeLlmFileCounts;
      return counts.get(llmFileCountKey(normalizedName, mentionType)) ?? 0;
    },
  };
}

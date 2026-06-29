import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createEntitySuppressionRepository } from "../db/repositories/entity-suppressions";
import type { DB } from "../db/schema";
import { personScopeKey, personScopeKeyId } from "./affiliations";
import { normalizeEntityMatchName } from "./match-normalize";
import { parseAliasesString, readPersonEmailFromMetadata } from "./materialize-json";
import type { EntityRow, IndexedFileFactRow, LookupIndex, MaterializeDeps } from "./materialize-types";
import {
  type CandidatePoolEntry,
  addToCandidatePool,
  buildCandidatePool,
  findFuzzyMatches,
  findStrictMatches,
  findTokenSetMatches,
  removeFromCandidatePool,
} from "./name-dedup";
import type { Entity, EntityLookup, ProposeEntityType } from "./propose";
import { canUseEntityAsMatchTarget } from "./provenance";

export { normalizeEntityMatchName } from "./match-normalize";

const DEFAULT_LLM_PROMOTION_THRESHOLD = 2;
const DEFAULT_LLM_TASK_CORROBORATION_THRESHOLD = 2;
const DEFAULT_FEATURE_AUTO_MINT_THRESHOLD = 1;
let configuredLlmPromotionThreshold = DEFAULT_LLM_PROMOTION_THRESHOLD;
let configuredLlmTaskCorroborationThreshold = DEFAULT_LLM_TASK_CORROBORATION_THRESHOLD;
let configuredFeatureAutoMintThreshold = DEFAULT_FEATURE_AUTO_MINT_THRESHOLD;
let configuredBirthGateTypes = new Set<ProposeEntityType>();
let configuredBirthGateLiveTypes = new Set<ProposeEntityType>();
let configuredStructuralAutoBirthTypes = new Set<ProposeEntityType>();
let configuredBirthGateDryRun = true;
let configuredExperimentalFlag = false;

/**
 * Set the default `llmPromotionThreshold` used by entry points
 * (`materializeUnmaterializedFacts`, `replaySourceFacts`,
 * `buildMaterializeDeps`) when the caller doesn't pass one. Production
 * callers should invoke this once at boot with `config.LLM_PROMOTION_THRESHOLD`.
 */
export function configureMaterializeDefaults(opts: {
  llmPromotionThreshold?: number;
  llmTaskCorroborationThreshold?: number;
  featureAutoMintThreshold?: number;
  birthGateTypes?: Set<ProposeEntityType>;
  birthGateLiveTypes?: Set<ProposeEntityType>;
  structuralAutoBirthTypes?: Set<ProposeEntityType>;
  birthGateDryRun?: boolean;
  experimentalFlag?: boolean;
}): void {
  if (typeof opts.llmPromotionThreshold === "number" && opts.llmPromotionThreshold >= 1) {
    configuredLlmPromotionThreshold = Math.floor(opts.llmPromotionThreshold);
  }
  if (typeof opts.llmTaskCorroborationThreshold === "number" && opts.llmTaskCorroborationThreshold >= 1) {
    configuredLlmTaskCorroborationThreshold = Math.floor(opts.llmTaskCorroborationThreshold);
  }
  if (typeof opts.featureAutoMintThreshold === "number" && opts.featureAutoMintThreshold >= 1) {
    configuredFeatureAutoMintThreshold = Math.floor(opts.featureAutoMintThreshold);
  }
  if (opts.birthGateTypes) configuredBirthGateTypes = new Set(opts.birthGateTypes);
  if (opts.birthGateLiveTypes) configuredBirthGateLiveTypes = new Set(opts.birthGateLiveTypes);
  if (opts.structuralAutoBirthTypes) configuredStructuralAutoBirthTypes = new Set(opts.structuralAutoBirthTypes);
  if (typeof opts.birthGateDryRun === "boolean") configuredBirthGateDryRun = opts.birthGateDryRun;
  if (typeof opts.experimentalFlag === "boolean") configuredExperimentalFlag = opts.experimentalFlag;
}

async function buildLookupIndex(db: Kysely<DB>): Promise<LookupIndex> {
  const supportedTypes: ProposeEntityType[] = ["person", "company", "product", "project", "team", "deal", "tool"];
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
    if (!canUseEntityAsMatchTarget(e.source_type, e.provenance_tier)) continue;
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
    if (!canUseEntityAsMatchTarget(row.source_type, row.provenance_tier)) continue;
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
  const personScopeKeysByEntityId = await buildPersonScopeKeys(
    db,
    entities.filter((entity) => entity.source_type === "person"),
  );
  return {
    entitiesByType,
    byNormalizedName,
    byNormalizedAlias,
    dedupPoolsByType,
    bySourceRef,
    companyIdsByDomain,
    personScopeKeysByEntityId,
  };
}

async function buildPersonScopeKeys(db: Kysely<DB>, persons: EntityRow[]): Promise<Map<string, string[]>> {
  const scopeKeys = new Map<string, Set<string>>();
  for (const person of persons) scopeKeys.set(person.id, new Set());
  const domainsRepo = createEntityDomainsRepository(db);
  for (const person of persons) {
    const email = readPersonEmailFromMetadata(person.metadata);
    const scope = await personScopeKey(email, domainsRepo);
    if (scope) scopeKeys.get(person.id)?.add(personScopeKeyId(scope));
  }

  const personIds = persons.map((person) => person.id);
  const worksAtRows =
    personIds.length > 0
      ? await db
          .selectFrom("entity_relationships")
          .select(["source_entity_id", "target_entity_id"])
          .where("relationship_type", "=", "works_at")
          .where("source_entity_id", "in", personIds)
          .where("valid_to", "is", null)
          .execute()
      : [];
  for (const row of worksAtRows) {
    scopeKeys.get(row.source_entity_id)?.add(personScopeKeyId({ kind: "company", value: row.target_entity_id }));
  }

  return new Map([...scopeKeys].map(([entityId, keys]) => [entityId, [...keys]]));
}

export function registerEntity(index: LookupIndex, entity: EntityRow): void {
  const existingPersonScopeKeys = index.personScopeKeysByEntityId.get(entity.id);
  unregisterEntity(index, entity.id);
  const entityType = entity.source_type as ProposeEntityType;
  if (!canUseEntityAsMatchTarget(entityType, entity.provenance_tier)) return;
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
  if (entityType === "person" && existingPersonScopeKeys) {
    index.personScopeKeysByEntityId.set(entity.id, existingPersonScopeKeys);
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
  index.personScopeKeysByEntityId.delete(entityId);
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
  if (!canUseEntityAsMatchTarget(row.source_type, row.provenance_tier)) return;
  const scopeKeys = await buildPersonScopeKeys(db, row.source_type === "person" ? [row] : []);
  const personScopeKeys = scopeKeys.get(row.id);
  if (personScopeKeys) index.personScopeKeysByEntityId.set(row.id, personScopeKeys);
  for (const ref of sourceRefs) {
    index.bySourceRef.set(`${ref.source}:${ref.source_id}`, row);
  }
}

export interface BuildMaterializeDepsOptions {
  llmPromotionThreshold?: number;
  llmTaskCorroborationThreshold?: number;
  featureAutoMintThreshold?: number;
  logger?: Logger;
  birthGateTypes?: Set<ProposeEntityType>;
  birthGateLiveTypes?: Set<ProposeEntityType>;
  structuralAutoBirthTypes?: Set<ProposeEntityType>;
  birthGateDryRun?: boolean;
  experimentalFlag?: boolean;
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
  const llmTaskCorroborationThreshold =
    typeof opts.llmTaskCorroborationThreshold === "number" && opts.llmTaskCorroborationThreshold >= 1
      ? Math.floor(opts.llmTaskCorroborationThreshold)
      : configuredLlmTaskCorroborationThreshold;
  const featureAutoMintThreshold =
    typeof opts.featureAutoMintThreshold === "number" && opts.featureAutoMintThreshold >= 1
      ? Math.floor(opts.featureAutoMintThreshold)
      : configuredFeatureAutoMintThreshold;
  const birthGateTypes = new Set(opts.birthGateTypes ?? configuredBirthGateTypes);
  const birthGateLiveTypes = new Set(opts.birthGateLiveTypes ?? configuredBirthGateLiveTypes);
  const structuralAutoBirthTypes = new Set(opts.structuralAutoBirthTypes ?? configuredStructuralAutoBirthTypes);
  const birthGateDryRun = opts.birthGateDryRun ?? configuredBirthGateDryRun;
  const experimentalFlag = opts.experimentalFlag ?? configuredExperimentalFlag;

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
      const tokenSet = findTokenSetMatches(name, pool);
      const tokenSetEntityIds = new Set(tokenSet.map((match) => match.entityId));
      const fuzzy = findFuzzyMatches(name, pool);
      const byEntity = new Map<
        string,
        {
          entity: EntityRow;
          score: number;
          reason: "strict-normalized" | "token-set" | "minhash";
        }
      >();
      for (const match of [...strict, ...tokenSet, ...fuzzy]) {
        const entity = entitiesById.get(match.entityId);
        if (!entity) continue;
        const reason = strictEntityIds.has(match.entityId)
          ? "strict-normalized"
          : tokenSetEntityIds.has(match.entityId)
            ? "token-set"
            : "minhash";
        const existing = byEntity.get(match.entityId);
        if (!existing || match.score > existing.score)
          byEntity.set(match.entityId, { entity, score: match.score, reason });
      }
      return [...byEntity.values()].sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
    },
    getCompanyIdsByDomain: (domain) => index.companyIdsByDomain.get(domain.toLowerCase()) ?? [],
    getPersonScopeKeys: (entityId) => index.personScopeKeysByEntityId.get(entityId) ?? [],
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
    llmTaskCorroborationThreshold,
    featureAutoMintThreshold,
    birthGateTypes,
    birthGateLiveTypes,
    structuralAutoBirthTypes,
    birthGateDryRun,
    experimentalFlag,
    readEmail: (e: Entity) => readPersonEmailFromMetadata(e.metadata),
    onEntityResolved: (entity: Entity) => refreshResolvedEntityIndex(db, index, entity),
    getIndexedFileSourceTime: (indexedFileId: string) =>
      db
        .selectFrom("indexed_files")
        .select(["source_created_at", "source_updated_at", "synced_at"])
        .where("id", "=", indexedFileId)
        .executeTakeFirst()
        .then((row) => row ?? null),
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
  };
}

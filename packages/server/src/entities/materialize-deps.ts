import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { type NameDedupEntityType, retrieveEntityNameCandidates } from "../connectors/embeddings/trunk-name-embeddings";
import type { EmbeddingProvider } from "../connectors/embeddings/types";
import {
  SLACK_CONNECTOR_TYPE,
  SLACK_CONVERSATION_SLICE_FILE_TYPE,
  WHATSAPP_CONNECTOR_TYPE,
  WHATSAPP_CONVERSATION_SLICE_FILE_TYPE,
} from "../connectors/types";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createEntitySuppressionRepository } from "../db/repositories/entity-suppressions";
import type { DB } from "../db/schema";
import { personScopeKey, personScopeKeyId } from "./affiliations";
import { DEFAULT_FACT_BATCH_SIZE, forEachFactBatch } from "./fact-batches";
import { type MentionType, normalizeMentionType } from "./graph";
import { normalizeEntityMatchName } from "./match-normalize";
import { parseAliasesString, readJsonObject, readPersonEmailFromMetadata } from "./materialize-json";
import { ENTITY_INDEX_COLUMNS } from "./materialize-types";
import type { EntityRow, IndexEntityRow, IndexedFileFactRow, LookupIndex, MaterializeDeps } from "./materialize-types";
import {
  type CandidatePoolEntry,
  addToCandidatePool,
  buildCandidatePool,
  findFuzzyMatches,
  findStrictMatches,
  findTokenSetMatches,
  removeFromCandidatePool,
} from "./name-dedup";
import type { Entity, EntityLookup, ProposeEntityType, RankedCandidate } from "./propose";
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
}

async function buildLookupIndex(db: Kysely<DB>): Promise<LookupIndex> {
  const supportedTypes: ProposeEntityType[] = ["person", "company", "product", "project", "team", "deal", "tool"];
  const supportedTypeSet = new Set<string>(supportedTypes);
  /**
   * One shared row instance per live entity, keyed by id. The type, name,
   * alias, and source-ref indexes all point at these instances, so an in-pass
   * `registerEntity` update reflows through every bucket and no full row is
   * duplicated per source ref. All live entities are loaded (not just the
   * supported types) because `bySourceRef` also resolves system entities such
   * as `clickup_workspace`/`clickup_space`, which are never bucketed by name.
   */
  const entityRows = await db
    .selectFrom("entities")
    .select([...ENTITY_INDEX_COLUMNS])
    .where(whereLiveEntity())
    .execute();
  const byId = new Map<string, IndexEntityRow>();
  for (const e of entityRows) byId.set(e.id, e);

  const entitiesByType = new Map<ProposeEntityType, IndexEntityRow[]>();
  for (const t of supportedTypes) entitiesByType.set(t, []);
  const byNormalizedName = new Map<string, IndexEntityRow[]>();
  const byNormalizedAlias = new Map<string, IndexEntityRow[]>();
  const dedupEntriesByType = new Map<ProposeEntityType, CandidatePoolEntry[]>();
  for (const t of supportedTypes) dedupEntriesByType.set(t, []);
  for (const e of entityRows) {
    if (!supportedTypeSet.has(e.source_type)) continue;
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

  const sourceRefs = await db.selectFrom("entity_source_refs").select(["entity_id", "source", "source_id"]).execute();
  const bySourceRef = new Map<string, IndexEntityRow>();
  for (const ref of sourceRefs) {
    const row = byId.get(ref.entity_id);
    if (!row) continue;
    if (!canUseEntityAsMatchTarget(row.source_type, row.provenance_tier)) continue;
    bySourceRef.set(`${ref.source}:${ref.source_id}`, row);
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
    entityRows.filter((entity) => entity.source_type === "person"),
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

async function buildPersonScopeKeys(db: Kysely<DB>, persons: IndexEntityRow[]): Promise<Map<string, string[]>> {
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

/**
 * Scan `llm_extracted` facts for a third-party (company/tool) mention matching
 * `name`. Keyset-paginated by `id` so only one page of `raw` payloads is held at
 * once, with an early return on the first match. The single-pass version loaded
 * every `llm_extracted` fact (including `raw`) on every call; iteration order was
 * DB-unspecified then and is deterministic (ascending `id`) now.
 */
async function findLlmExtractedThirdPartyMention(
  db: Kysely<DB>,
  name: string,
): Promise<{ type: Extract<ProposeEntityType, "company" | "tool">; name: string } | null> {
  let cursor = "";
  for (;;) {
    const rows = await db
      .selectFrom("indexed_file_facts")
      .select(["id", "subject_name", "raw"])
      .where("source", "=", "llm_extraction")
      .where("fact_type", "=", "llm_extracted")
      .where("deleted_at", "is", null)
      .where("subject_name", "is not", null)
      .where("id", ">", cursor)
      .orderBy("id", "asc")
      .limit(DEFAULT_FACT_BATCH_SIZE)
      .execute();
    if (rows.length === 0) return null;
    for (const row of rows) {
      const raw = readJsonObject(row.raw);
      const rawType = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
      if (rawType !== "company" && rawType !== "tool") continue;
      const mention = typeof raw.mention === "string" ? raw.mention : row.subject_name;
      if (!mention) continue;
      if (normalizeEntityMatchName(rawType, mention) === normalizeEntityMatchName(rawType, name)) {
        return { type: rawType, name: mention };
      }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < DEFAULT_FACT_BATCH_SIZE) return null;
  }
}

/**
 * Indexed equivalent of `findLlmExtractedThirdPartyMention`. Once the
 * normalization backfill is complete every `llm_extracted` row carries
 * `raw_mention_type`/`normalized_mention_name`, so the first company/tool match
 * for a name is a single indexed lookup instead of a keyset scan of every
 * payload. The returned `name` reparses only the one matched row (the caller
 * uses only `type`, but parity is preserved).
 */
async function findLlmExtractedThirdPartyMentionIndexed(
  db: Kysely<DB>,
  name: string,
): Promise<{ type: Extract<ProposeEntityType, "company" | "tool">; name: string } | null> {
  const key = normalizeEntityMatchName("company", name);
  if (!key) return null;
  const row = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "raw", "raw_mention_type"])
    .where("source", "=", "llm_extraction")
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .where("subject_name", "is not", null)
    .where("raw_mention_type", "in", ["company", "tool"])
    .where("normalized_mention_name", "=", key)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!row || (row.raw_mention_type !== "company" && row.raw_mention_type !== "tool")) return null;
  const raw = readJsonObject(row.raw);
  const mention = typeof raw.mention === "string" ? raw.mention : row.subject_name;
  if (!mention) return null;
  return { type: row.raw_mention_type, name: mention };
}

/**
 * Indexed equivalent of the `buildActiveLlmFileCounts` map lookup for one
 * (name, mention-type) pair: a single `COUNT(DISTINCT indexed_file_id)` over the
 * partial corroboration index. Callers pass the coerced `mentionType`, so a row
 * whose `raw_mention_type` differs after tool-denylist coercion is excluded here
 * exactly as the whole-table map missed it.
 */
async function countActiveLlmFilesIndexed(
  db: Kysely<DB>,
  normalizedName: string,
  mentionType: MentionType,
): Promise<number> {
  const row = await db
    .selectFrom("indexed_file_facts")
    .select((eb) => eb.fn.count("indexed_file_id").distinct().as("c"))
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .where("raw_mention_type", "=", mentionType)
    .where("normalized_subject_name", "=", normalizedName)
    .executeTakeFirst();
  return Number(row?.c ?? 0);
}

/**
 * Reads whether the Fix 2b normalization backfill has populated projection
 * columns for every pre-existing row. Until then, corroboration and third-party
 * reads must fall back to the legacy JS scans, which parse `raw` and so see rows
 * the not-yet-populated columns would miss.
 */
async function isNormalizationBackfillComplete(db: Kysely<DB>): Promise<boolean> {
  const row = await db
    .selectFrom("normalization_backfill_state")
    .select("status")
    .where("id", "=", "v1")
    .executeTakeFirst();
  return row?.status === "complete";
}

function isNameDedupEntityType(entityType: ProposeEntityType): entityType is NameDedupEntityType {
  return entityType === "project" || entityType === "product" || entityType === "person" || entityType === "company";
}

export function registerEntity(index: LookupIndex, entity: IndexEntityRow): void {
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

function removeEntityFromMapBuckets<T extends IndexEntityRow>(map: Map<string, T[]>, entityId: string): void {
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

function isChatConversationSliceEvidence(source: string | null, fileType: string | null): boolean {
  return (
    (source === WHATSAPP_CONNECTOR_TYPE && fileType === WHATSAPP_CONVERSATION_SLICE_FILE_TYPE) ||
    (source === SLACK_CONNECTOR_TYPE && fileType === SLACK_CONVERSATION_SLICE_FILE_TYPE)
  );
}

function llmFileCountKey(normalizedName: string, mentionType: MentionType): string {
  return `${mentionType}\u0000${normalizedName}`;
}

/**
 * Count distinct source files per (name, mention-type) across `llm_extracted`
 * facts. Keyset-paginated by `id` so only one page of `raw` payloads is held at
 * once; the result is order-independent, so streaming yields the same Map the
 * single whole-table load produced.
 */
interface ActiveLlmEvidenceProfile {
  fileIds: Set<string>;
  chatSliceOnly: boolean;
}

async function buildActiveLlmEvidenceProfiles(db: Kysely<DB>): Promise<Map<string, ActiveLlmEvidenceProfile>> {
  const evidenceByName = new Map<string, ActiveLlmEvidenceProfile>();
  await forEachFactBatch(
    (cursor, limit) =>
      db
        .selectFrom("indexed_file_facts")
        .innerJoin("indexed_files", "indexed_files.id", "indexed_file_facts.indexed_file_id")
        .select([
          "indexed_file_facts.id",
          "indexed_file_facts.created_at",
          "indexed_file_facts.indexed_file_id",
          "indexed_file_facts.subject_name",
          "indexed_file_facts.raw",
          "indexed_files.source as file_source",
          "indexed_files.file_type as file_type",
        ])
        .where("indexed_file_facts.fact_type", "=", "llm_extracted")
        .where("indexed_file_facts.deleted_at", "is", null)
        .where("indexed_file_facts.subject_name", "is not", null)
        .where((eb) =>
          eb.or([
            eb("indexed_file_facts.created_at", ">", cursor.createdAt),
            eb.and([
              eb("indexed_file_facts.created_at", "=", cursor.createdAt),
              eb("indexed_file_facts.id", ">", cursor.id),
            ]),
          ]),
        )
        .orderBy("indexed_file_facts.created_at", "asc")
        .orderBy("indexed_file_facts.id", "asc")
        .limit(limit)
        .execute(),
    async (rows) => {
      for (const row of rows) {
        if (!row.indexed_file_id || !row.subject_name) continue;
        const mentionType = normalizeMentionType(readJsonObject(row.raw).type);
        if (!mentionType) continue;
        const normalizedName = normalizeEntityMatchName(mentionType, row.subject_name);
        if (!normalizedName) continue;
        const key = llmFileCountKey(normalizedName, mentionType);
        const isChatSlice = isChatConversationSliceEvidence(row.file_source, row.file_type);
        const profile = evidenceByName.get(key);
        if (profile) {
          profile.fileIds.add(row.indexed_file_id);
          profile.chatSliceOnly = profile.chatSliceOnly && isChatSlice;
        } else {
          evidenceByName.set(key, { fileIds: new Set([row.indexed_file_id]), chatSliceOnly: isChatSlice });
        }
      }
    },
  );
  return evidenceByName;
}

export async function refreshResolvedEntityIndex(
  db: Kysely<DB>,
  index: LookupIndex,
  entity: IndexEntityRow,
): Promise<void> {
  const sourceRefs = await db
    .selectFrom("entity_source_refs")
    .select(["source", "source_id"])
    .where("entity_id", "=", entity.id)
    .execute();
  const refreshed = await db
    .selectFrom("entities")
    .select([...ENTITY_INDEX_COLUMNS])
    .where("id", "=", entity.id)
    .executeTakeFirst();
  const row: IndexEntityRow = refreshed ?? entity;
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
  embeddingProvider?: EmbeddingProvider | null;
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
  const normalizationBackfillComplete = await isNormalizationBackfillComplete(db);
  const llmPromotionThreshold =
    typeof opts.llmPromotionThreshold === "number" && opts.llmPromotionThreshold >= 1
      ? Math.floor(opts.llmPromotionThreshold)
      : configuredLlmPromotionThreshold;
  let activeLlmEvidenceProfiles: Promise<Map<string, ActiveLlmEvidenceProfile>> | null = null;
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
  const embeddingProvider = opts.embeddingProvider ?? null;

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
          entity: IndexEntityRow;
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
    findLlmExtractedThirdPartyMention: (name) =>
      normalizationBackfillComplete
        ? findLlmExtractedThirdPartyMentionIndexed(db, name)
        : findLlmExtractedThirdPartyMention(db, name),
  };
  if (embeddingProvider) {
    lookup.retrieveEmbeddingCandidates = async (entityType, name): Promise<RankedCandidate[]> => {
      if (!isNameDedupEntityType(entityType)) return [];
      try {
        const pool = index.entitiesByType.get(entityType) ?? [];
        const entitiesById = new Map(pool.map((entity) => [entity.id, entity]));
        const rows = await retrieveEntityNameCandidates(db, embeddingProvider, { name, type: entityType });
        const candidates: RankedCandidate[] = [];
        for (const row of rows) {
          const entity = entitiesById.get(row.entityId);
          if (entity) candidates.push({ entity, score: row.similarity, reason: "embedding" });
        }
        return candidates;
      } catch (err) {
        opts.logger?.warn({ err, entityType }, "embedding lookup failed open");
        return [];
      }
    };
  }

  const chatSliceFileCache = new Map<string, boolean>();
  const fileToConnector = new Map<string, string>();
  const connectorOwners = new Map<string, string>();
  const allFiles = await db.selectFrom("indexed_files").select(["id", "connector_config_id"]).execute();
  for (const f of allFiles) fileToConnector.set(f.id, f.connector_config_id);
  const allConfigs = await db.selectFrom("connector_configs").select(["id", "created_by"]).execute();
  for (const c of allConfigs) connectorOwners.set(c.id, c.created_by);
  const allUsers = await db.selectFrom("users").select("id").execute();
  const knownUserIds = new Set(allUsers.map((u) => u.id));

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
    embeddingProvider,
    readEmail: (e: IndexEntityRow) => readPersonEmailFromMetadata(e.metadata),
    onEntityResolved: (entity: IndexEntityRow) => refreshResolvedEntityIndex(db, index, entity),
    getIndexedFileSourceTime: (indexedFileId: string) =>
      db
        .selectFrom("indexed_files")
        .select(["source_created_at", "source_updated_at", "synced_at"])
        .where("id", "=", indexedFileId)
        .executeTakeFirst()
        .then((row) => row ?? null),
    isChatConversationSliceFile: async (indexedFileId: string) => {
      const cached = chatSliceFileCache.get(indexedFileId);
      if (cached !== undefined) return cached;
      const row = await db
        .selectFrom("indexed_files")
        .select(["source", "file_type"])
        .where("id", "=", indexedFileId)
        .executeTakeFirst();
      const isChatSlice = row ? isChatConversationSliceEvidence(row.source, row.file_type) : false;
      chatSliceFileCache.set(indexedFileId, isChatSlice);
      return isChatSlice;
    },
    /**
     * Resolves the owning user for a fact, falling back to the connector's
     * owner. Only ids present in `users` are returned: legacy auth wrote
     * sentinel strings ('admin', 'sketch-api-key') as owners, and a user row
     * can be deleted after facts referenced it; passing either through would
     * fail the owner foreign key on every table the materializers write to.
     */
    resolveOwner: (fact: IndexedFileFactRow) => {
      if (fact.created_by_user_id && knownUserIds.has(fact.created_by_user_id)) return fact.created_by_user_id;
      const connectorId =
        fact.connector_config_id ?? (fact.indexed_file_id ? fileToConnector.get(fact.indexed_file_id) : undefined);
      if (connectorId) {
        const owner = connectorOwners.get(connectorId);
        if (owner && knownUserIds.has(owner)) return owner;
      }
      return null;
    },
    normalizationBackfillComplete,
    countActiveLlmFilesForName: async (normalizedName, mentionType) => {
      if (normalizationBackfillComplete) {
        return countActiveLlmFilesIndexed(db, normalizedName, mentionType);
      }
      activeLlmEvidenceProfiles ??= buildActiveLlmEvidenceProfiles(db);
      const profiles = await activeLlmEvidenceProfiles;
      return profiles.get(llmFileCountKey(normalizedName, mentionType))?.fileIds.size ?? 0;
    },
    hasOnlyChatConversationSliceEvidence: async (normalizedName, mentionType) => {
      if (normalizationBackfillComplete) {
        const rows = await db
          .selectFrom("indexed_file_facts as fact")
          .innerJoin("indexed_files as file", "file.id", "fact.indexed_file_id")
          .select(["file.source", "file.file_type"])
          .distinct()
          .where("fact.fact_type", "=", "llm_extracted")
          .where("fact.deleted_at", "is", null)
          .where("fact.raw_mention_type", "=", mentionType)
          .where("fact.normalized_subject_name", "=", normalizedName)
          .execute();
        return rows.length > 0 && rows.every((row) => isChatConversationSliceEvidence(row.source, row.file_type));
      }
      activeLlmEvidenceProfiles ??= buildActiveLlmEvidenceProfiles(db);
      const profiles = await activeLlmEvidenceProfiles;
      return profiles.get(llmFileCountKey(normalizedName, mentionType))?.chatSliceOnly ?? false;
    },
  };
}

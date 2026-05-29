import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { normalizeName } from "../connectors/name-normalize";
import {
  type EntityMentionConfidence,
  type EntityMentionRelation,
  createEntityRepository,
} from "../db/repositories/entities";
import {
  type EntityDomainsRepository,
  type EntityRelationshipType,
  createEntityDomainsRepository,
} from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { IndexedFileFactType } from "../db/repositories/indexed-file-facts";
import type { DB, EntitiesTable, IndexedFileFactsTable } from "../db/schema";
import { inferAffiliationFromEmail } from "./affiliations";
import { type Entity, type EntityLookup, type ProposeEntityType, proposeEntity } from "./propose";

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

const NON_PERSON_MENTION_TYPES = ["project", "company", "product", "team"] as const;
type NonPersonMentionType = (typeof NON_PERSON_MENTION_TYPES)[number];
type MentionType = "person" | NonPersonMentionType;
const RELATION_TYPES = ["works_at", "leads", "contributes_to", "builds", "part_of", "partner_of"] as const;

function normalizeMentionType(raw: unknown): MentionType | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "person") return "person";
  if ((NON_PERSON_MENTION_TYPES as readonly string[]).includes(lowered)) {
    return lowered as NonPersonMentionType;
  }
  return null;
}

export interface ReplayFactsSummary {
  factsRead: number;
  entitiesCreated: number;
  entitiesLinked: number;
  queued: number;
  mentionsWritten: number;
  relationshipsWritten: number;
  skipped: number;
}

export interface MaterializeFactsSummary extends ReplayFactsSummary {
  materialized: number;
  deferred: number;
  deferredBelowThreshold: number;
}

type EntityRow = Selectable<EntitiesTable>;
export type IndexedFileFactRow = Selectable<IndexedFileFactsTable>;

export interface LookupIndex {
  entitiesByType: Map<ProposeEntityType, EntityRow[]>;
  byNormalizedName: Map<string, EntityRow[]>;
  byNormalizedAlias: Map<string, EntityRow[]>;
  bySourceRef: Map<string, EntityRow>;
}

export interface MaterializeDeps {
  db: Kysely<DB>;
  entityRepo: ReturnType<typeof createEntityRepository>;
  reviewRepo: ReturnType<typeof createEntityReviewRepo>;
  domainsRepo: EntityDomainsRepository;
  lookup: EntityLookup;
  index: LookupIndex;
  readEmail: (entity: Entity) => string | null;
  resolveOwner: (fact: IndexedFileFactRow) => string | null;
  llmPromotionThreshold: number;
}

export type MaterializeResult =
  | { kind: "entity_created"; entity: EntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "entity_linked"; entity: EntityRow; mentionWritten: boolean; countEntity?: boolean }
  | { kind: "queued"; reviewId: string }
  | { kind: "queued_held"; reviewId: string; reason: "llm_ambiguous" | "non_person_collision" | "relation_endpoint" }
  | {
      kind: "relationship_materialized";
      entitiesCreated: number;
      entitiesLinked: number;
      mentionsWritten: number;
      relationshipsWritten: number;
    }
  | { kind: "structural"; entity: EntityRow }
  | { kind: "skipped_missing_owner"; reason: string }
  | { kind: "deferred_below_threshold"; reason: string }
  | { kind: "skipped"; reason: string };

const FACT_REPLAY_ORDER = [
  "structural_seed",
  "person_seed",
  "attendee",
  "assignee",
  "author",
  "parent_entity",
  "llm_extracted",
  "llm_relation",
] as const;

const PERSON_FACT_RELATION = {
  attendee: "attended",
  assignee: "assigned",
  author: "authored",
  llm_extracted: "mentioned",
} as const;

function readJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readPersonEmailFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { email?: unknown };
    if (typeof parsed.email === "string" && parsed.email.length > 0) return parsed.email.toLowerCase();
  } catch {
    return null;
  }
  return null;
}

function parseAliasesString(aliases: string | null): string[] {
  if (!aliases) return [];
  try {
    const parsed = JSON.parse(aliases);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
  return [];
}

function normalizeEntityMatchName(entityType: string, name: string): string {
  if (entityType !== "product") return normalizeName(name);
  return normalizeName(
    name
      .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " "),
  );
}

async function buildLookupIndex(db: Kysely<DB>): Promise<LookupIndex> {
  const supportedTypes: ProposeEntityType[] = ["person", "company", "product", "project", "team"];
  const entities = await db.selectFrom("entities").selectAll().where("source_type", "in", supportedTypes).execute();
  const entitiesByType = new Map<ProposeEntityType, EntityRow[]>();
  for (const t of supportedTypes) entitiesByType.set(t, []);
  const byNormalizedName = new Map<string, EntityRow[]>();
  const byNormalizedAlias = new Map<string, EntityRow[]>();
  for (const e of entities) {
    const entityType = e.source_type as ProposeEntityType;
    entitiesByType.get(entityType)?.push(e);
    const nameKey = normalizeEntityMatchName(entityType, e.name);
    if (nameKey) {
      const bucket = byNormalizedName.get(nameKey);
      if (bucket) bucket.push(e);
      else byNormalizedName.set(nameKey, [e]);
    }
    for (const alias of parseAliasesString(e.aliases)) {
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
    .execute();
  const bySourceRef = new Map<string, EntityRow>();
  for (const row of sourceRefs) {
    bySourceRef.set(`${row.source}:${row.source_id}`, row as unknown as EntityRow);
  }
  return { entitiesByType, byNormalizedName, byNormalizedAlias, bySourceRef };
}

function registerEntity(index: LookupIndex, entity: EntityRow): void {
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
}

export interface BuildMaterializeDepsOptions {
  llmPromotionThreshold?: number;
}

export async function buildMaterializeDeps(
  db: Kysely<DB>,
  opts: BuildMaterializeDepsOptions = {},
): Promise<MaterializeDeps> {
  const entityRepo = createEntityRepository(db);
  const reviewRepo = createEntityReviewRepo(db);
  const domainsRepo = createEntityDomainsRepository(db);
  const index = await buildLookupIndex(db);
  const llmPromotionThreshold =
    typeof opts.llmPromotionThreshold === "number" && opts.llmPromotionThreshold >= 1
      ? Math.floor(opts.llmPromotionThreshold)
      : configuredLlmPromotionThreshold;

  const lookup: EntityLookup = {
    getByNormalizedName: (n) => index.byNormalizedName.get(n) ?? [],
    getByAlias: (n) => index.byNormalizedAlias.get(n) ?? [],
    listByType: (t: ProposeEntityType) => index.entitiesByType.get(t) ?? [],
  };

  const fileToConnector = new Map<string, string>();
  const connectorOwners = new Map<string, string>();
  const allFiles = await db.selectFrom("indexed_files").select(["id", "connector_config_id"]).execute();
  for (const f of allFiles) fileToConnector.set(f.id, f.connector_config_id);
  const allConfigs = await db.selectFrom("connector_configs").select(["id", "created_by"]).execute();
  for (const c of allConfigs) connectorOwners.set(c.id, c.created_by);

  return {
    db,
    entityRepo,
    reviewRepo,
    domainsRepo,
    lookup,
    index,
    llmPromotionThreshold,
    readEmail: (e: Entity) => readPersonEmailFromMetadata(e.metadata),
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

export async function materializeFromFact(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (fact.fact_type === "structural_seed") {
    return materializeStructuralSeed(deps, fact);
  }
  if (fact.fact_type === "person_seed") {
    return materializePersonSeed(deps, fact);
  }
  if (fact.fact_type === "llm_extracted") {
    return materializeLlmExtractedFact(deps, fact);
  }
  if (fact.fact_type === "llm_relation") {
    return materializeLlmRelationFact(deps, fact);
  }
  if (fact.fact_type === "attendee" || fact.fact_type === "assignee" || fact.fact_type === "author") {
    return materializePersonFact(deps, fact);
  }
  if (fact.fact_type === "parent_entity") {
    return materializeParentEntity(deps, fact);
  }
  return { kind: "skipped", reason: "unknown_fact_type" };
}

function accumulate(summary: ReplayFactsSummary, result: MaterializeResult): void {
  if (result.kind === "entity_created") {
    if (result.countEntity !== false) summary.entitiesCreated++;
    if (result.mentionWritten) summary.mentionsWritten++;
    return;
  }
  if (result.kind === "entity_linked") {
    if (result.countEntity !== false) summary.entitiesLinked++;
    if (result.mentionWritten) summary.mentionsWritten++;
    return;
  }
  if (result.kind === "queued") {
    summary.queued++;
    return;
  }
  if (result.kind === "queued_held") {
    summary.queued++;
    return;
  }
  if (result.kind === "relationship_materialized") {
    summary.entitiesCreated += result.entitiesCreated;
    summary.entitiesLinked += result.entitiesLinked;
    summary.mentionsWritten += result.mentionsWritten;
    summary.relationshipsWritten += result.relationshipsWritten;
    return;
  }
  if (
    result.kind === "skipped" ||
    result.kind === "skipped_missing_owner" ||
    result.kind === "deferred_below_threshold"
  ) {
    summary.skipped++;
  }
}

export interface ReplaySourceFactsOptions {
  llmPromotionThreshold?: number;
}

export async function replaySourceFacts(
  db: Kysely<DB>,
  logger: Logger,
  opts: ReplaySourceFactsOptions = {},
): Promise<ReplayFactsSummary> {
  const summary: ReplayFactsSummary = {
    factsRead: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    queued: 0,
    mentionsWritten: 0,
    relationshipsWritten: 0,
    skipped: 0,
  };

  const deps = await buildMaterializeDeps(db, { llmPromotionThreshold: opts.llmPromotionThreshold });
  const orderRank = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));
  const facts = (await db.selectFrom("indexed_file_facts").selectAll().where("deleted_at", "is", null).execute())
    .filter((f) => orderRank.has(f.fact_type))
    .sort((a, b) => (orderRank.get(a.fact_type) ?? 0) - (orderRank.get(b.fact_type) ?? 0));

  summary.factsRead = facts.length;

  for (const fact of facts) {
    try {
      const result = await materializeFromFact(deps, fact);
      accumulate(summary, result);
    } catch (err) {
      logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Replay failed for fact");
      summary.skipped++;
    }
  }

  logger.info({ summary }, "Source-fact replay complete");
  return summary;
}

let materializeQueue: Promise<void> = Promise.resolve();

export interface MaterializeProgress {
  phase: string;
  completed: number;
  total: number;
}

export interface MaterializeUnmaterializedOptions {
  llmPromotionThreshold?: number;
  factTypes?: IndexedFileFactType[];
  /**
   * Fires before processing each fact with `completed = index, total = facts.length`
   * and after the loop with `completed = total`. Used by the reset/reenrich job
   * watcher to surface live progress to the rebuild banner in the UI.
   */
  onProgress?: (progress: MaterializeProgress) => void;
}

export async function materializeUnmaterializedFacts(
  db: Kysely<DB>,
  logger: Logger,
  opts: MaterializeUnmaterializedOptions = {},
): Promise<MaterializeFactsSummary> {
  const run = materializeQueue.then(() => materializeUnmaterializedFactsInner(db, logger, opts));
  materializeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function cleanupRelationshipEvidenceForFacts(db: Kysely<DB>, sourceFactIds: string[]): Promise<number> {
  return createEntityDomainsRepository(db).deleteEvidenceForSourceFacts(sourceFactIds);
}

export async function cleanupEmptyRelationships(db: Kysely<DB>): Promise<number> {
  return createEntityDomainsRepository(db).cleanupEmptyRelationships();
}

async function materializeUnmaterializedFactsInner(
  db: Kysely<DB>,
  logger: Logger,
  opts: MaterializeUnmaterializedOptions,
): Promise<MaterializeFactsSummary> {
  const summary: MaterializeFactsSummary = {
    factsRead: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    queued: 0,
    mentionsWritten: 0,
    relationshipsWritten: 0,
    skipped: 0,
    materialized: 0,
    deferred: 0,
    deferredBelowThreshold: 0,
  };

  const deps = await buildMaterializeDeps(db, { llmPromotionThreshold: opts.llmPromotionThreshold });
  const orderRank = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));
  let factsQuery = db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("deleted_at", "is", null)
    .where("materialized_at", "is", null);
  if (opts.factTypes && opts.factTypes.length > 0) {
    factsQuery = factsQuery.where("fact_type", "in", opts.factTypes);
  }
  const facts = (await factsQuery.execute()).sort(
    (a, b) =>
      (orderRank.get(a.fact_type) ?? Number.MAX_SAFE_INTEGER) - (orderRank.get(b.fact_type) ?? Number.MAX_SAFE_INTEGER),
  );

  summary.factsRead = facts.length;
  opts.onProgress?.({ phase: "materialize", completed: 0, total: facts.length });

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    try {
      const result = await materializeFromFact(deps, fact);
      accumulate(summary, result);
      if (result.kind === "deferred_below_threshold") {
        summary.deferredBelowThreshold++;
      }
      if (shouldMarkMaterialized(result)) {
        await db
          .updateTable("indexed_file_facts")
          .set({ materialized_at: new Date().toISOString() })
          .where("id", "=", fact.id)
          .execute();
        summary.materialized++;
      } else {
        summary.deferred++;
      }
    } catch (err) {
      logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Materialization failed for fact");
      summary.skipped++;
      summary.deferred++;
    }
    opts.onProgress?.({ phase: "materialize", completed: i + 1, total: facts.length });
  }

  await cleanupEmptyRelationships(db);
  logger.info({ summary }, "Source-fact materialization complete");
  return summary;
}

export function shouldMarkMaterialized(result: MaterializeResult): boolean {
  if (
    result.kind === "entity_created" ||
    result.kind === "entity_linked" ||
    result.kind === "queued" ||
    result.kind === "relationship_materialized" ||
    result.kind === "structural"
  ) {
    return true;
  }
  if (result.kind === "skipped_missing_owner") return false;
  if (result.kind === "deferred_below_threshold") return false;
  if (result.kind === "skipped") {
    return (
      result.reason !== "missing_parent_seed" &&
      result.reason !== "unknown_fact_type" &&
      result.reason !== "missing_or_invalid_mention_type"
    );
  }
  return false;
}

async function materializeStructuralSeed(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const subjectSource = fact.subject_source ?? fact.source;
  const subjectSourceId = fact.subject_source_id;
  if (!subjectSourceId || !fact.subject_name) return { kind: "skipped", reason: "missing_structural_subject" };

  let sourceType: string;
  if (typeof raw.sourceType === "string") {
    sourceType = raw.sourceType;
  } else if (typeof raw.fileType === "string") {
    sourceType = `${fact.source}_${raw.fileType}`;
  } else {
    sourceType = fact.source;
  }
  const sourceUrl = typeof raw.providerUrl === "string" ? raw.providerUrl : (raw.sourceUrl as string | undefined);
  const sourcePath = typeof raw.sourcePath === "string" ? raw.sourcePath : undefined;
  const metadataFromRaw =
    raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : undefined;
  const metadata = metadataFromRaw ?? (sourcePath ? { path: sourcePath } : undefined);

  const entity = (await deps.entityRepo.upsertEntityFromTool({
    name: fact.subject_name,
    sourceType,
    source: subjectSource,
    sourceId: subjectSourceId,
    sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata,
  })) as unknown as EntityRow;
  deps.index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity);
  return { kind: "structural", entity };
}

async function materializePersonSeed(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!fact.subject_name || !fact.subject_source || !fact.subject_source_id) {
    return { kind: "skipped", reason: "missing_person_seed_subject" };
  }
  const raw = readJsonObject(fact.raw);
  const subtype = raw.subtype === "internal" ? "internal" : "external";
  const entity = (await deps.entityRepo.upsertPersonEntity({
    name: fact.subject_name,
    email: fact.subject_email ?? undefined,
    subtype,
    source: fact.subject_source,
    sourceId: fact.subject_source_id,
  })) as unknown as EntityRow;
  deps.index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity);
  registerEntity(deps.index, entity);
  await inferAffiliationFromEmail(
    { db: deps.db, domainsRepo: deps.domainsRepo },
    {
      personEntityId: entity.id,
      email: fact.subject_email,
      evidenceFileId: fact.indexed_file_id,
      firstObservedByUserId: fact.created_by_user_id,
    },
  );
  return { kind: "structural", entity };
}

async function countActiveLlmFilesForName(
  db: Kysely<DB>,
  normalized: string,
  mentionType: MentionType,
): Promise<number> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id", "subject_name", "raw"])
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .where("subject_name", "is not", null)
    .execute();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.indexed_file_id || !row.subject_name) continue;
    const raw = readJsonObject(row.raw);
    if (normalizeMentionType(raw.type) !== mentionType) continue;
    if (normalizeEntityMatchName(mentionType, row.subject_name) !== normalized) continue;
    seen.add(row.indexed_file_id);
  }
  return seen.size;
}

async function materializeLlmExtractedFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  if (!fact.subject_name) {
    return { kind: "skipped", reason: "missing_llm_subject" };
  }
  const raw = readJsonObject(fact.raw);
  const mentionType = normalizeMentionType(raw.type);
  if (!mentionType) {
    return { kind: "skipped", reason: "missing_or_invalid_mention_type" };
  }

  const normalized = normalizeEntityMatchName(mentionType, fact.subject_name);
  if (!normalized) {
    return { kind: "skipped", reason: "missing_llm_subject" };
  }
  const fileCount = await countActiveLlmFilesForName(deps.db, normalized, mentionType);
  if (fileCount < deps.llmPromotionThreshold) {
    return { kind: "deferred_below_threshold", reason: "below_promotion_threshold" };
  }

  if (mentionType === "person") {
    return materializePersonFact(deps, fact);
  }
  return materializeNonPersonLlmEntity(deps, fact, mentionType);
}

interface RelationEndpoint {
  name: string;
  type: MentionType;
  variations: string[];
}

function normalizeRelationType(raw: unknown): EntityRelationshipType | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  return (RELATION_TYPES as readonly string[]).includes(lowered) ? (lowered as EntityRelationshipType) : null;
}

function readRelationEndpoint(raw: Record<string, unknown>, key: "source" | "target"): RelationEndpoint | null {
  const endpoint = raw[key];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return null;
  const record = endpoint as Record<string, unknown>;
  if (typeof record.name !== "string") return null;
  const type = normalizeMentionType(record.type);
  if (!type) return null;
  const variations = Array.isArray(record.variations) ? record.variations.filter(isString) : [];
  return { name: record.name, type, variations };
}

function relationDirectionAllowed(
  relationType: EntityRelationshipType,
  sourceType: MentionType,
  targetType: MentionType,
): boolean {
  if (relationType === "works_at") return sourceType === "person" && targetType === "company";
  if (relationType === "leads") {
    return sourceType === "person" && (targetType === "project" || targetType === "product" || targetType === "team");
  }
  if (relationType === "contributes_to") {
    return sourceType === "person" && (targetType === "project" || targetType === "product");
  }
  if (relationType === "builds") return sourceType === "company" && targetType === "product";
  if (relationType === "part_of") {
    return (
      (sourceType === "project" && targetType === "project") ||
      (sourceType === "product" && targetType === "product") ||
      (sourceType === "team" && targetType === "company")
    );
  }
  return sourceType === "company" && targetType === "company";
}

async function materializeLlmRelationFact(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const relationType = normalizeRelationType(raw.relationType ?? fact.relation);
  const source = readRelationEndpoint(raw, "source");
  const target = readRelationEndpoint(raw, "target");
  const confidenceScore = typeof raw.confidence === "number" ? raw.confidence : 0;
  const sourceConfidence = typeof raw.sourceConfidence === "number" ? raw.sourceConfidence : 0;
  const targetConfidence = typeof raw.targetConfidence === "number" ? raw.targetConfidence : 0;
  if (!relationType || !source || !target) return { kind: "skipped", reason: "invalid_llm_relation" };
  if (confidenceScore < 0.85) return { kind: "skipped", reason: "low_confidence_relation" };
  if (sourceConfidence < 0.8 || targetConfidence < 0.8) {
    return { kind: "skipped", reason: "low_endpoint_confidence" };
  }
  if (!relationDirectionAllowed(relationType, source.type, target.type)) {
    return { kind: "skipped", reason: "invalid_relation_direction" };
  }
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };

  const sourceResult = await materializeRelationEndpoint(deps, fact, source, triggeredByUserId, "source");
  if (sourceResult.kind === "queued_held") return sourceResult;
  const targetResult = await materializeRelationEndpoint(deps, fact, target, triggeredByUserId, "target");
  if (targetResult.kind === "queued_held") return targetResult;
  if (sourceResult.entity.id === targetResult.entity.id) return { kind: "skipped", reason: "self_relation" };

  let relationshipsWritten = 0;
  const relationshipId = await deps.domainsRepo.upsertRelationship({
    sourceEntityId: sourceResult.entity.id,
    targetEntityId: targetResult.entity.id,
    relationshipType: relationType,
    confidence: "EXTRACTED",
    confidenceScore,
    source: "llm_extraction",
  });
  relationshipsWritten++;
  if (fact.indexed_file_id) {
    await deps.domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: fact.indexed_file_id,
      chunkIndex: 0,
      note: `llm_relation:${relationType}`,
      sourceFactId: fact.id,
    });
  }
  if (relationType === "partner_of") {
    const reverseId = await deps.domainsRepo.upsertRelationship({
      sourceEntityId: targetResult.entity.id,
      targetEntityId: sourceResult.entity.id,
      relationshipType: relationType,
      confidence: "EXTRACTED",
      confidenceScore,
      source: "llm_extraction",
    });
    relationshipsWritten++;
    if (fact.indexed_file_id) {
      await deps.domainsRepo.addEvidence({
        relationshipId: reverseId,
        indexedFileId: fact.indexed_file_id,
        chunkIndex: 0,
        note: `llm_relation:${relationType}`,
        sourceFactId: fact.id,
      });
    }
  }

  let mentionsWritten = 0;
  if (fact.indexed_file_id) {
    await createMentionFromFact(deps, {
      entityId: sourceResult.entity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "llm_relation",
      relation: "mentioned",
    });
    await createMentionFromFact(deps, {
      entityId: targetResult.entity.id,
      indexedFileId: fact.indexed_file_id,
      contextSnippet: fact.context_snippet ?? null,
      confidence: "EXTRACTED",
      source: "llm_relation",
      relation: "mentioned",
    });
    mentionsWritten = 2;
  }

  return {
    kind: "relationship_materialized",
    entitiesCreated: Number(sourceResult.created) + Number(targetResult.created),
    entitiesLinked: Number(!sourceResult.created) + Number(!targetResult.created),
    mentionsWritten,
    relationshipsWritten,
  };
}

async function materializeRelationEndpoint(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  endpoint: RelationEndpoint,
  triggeredByUserId: string,
  role: "source" | "target",
): Promise<
  | { kind: "resolved"; entity: EntityRow; created: boolean }
  | { kind: "queued_held"; reviewId: string; reason: "relation_endpoint" }
> {
  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      lookup: deps.lookup,
      readEmail: deps.readEmail,
    },
    {
      name: endpoint.name,
      entityType: endpoint.type,
      subtype: "external",
      source: "llm_relation",
      sourceId: `${fact.indexed_file_id ?? "no-file"}:${fact.content_hash ?? "no-hash"}:${role}:${endpoint.name}`,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      aliases: endpoint.variations,
      metadata: { origin: "ai", relationEndpoint: true },
    },
  );
  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "relation_endpoint" };
  }
  const entity = result.entity as unknown as EntityRow;
  registerEntity(deps.index, entity);
  return { kind: "resolved", entity, created: result.kind === "created" };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function materializeNonPersonLlmEntity(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
  sourceType: NonPersonMentionType,
): Promise<MaterializeResult> {
  const raw = readJsonObject(fact.raw);
  const variations = Array.isArray(raw.variations) ? raw.variations.filter(isString) : [];
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) {
    return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };
  }

  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      lookup: deps.lookup,
      readEmail: deps.readEmail,
    },
    {
      name: fact.subject_name as string,
      entityType: sourceType,
      subtype: "external",
      source: "llm_extraction",
      sourceId: fact.subject_source_id ?? `${fact.indexed_file_id ?? "no-file"}:${fact.subject_name}`,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      aliases: variations,
      metadata: { origin: "ai" },
    },
  );

  if (result.kind === "queued") {
    return { kind: "queued_held", reviewId: result.reviewId, reason: "non_person_collision" };
  }

  const entity = result.entity as unknown as EntityRow;
  const created = result.kind === "created";
  registerEntity(deps.index, entity);

  if (!fact.indexed_file_id) {
    return { kind: created ? "entity_created" : "entity_linked", entity, mentionWritten: false };
  }
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "INFERRED",
    source: "llm_extraction",
    relation: "mentioned",
  });
  return {
    kind: created ? "entity_created" : "entity_linked",
    entity,
    mentionWritten: true,
  };
}

async function materializePersonFact(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!fact.subject_name) {
    return { kind: "skipped", reason: "missing_person_subject" };
  }
  const factType = fact.fact_type as keyof typeof PERSON_FACT_RELATION;
  const relation = PERSON_FACT_RELATION[factType];
  const confidence = fact.fact_type === "llm_extracted" ? "INFERRED" : "EXTRACTED";
  const mentionSource = fact.fact_type === "llm_extracted" ? "llm_extraction" : `${fact.source}_${fact.fact_type}`;
  const subtype = fact.subject_email ? "external" : "external";

  let entity: EntityRow | null = null;
  if (fact.subject_source && fact.subject_source_id) {
    const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
    const cached = deps.index.bySourceRef.get(refKey);
    if (cached) {
      entity = cached;
    }
  }

  let resultKind: "entity_created" | "entity_linked" = "entity_linked";
  if (!entity) {
    const source = fact.subject_source ?? fact.source;
    const sourceId =
      fact.subject_source_id ?? `${fact.indexed_file_id ?? "no-file"}:${fact.subject_email ?? fact.subject_name}`;
    const triggeredByUserId = deps.resolveOwner(fact);
    if (!triggeredByUserId) {
      return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };
    }

    const result = await proposeEntity(
      {
        entityRepo: deps.entityRepo,
        reviewRepo: deps.reviewRepo,
        lookup: deps.lookup,
        readEmail: deps.readEmail,
      },
      {
        name: fact.subject_name,
        email: fact.subject_email ?? null,
        entityType: "person",
        subtype,
        source,
        sourceId,
        evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
        triggeredByUserId,
      },
    );
    if (result.kind === "queued") {
      if (fact.fact_type === "llm_extracted") {
        return { kind: "queued_held", reviewId: result.reviewId, reason: "llm_ambiguous" };
      }
      return { kind: "queued", reviewId: result.reviewId };
    }
    entity = result.entity as unknown as EntityRow;
    resultKind = result.kind === "created" ? "entity_created" : "entity_linked";
    registerEntity(deps.index, entity);
    if (fact.subject_source && fact.subject_source_id) {
      deps.index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity);
    }
  }

  if (entity && fact.subject_email) {
    await inferAffiliationFromEmail(
      { db: deps.db, domainsRepo: deps.domainsRepo },
      {
        personEntityId: entity.id,
        email: fact.subject_email,
        evidenceFileId: fact.indexed_file_id,
        firstObservedByUserId: fact.created_by_user_id,
      },
    );
  }

  if (!entity || !fact.indexed_file_id) return { kind: resultKind, entity, mentionWritten: false };
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence,
    source: mentionSource,
    relation,
  });
  return { kind: resultKind, entity, mentionWritten: true };
}

async function materializeParentEntity(deps: MaterializeDeps, fact: IndexedFileFactRow): Promise<MaterializeResult> {
  if (!fact.indexed_file_id || !fact.subject_source || !fact.subject_source_id) {
    return { kind: "skipped", reason: "missing_parent_subject" };
  }
  const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
  let entity = deps.index.bySourceRef.get(refKey);
  if (!entity) {
    const found = await deps.entityRepo.getEntityBySourceRef(fact.subject_source, fact.subject_source_id);
    if (found) {
      entity = found as unknown as EntityRow;
      deps.index.bySourceRef.set(refKey, entity);
    }
  }
  if (!entity) {
    return { kind: "skipped", reason: "missing_parent_seed" };
  }
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "EXTRACTED",
    source: `${fact.source}_parent_entity`,
    relation: "mentioned",
  });
  return { kind: "entity_linked", entity, mentionWritten: true, countEntity: false };
}

async function createMentionFromFact(
  deps: MaterializeDeps,
  data: {
    entityId: string;
    indexedFileId: string;
    contextSnippet: string | null;
    confidence: EntityMentionConfidence;
    source: string;
    relation: EntityMentionRelation;
  },
): Promise<void> {
  const now = new Date().toISOString();
  if (data.confidence === "EXTRACTED") {
    await deps.db
      .updateTable("entity_mentions")
      .set({
        context_snippet: data.contextSnippet,
        confidence: "EXTRACTED",
        source: data.source,
        mentioned_at: now,
      })
      .where("entity_id", "=", data.entityId)
      .where("indexed_file_id", "=", data.indexedFileId)
      .where("relation", "=", data.relation)
      .where("confidence", "!=", "EXTRACTED")
      .execute();
  }

  await deps.entityRepo.createMention({
    entityId: data.entityId,
    indexedFileId: data.indexedFileId,
    contextSnippet: data.contextSnippet,
    confidence: data.confidence,
    source: data.source,
    relation: data.relation,
  });
}

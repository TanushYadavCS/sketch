import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { createEmbeddingProvider } from "../connectors/embeddings";
import { type EnrichmentResult, isEnrichmentActive, runEnrichment } from "../connectors/enrichment";
import { normalizeName } from "../connectors/name-normalize";
import { getSyncProgress } from "../connectors/sync";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB, EntitiesTable } from "../db/schema";
import { type Entity, type EntityLookup, type ProposeEntityType, proposeEntity } from "./propose";
import { isRecreateActive, withRecreateLock } from "./recreate-state";

export interface ResetSummary {
  dryRun: boolean;
  deleted: Record<string, number>;
  filesMarkedPending: number;
  warnings: string[];
}

export interface RecreateConflict {
  code: "RECREATE_ACTIVE" | "SYNC_ACTIVE" | "ENRICHMENT_ACTIVE";
  message: string;
}

const DERIVED_TABLES = [
  "entity_review_evidence",
  "entity_alias_rejections",
  "entity_review_queue",
  "entity_candidates",
  "entity_mentions",
  "entity_source_refs",
  "entities",
  "chunk_embeddings",
  "file_embeddings",
  "document_chunks",
  "document_timeframes",
] as const;

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table") || message.includes("does not exist");
}

async function countTable(db: Kysely<DB>, table: string): Promise<number> {
  try {
    const result = await sql<{
      count: string | number | bigint;
    }>`SELECT COUNT(*) AS count FROM ${sql.raw(table)}`.execute(db);
    return Number(result.rows[0]?.count ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function deleteTable(db: Kysely<DB>, table: string): Promise<number> {
  const count = await countTable(db, table);
  if (count === 0) return 0;
  try {
    await sql`DELETE FROM ${sql.raw(table)}`.execute(db);
    return count;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function getPendingFileCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("indexed_files")
    .select(db.fn.countAll<number>().as("count"))
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function markFilesPending(db: Kysely<DB>): Promise<number> {
  const result = await db
    .updateTable("indexed_files")
    .set({
      embedding_status: "pending",
      summary_status: "pending",
      enrichment_status: "raw",
      summary: null,
    })
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

async function countFilesWithoutSourceFacts(db: Kysely<DB>): Promise<number> {
  try {
    const row = await db
      .selectFrom("indexed_files")
      .select(db.fn.countAll<number>().as("count"))
      .where("is_archived", "=", 0)
      .where(
        "id",
        "not in",
        db.selectFrom("indexed_file_facts").select("indexed_file_id").where("indexed_file_id", "is not", null),
      )
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

export async function getRecreateConflict(db: Kysely<DB>): Promise<RecreateConflict | null> {
  if (isRecreateActive()) {
    return { code: "RECREATE_ACTIVE", message: "Entity recreate is already active" };
  }
  if (isEnrichmentActive()) {
    return { code: "ENRICHMENT_ACTIVE", message: "Enrichment is currently active" };
  }
  if (getSyncProgress().length > 0) {
    return { code: "SYNC_ACTIVE", message: "Connector sync is currently active" };
  }
  const syncing = await db
    .selectFrom("connector_configs")
    .select("id")
    .where("sync_status", "=", "syncing")
    .limit(1)
    .executeTakeFirst();
  if (syncing) {
    return { code: "SYNC_ACTIVE", message: "A connector is marked syncing" };
  }
  return null;
}

export async function resetDerivedEntityData(
  db: Kysely<DB>,
  logger: Logger,
  opts: { dryRun?: boolean; lockAlreadyHeld?: boolean } = {},
): Promise<ResetSummary> {
  if (!opts.lockAlreadyHeld) {
    const conflict = await getRecreateConflict(db);
    if (conflict) {
      throw new Error(conflict.code);
    }
  }

  const deleted: Record<string, number> = {};
  for (const table of DERIVED_TABLES) {
    deleted[table] = await countTable(db, table);
  }

  const filesMarkedPending = await getPendingFileCount(db);
  const filesWithoutSourceFacts = await countFilesWithoutSourceFacts(db);
  const warnings = [
    `${deleted.entities ?? 0} entities will be deleted and recreated from durable facts/enrichment.`,
    `${deleted.entity_review_queue ?? 0} review-queue rows will be deleted.`,
    `${deleted.entity_alias_rejections ?? 0} alias rejections will be deleted; rejected aliases may be re-proposed after recreate.`,
  ];
  if (filesWithoutSourceFacts > 0) {
    warnings.push(
      `${filesWithoutSourceFacts} non-archived files have no persisted source facts; recreate can only recover content-derived graph data for them.`,
    );
  }

  if (opts.dryRun) {
    return { dryRun: true, deleted, filesMarkedPending, warnings };
  }

  return opts.lockAlreadyHeld
    ? resetDerivedEntityDataInner(db, logger)
    : withRecreateLock(() => resetDerivedEntityDataInner(db, logger));
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — Replay durable source facts back into the entity graph.
// ─────────────────────────────────────────────────────────────────────────

export interface ReplayFactsSummary {
  factsRead: number;
  entitiesCreated: number;
  entitiesLinked: number;
  queued: number;
  mentionsWritten: number;
  skipped: number;
}

const FACT_REPLAY_ORDER = [
  "structural_seed",
  "person_seed",
  "attendee",
  "assignee",
  "author",
  "parent_entity",
] as const;

type EntityRow = Selectable<EntitiesTable>;

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
    /* corrupt metadata — skip */
  }
  return null;
}

function parseAliasesString(aliases: string | null): string[] {
  if (!aliases) return [];
  try {
    const parsed = JSON.parse(aliases);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    /* corrupt aliases — skip */
  }
  return [];
}

interface LookupIndex {
  personEntities: EntityRow[];
  byNormalizedName: Map<string, EntityRow[]>;
  byNormalizedAlias: Map<string, EntityRow[]>;
  bySourceRef: Map<string, EntityRow>;
}

async function buildLookupIndex(db: Kysely<DB>): Promise<LookupIndex> {
  const personEntities = await db.selectFrom("entities").selectAll().where("source_type", "=", "person").execute();
  const byNormalizedName = new Map<string, EntityRow[]>();
  const byNormalizedAlias = new Map<string, EntityRow[]>();
  for (const e of personEntities) {
    const nameKey = normalizeName(e.name);
    if (nameKey) {
      const bucket = byNormalizedName.get(nameKey);
      if (bucket) bucket.push(e);
      else byNormalizedName.set(nameKey, [e]);
    }
    for (const alias of parseAliasesString(e.aliases)) {
      const aliasKey = normalizeName(alias);
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
  return { personEntities, byNormalizedName, byNormalizedAlias, bySourceRef };
}

function registerPerson(index: LookupIndex, entity: EntityRow): void {
  if (!index.personEntities.some((p) => p.id === entity.id)) index.personEntities.push(entity);
  const nameKey = normalizeName(entity.name);
  if (nameKey) {
    const bucket = index.byNormalizedName.get(nameKey);
    if (bucket) {
      if (!bucket.some((b) => b.id === entity.id)) bucket.push(entity);
    } else {
      index.byNormalizedName.set(nameKey, [entity]);
    }
  }
  for (const alias of parseAliasesString(entity.aliases)) {
    const aliasKey = normalizeName(alias);
    if (!aliasKey) continue;
    const bucket = index.byNormalizedAlias.get(aliasKey);
    if (bucket) {
      if (!bucket.some((b) => b.id === entity.id)) bucket.push(entity);
    } else {
      index.byNormalizedAlias.set(aliasKey, [entity]);
    }
  }
}

interface FactRow {
  id: string;
  indexed_file_id: string | null;
  source: string;
  fact_type: string;
  relation: string;
  subject_name: string | null;
  subject_email: string | null;
  subject_source: string | null;
  subject_source_id: string | null;
  context_snippet: string | null;
  raw: string | null;
}

export async function replaySourceFacts(
  db: Kysely<DB>,
  logger: Logger,
  opts: { triggeredByUserId: string },
): Promise<ReplayFactsSummary> {
  const summary: ReplayFactsSummary = {
    factsRead: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    queued: 0,
    mentionsWritten: 0,
    skipped: 0,
  };

  const entityRepo = createEntityRepository(db);
  const reviewRepo = createEntityReviewRepo(db);
  const index = await buildLookupIndex(db);

  const lookup: EntityLookup = {
    getByNormalizedName: (n) => index.byNormalizedName.get(n) ?? [],
    getByAlias: (n) => index.byNormalizedAlias.get(n) ?? [],
    listByType: (t: ProposeEntityType) => (t === "person" ? index.personEntities : []),
  };

  const proposeDeps = {
    entityRepo,
    reviewRepo,
    lookup,
    readEmail: (e: Entity) => readPersonEmailFromMetadata(e.metadata),
  };

  // Cache file→connector_config_id mapping so personal/structural seeds can
  // attribute correctly. Replay-time `triggeredByUserId` defaults to the caller
  // but falls back to the connector_config.created_by when a fact has a file.
  const fileToConnector = new Map<string, string>();
  const connectorOwners = new Map<string, string>();
  const allFiles = await db.selectFrom("indexed_files").select(["id", "connector_config_id"]).execute();
  for (const f of allFiles) fileToConnector.set(f.id, f.connector_config_id);
  const allConfigs = await db.selectFrom("connector_configs").select(["id", "created_by"]).execute();
  for (const c of allConfigs) connectorOwners.set(c.id, c.created_by);

  function resolveTriggeredBy(indexedFileId: string | null): string {
    if (indexedFileId) {
      const cfg = fileToConnector.get(indexedFileId);
      if (cfg) {
        const owner = connectorOwners.get(cfg);
        if (owner) return owner;
      }
    }
    return opts.triggeredByUserId;
  }

  // Pre-load all facts ordered by fact_type so the in-memory loop respects the
  // fixed replay order (structural seeds → person seeds → people → parent refs).
  const orderRank = new Map<string, number>(FACT_REPLAY_ORDER.map((t, i) => [t, i]));
  const facts: FactRow[] = (
    await db
      .selectFrom("indexed_file_facts")
      .select([
        "id",
        "indexed_file_id",
        "source",
        "fact_type",
        "relation",
        "subject_name",
        "subject_email",
        "subject_source",
        "subject_source_id",
        "context_snippet",
        "raw",
      ])
      .execute()
  )
    .filter((f) => orderRank.has(f.fact_type))
    .sort((a, b) => (orderRank.get(a.fact_type) ?? 0) - (orderRank.get(b.fact_type) ?? 0));

  summary.factsRead = facts.length;

  for (const fact of facts) {
    try {
      if (fact.fact_type === "structural_seed") {
        await replayStructuralSeed(db, entityRepo, index, fact);
      } else if (fact.fact_type === "person_seed") {
        await replayPersonSeed(entityRepo, index, fact);
      } else if (fact.fact_type === "attendee" || fact.fact_type === "assignee" || fact.fact_type === "author") {
        await replayPersonFact(entityRepo, proposeDeps, index, fact, resolveTriggeredBy(fact.indexed_file_id), summary);
      } else if (fact.fact_type === "parent_entity") {
        await replayParentEntity(db, entityRepo, index, fact, summary);
      } else {
        summary.skipped++;
      }
    } catch (err) {
      logger.warn({ err, factId: fact.id, factType: fact.fact_type }, "Replay failed for fact");
      summary.skipped++;
    }
  }

  logger.info({ summary }, "Source-fact replay complete");
  return summary;
}

async function replayStructuralSeed(
  db: Kysely<DB>,
  entityRepo: ReturnType<typeof createEntityRepository>,
  index: LookupIndex,
  fact: FactRow,
): Promise<void> {
  const raw = readJsonObject(fact.raw);
  const subjectSource = fact.subject_source ?? fact.source;
  const subjectSourceId = fact.subject_source_id;
  if (!subjectSourceId || !fact.subject_name) return;

  // File-attached structural seed (promotable file → structural entity):
  // sourceType is `${connectorType}_${fileType}`, sourceRefId points at the
  // indexed file. File-less structural seed (onEntitySeed payload): use raw
  // seed shape — sourceType is provided by the caller of onEntitySeed.
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

  const entity = await entityRepo.upsertEntityFromTool({
    name: fact.subject_name,
    sourceType,
    source: subjectSource,
    sourceId: subjectSourceId,
    sourceUrl,
    sourceRefId: fact.indexed_file_id ?? undefined,
    metadata,
  });
  index.bySourceRef.set(`${subjectSource}:${subjectSourceId}`, entity as unknown as EntityRow);
}

async function replayPersonSeed(
  entityRepo: ReturnType<typeof createEntityRepository>,
  index: LookupIndex,
  fact: FactRow,
): Promise<void> {
  if (!fact.subject_name || !fact.subject_source || !fact.subject_source_id) return;
  const raw = readJsonObject(fact.raw);
  const subtype = raw.subtype === "internal" ? "internal" : "external";
  const entity = await entityRepo.upsertPersonEntity({
    name: fact.subject_name,
    email: fact.subject_email ?? undefined,
    subtype,
    source: fact.subject_source,
    sourceId: fact.subject_source_id,
  });
  index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity as unknown as EntityRow);
  registerPerson(index, entity as unknown as EntityRow);
}

const PERSON_FACT_RELATION = {
  attendee: "attended",
  assignee: "assigned",
  author: "authored",
} as const;

async function replayPersonFact(
  entityRepo: ReturnType<typeof createEntityRepository>,
  proposeDeps: {
    entityRepo: ReturnType<typeof createEntityRepository>;
    reviewRepo: ReturnType<typeof createEntityReviewRepo>;
    lookup: EntityLookup;
    readEmail: (e: Entity) => string | null;
  },
  index: LookupIndex,
  fact: FactRow,
  triggeredByUserId: string,
  summary: ReplayFactsSummary,
): Promise<void> {
  if (!fact.subject_name) {
    summary.skipped++;
    return;
  }
  const factType = fact.fact_type as keyof typeof PERSON_FACT_RELATION;
  const relation = PERSON_FACT_RELATION[factType];
  const subtype = fact.subject_email ? "external" : "external";

  let entity: EntityRow | null = null;
  if (fact.subject_source && fact.subject_source_id) {
    const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
    const cached = index.bySourceRef.get(refKey);
    if (cached) {
      entity = cached;
    }
  }

  if (!entity) {
    const source = fact.subject_source ?? fact.source;
    const sourceId =
      fact.subject_source_id ?? `${fact.indexed_file_id ?? "no-file"}:${fact.subject_email ?? fact.subject_name}`;
    const result = await proposeEntity(proposeDeps, {
      name: fact.subject_name,
      email: fact.subject_email ?? null,
      entityType: "person",
      subtype,
      source,
      sourceId,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
    });
    if (result.kind === "queued") {
      summary.queued++;
      return;
    }
    entity = result.entity as unknown as EntityRow;
    if (result.kind === "created") summary.entitiesCreated++;
    if (result.kind === "linked") summary.entitiesLinked++;
    registerPerson(index, entity);
    if (fact.subject_source && fact.subject_source_id) {
      index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity);
    }
  }

  if (!entity || !fact.indexed_file_id) return;
  await entityRepo.createMention({
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "EXTRACTED",
    source: `${fact.source}_${fact.fact_type}`,
    relation,
  });
  summary.mentionsWritten++;
}

async function replayParentEntity(
  db: Kysely<DB>,
  entityRepo: ReturnType<typeof createEntityRepository>,
  index: LookupIndex,
  fact: FactRow,
  summary: ReplayFactsSummary,
): Promise<void> {
  if (!fact.indexed_file_id || !fact.subject_source || !fact.subject_source_id) {
    summary.skipped++;
    return;
  }
  const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
  let entity = index.bySourceRef.get(refKey);
  if (!entity) {
    const found = await entityRepo.getEntityBySourceRef(fact.subject_source, fact.subject_source_id);
    if (found) {
      entity = found as unknown as EntityRow;
      index.bySourceRef.set(refKey, entity);
    }
  }
  if (!entity) {
    // The parent structural seed didn't replay — likely because the
    // structural_seed fact never landed for it. Skip rather than fabricate
    // a fresh entity from a parent-only reference (which would create
    // duplicates if the seed lands later).
    summary.skipped++;
    return;
  }
  await entityRepo.createMention({
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence: "EXTRACTED",
    source: `${fact.source}_parent_entity`,
    relation: "mentioned",
  });
  summary.mentionsWritten++;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 — Reset → replay → enrichment loop.
// ─────────────────────────────────────────────────────────────────────────

export interface RecreateSummary {
  reset: ResetSummary;
  replay: ReplayFactsSummary;
  enrichmentIterations: number;
  enrichment: EnrichmentResult;
}

export interface RecreateDeps {
  db: Kysely<DB>;
  logger: Logger;
  triggeredByUserId: string;
  /**
   * Cap on enrichment passes. At MAX_FILES_PER_RUN=5000, 20 iterations
   * covers up to 100k files. Tests override to 2–3.
   */
  maxIterations?: number;
  /**
   * Skip the LLM-driven enrichment path. Implemented by passing
   * `geminiApiKey: null` to `runEnrichment`, which short-circuits
   * `smartEnrichFile` and runs the deterministic path only.
   */
  skipLlm?: boolean;
  /**
   * Skip enrichment entirely — for tests that only validate replay.
   */
  skipEnrichment?: boolean;
  /**
   * Skip the reset phase — for callers that already invoked /reset and now
   * want to do replay + enrichment only.
   */
  skipReset?: boolean;
  lockAlreadyHeld?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 20;

async function countPendingEnrichmentFiles(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("indexed_files")
    .select(db.fn.countAll<number>().as("count"))
    .where("is_archived", "=", 0)
    .where((eb) =>
      eb.or([
        eb("embedding_status", "in", ["pending", "failed"]),
        eb.and([eb("embedding_status", "=", "done"), eb("summary_status", "in", ["pending", "failed"])]),
      ]),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function recreateEntityGraph(deps: RecreateDeps): Promise<RecreateSummary> {
  const { db, logger } = deps;
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const run = async () => {
    const reset = deps.skipReset
      ? {
          dryRun: false,
          deleted: {},
          filesMarkedPending: 0,
          warnings: ["Reset skipped — caller invoked /reset separately."],
        }
      : await resetDerivedEntityDataInner(db, logger);

    const replay = await replaySourceFacts(db, logger, { triggeredByUserId: deps.triggeredByUserId });

    if (deps.skipEnrichment) {
      return {
        reset,
        replay,
        enrichmentIterations: 0,
        enrichment: { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] },
      };
    }

    const settings = await db
      .selectFrom("settings")
      .select(["gemini_api_key"])
      .where("id", "=", "default")
      .executeTakeFirst();

    const effectiveKey = deps.skipLlm ? null : (settings?.gemini_api_key ?? null);
    const embeddingProvider = effectiveKey
      ? createEmbeddingProvider({ provider: "gemini", apiKey: effectiveKey })
      : null;

    let aggregated: EnrichmentResult = { filesProcessed: 0, filesSkipped: 0, filesFailed: 0, errors: [] };
    let iterations = 0;

    while (iterations < maxIterations) {
      const pending = await countPendingEnrichmentFiles(db);
      if (pending === 0) break;
      iterations++;
      // No `downloadImage` — recreate must not pull bytes from connector APIs.
      const result = await runEnrichment({
        db,
        logger: logger.child({ component: "recreate-enrichment", iteration: iterations }),
        embeddingProvider,
        geminiApiKey: effectiveKey,
      });
      aggregated = {
        filesProcessed: aggregated.filesProcessed + result.filesProcessed,
        filesSkipped: aggregated.filesSkipped + result.filesSkipped,
        filesFailed: aggregated.filesFailed + result.filesFailed,
        errors: [...aggregated.errors, ...result.errors],
      };
      if (result.filesProcessed === 0 && result.filesSkipped === 0 && result.filesFailed === 0) break;
    }

    return { reset, replay, enrichmentIterations: iterations, enrichment: aggregated };
  };

  return deps.lockAlreadyHeld ? run() : withRecreateLock(run);
}

/**
 * Reset implementation without the recreate-lock wrapper. Used internally by
 * `recreateEntityGraph`, which acquires the lock for the full phase chain.
 */
async function resetDerivedEntityDataInner(db: Kysely<DB>, logger: Logger): Promise<ResetSummary> {
  const deleted: Record<string, number> = {};
  for (const table of DERIVED_TABLES) deleted[table] = await countTable(db, table);
  const filesMarkedPending = await getPendingFileCount(db);
  const filesWithoutSourceFacts = await countFilesWithoutSourceFacts(db);
  const warnings = [
    `${deleted.entities ?? 0} entities will be deleted and recreated from durable facts/enrichment.`,
    `${deleted.entity_review_queue ?? 0} review-queue rows will be deleted.`,
    `${deleted.entity_alias_rejections ?? 0} alias rejections will be deleted; rejected aliases may be re-proposed after recreate.`,
  ];
  if (filesWithoutSourceFacts > 0) {
    warnings.push(
      `${filesWithoutSourceFacts} non-archived files have no persisted source facts; recreate can only recover content-derived graph data for them.`,
    );
  }

  const appliedDeleted: Record<string, number> = {};
  await db.transaction().execute(async (trx) => {
    for (const table of DERIVED_TABLES) appliedDeleted[table] = await deleteTable(trx, table);
    await markFilesPending(trx);
  });
  logger.warn({ deleted: appliedDeleted, filesMarkedPending }, "Derived entity data reset");
  return { dryRun: false, deleted: appliedDeleted, filesMarkedPending, warnings };
}

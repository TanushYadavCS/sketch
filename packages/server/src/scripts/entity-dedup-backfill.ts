import { parseArgs } from "node:util";
import type { Kysely, Selectable } from "kysely";
import { loadConfig, validateConfig } from "../config";
import { createGeminiGenerator } from "../connectors/gemini-generate";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB, EntitiesTable } from "../db/schema";
import {
  type AdjudicationGenerator,
  type EntityAdjudicationConfidence,
  adjudicateEntityMatch,
  buildEntityAdjudicationContext,
} from "../entities/adjudicate";
import { isTrustedPersonScopeKey, personScopeKey, personScopeKeyId } from "../entities/affiliations";
import { readPersonEmailFromMetadata } from "../entities/materialize-json";
import { mergeEntities, previewMerge } from "../entities/merge";
import { type CandidatePoolEntry, buildCandidatePool, findFuzzyMatches, normalizeStrict } from "../entities/name-dedup";
import type { ProposeEntityType } from "../entities/propose";
import { yieldToEventLoop } from "../lib/event-loop";

type Entity = Selectable<EntitiesTable>;

export interface EntityDedupBackfillOptions {
  execute?: boolean;
  userId: string;
  fuzzyThreshold?: number;
  sampleLimit?: number;
  batchSize?: number;
  useLlm?: boolean;
  /** Entity ids to leave untouched — any pair where either side matches is dropped. */
  excludeEntityIds?: string[];
  /** Structured generator for adjudication (Gemini in prod; a fake in tests). */
  generator?: AdjudicationGenerator;
}

export interface EntityDedupBackfillPair {
  entityType: string;
  survivorId: string;
  loserId: string;
  survivorName: string;
  loserName: string;
  reason: "strict" | "fuzzy" | "token-set" | "ambiguous" | "person_scope_missing" | "person_scope_mismatch";
  score: number;
}

export interface EntityDedupBackfillAdjudication {
  pair: EntityDedupBackfillPair;
  matchEntityId: string | null;
  confidence: EntityAdjudicationConfidence;
  reason: string;
}

export interface EntityDedupBackfillResult {
  mode: "dry-run" | "execute";
  autoMergeCandidates: EntityDedupBackfillPair[];
  queuedCandidates: EntityDedupBackfillPair[];
  adjudicated: EntityDedupBackfillAdjudication[];
  merged: EntityDedupBackfillPair[];
  queued: EntityDedupBackfillPair[];
  skipped: EntityDedupBackfillPair[];
  samples: {
    autoMerge: EntityDedupBackfillPair[];
    queue: EntityDedupBackfillPair[];
    adjudicated: EntityDedupBackfillAdjudication[];
  };
}

interface TypeScan {
  entityType: string;
  entities: Entity[];
  entries: CandidatePoolEntry[];
}

interface PersonScopes {
  byEntityId: Map<string, Set<string>>;
}

const SUPPORTED_TYPES: ProposeEntityType[] = ["person", "company", "product", "project", "team", "deal"];
const DEFAULT_FUZZY_THRESHOLD = 0.85;
const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_BATCH_SIZE = 100;
const BACKFILL_SOURCE = "entity_dedup_backfill";
const REASON_RANK: Record<EntityDedupBackfillPair["reason"], number> = {
  strict: 3,
  "token-set": 2,
  fuzzy: 1,
  ambiguous: 0,
  person_scope_missing: 0,
  person_scope_mismatch: 0,
};

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("\0");
}

function persistedPairKey(a: string, b: string): string {
  return [a, b].sort().map(encodeURIComponent).join("~");
}

function chooseSurvivor(a: Entity, b: Entity): { survivor: Entity; loser: Entity } {
  const sorted = [a, b].sort((left, right) => {
    if (right.hotness !== left.hotness) return right.hotness - left.hotness;
    if (left.status !== right.status) {
      if (left.status === "confirmed") return -1;
      if (right.status === "confirmed") return 1;
    }
    if (left.created_at !== right.created_at) return left.created_at.localeCompare(right.created_at);
    return left.id.localeCompare(right.id);
  });
  return { survivor: sorted[0], loser: sorted[1] };
}

function toPair(
  entityType: string,
  a: Entity,
  b: Entity,
  reason: EntityDedupBackfillPair["reason"],
  score: number,
): EntityDedupBackfillPair {
  const { survivor, loser } = chooseSurvivor(a, b);
  return {
    entityType,
    survivorId: survivor.id,
    loserId: loser.id,
    survivorName: survivor.name,
    loserName: loser.name,
    reason,
    score,
  };
}

async function loadTypeScans(db: Kysely<DB>): Promise<TypeScan[]> {
  const entities = await db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "in", SUPPORTED_TYPES)
    .where(whereLiveEntity())
    .execute();

  const byType = new Map<string, Entity[]>();
  for (const type of SUPPORTED_TYPES) byType.set(type, []);
  for (const entity of entities) byType.get(entity.source_type)?.push(entity);

  return [...byType].map(([entityType, rows]) => ({
    entityType,
    entities: rows,
    entries: rows.flatMap((entity) => [
      { entityId: entity.id, valueKind: "name" as const, value: entity.name },
      ...parseAliases(entity.aliases).map((value) => ({ entityId: entity.id, valueKind: "alias" as const, value })),
    ]),
  }));
}

async function buildPersonScopes(db: Kysely<DB>, persons: Entity[]): Promise<PersonScopes> {
  const domainsRepo = createEntityDomainsRepository(db);
  const byEntityId = new Map<string, Set<string>>();
  for (const person of persons) byEntityId.set(person.id, new Set());

  for (const person of persons) {
    const scope = await personScopeKey(readPersonEmailFromMetadata(person.metadata), domainsRepo);
    if (scope) byEntityId.get(person.id)?.add(personScopeKeyId(scope));
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
    byEntityId.get(row.source_entity_id)?.add(personScopeKeyId({ kind: "company", value: row.target_entity_id }));
  }

  return { byEntityId };
}

function classifyPersonStrictPair(pair: EntityDedupBackfillPair, scopes: PersonScopes): EntityDedupBackfillPair {
  const survivorScopes = scopes.byEntityId.get(pair.survivorId) ?? new Set();
  const loserScopes = scopes.byEntityId.get(pair.loserId) ?? new Set();
  const survivorTrusted = [...survivorScopes].filter(isTrustedPersonScopeKey);
  const loserTrusted = [...loserScopes].filter(isTrustedPersonScopeKey);
  if (survivorTrusted.length === 0 || loserTrusted.length === 0) return { ...pair, reason: "person_scope_missing" };
  if (survivorTrusted.some((scope) => loserScopes.has(scope))) return pair;
  return { ...pair, reason: "person_scope_mismatch" };
}

function addUniquePair(map: Map<string, EntityDedupBackfillPair>, pair: EntityDedupBackfillPair): void {
  const key = pairKey(pair.survivorId, pair.loserId);
  const existing = map.get(key);
  if (!existing || pair.score > existing.score) {
    map.set(key, pair);
    return;
  }
  if (pair.score === existing.score && REASON_RANK[pair.reason] > REASON_RANK[existing.reason]) map.set(key, pair);
}

async function discoverPairs(
  db: Kysely<DB>,
  scans: TypeScan[],
  opts: Required<Pick<EntityDedupBackfillOptions, "fuzzyThreshold" | "batchSize">>,
): Promise<{ autoMerge: EntityDedupBackfillPair[]; queue: EntityDedupBackfillPair[] }> {
  const autoMerge = new Map<string, EntityDedupBackfillPair>();
  const queue = new Map<string, EntityDedupBackfillPair>();
  const personScan = scans.find((scan) => scan.entityType === "person");
  const personScopes = personScan ? await buildPersonScopes(db, personScan.entities) : { byEntityId: new Map() };

  for (const scan of scans) {
    const entitiesById = new Map(scan.entities.map((entity) => [entity.id, entity]));
    const pool = buildCandidatePool(scan.entries);
    const seenExactPairKeys = new Set<string>();

    for (const bucket of pool.byStrictKey.values()) {
      const ids = [...new Set(bucket.map((entry) => entry.entityId))].sort();
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) seenExactPairKeys.add(pairKey(ids[i], ids[j]));
      }
      if (ids.length === 2) {
        const a = entitiesById.get(ids[0]);
        const b = entitiesById.get(ids[1]);
        if (!a || !b) continue;
        const pair =
          scan.entityType === "person"
            ? classifyPersonStrictPair(toPair(scan.entityType, a, b, "strict", 1), personScopes)
            : toPair(scan.entityType, a, b, "strict", 1);
        if (pair.reason === "strict") addUniquePair(autoMerge, pair);
        else addUniquePair(queue, pair);
        continue;
      }
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = entitiesById.get(ids[i]);
          const b = entitiesById.get(ids[j]);
          if (a && b) addUniquePair(queue, toPair(scan.entityType, a, b, "ambiguous", 1));
        }
      }
    }

    for (const bucket of pool.byTokenSetKey.values()) {
      const ids = [...new Set(bucket.map((entry) => entry.entityId))].sort();
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const key = pairKey(ids[i], ids[j]);
          if (seenExactPairKeys.has(key)) continue;
          const a = entitiesById.get(ids[i]);
          const b = entitiesById.get(ids[j]);
          if (!a || !b) continue;
          addUniquePair(queue, toPair(scan.entityType, a, b, ids.length === 2 ? "token-set" : "ambiguous", 1));
          seenExactPairKeys.add(key);
        }
      }
    }

    let scanned = 0;
    for (const entry of scan.entries) {
      scanned += 1;
      if (scanned % opts.batchSize === 0) await yieldToEventLoop();
      const entity = entitiesById.get(entry.entityId);
      if (!entity) continue;
      for (const match of findFuzzyMatches(entry.value, pool, { threshold: opts.fuzzyThreshold })) {
        if (match.entityId === entry.entityId) continue;
        if (seenExactPairKeys.has(pairKey(entry.entityId, match.entityId))) continue;
        const matched = entitiesById.get(match.entityId);
        if (!matched) continue;
        addUniquePair(queue, toPair(scan.entityType, entity, matched, "fuzzy", match.score));
      }
    }
  }

  return {
    autoMerge: [...autoMerge.values()].sort(sortPairs),
    queue: [...queue.values()].sort(sortPairs),
  };
}

function sortPairs(a: EntityDedupBackfillPair, b: EntityDedupBackfillPair): number {
  return (
    a.entityType.localeCompare(b.entityType) ||
    a.survivorName.localeCompare(b.survivorName) ||
    a.loserName.localeCompare(b.loserName) ||
    a.survivorId.localeCompare(b.survivorId) ||
    a.loserId.localeCompare(b.loserId)
  );
}

async function queuePair(db: Kysely<DB>, pair: EntityDedupBackfillPair, userId: string): Promise<void> {
  const reviewRepo = createEntityReviewRepo(db);
  await reviewRepo.upsertQueueRow({
    proposedName: pair.loserName,
    normalizedName: `${BACKFILL_SOURCE}:${pair.entityType}:${normalizeStrict(pair.survivorName || pair.loserName)}`,
    entityType: pair.entityType,
    source: BACKFILL_SOURCE,
    sourceId: persistedPairKey(pair.survivorId, pair.loserId),
    candidateEntityId: pair.reason === "ambiguous" ? null : pair.survivorId,
    candidateScore: pair.reason === "ambiguous" ? null : pair.score,
    candidateReason:
      pair.reason === "fuzzy" ? "minhash" : pair.reason === "token-set" ? "token-set" : "strict-normalized",
    triggeredByUserId: userId,
  });
}

async function resolveLiveEntity(db: Kysely<DB>, entityId: string): Promise<Entity | null> {
  const seen = new Set<string>();
  let currentId: string | null = entityId;

  while (currentId) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const row = await db.selectFrom("entities").selectAll().where("id", "=", currentId).executeTakeFirst();
    if (!row) return null;
    if (!row.deleted_at && !row.merged_into_entity_id) return row;
    currentId = row.merged_into_entity_id;
  }

  return null;
}

async function resolveQueuedPair(
  db: Kysely<DB>,
  pair: EntityDedupBackfillPair,
): Promise<EntityDedupBackfillPair | null> {
  const survivor = await resolveLiveEntity(db, pair.survivorId);
  const loser = await resolveLiveEntity(db, pair.loserId);
  if (!survivor || !loser || survivor.id === loser.id) return null;
  return {
    ...pair,
    survivorId: survivor.id,
    loserId: loser.id,
    survivorName: survivor.name,
    loserName: loser.name,
  };
}

async function adjudicatePair(
  db: Kysely<DB>,
  pair: EntityDedupBackfillPair,
  generator: AdjudicationGenerator,
): Promise<EntityDedupBackfillAdjudication> {
  const loserContext = await buildEntityAdjudicationContext(db, pair.loserId);
  const survivorContext = await buildEntityAdjudicationContext(db, pair.survivorId);
  const verdict = await adjudicateEntityMatch(generator, loserContext, [survivorContext]);
  return {
    pair,
    matchEntityId: verdict.matchEntityId,
    confidence: verdict.confidence,
    reason: verdict.reason,
  };
}

async function applyAutoMerges(
  db: Kysely<DB>,
  pairs: EntityDedupBackfillPair[],
  result: EntityDedupBackfillResult,
  options: EntityDedupBackfillOptions,
  mergedAway: Set<string>,
  batchSize: number,
): Promise<void> {
  let processed = 0;
  for (const pair of pairs) {
    if (pair.survivorId === pair.loserId || mergedAway.has(pair.survivorId) || mergedAway.has(pair.loserId)) {
      result.skipped.push(pair);
      continue;
    }
    processed += 1;
    const preview = await previewMerge(db, { survivorId: pair.survivorId, loserId: pair.loserId });
    if (preview.blocked) {
      result.skipped.push(pair);
      continue;
    }
    await mergeEntities(db, { survivorId: pair.survivorId, loserId: pair.loserId, userId: options.userId });
    mergedAway.add(pair.loserId);
    result.merged.push(pair);
    if (processed % batchSize === 0) await yieldToEventLoop();
  }
}

async function applyAdjudication(
  db: Kysely<DB>,
  adjudication: EntityDedupBackfillAdjudication,
  result: EntityDedupBackfillResult,
  options: EntityDedupBackfillOptions,
  mergedAway: Set<string>,
): Promise<boolean> {
  const pair = adjudication.pair;
  if (pair.survivorId === pair.loserId || mergedAway.has(pair.survivorId) || mergedAway.has(pair.loserId)) {
    result.skipped.push(pair);
    return true;
  }
  if (adjudication.confidence !== "high") return false;
  if (adjudication.matchEntityId === pair.survivorId) {
    const preview = await previewMerge(db, { survivorId: pair.survivorId, loserId: pair.loserId });
    if (preview.blocked) {
      result.skipped.push(pair);
      return true;
    }
    await mergeEntities(db, { survivorId: pair.survivorId, loserId: pair.loserId, userId: options.userId });
    mergedAway.add(pair.loserId);
    result.merged.push(pair);
    return true;
  }
  if (adjudication.matchEntityId === null) {
    const reviewRepo = createEntityReviewRepo(db);
    await reviewRepo.addRejection({
      entityId: pair.survivorId,
      rejectedName: pair.loserName,
      rejectedBy: options.userId,
    });
    await reviewRepo.addRejection({
      entityId: pair.loserId,
      rejectedName: pair.survivorName,
      rejectedBy: options.userId,
    });
    return true;
  }
  return false;
}

async function adjudicateCandidates(
  db: Kysely<DB>,
  result: EntityDedupBackfillResult,
  queueCandidates: EntityDedupBackfillPair[],
  generator: AdjudicationGenerator,
  sampleLimit: number,
  batchSize: number,
  mergedAway: Set<string>,
): Promise<void> {
  let processed = 0;
  for (const pair of queueCandidates) {
    if (pair.survivorId === pair.loserId || mergedAway.has(pair.survivorId) || mergedAway.has(pair.loserId)) {
      result.skipped.push(pair);
      continue;
    }
    const adjudication = await adjudicatePair(db, pair, generator);
    result.adjudicated.push(adjudication);
    result.samples.adjudicated = result.adjudicated.slice(0, sampleLimit);
    processed += 1;
    if (processed % batchSize === 0) await yieldToEventLoop();
  }
}

export async function runEntityDedupBackfill(
  db: Kysely<DB>,
  options: EntityDedupBackfillOptions,
): Promise<EntityDedupBackfillResult> {
  const execute = options.execute === true;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const useLlm = options.useLlm !== false;
  const scans = await loadTypeScans(db);
  const discovered = await discoverPairs(db, scans, { fuzzyThreshold, batchSize });
  const excludeIds = new Set(options.excludeEntityIds ?? []);
  const keepPair = (pair: EntityDedupBackfillPair): boolean =>
    !excludeIds.has(pair.survivorId) && !excludeIds.has(pair.loserId);
  const autoMerge = discovered.autoMerge.filter(keepPair);
  const queueCandidates = discovered.queue.filter(keepPair);
  const result: EntityDedupBackfillResult = {
    mode: execute ? "execute" : "dry-run",
    autoMergeCandidates: autoMerge,
    queuedCandidates: queueCandidates,
    adjudicated: [],
    merged: [],
    queued: [],
    skipped: [],
    samples: {
      autoMerge: autoMerge.slice(0, sampleLimit),
      queue: queueCandidates.slice(0, sampleLimit),
      adjudicated: [],
    },
  };

  const generator = options.generator;
  if (useLlm && generator && queueCandidates.length > 0) {
    if (!execute) {
      await adjudicateCandidates(db, result, queueCandidates, generator, sampleLimit, batchSize, new Set());
      return result;
    }
    const mergedAway = new Set<string>();
    await applyAutoMerges(db, autoMerge, result, options, mergedAway, batchSize);
    let processed = 0;
    for (const pair of queueCandidates) {
      const resolved = await resolveQueuedPair(db, pair);
      if (!resolved) {
        result.skipped.push(pair);
        continue;
      }
      const adjudication = await adjudicatePair(db, resolved, generator);
      result.adjudicated.push(adjudication);
      result.samples.adjudicated = result.adjudicated.slice(0, sampleLimit);
      const handled = await applyAdjudication(db, adjudication, result, options, mergedAway);
      if (!handled) {
        await queuePair(db, resolved, options.userId);
        result.queued.push(resolved);
      }
      processed += 1;
      if (processed % batchSize === 0) await yieldToEventLoop();
    }
    return result;
  }

  if (!execute) return result;

  const mergedAway = new Set<string>();
  await applyAutoMerges(db, autoMerge, result, options, mergedAway, batchSize);

  let processed = 0;
  for (const pair of queueCandidates) {
    if (pair.survivorId === pair.loserId || mergedAway.has(pair.survivorId) || mergedAway.has(pair.loserId)) {
      result.skipped.push(pair);
      continue;
    }
    processed += 1;
    const resolved = await resolveQueuedPair(db, pair);
    if (!resolved) {
      result.skipped.push(pair);
      if (processed % batchSize === 0) await yieldToEventLoop();
      continue;
    }
    await queuePair(db, resolved, options.userId);
    result.queued.push(resolved);
    if (processed % batchSize === 0) await yieldToEventLoop();
  }

  return result;
}

function printResult(result: EntityDedupBackfillResult): void {
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        autoMergeCandidates: result.autoMergeCandidates.length,
        queuedCandidates: result.queuedCandidates.length,
        adjudicated: result.adjudicated.length,
        merged: result.merged.length,
        queued: result.queued.length,
        skipped: result.skipped.length,
        samples: result.samples,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      "user-id": { type: "string", default: "entity-dedup-backfill" },
      "fuzzy-threshold": { type: "string", default: String(DEFAULT_FUZZY_THRESHOLD) },
      "sample-limit": { type: "string", default: String(DEFAULT_SAMPLE_LIMIT) },
      "exclude-entity": { type: "string" },
      "no-llm": { type: "boolean", default: false },
    },
  });
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);
  try {
    await runMigrations(db);
    const useLlm = parsed.values["no-llm"] !== true;
    let generator: AdjudicationGenerator | undefined;
    if (useLlm) {
      const settingsRow = await createSettingsRepository(db, config.ENCRYPTION_KEY).get();
      if (settingsRow?.gemini_api_key) {
        generator = createGeminiGenerator(settingsRow.gemini_api_key);
      } else {
        console.warn("No Gemini API key in settings; adjudication disabled — pairs fall back to the review queue.");
      }
    }
    const result = await runEntityDedupBackfill(db, {
      execute: parsed.values.execute,
      userId: parsed.values["user-id"],
      fuzzyThreshold: Number(parsed.values["fuzzy-threshold"]),
      sampleLimit: Number(parsed.values["sample-limit"]),
      useLlm,
      generator,
      excludeEntityIds: parsed.values["exclude-entity"]
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    });
    printResult(result);
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

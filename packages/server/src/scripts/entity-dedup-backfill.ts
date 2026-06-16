import { parseArgs } from "node:util";
import type { Kysely, Selectable } from "kysely";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB, EntitiesTable } from "../db/schema";
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
  /** Entity ids to leave untouched — any pair where either side matches is dropped. */
  excludeEntityIds?: string[];
}

export interface EntityDedupBackfillPair {
  entityType: string;
  survivorId: string;
  loserId: string;
  survivorName: string;
  loserName: string;
  reason: "strict" | "fuzzy" | "ambiguous" | "person_scope_missing" | "person_scope_mismatch";
  score: number;
}

export interface EntityDedupBackfillResult {
  mode: "dry-run" | "execute";
  autoMergeCandidates: EntityDedupBackfillPair[];
  queuedCandidates: EntityDedupBackfillPair[];
  merged: EntityDedupBackfillPair[];
  queued: EntityDedupBackfillPair[];
  skipped: EntityDedupBackfillPair[];
  samples: {
    autoMerge: EntityDedupBackfillPair[];
    queue: EntityDedupBackfillPair[];
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
  if (!existing || pair.score > existing.score) map.set(key, pair);
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
    const strictPairKeys = new Set<string>();

    for (const bucket of pool.byStrictKey.values()) {
      const ids = [...new Set(bucket.map((entry) => entry.entityId))].sort();
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          strictPairKeys.add(pairKey(ids[i], ids[j]));
        }
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

    let scanned = 0;
    for (const entry of scan.entries) {
      scanned += 1;
      if (scanned % opts.batchSize === 0) await yieldToEventLoop();
      const entity = entitiesById.get(entry.entityId);
      if (!entity) continue;
      for (const match of findFuzzyMatches(entry.value, pool, { threshold: opts.fuzzyThreshold })) {
        if (match.entityId === entry.entityId) continue;
        if (strictPairKeys.has(pairKey(entry.entityId, match.entityId))) continue;
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
    sourceId: pairKey(pair.survivorId, pair.loserId),
    candidateEntityId: pair.reason === "ambiguous" ? null : pair.survivorId,
    candidateScore: pair.reason === "ambiguous" ? null : pair.score,
    candidateReason: pair.reason === "fuzzy" ? "minhash" : "strict-normalized",
    triggeredByUserId: userId,
  });
}

export async function runEntityDedupBackfill(
  db: Kysely<DB>,
  options: EntityDedupBackfillOptions,
): Promise<EntityDedupBackfillResult> {
  const execute = options.execute === true;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
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
    merged: [],
    queued: [],
    skipped: [],
    samples: {
      autoMerge: autoMerge.slice(0, sampleLimit),
      queue: queueCandidates.slice(0, sampleLimit),
    },
  };

  if (!execute) return result;

  let processed = 0;
  for (const pair of autoMerge) {
    processed += 1;
    const preview = await previewMerge(db, { survivorId: pair.survivorId, loserId: pair.loserId });
    if (preview.blocked) {
      result.skipped.push(pair);
      continue;
    }
    await mergeEntities(db, { survivorId: pair.survivorId, loserId: pair.loserId, userId: options.userId });
    result.merged.push(pair);
    if (processed % batchSize === 0) await yieldToEventLoop();
  }

  for (const pair of queueCandidates) {
    processed += 1;
    await queuePair(db, pair, options.userId);
    result.queued.push(pair);
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
    },
  });
  const config = loadConfig();
  validateConfig(config);
  const db = await createDatabase(config);
  try {
    await runMigrations(db);
    const result = await runEntityDedupBackfill(db, {
      execute: parsed.values.execute,
      userId: parsed.values["user-id"],
      fuzzyThreshold: Number(parsed.values["fuzzy-threshold"]),
      sampleLimit: Number(parsed.values["sample-limit"]),
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

import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";

const DEFAULT_THRESHOLD = 3;
const CO_MENTION_SOURCE = "co_mention";
const CO_MENTION_RELATIONSHIP_TYPE = "contributes_to";
const CO_MENTION_CONFIDENCE = "INFERRED";
const CO_MENTION_NOTE_PREFIX = "co_mention:";

export type CoMentionSweepScope = { kind: "full" } | { kind: "files"; indexedFileIds: string[] };

export interface CoMentionSweepOptions {
  scope?: CoMentionSweepScope;
  threshold?: number;
}

export interface CoMentionSweepSummary {
  scannedPairs: number;
  upsertedRelationships: number;
  addedEvidence: number;
  removedEvidence: number;
  removedRelationships: number;
}

interface Pair {
  personEntityId: string;
  targetEntityId: string;
}

interface ManagedRelationship extends Pair {
  id: string;
}

interface CoMentionRow extends Pair {
  indexedFileId: string;
}

function pairKey(pair: Pair): string {
  return `${pair.personEntityId}\u0000${pair.targetEntityId}`;
}

function noteForPair(pair: Pair): string {
  return `${CO_MENTION_NOTE_PREFIX}${pair.personEntityId}:${pair.targetEntityId}`;
}

function evidenceKey(relationshipId: string, indexedFileId: string, note: string): string {
  return `note:${relationshipId}:${indexedFileId}:-1:${note}`;
}

function normalizeThreshold(threshold: number | undefined): number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return DEFAULT_THRESHOLD;
  return Math.max(2, Math.floor(threshold));
}

function confidenceScore(fileCount: number): number {
  return Math.min(0.84, 0.5 + 0.05 * fileCount);
}

async function queryCoMentionRows(
  db: Kysely<DB>,
  filter?: { personEntityIds?: string[]; targetEntityIds?: string[]; indexedFileIds?: string[] },
): Promise<CoMentionRow[]> {
  let query = db
    .selectFrom("entity_mentions as pm")
    .innerJoin("indexed_files as f", "f.id", "pm.indexed_file_id")
    .innerJoin("entities as p", "p.id", "pm.entity_id")
    .innerJoin("entity_mentions as tm", "tm.indexed_file_id", "pm.indexed_file_id")
    .innerJoin("entities as t", "t.id", "tm.entity_id")
    .select(["pm.entity_id as personEntityId", "tm.entity_id as targetEntityId", "pm.indexed_file_id as indexedFileId"])
    .where("p.source_type", "=", "person")
    .where("t.source_type", "in", ["project", "product"])
    .where(whereLiveEntity("p"))
    .where(whereLiveEntity("t"))
    .where("f.is_archived", "=", 0)
    .where("pm.confidence", "=", "EXTRACTED")
    .where("tm.confidence", "=", "EXTRACTED")
    .whereRef("pm.entity_id", "!=", "tm.entity_id");

  if (filter) {
    if (filter.personEntityIds) query = query.where("pm.entity_id", "in", filter.personEntityIds);
    if (filter.targetEntityIds) query = query.where("tm.entity_id", "in", filter.targetEntityIds);
    if (filter.indexedFileIds) query = query.where("pm.indexed_file_id", "in", filter.indexedFileIds);
  }

  return query.execute();
}

async function observedPairsForFiles(db: Kysely<DB>, indexedFileIds: string[]): Promise<Map<string, Pair>> {
  if (indexedFileIds.length === 0) return new Map();
  const rows = await queryCoMentionRows(db, { indexedFileIds });
  const pairs = new Map<string, Pair>();
  for (const row of rows) {
    const pair = { personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
    pairs.set(pairKey(pair), pair);
  }
  return pairs;
}

async function existingCoMentionPairsForFiles(db: Kysely<DB>, indexedFileIds: string[]): Promise<Map<string, Pair>> {
  if (indexedFileIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_relationship_evidence as ev")
    .innerJoin("entity_relationships as rel", "rel.id", "ev.relationship_id")
    .select(["rel.source_entity_id as personEntityId", "rel.target_entity_id as targetEntityId"])
    .where("ev.indexed_file_id", "in", indexedFileIds)
    .where("ev.source_fact_id", "is", null)
    .where("ev.note", "like", `${CO_MENTION_NOTE_PREFIX}%`)
    .where("rel.source", "=", CO_MENTION_SOURCE)
    .where("rel.relationship_type", "=", CO_MENTION_RELATIONSHIP_TYPE)
    .where("rel.confidence", "=", CO_MENTION_CONFIDENCE)
    .execute();
  const pairs = new Map<string, Pair>();
  for (const row of rows) {
    const pair = { personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
    pairs.set(pairKey(pair), pair);
  }
  return pairs;
}

async function candidatePairs(db: Kysely<DB>, scope: CoMentionSweepScope): Promise<Map<string, Pair> | null> {
  if (scope.kind === "full") return null;
  const pairs = await observedPairsForFiles(db, scope.indexedFileIds);
  const existing = await existingCoMentionPairsForFiles(db, scope.indexedFileIds);
  for (const [key, pair] of existing) pairs.set(key, pair);
  return pairs;
}

async function supportByPair(db: Kysely<DB>, candidates: Map<string, Pair> | null): Promise<Map<string, Set<string>>> {
  if (candidates && candidates.size === 0) return new Map();
  const rows = candidates
    ? await queryCoMentionRows(db, {
        personEntityIds: [...new Set([...candidates.values()].map((p) => p.personEntityId))],
        targetEntityIds: [...new Set([...candidates.values()].map((p) => p.targetEntityId))],
      })
    : await queryCoMentionRows(db);
  const support = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = pairKey(row);
    if (candidates && !candidates.has(key)) continue;
    const files = support.get(key);
    if (files) files.add(row.indexedFileId);
    else support.set(key, new Set([row.indexedFileId]));
  }
  return support;
}

async function managedRelationships(
  db: Kysely<DB>,
  candidates: Map<string, Pair> | null,
): Promise<Map<string, ManagedRelationship>> {
  let query = db
    .selectFrom("entity_relationships")
    .select(["id", "source_entity_id as personEntityId", "target_entity_id as targetEntityId"])
    .where("source", "=", CO_MENTION_SOURCE)
    .where("relationship_type", "=", CO_MENTION_RELATIONSHIP_TYPE)
    .where("confidence", "=", CO_MENTION_CONFIDENCE);

  if (candidates) {
    if (candidates.size === 0) return new Map();
    query = query
      .where("source_entity_id", "in", [...new Set([...candidates.values()].map((p) => p.personEntityId))])
      .where("target_entity_id", "in", [...new Set([...candidates.values()].map((p) => p.targetEntityId))]);
  }

  const rows = await query.execute();
  const relationships = new Map<string, ManagedRelationship>();
  for (const row of rows) {
    const relationship = { id: row.id, personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
    const key = pairKey(relationship);
    if (!candidates || candidates.has(key)) relationships.set(key, relationship);
  }
  return relationships;
}

async function directRelationshipKeys(db: Kysely<DB>, pairs: Pair[]): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await db
    .selectFrom("entity_relationships")
    .select(["source_entity_id as personEntityId", "target_entity_id as targetEntityId"])
    .where("relationship_type", "=", CO_MENTION_RELATIONSHIP_TYPE)
    .where("source", "!=", CO_MENTION_SOURCE)
    .where("source_entity_id", "in", [...new Set(pairs.map((p) => p.personEntityId))])
    .where("target_entity_id", "in", [...new Set(pairs.map((p) => p.targetEntityId))])
    .execute();
  return new Set(rows.map((row) => pairKey(row)));
}

export async function sweepCoMentionContributesTo(
  db: Kysely<DB>,
  logger: Logger,
  opts: CoMentionSweepOptions = {},
): Promise<CoMentionSweepSummary> {
  const threshold = normalizeThreshold(opts.threshold);
  const scope = opts.scope ?? { kind: "full" };
  const candidates = await candidatePairs(db, scope);
  const support = await supportByPair(db, candidates);
  const managed = await managedRelationships(db, candidates);
  const scannedPairs = candidates ? candidates.size : support.size;
  const pairValues = candidates
    ? [...candidates.values()]
    : [...support.keys()].map((key) => {
        const [personEntityId, targetEntityId] = key.split("\u0000");
        return { personEntityId, targetEntityId };
      });
  const directKeys = await directRelationshipKeys(db, pairValues);
  const domainsRepo = createEntityDomainsRepository(db);
  const keepEvidenceKeys = new Set<string>();
  const touchedManagedRelationshipIds = new Set<string>([...managed.values()].map((rel) => rel.id));
  let upsertedRelationships = 0;
  let addedEvidence = 0;

  for (const pair of pairValues) {
    const key = pairKey(pair);
    if (directKeys.has(key)) continue;
    const files = support.get(key) ?? new Set<string>();
    if (files.size < threshold) continue;
    const relationshipId = await domainsRepo.upsertRelationship({
      sourceEntityId: pair.personEntityId,
      targetEntityId: pair.targetEntityId,
      relationshipType: CO_MENTION_RELATIONSHIP_TYPE,
      confidence: CO_MENTION_CONFIDENCE,
      confidenceScore: confidenceScore(files.size),
      source: CO_MENTION_SOURCE,
    });
    upsertedRelationships++;
    touchedManagedRelationshipIds.add(relationshipId);
    const note = noteForPair(pair);
    for (const indexedFileId of files) {
      await domainsRepo.addEvidence({
        relationshipId,
        indexedFileId,
        chunkIndex: -1,
        note,
        sourceFactId: null,
      });
      keepEvidenceKeys.add(evidenceKey(relationshipId, indexedFileId, note));
      addedEvidence++;
    }
  }

  const removedEvidence = await domainsRepo.deleteCoMentionEvidenceForRelationships(
    [...touchedManagedRelationshipIds],
    keepEvidenceKeys,
  );
  const removedRelationships = await domainsRepo.cleanupEmptyRelationships();
  logger.debug(
    { scope: scope.kind, scannedPairs, upsertedRelationships, addedEvidence, removedEvidence, removedRelationships },
    "Co-mention contributes_to sweep complete",
  );
  return { scannedPairs, upsertedRelationships, addedEvidence, removedEvidence, removedRelationships };
}

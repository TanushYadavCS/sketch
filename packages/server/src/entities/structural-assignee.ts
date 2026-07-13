import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { forEachChunk } from "../connectors/sync-utils";
import { whereLiveEntity } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { TEST_ACCOUNT_ENTITY_ID } from "../db/repositories/tasks";
import type { DB } from "../db/schema";

const STRUCTURAL_ASSIGNEE_SOURCE = "structural_assignee";
const STRUCTURAL_ASSIGNEE_RELATIONSHIP_TYPE = "contributes_to";
const STRUCTURAL_ASSIGNEE_CONFIDENCE = "INFERRED";
const STRUCTURAL_ASSIGNEE_CONFIDENCE_SCORE = 0.9;
const STRUCTURAL_ASSIGNEE_NOTE_PREFIX = "structural_assignee:";

export type StructuralAssigneeScope =
  | { kind: "full" }
  | { kind: "files"; indexedFileIds: string[] }
  | { kind: "tasks"; taskIds: string[] };

export interface StructuralAssigneeOptions {
  scope?: StructuralAssigneeScope;
}

export interface StructuralAssigneeSummary {
  scannedPairs: number;
  upsertedRelationships: number;
  addedEvidence: number;
  removedEvidence: number;
  removedCoMentionEvidence: number;
  removedRelationships: number;
}

interface Pair {
  personEntityId: string;
  targetEntityId: string;
}

interface StructuralTaskRow extends Pair {
  taskId: string;
  indexedFileId: string;
}

interface ManagedRelationship extends Pair {
  id: string;
}

function pairKey(pair: Pair): string {
  return `${pair.personEntityId}\u0000${pair.targetEntityId}`;
}

function noteForTask(taskId: string): string {
  return `${STRUCTURAL_ASSIGNEE_NOTE_PREFIX}task:${taskId}`;
}

function evidenceKey(relationshipId: string, indexedFileId: string, note: string): string {
  return `note:${relationshipId}:${indexedFileId}:-1:${note}`;
}

async function queryStructuralTaskRows(
  db: Kysely<DB>,
  filter?: {
    indexedFileIds?: string[];
    taskIds?: string[];
    personEntityIds?: string[];
    targetEntityIds?: string[];
  },
): Promise<StructuralTaskRow[]> {
  if (filter?.indexedFileIds?.length === 0) return [];
  if (filter?.taskIds?.length === 0) return [];
  if (filter?.personEntityIds?.length === 0) return [];
  if (filter?.targetEntityIds?.length === 0) return [];

  let query = db
    .selectFrom("tasks as t")
    .innerJoin("entities as assignee", "assignee.id", "t.assignee_entity_id")
    .innerJoin("entities as parent", "parent.id", "t.parent_entity_id")
    .innerJoin("task_evidence as te", "te.task_id", "t.id")
    .innerJoin("indexed_files as f", "f.id", "te.ref_id")
    .select([
      "t.id as taskId",
      "t.assignee_entity_id as personEntityId",
      "t.parent_entity_id as targetEntityId",
      "te.ref_id as indexedFileId",
    ])
    .where("t.provenance", "=", "structural")
    .where("t.valid_to", "is", null)
    .where("t.assignee_entity_id", "is not", null)
    .where("t.parent_entity_id", "is not", null)
    .where("assignee.source_type", "=", "person")
    .where("assignee.id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity("assignee"))
    .where("parent.source_type", "=", "project")
    .where("parent.id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity("parent"))
    .where("te.kind", "=", "file")
    .where("f.is_archived", "=", 0);

  if (filter?.indexedFileIds) query = query.where("te.ref_id", "in", filter.indexedFileIds);
  if (filter?.taskIds) query = query.where("t.id", "in", filter.taskIds);
  if (filter?.personEntityIds) query = query.where("t.assignee_entity_id", "in", filter.personEntityIds);
  if (filter?.targetEntityIds) query = query.where("t.parent_entity_id", "in", filter.targetEntityIds);

  const rows = await query.execute();
  return rows.flatMap((row) =>
    row.personEntityId && row.targetEntityId
      ? [
          {
            taskId: row.taskId,
            personEntityId: row.personEntityId,
            targetEntityId: row.targetEntityId,
            indexedFileId: row.indexedFileId,
          },
        ]
      : [],
  );
}

async function observedPairsForFiles(db: Kysely<DB>, indexedFileIds: string[]): Promise<Map<string, Pair>> {
  const pairs = new Map<string, Pair>();
  await forEachChunk(indexedFileIds, async (batch) => {
    const rows = await queryStructuralTaskRows(db, { indexedFileIds: batch });
    for (const [key, pair] of pairsFromRows(rows)) pairs.set(key, pair);
  });
  return pairs;
}

async function observedPairsForTasks(db: Kysely<DB>, taskIds: string[]): Promise<Map<string, Pair>> {
  const rows = await queryStructuralTaskRows(db, { taskIds });
  return pairsFromRows(rows);
}

function pairsFromRows(rows: StructuralTaskRow[]): Map<string, Pair> {
  const pairs = new Map<string, Pair>();
  for (const row of rows) {
    const pair = { personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
    pairs.set(pairKey(pair), pair);
  }
  return pairs;
}

async function existingStructuralPairsForFiles(db: Kysely<DB>, indexedFileIds: string[]): Promise<Map<string, Pair>> {
  const pairs = new Map<string, Pair>();
  await forEachChunk(indexedFileIds, async (batch) => {
    const rows = await db
      .selectFrom("entity_relationship_evidence as ev")
      .innerJoin("entity_relationships as rel", "rel.id", "ev.relationship_id")
      .select(["rel.source_entity_id as personEntityId", "rel.target_entity_id as targetEntityId"])
      .where("ev.indexed_file_id", "in", batch)
      .where("ev.note", "like", `${STRUCTURAL_ASSIGNEE_NOTE_PREFIX}%`)
      .where("rel.source", "=", STRUCTURAL_ASSIGNEE_SOURCE)
      .where("rel.relationship_type", "=", STRUCTURAL_ASSIGNEE_RELATIONSHIP_TYPE)
      .where("rel.confidence", "=", STRUCTURAL_ASSIGNEE_CONFIDENCE)
      .where("rel.valid_from", "=", "")
      .execute();
    for (const row of rows) {
      const pair = { personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
      pairs.set(pairKey(pair), pair);
    }
  });
  return pairs;
}

async function existingStructuralPairsForTasks(db: Kysely<DB>, taskIds: string[]): Promise<Map<string, Pair>> {
  if (taskIds.length === 0) return new Map();
  const notes = taskIds.map(noteForTask);
  const rows = await db
    .selectFrom("entity_relationship_evidence as ev")
    .innerJoin("entity_relationships as rel", "rel.id", "ev.relationship_id")
    .select(["rel.source_entity_id as personEntityId", "rel.target_entity_id as targetEntityId"])
    .where("ev.note", "in", notes)
    .where("rel.source", "=", STRUCTURAL_ASSIGNEE_SOURCE)
    .where("rel.relationship_type", "=", STRUCTURAL_ASSIGNEE_RELATIONSHIP_TYPE)
    .where("rel.confidence", "=", STRUCTURAL_ASSIGNEE_CONFIDENCE)
    .where("rel.valid_from", "=", "")
    .execute();
  const pairs = new Map<string, Pair>();
  for (const row of rows) {
    const pair = { personEntityId: row.personEntityId, targetEntityId: row.targetEntityId };
    pairs.set(pairKey(pair), pair);
  }
  return pairs;
}

async function candidatePairs(db: Kysely<DB>, scope: StructuralAssigneeScope): Promise<Map<string, Pair> | null> {
  if (scope.kind === "full") return null;
  const pairs =
    scope.kind === "files"
      ? await observedPairsForFiles(db, scope.indexedFileIds)
      : await observedPairsForTasks(db, scope.taskIds);
  const existing =
    scope.kind === "files"
      ? await existingStructuralPairsForFiles(db, scope.indexedFileIds)
      : await existingStructuralPairsForTasks(db, scope.taskIds);
  for (const [key, pair] of existing) pairs.set(key, pair);
  return pairs;
}

async function supportByPair(
  db: Kysely<DB>,
  candidates: Map<string, Pair> | null,
): Promise<Map<string, StructuralTaskRow[]>> {
  if (candidates && candidates.size === 0) return new Map();
  const rows = candidates
    ? await queryStructuralTaskRows(db, {
        personEntityIds: [...new Set([...candidates.values()].map((p) => p.personEntityId))],
        targetEntityIds: [...new Set([...candidates.values()].map((p) => p.targetEntityId))],
      })
    : await queryStructuralTaskRows(db);
  const support = new Map<string, StructuralTaskRow[]>();
  for (const row of rows) {
    const key = pairKey(row);
    if (candidates && !candidates.has(key)) continue;
    const existing = support.get(key);
    if (existing) existing.push(row);
    else support.set(key, [row]);
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
    .where("source", "=", STRUCTURAL_ASSIGNEE_SOURCE)
    .where("relationship_type", "=", STRUCTURAL_ASSIGNEE_RELATIONSHIP_TYPE)
    .where("confidence", "=", STRUCTURAL_ASSIGNEE_CONFIDENCE)
    .where("valid_from", "=", "");

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

export async function reconcileStructuralAssigneeContributesTo(
  db: Kysely<DB>,
  logger: Logger,
  opts: StructuralAssigneeOptions = {},
): Promise<StructuralAssigneeSummary> {
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
  const domainsRepo = createEntityDomainsRepository(db);
  const keepEvidenceKeys = new Set<string>();
  const touchedManagedRelationshipIds = new Set<string>([...managed.values()].map((rel) => rel.id));
  const upsertedRelationshipIds = new Set<string>();
  let upsertedRelationships = 0;
  let addedEvidence = 0;

  for (const pair of pairValues) {
    const rows = support.get(pairKey(pair)) ?? [];
    if (rows.length === 0) continue;
    const relationshipId = await domainsRepo.upsertRelationship({
      sourceEntityId: pair.personEntityId,
      targetEntityId: pair.targetEntityId,
      relationshipType: STRUCTURAL_ASSIGNEE_RELATIONSHIP_TYPE,
      confidence: STRUCTURAL_ASSIGNEE_CONFIDENCE,
      confidenceScore: STRUCTURAL_ASSIGNEE_CONFIDENCE_SCORE,
      source: STRUCTURAL_ASSIGNEE_SOURCE,
      validFrom: "",
    });
    upsertedRelationships++;
    touchedManagedRelationshipIds.add(relationshipId);
    upsertedRelationshipIds.add(relationshipId);
    for (const row of rows) {
      const note = noteForTask(row.taskId);
      await domainsRepo.addEvidence({
        relationshipId,
        indexedFileId: row.indexedFileId,
        chunkIndex: -1,
        note,
        sourceFactId: null,
      });
      keepEvidenceKeys.add(evidenceKey(relationshipId, row.indexedFileId, note));
      addedEvidence++;
    }
  }

  const removedCoMentionEvidence = await domainsRepo.deleteCoMentionEvidenceForRelationships([
    ...upsertedRelationshipIds,
  ]);
  const removedEvidence = await domainsRepo.deleteStructuralAssigneeEvidenceForRelationships(
    [...touchedManagedRelationshipIds],
    keepEvidenceKeys,
  );
  const removedRelationships = await domainsRepo.cleanupEmptyRelationships();
  logger.debug(
    {
      scope: scope.kind,
      scannedPairs,
      upsertedRelationships,
      addedEvidence,
      removedEvidence,
      removedCoMentionEvidence,
      removedRelationships,
    },
    "Structural assignee contributes_to reconciliation complete",
  );
  return {
    scannedPairs,
    upsertedRelationships,
    addedEvidence,
    removedEvidence,
    removedCoMentionEvidence,
    removedRelationships,
  };
}

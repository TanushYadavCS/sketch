import type { Kysely } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { CommitmentSeed, IndexedFileFactRaw } from "../../connectors/types";
import type { DB, IndexedFileFactsTable } from "../schema";
import {
  type IndexedFileFactRelation,
  type IndexedFileFactType,
  createIndexedFileFactRepository,
} from "./indexed-file-facts";
import { type SubEntityRow, createSubEntityRepository } from "./sub-entities";

export type CommitmentStatus = "open" | "done" | "dropped";

export interface CommitmentFactRaw extends CommitmentSeed {
  parent_entity_id?: string;
}

export interface UpsertCommitmentFactInput {
  experimentalFlag?: boolean;
  indexedFileId?: string | null;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  commitmentId: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  title: string;
  status?: CommitmentStatus;
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  contextSnippet?: string | null;
}

export interface OpenCommitment {
  factId: string;
  commitmentId: string;
  parentEntityId: string | null;
  title: string;
  status: "open";
  dueAt: string | null;
  evidence: { fileIds: string[]; entityIds: string[] };
  raw: CommitmentFactRaw;
}

export interface MeasureCommitmentStompInput {
  overwriteCohort: string[];
  tombstoneCohort: string[];
  priorSyncRunId: string;
  nextSyncRunId: string;
}

export interface MeasureCommitmentStompResult {
  overwritten: number;
  tombstoned: number;
  survived: number;
  reconcileSkipped: boolean;
}

export async function upsertCommitmentFact(
  db: Kysely<DB>,
  input: UpsertCommitmentFactInput,
): Promise<{ emitted: boolean }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const commitmentId = requireNonEmpty(input.commitmentId, "commitmentId");
  if (!input.experimentalFlag) return { emitted: false };

  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.indexedFileId ?? null,
    connectorConfigId,
    createdByUserId: input.createdByUserId ?? null,
    lastSeenSyncRunId: input.lastSeenSyncRunId ?? null,
    contentHash: input.contentHash ?? null,
    source,
    factType: "commitment",
    relation: "mentioned",
    subjectName: input.title,
    subjectSource: source,
    subjectSourceId: commitmentId,
    contextSnippet: input.contextSnippet ?? null,
    raw: buildCommitmentRaw(input, commitmentId),
  });
  return { emitted: true };
}

export async function markCommitmentDone(db: Kysely<DB>, commitmentId: string): Promise<boolean> {
  const fact = await findActiveCommitmentFact(db, commitmentId);
  if (!fact) return false;
  const raw = readCommitmentRaw(fact.raw);
  if (!raw) return false;
  const repo = createSubEntityRepository(db);
  const subEntityId = await findCommitmentSubEntityIdByFact(db, fact.id);
  if (subEntityId) return repo.markSubEntityStatus(subEntityId, "done");
  const fallback = await findCommitmentSubEntityByScopeAndName(db, readParentEntityId(raw), raw.title);
  if (!fallback) return false;
  return repo.markSubEntityStatus(fallback.id, "done");
}

export async function listOpenCommitments(
  db: Kysely<DB>,
  opts: { parentEntityId?: string | null } = {},
): Promise<OpenCommitment[]> {
  const rows = await createSubEntityRepository(db).listOpenSubEntities({
    parentEntityId: opts.parentEntityId,
    kind: "commitment",
  });
  const out: OpenCommitment[] = [];
  for (const row of rows) {
    const fact = await findSubEntityCommitmentFact(db, row.id);
    const raw = readCommitmentRaw(fact?.raw ?? null);
    if (!fact || !raw) continue;
    out.push({
      factId: fact.id,
      commitmentId: raw.commitmentId,
      parentEntityId: row.parent_entity_id,
      title: raw.title,
      status: "open",
      dueAt: row.due_at,
      evidence: raw.evidence,
      raw,
    });
  }
  return out;
}

export async function measureCommitmentStomp(
  db: Kysely<DB>,
  connectorConfigId: string,
  input: MeasureCommitmentStompInput,
): Promise<MeasureCommitmentStompResult> {
  requireNonEmpty(connectorConfigId, "connectorConfigId");
  assertDisjoint(input.overwriteCohort, input.tombstoneCohort);
  const repo = createIndexedFileFactRepository(db);
  const overwriteSet = new Set(input.overwriteCohort);
  const tombstoneSet = new Set(input.tombstoneCohort);
  const allIds = [...overwriteSet, ...tombstoneSet];

  for (const commitmentId of allIds) {
    await markCommitmentDone(db, commitmentId);
  }
  if (input.tombstoneCohort.length > 0) {
    await db
      .updateTable("indexed_file_facts")
      .set({ last_seen_sync_run_id: input.priorSyncRunId, updated_at: new Date().toISOString() })
      .where("connector_config_id", "=", connectorConfigId)
      .where("fact_type", "=", "commitment")
      .where("subject_source_id", "in", input.tombstoneCohort)
      .execute();
  }

  const overwriteFacts = await selectCommitmentFacts(db, connectorConfigId, input.overwriteCohort);
  for (const fact of overwriteFacts) {
    const raw = readCommitmentRaw(fact.raw);
    if (!raw) continue;
    await repo.upsertFact({
      indexedFileId: fact.indexed_file_id,
      connectorConfigId,
      createdByUserId: fact.created_by_user_id,
      lastSeenSyncRunId: input.nextSyncRunId,
      contentHash: fact.content_hash,
      source: fact.source,
      factType: "commitment",
      relation: "mentioned",
      subjectName: fact.subject_name,
      subjectSource: fact.subject_source,
      subjectSourceId: fact.subject_source_id,
      contextSnippet: fact.context_snippet,
      raw: { ...raw, status: "open" },
    });
  }

  const otherFacts = await selectOtherActiveFacts(db, connectorConfigId, allIds, input.tombstoneCohort.length);
  for (const fact of otherFacts) {
    const raw = readRaw(fact.raw);
    await repo.upsertFact({
      indexedFileId: fact.indexed_file_id,
      connectorConfigId,
      createdByUserId: fact.created_by_user_id,
      lastSeenSyncRunId: input.nextSyncRunId,
      contentHash: fact.content_hash,
      source: fact.source,
      factType: fact.fact_type as IndexedFileFactType,
      relation: fact.relation as IndexedFileFactRelation,
      subjectName: fact.subject_name,
      subjectEmail: fact.subject_email,
      subjectSource: fact.subject_source,
      subjectSourceId: fact.subject_source_id,
      contextSnippet: fact.context_snippet,
      raw,
    });
  }

  const reconcile = await repo.reconcileStaleFacts(
    { kind: "connector", connectorConfigId, syncRunId: input.nextSyncRunId },
    null,
  );
  const after = await selectCommitmentFacts(db, connectorConfigId, allIds);
  const afterById = new Map(after.map((fact) => [fact.subject_source_id, fact]));
  let overwritten = 0;
  let tombstoned = 0;
  let survived = 0;
  for (const commitmentId of input.overwriteCohort) {
    const fact = afterById.get(commitmentId);
    const raw = readCommitmentRaw(fact?.raw ?? null);
    if (fact && raw?.status === "open") overwritten++;
    if (fact && raw?.status === "done" && fact.deleted_at === null) survived++;
  }
  for (const commitmentId of input.tombstoneCohort) {
    const fact = afterById.get(commitmentId);
    const raw = readCommitmentRaw(fact?.raw ?? null);
    if (fact?.deleted_at !== null && fact?.deleted_at !== undefined) tombstoned++;
    if (fact && raw?.status === "done" && fact.deleted_at === null) survived++;
  }
  return {
    overwritten,
    tombstoned,
    survived,
    reconcileSkipped: reconcile.skipped?.reason === "delta_exceeds_threshold",
  };
}

function buildCommitmentRaw(input: UpsertCommitmentFactInput, commitmentId: string): CommitmentFactRaw {
  return {
    commitmentId,
    parentRef: input.parentRef,
    parentEntityId: input.parentEntityId,
    title: input.title,
    status: input.status ?? "open",
    dueAt: input.dueAt,
    evidence: input.evidence,
  };
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`commitment ${name} is required`);
  return trimmed;
}

async function findActiveCommitmentFact(db: Kysely<DB>, commitmentId: string) {
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("fact_type", "=", "commitment")
    .where("subject_source_id", "=", commitmentId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

async function findCommitmentSubEntityIdByFact(db: Kysely<DB>, factId: string): Promise<string | null> {
  const row = await db
    .selectFrom("sub_entity_evidence")
    .innerJoin("sub_entities", "sub_entities.id", "sub_entity_evidence.sub_entity_id")
    .select("sub_entities.id")
    .where("sub_entity_evidence.kind", "=", "fact")
    .where("sub_entity_evidence.ref_id", "=", factId)
    .where("sub_entities.kind", "=", "commitment")
    .where("sub_entities.valid_to", "is", null)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function findCommitmentSubEntityByScopeAndName(
  db: Kysely<DB>,
  parentEntityId: string | null,
  title: string,
): Promise<SubEntityRow | undefined> {
  return db
    .selectFrom("sub_entities")
    .selectAll()
    .where("parent_scope_key", "=", parentEntityId ?? "global")
    .where("kind", "=", "commitment")
    .where("normalized_name", "=", normalizeName(title))
    .where("valid_to", "is", null)
    .executeTakeFirst();
}

async function findSubEntityCommitmentFact(db: Kysely<DB>, subEntityId: string) {
  return db
    .selectFrom("sub_entity_evidence")
    .innerJoin("indexed_file_facts", "indexed_file_facts.id", "sub_entity_evidence.ref_id")
    .selectAll("indexed_file_facts")
    .where("sub_entity_evidence.sub_entity_id", "=", subEntityId)
    .where("sub_entity_evidence.kind", "=", "fact")
    .where("indexed_file_facts.fact_type", "=", "commitment")
    .where("indexed_file_facts.deleted_at", "is", null)
    .orderBy("indexed_file_facts.updated_at", "desc")
    .executeTakeFirst();
}

async function selectCommitmentFacts(db: Kysely<DB>, connectorConfigId: string, commitmentIds: string[]) {
  if (commitmentIds.length === 0) return [];
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .where("fact_type", "=", "commitment")
    .where("subject_source_id", "in", commitmentIds)
    .execute();
}

async function selectOtherActiveFacts(
  db: Kysely<DB>,
  connectorConfigId: string,
  excludedCommitmentIds: string[],
  minimum: number,
) {
  if (minimum === 0) return [];
  const rows = await db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .where("deleted_at", "is", null)
    .execute();
  return rows
    .filter(
      (row) =>
        row.fact_type !== "commitment" ||
        !row.subject_source_id ||
        !excludedCommitmentIds.includes(row.subject_source_id),
    )
    .slice(0, minimum);
}

function assertDisjoint(left: string[], right: string[]): void {
  const seen = new Set(left);
  for (const value of right) {
    if (seen.has(value)) throw new Error("overwriteCohort and tombstoneCohort must be disjoint");
  }
}

function readRaw(raw: string | null): IndexedFileFactRaw | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as IndexedFileFactRaw;
  return parsed;
}

function readCommitmentRaw(raw: string | null): CommitmentFactRaw | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CommitmentFactRaw>;
    if (
      typeof parsed.commitmentId !== "string" ||
      typeof parsed.title !== "string" ||
      (parsed.status !== "open" && parsed.status !== "done" && parsed.status !== "dropped") ||
      !parsed.evidence ||
      !Array.isArray(parsed.evidence.fileIds) ||
      !Array.isArray(parsed.evidence.entityIds)
    ) {
      return null;
    }
    return parsed as CommitmentFactRaw;
  } catch {
    return null;
  }
}

function readParentEntityId(raw: CommitmentFactRaw): string | null {
  return raw.parentEntityId ?? raw.parent_entity_id ?? null;
}

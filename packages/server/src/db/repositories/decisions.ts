import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DecisionSeed } from "../../connectors/types";
import type { DB, IndexedFileFactsTable } from "../schema";
import { buildIndexedFileFactKey, createIndexedFileFactRepository } from "./indexed-file-facts";
import { type SubEntityRow, createSubEntityRepository } from "./sub-entities";

const DECISION_ID_SEPARATOR = "\u001f";

export interface DecisionFactRaw extends DecisionSeed {
  decisionId: string;
}

export interface UpsertDecisionFactInput {
  experimentalFlag?: boolean;
  indexedFileId: string;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  decisionId?: string;
  topic: string;
  statement: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  decidedBy?: string;
  decidedAt?: string;
  rationale?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  promptVersion?: string;
  contextSnippet?: string | null;
}

export interface UpsertDecisionFactsForFileInput {
  experimentalFlag?: boolean;
  indexedFileId: string;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  decisions: DecisionSeed[];
  contextSnippet?: string | null;
}

export interface CurrentDecision {
  factId: string;
  decisionId: string;
  parentEntityId: string;
  topic: string;
  statement: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rationale: string | null;
  evidence: { fileIds: string[]; entityIds: string[] };
  raw: DecisionFactRaw;
  row: SubEntityRow;
}

export async function upsertDecisionFact(
  db: Kysely<DB>,
  input: UpsertDecisionFactInput,
): Promise<{ emitted: boolean; factKey?: string; decisionId?: string }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const decisionId = requireNonEmpty(
    input.decisionId ?? buildDecisionId(input.indexedFileId, input.topic, input.statement),
    "decisionId",
  );
  if (!input.experimentalFlag) return { emitted: false };

  const raw: DecisionFactRaw = {
    decisionId,
    topic: input.topic,
    statement: input.statement,
    parentRef: input.parentRef,
    parentEntityId: input.parentEntityId,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt,
    rationale: input.rationale,
    evidence: input.evidence,
    promptVersion: input.promptVersion,
  };
  const factInput = {
    indexedFileId: input.indexedFileId,
    connectorConfigId,
    createdByUserId: input.createdByUserId ?? null,
    lastSeenSyncRunId: input.lastSeenSyncRunId ?? null,
    contentHash: input.contentHash ?? null,
    source,
    factType: "decision" as const,
    relation: "mentioned" as const,
    subjectName: input.statement,
    subjectSource: source,
    subjectSourceId: decisionId,
    contextSnippet: input.contextSnippet ?? null,
    raw,
  };
  await createIndexedFileFactRepository(db).upsertFact(factInput);
  return { emitted: true, factKey: buildIndexedFileFactKey(factInput), decisionId };
}

export async function upsertDecisionFactsForFile(
  db: Kysely<DB>,
  input: UpsertDecisionFactsForFileInput,
): Promise<{ emitted: boolean; factKeys: Set<string> }> {
  requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  requireNonEmpty(input.source, "source");
  const emittedKeys = new Set<string>();
  if (!input.experimentalFlag) return { emitted: false, factKeys: emittedKeys };

  for (const decision of input.decisions) {
    const result = await upsertDecisionFact(db, {
      experimentalFlag: input.experimentalFlag,
      indexedFileId: input.indexedFileId,
      connectorConfigId: input.connectorConfigId,
      createdByUserId: input.createdByUserId,
      lastSeenSyncRunId: input.lastSeenSyncRunId,
      contentHash: input.contentHash,
      source: input.source,
      decisionId: decision.decisionId,
      topic: decision.topic,
      statement: decision.statement,
      parentRef: decision.parentRef,
      parentEntityId: decision.parentEntityId,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      rationale: decision.rationale,
      evidence: decision.evidence,
      promptVersion: decision.promptVersion,
      contextSnippet: input.contextSnippet,
    });
    if (result.factKey) emittedKeys.add(result.factKey);
  }
  await createIndexedFileFactRepository(db).reconcileStaleFacts(
    { kind: "file", indexedFileId: input.indexedFileId, source: input.source, factType: "decision" },
    emittedKeys,
  );
  return { emitted: true, factKeys: emittedKeys };
}

export function buildDecisionId(indexedFileId: string, topic: string, statement: string): string {
  return createHash("sha256")
    .update([indexedFileId, normalizeName(topic), normalizeName(statement)].join(DECISION_ID_SEPARATOR))
    .digest("hex");
}

export async function listCurrentDecisions(
  db: Kysely<DB>,
  opts: { experimentalFlag?: boolean; parentEntityId: string },
): Promise<CurrentDecision[]> {
  if (!opts.experimentalFlag) return [];
  const rows = await createSubEntityRepository(db).listCurrentByKind({
    parentEntityId: opts.parentEntityId,
    kind: "decision",
  });
  return hydrateDecisionRows(db, rows);
}

export async function getDecisionsAsOf(
  db: Kysely<DB>,
  opts: { experimentalFlag?: boolean; parentEntityId: string; at: string },
): Promise<CurrentDecision[]> {
  if (!opts.experimentalFlag) return [];
  const rows = await createSubEntityRepository(db).getSubEntitiesAsOf({
    parentEntityId: opts.parentEntityId,
    kind: "decision",
    at: opts.at,
  });
  return hydrateDecisionRows(db, rows);
}

async function hydrateDecisionRows(db: Kysely<DB>, rows: SubEntityRow[]): Promise<CurrentDecision[]> {
  const out: CurrentDecision[] = [];
  for (const row of rows) {
    const fact = row.source_fact_id ? await findDecisionFact(db, row.source_fact_id) : undefined;
    const raw = readDecisionRaw(fact?.raw ?? null);
    if (!fact || !raw || !row.parent_entity_id) continue;
    out.push({
      factId: fact.id,
      decisionId: raw.decisionId,
      parentEntityId: row.parent_entity_id,
      topic: raw.topic,
      statement: row.display_name,
      decidedBy: raw.decidedBy ?? null,
      decidedAt: raw.decidedAt ?? null,
      rationale: raw.rationale ?? null,
      evidence: raw.evidence,
      raw,
      row,
    });
  }
  return out;
}

async function findDecisionFact(
  db: Kysely<DB>,
  factId: string,
): Promise<Pick<IndexedFileFactsTable, "id" | "raw"> | undefined> {
  return db
    .selectFrom("indexed_file_facts")
    .select(["id", "raw"])
    .where("id", "=", factId)
    .where("fact_type", "=", "decision")
    .executeTakeFirst();
}

function readDecisionRaw(raw: string | null): DecisionFactRaw | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.decisionId !== "string" ||
    typeof record.topic !== "string" ||
    typeof record.statement !== "string" ||
    !isEvidence(record.evidence)
  ) {
    return null;
  }
  return {
    decisionId: record.decisionId,
    topic: record.topic,
    statement: record.statement,
    parentRef: readParentRef(record.parentRef),
    parentEntityId: readOptionalString(record.parentEntityId),
    decidedBy: readOptionalString(record.decidedBy),
    decidedAt: readOptionalString(record.decidedAt),
    rationale: readOptionalString(record.rationale),
    evidence: { fileIds: record.evidence.fileIds, entityIds: record.evidence.entityIds },
    promptVersion: readOptionalString(record.promptVersion),
  };
}

function isEvidence(value: unknown): value is { fileIds: string[]; entityIds: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.fileIds) &&
    record.fileIds.every((id) => typeof id === "string") &&
    Array.isArray(record.entityIds) &&
    record.entityIds.every((id) => typeof id === "string")
  );
}

function readParentRef(value: unknown): { source: string; sourceId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.sourceId !== "string") return undefined;
  return { source: record.source, sourceId: record.sourceId };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`decision ${name} is required`);
  return trimmed;
}

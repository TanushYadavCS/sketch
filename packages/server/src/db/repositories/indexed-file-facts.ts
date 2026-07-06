import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { IndexedFileFactRaw, LlmTaskCandidate, LlmTaskFactRaw } from "../../connectors/types";
import type { DB } from "../schema";

export type IndexedFileFactType =
  | "attendee"
  | "correspondent"
  | "assignee"
  | "author"
  | "parent_entity"
  | "contact_point"
  | "structural_seed"
  | "structural_task"
  | "commitment"
  | "decision"
  | "llm_task"
  | "person_seed"
  | "llm_extracted"
  | "llm_relation"
  | "crm_relation";

/**
 * Fact types whose subject is a person participating in a file (meeting attendee,
 * email correspondent). Consumers that derive file participants — scope context,
 * participant block, engagement floor, enrichment selection — must query this whole
 * set, not the `attendee` literal, so a new participant fact type can't silently
 * fall out of those paths. `author` is intentionally excluded: it is a single
 * authorship role, not a participant set, and existing consumers never included it.
 */
export const PERSON_PARTICIPANT_FACT_TYPES = ["attendee", "correspondent"] as const satisfies IndexedFileFactType[];

export type IndexedFileFactRelation =
  | "attended"
  | "corresponded"
  | "assigned"
  | "authored"
  | "mentioned"
  | "contactable"
  | "seeded"
  | "works_at"
  | "engaged_with"
  | "leads"
  | "contributes_to"
  | "builds"
  | "part_of"
  | "engagement_for"
  | "partner_of"
  | "deal_for"
  | "primary_contact"
  | "member_of";

export interface UpsertIndexedFileFactInput {
  indexedFileId?: string | null;
  connectorConfigId?: string | null;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  factType: IndexedFileFactType;
  relation: IndexedFileFactRelation;
  subjectName?: string | null;
  subjectEmail?: string | null;
  subjectSource?: string | null;
  subjectSourceId?: string | null;
  contextSnippet?: string | null;
  raw?: IndexedFileFactRaw;
}

export type ReconcileScope =
  | { kind: "connector"; connectorConfigId: string; syncRunId: string }
  | { kind: "file"; indexedFileId: string; source: string; factType: string };

export interface ReconcileOptions {
  maxDeletionRatio?: number;
  force?: boolean;
}

export interface ReconcileResult {
  activeBefore: number;
  wouldTombstone: number;
  tombstoned: number;
  affectedIndexedFileIds: string[];
  tombstonedFactIds: string[];
  skipped?: { reason: "delta_exceeds_threshold"; ratio: number; threshold: number };
}

const LLM_TASK_ID_SEPARATOR = "\u001f";

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

function rawString(input: UpsertIndexedFileFactInput, key: string): string {
  const raw = input.raw as Record<string, unknown> | undefined;
  const value = raw?.[key];
  return typeof value === "string" ? normalizeName(value) : "";
}

function rawEndpoint(input: UpsertIndexedFileFactInput, key: "source" | "target", field: "name" | "type"): string {
  const raw = input.raw as Record<string, unknown> | undefined;
  const endpoint = raw?.[key];
  if (!isRecord(endpoint)) return "";
  const value = endpoint[field];
  return typeof value === "string" ? normalizeName(value) : "";
}

function rawContactPoint(input: UpsertIndexedFileFactInput, field: "kind" | "value"): string {
  const raw = input.raw as Record<string, unknown> | undefined;
  const contactPoint = raw?.contactPoint;
  if (!isRecord(contactPoint)) return "";
  const value = contactPoint[field];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function rawEndpointIdentity(
  input: UpsertIndexedFileFactInput,
  key: "source" | "target",
  field: "source" | "sourceId",
): string {
  const raw = input.raw as Record<string, unknown> | undefined;
  const endpoint = raw?.[key];
  if (!isRecord(endpoint)) return "";
  const value = endpoint[field];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function buildIndexedFileFactKey(input: UpsertIndexedFileFactInput): string {
  if (input.factType === "structural_task") {
    const raw = input.raw as Record<string, unknown> | undefined;
    const task = isRecord(raw?.task) ? raw.task : undefined;
    const sourceTaskId = typeof task?.sourceTaskId === "string" ? task.sourceTaskId.trim().toLowerCase() : "";
    return createHash("sha256")
      .update([input.connectorConfigId ?? "", input.factType, input.source, sourceTaskId].join("|"))
      .digest("hex");
  }
  if (input.factType === "commitment") {
    const raw = input.raw as Record<string, unknown> | undefined;
    const commitmentId = typeof raw?.commitmentId === "string" ? raw.commitmentId.trim().toLowerCase() : "";
    return createHash("sha256")
      .update([input.connectorConfigId ?? "", input.factType, input.source, commitmentId].join("|"))
      .digest("hex");
  }
  if (input.factType === "decision") {
    const raw = input.raw as Record<string, unknown> | undefined;
    const decisionId = typeof raw?.decisionId === "string" ? raw.decisionId.trim().toLowerCase() : "";
    return createHash("sha256")
      .update([input.connectorConfigId ?? "", input.factType, input.source, decisionId].join("|"))
      .digest("hex");
  }
  if (input.factType === "llm_task") {
    const raw = input.raw as Record<string, unknown> | undefined;
    const candidateId = typeof raw?.candidateId === "string" ? raw.candidateId.trim().toLowerCase() : "";
    return createHash("sha256")
      .update([input.connectorConfigId ?? "", input.factType, input.source, candidateId].join("|"))
      .digest("hex");
  }
  const parts = [
    input.connectorConfigId ?? "",
    input.source,
    input.factType,
    input.relation,
    input.indexedFileId ?? "",
    input.factType === "llm_extracted" ? (input.contentHash ?? "") : "",
    input.subjectSource ?? "",
    input.subjectSourceId ?? "",
    normalizeEmail(input.subjectEmail),
    normalizeName(input.subjectName),
  ];
  if (input.factType === "llm_relation") {
    parts.push(
      rawString(input, "relationType"),
      rawEndpoint(input, "source", "name"),
      rawEndpoint(input, "source", "type"),
      rawEndpoint(input, "target", "name"),
      rawEndpoint(input, "target", "type"),
    );
  }
  if (input.factType === "contact_point") {
    parts.push(rawContactPoint(input, "kind"), rawContactPoint(input, "value"));
  }
  if (input.factType === "crm_relation") {
    parts.push(
      rawString(input, "relationType"),
      rawEndpointIdentity(input, "source", "source"),
      rawEndpointIdentity(input, "source", "sourceId"),
      rawEndpointIdentity(input, "target", "source"),
      rawEndpointIdentity(input, "target", "sourceId"),
    );
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function buildLegacyIndexedFileFactKey(input: UpsertIndexedFileFactInput): string {
  const parts = [
    input.source,
    input.factType,
    input.relation,
    input.indexedFileId ?? "",
    input.subjectSourceId ?? "",
    normalizeEmail(input.subjectEmail),
    normalizeName(input.subjectName),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

function validateRaw(input: UpsertIndexedFileFactInput): string | null {
  if (!input.raw && input.factType === "decision") {
    throw new Error("decision facts require raw decision data");
  }
  if (!input.raw) return null;
  if (!isRecord(input.raw)) {
    throw new Error("indexed_file_facts.raw must be an object");
  }
  const raw = input.raw as Record<string, unknown>;

  if (input.factType === "attendee" || input.factType === "correspondent") {
    const rawKey = input.factType === "attendee" ? "attendee" : "correspondent";
    if (!hasString(raw, "providerFileId") || !isRecord(raw[rawKey])) {
      throw new Error(`${input.factType} facts require raw.providerFileId and raw.${rawKey}`);
    }
  } else if (input.factType === "assignee") {
    if (!hasString(raw, "providerFileId") || !isRecord(raw.assignee) || !hasString(raw, "sourceRefKey")) {
      throw new Error("assignee facts require raw.providerFileId, raw.assignee, and raw.sourceRefKey");
    }
  } else if (input.factType === "author") {
    if (!hasString(raw, "providerFileId") || !isRecord(raw.author)) {
      throw new Error("author facts require raw.providerFileId and raw.author");
    }
    const author = raw.author as Record<string, unknown>;
    const email = typeof author.email === "string" ? author.email.trim() : "";
    const name = typeof author.name === "string" ? author.name.trim() : "";
    if (!email && !name) {
      throw new Error("author facts require raw.author.email or raw.author.name");
    }
  } else if (input.factType === "parent_entity") {
    if (!hasString(raw, "providerFileId") || !isRecord(raw.parent)) {
      throw new Error("parent_entity facts require raw.providerFileId and raw.parent");
    }
  } else if (input.factType === "contact_point") {
    if (!hasString(raw, "providerFileId") || !isRecord(raw.contactPoint)) {
      throw new Error("contact_point facts require raw.providerFileId and raw.contactPoint");
    }
    const contactPoint = raw.contactPoint as Record<string, unknown>;
    if (
      !hasString(contactPoint, "subjectName") ||
      !hasString(contactPoint, "subjectSource") ||
      !hasString(contactPoint, "subjectSourceId") ||
      !hasString(contactPoint, "kind") ||
      !hasString(contactPoint, "value") ||
      !hasString(contactPoint, "source")
    ) {
      throw new Error(
        "contact_point facts require subjectName, subjectSource, subjectSourceId, kind, value, and source",
      );
    }
  } else if (input.factType === "structural_seed") {
    if (!hasString(raw, "sourceType") && (!hasString(raw, "providerFileId") || !hasString(raw, "fileType"))) {
      throw new Error("structural_seed facts require raw.sourceType or raw provider file metadata");
    }
  } else if (input.factType === "structural_task") {
    if (!isRecord(raw.task) || !hasString(raw, "indexedFileId")) {
      throw new Error("structural_task facts require raw.task and raw.indexedFileId");
    }
    const task = raw.task as Record<string, unknown>;
    if (!hasString(task, "sourceTaskId") || !hasString(task, "title") || !hasString(task, "statusType")) {
      throw new Error("structural_task facts require sourceTaskId, title, and statusType");
    }
  } else if (input.factType === "commitment") {
    if (
      !hasString(raw, "commitmentId") ||
      !hasString(raw, "title") ||
      !hasString(raw, "status") ||
      !isRecord(raw.evidence)
    ) {
      throw new Error("commitment facts require commitmentId, title, status, and evidence");
    }
    if (raw.status !== "open" && raw.status !== "done" && raw.status !== "dropped") {
      throw new Error("commitment status must be open, done, or dropped");
    }
    const evidence = raw.evidence as Record<string, unknown>;
    if (!Array.isArray(evidence.fileIds) || !Array.isArray(evidence.entityIds)) {
      throw new Error("commitment evidence requires fileIds and entityIds arrays");
    }
    if (raw.parentRef !== undefined && !isRecord(raw.parentRef)) {
      throw new Error("commitment parentRef must be an object");
    }
    const parentRef = raw.parentRef as Record<string, unknown> | undefined;
    if (parentRef && (!hasString(parentRef, "source") || !hasString(parentRef, "sourceId"))) {
      throw new Error("commitment parentRef requires source and sourceId");
    }
  } else if (input.factType === "decision") {
    if (
      !input.connectorConfigId?.trim() ||
      !input.source.trim() ||
      !hasString(raw, "decisionId") ||
      !hasString(raw, "topic") ||
      !hasString(raw, "statement") ||
      !isRecord(raw.evidence)
    ) {
      throw new Error("decision facts require connectorConfigId, source, decisionId, topic, statement, and evidence");
    }
    const evidence = raw.evidence as Record<string, unknown>;
    if (!Array.isArray(evidence.fileIds) || !Array.isArray(evidence.entityIds)) {
      throw new Error("decision evidence requires fileIds and entityIds arrays");
    }
    if (
      !evidence.fileIds.every((id) => typeof id === "string") ||
      !evidence.entityIds.every((id) => typeof id === "string")
    ) {
      throw new Error("decision evidence ids must be strings");
    }
    if (raw.parentRef !== undefined && !isRecord(raw.parentRef)) {
      throw new Error("decision parentRef must be an object");
    }
    const parentRef = raw.parentRef as Record<string, unknown> | undefined;
    if (parentRef && (!hasString(parentRef, "source") || !hasString(parentRef, "sourceId"))) {
      throw new Error("decision parentRef requires source and sourceId");
    }
    for (const key of ["parentEntityId", "decidedBy", "decidedAt", "rationale", "promptVersion"]) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        throw new Error(`decision ${key} must be a string`);
      }
    }
  } else if (input.factType === "llm_task") {
    if (
      !hasString(raw, "candidateId") ||
      !hasString(raw, "title") ||
      typeof raw.hasOwnerVerbObject !== "boolean" ||
      !hasString(raw, "corroborationKey") ||
      !hasString(raw, "promptVersion") ||
      !isRecord(raw.evidence)
    ) {
      throw new Error(
        "llm_task facts require candidateId, title, hasOwnerVerbObject, corroborationKey, promptVersion, and evidence",
      );
    }
    const evidence = raw.evidence as Record<string, unknown>;
    if (!Array.isArray(evidence.fileIds) || !Array.isArray(evidence.entityIds)) {
      throw new Error("llm_task evidence requires fileIds and entityIds arrays");
    }
    if (raw.owner !== undefined && !isRecord(raw.owner)) {
      throw new Error("llm_task owner must be an object");
    }
    const owner = raw.owner as Record<string, unknown> | undefined;
    if (
      owner &&
      ((owner.name !== undefined && typeof owner.name !== "string") ||
        (owner.email !== undefined && typeof owner.email !== "string"))
    ) {
      throw new Error("llm_task owner name and email must be strings");
    }
    if (raw.parentRef !== undefined && !isRecord(raw.parentRef)) {
      throw new Error("llm_task parentRef must be an object");
    }
    const parentRef = raw.parentRef as Record<string, unknown> | undefined;
    if (parentRef && (!hasString(parentRef, "source") || !hasString(parentRef, "sourceId"))) {
      throw new Error("llm_task parentRef requires source and sourceId");
    }
    if (raw.dueDate !== undefined && typeof raw.dueDate !== "string") {
      throw new Error("llm_task dueDate must be a string");
    }
  } else if (input.factType === "person_seed") {
    if (!hasString(raw, "source") && !hasString(raw, "subtype")) {
      throw new Error("person_seed facts require raw source identity or subtype metadata");
    }
  } else if (input.factType === "llm_extracted") {
    if (!hasString(raw, "contentHash") || !hasString(raw, "promptVersion")) {
      throw new Error("llm_extracted facts require raw.contentHash and raw.promptVersion");
    }
  } else if (input.factType === "llm_relation") {
    if (
      !hasString(raw, "contentHash") ||
      !hasString(raw, "promptVersion") ||
      !hasString(raw, "relationType") ||
      !isRecord(raw.source) ||
      !isRecord(raw.target)
    ) {
      throw new Error(
        "llm_relation facts require raw.contentHash, raw.promptVersion, relationType, source, and target",
      );
    }
    const source = raw.source as Record<string, unknown>;
    const target = raw.target as Record<string, unknown>;
    if (
      !hasString(source, "name") ||
      !hasString(source, "type") ||
      !hasString(target, "name") ||
      !hasString(target, "type")
    ) {
      throw new Error("llm_relation endpoints require name and type");
    }
  } else if (input.factType === "crm_relation") {
    if (
      !hasString(raw, "providerFileId") ||
      !hasString(raw, "relationType") ||
      !isRecord(raw.source) ||
      !isRecord(raw.target)
    ) {
      throw new Error("crm_relation facts require raw.providerFileId, relationType, source, and target");
    }
    const source = raw.source as Record<string, unknown>;
    const target = raw.target as Record<string, unknown>;
    if (
      !hasString(source, "source") ||
      !hasString(source, "sourceId") ||
      !hasString(source, "name") ||
      !hasString(source, "type") ||
      !hasString(target, "source") ||
      !hasString(target, "sourceId") ||
      !hasString(target, "name") ||
      !hasString(target, "type")
    ) {
      throw new Error("crm_relation endpoints require source, sourceId, name, and type");
    }
  }

  return JSON.stringify(input.raw);
}

export interface UpsertLlmTaskFactInput {
  experimentalFlag?: boolean;
  indexedFileId: string;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  candidate: LlmTaskCandidate;
  candidateId?: string;
  corroborationKey: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  promptVersion: string;
}

export async function upsertLlmTaskFact(
  db: Kysely<DB>,
  input: UpsertLlmTaskFactInput,
): Promise<{ emitted: boolean; factKey?: string; candidateId?: string }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const candidateId = requireNonEmpty(
    input.candidateId ?? buildLlmTaskCandidateId(input.indexedFileId, input.candidate.title),
    "candidateId",
  );
  if (!input.experimentalFlag) return { emitted: false };

  const raw: LlmTaskFactRaw = {
    candidateId,
    title: input.candidate.title,
    owner: input.candidate.owner,
    dueDate: readOptionalDueDate(input.candidate.dueDate),
    hasOwnerVerbObject: input.candidate.hasOwnerVerbObject,
    corroborationKey: input.corroborationKey,
    parentRef: input.parentRef,
    parentEntityId: input.parentEntityId,
    evidence: input.evidence,
    sourceExcerpt: input.candidate.sourceExcerpt,
    promptVersion: input.promptVersion,
  };
  const factInput: UpsertIndexedFileFactInput = {
    indexedFileId: input.indexedFileId,
    connectorConfigId,
    createdByUserId: input.createdByUserId ?? null,
    lastSeenSyncRunId: input.lastSeenSyncRunId ?? null,
    contentHash: input.contentHash ?? null,
    source,
    factType: "llm_task",
    relation: "mentioned",
    subjectName: input.candidate.title,
    subjectSource: source,
    subjectSourceId: candidateId,
    contextSnippet: input.candidate.sourceExcerpt ?? null,
    raw,
  };
  await createIndexedFileFactRepository(db).upsertFact(factInput);
  return { emitted: true, factKey: buildIndexedFileFactKey(factInput), candidateId };
}

function readOptionalDueDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export function buildLlmTaskCandidateId(indexedFileId: string, title: string): string {
  return createHash("sha256")
    .update([indexedFileId, normalizeName(title)].join(LLM_TASK_ID_SEPARATOR))
    .digest("hex");
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`llm_task ${name} is required`);
  return trimmed;
}

export function createIndexedFileFactRepository(db: Kysely<DB>) {
  return {
    async upsertFact(input: UpsertIndexedFileFactInput): Promise<void> {
      const now = new Date().toISOString();
      const subjectEmail = normalizeEmail(input.subjectEmail) || null;
      const raw = validateRaw(input);
      const factKey = buildIndexedFileFactKey(input);
      const legacyFactKey = buildLegacyIndexedFileFactKey(input);
      const values = {
        indexed_file_id: input.indexedFileId ?? null,
        connector_config_id: input.connectorConfigId ?? null,
        created_by_user_id: input.createdByUserId ?? null,
        source: input.source,
        fact_type: input.factType,
        relation: input.relation,
        subject_name: input.subjectName?.trim() || null,
        subject_email: subjectEmail,
        subject_source: input.subjectSource ?? null,
        subject_source_id: input.subjectSourceId ?? null,
        context_snippet: input.contextSnippet ?? null,
        raw,
        fact_key: factKey,
        last_seen_sync_run_id: input.lastSeenSyncRunId ?? null,
        deleted_at: null,
        content_hash: input.contentHash ?? null,
        materialized_at: null,
        updated_at: now,
      };

      if (legacyFactKey !== factKey) {
        const existing = await db
          .selectFrom("indexed_file_facts")
          .select("id")
          .where("fact_key", "=", legacyFactKey)
          .executeTakeFirst();
        if (existing) {
          await db.updateTable("indexed_file_facts").set(values).where("id", "=", existing.id).execute();
          return;
        }
      }

      await db
        .insertInto("indexed_file_facts")
        .values({
          id: randomUUID(),
          ...values,
        })
        .onConflict((oc) =>
          oc.column("fact_key").doUpdateSet({
            ...values,
          }),
        )
        .execute();
    },

    async reconcileStaleFacts(
      scope: ReconcileScope,
      seenFactKeys: Set<string> | null,
      opts: ReconcileOptions = {},
    ): Promise<ReconcileResult> {
      const threshold = opts.maxDeletionRatio ?? (scope.kind === "connector" ? 0.5 : Number.POSITIVE_INFINITY);
      const countActive =
        scope.kind === "connector"
          ? await db
              .selectFrom("indexed_file_facts")
              .select(db.fn.countAll<number>().as("count"))
              .where("connector_config_id", "=", scope.connectorConfigId)
              .where("deleted_at", "is", null)
              .where("last_seen_sync_run_id", "is not", null)
              .executeTakeFirst()
          : await db
              .selectFrom("indexed_file_facts")
              .select(db.fn.countAll<number>().as("count"))
              .where("indexed_file_id", "=", scope.indexedFileId)
              .where("source", "=", scope.source)
              .where("fact_type", "=", scope.factType)
              .where("deleted_at", "is", null)
              .executeTakeFirst();
      const activeBefore = Number(countActive?.count ?? 0);

      const countStale =
        scope.kind === "connector"
          ? await db
              .selectFrom("indexed_file_facts")
              .select(db.fn.countAll<number>().as("count"))
              .where("connector_config_id", "=", scope.connectorConfigId)
              .where("deleted_at", "is", null)
              .where("last_seen_sync_run_id", "is not", null)
              .where("last_seen_sync_run_id", "!=", scope.syncRunId)
              .executeTakeFirst()
          : seenFactKeys && seenFactKeys.size > 0
            ? await db
                .selectFrom("indexed_file_facts")
                .select(db.fn.countAll<number>().as("count"))
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .where("fact_key", "not in", [...seenFactKeys])
                .executeTakeFirst()
            : await db
                .selectFrom("indexed_file_facts")
                .select(db.fn.countAll<number>().as("count"))
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .executeTakeFirst();

      const wouldTombstone = Number(countStale?.count ?? 0);
      const ratio = activeBefore > 0 ? wouldTombstone / activeBefore : 0;
      if (!opts.force && activeBefore > 0 && ratio > threshold) {
        return {
          activeBefore,
          wouldTombstone,
          tombstoned: 0,
          affectedIndexedFileIds: [],
          tombstonedFactIds: [],
          skipped: { reason: "delta_exceeds_threshold", ratio, threshold },
        };
      }

      const stale =
        scope.kind === "connector"
          ? await db
              .selectFrom("indexed_file_facts")
              .select(["id", "indexed_file_id"])
              .where("connector_config_id", "=", scope.connectorConfigId)
              .where("deleted_at", "is", null)
              .where("last_seen_sync_run_id", "is not", null)
              .where("last_seen_sync_run_id", "!=", scope.syncRunId)
              .execute()
          : seenFactKeys && seenFactKeys.size > 0
            ? await db
                .selectFrom("indexed_file_facts")
                .select(["id", "indexed_file_id"])
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .where("fact_key", "not in", [...seenFactKeys])
                .execute()
            : await db
                .selectFrom("indexed_file_facts")
                .select(["id", "indexed_file_id"])
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .execute();

      const now = new Date().toISOString();
      const updateResult =
        scope.kind === "connector"
          ? await db
              .updateTable("indexed_file_facts")
              .set({ deleted_at: now, materialized_at: null, updated_at: now })
              .where("connector_config_id", "=", scope.connectorConfigId)
              .where("deleted_at", "is", null)
              .where("last_seen_sync_run_id", "is not", null)
              .where("last_seen_sync_run_id", "!=", scope.syncRunId)
              .executeTakeFirst()
          : seenFactKeys && seenFactKeys.size > 0
            ? await db
                .updateTable("indexed_file_facts")
                .set({ deleted_at: now, materialized_at: null, updated_at: now })
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .where("fact_key", "not in", [...seenFactKeys])
                .executeTakeFirst()
            : await db
                .updateTable("indexed_file_facts")
                .set({ deleted_at: now, materialized_at: null, updated_at: now })
                .where("indexed_file_id", "=", scope.indexedFileId)
                .where("source", "=", scope.source)
                .where("fact_type", "=", scope.factType)
                .where("deleted_at", "is", null)
                .executeTakeFirst();

      return {
        activeBefore,
        wouldTombstone,
        tombstoned: Number(updateResult.numUpdatedRows ?? 0),
        affectedIndexedFileIds: [
          ...new Set(stale.map((row) => row.indexed_file_id).filter((id): id is string => Boolean(id))),
        ],
        tombstonedFactIds: stale.map((row) => row.id),
      };
    },

    async touchActiveFactsForFile(input: {
      indexedFileId: string;
      source: string;
      factType: IndexedFileFactType;
      lastSeenSyncRunId: string;
      contentHash?: string | null;
    }): Promise<number> {
      const result = await db
        .updateTable("indexed_file_facts")
        .set({
          last_seen_sync_run_id: input.lastSeenSyncRunId,
          content_hash: input.contentHash ?? null,
          updated_at: new Date().toISOString(),
        })
        .where("indexed_file_id", "=", input.indexedFileId)
        .where("source", "=", input.source)
        .where("fact_type", "=", input.factType)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    async clearMaterializedAtForActiveFacts(indexedFileIds: string[]): Promise<void> {
      if (indexedFileIds.length === 0) return;
      await db
        .updateTable("indexed_file_facts")
        .set({ materialized_at: null, updated_at: new Date().toISOString() })
        .where("indexed_file_id", "in", indexedFileIds)
        .where("deleted_at", "is", null)
        .execute();
    },

    async findUnmaterializedRelationFactsByEndpointName(names: string[], limit: number) {
      const normalizedNames = new Set(names.map(normalizeName).filter((name) => name.length > 0));
      if (normalizedNames.size === 0 || limit <= 0) return [];
      const facts = await db
        .selectFrom("indexed_file_facts")
        .selectAll()
        .where("fact_type", "=", "llm_relation")
        .where("materialized_at", "is", null)
        .where("deleted_at", "is", null)
        .execute();
      const matched = [];
      for (const fact of facts) {
        if (!fact.raw) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(fact.raw);
        } catch {
          continue;
        }
        if (!isRecord(raw)) continue;
        const source = raw.source;
        const target = raw.target;
        const sourceName = isRecord(source) && typeof source.name === "string" ? normalizeName(source.name) : "";
        const targetName = isRecord(target) && typeof target.name === "string" ? normalizeName(target.name) : "";
        if (!normalizedNames.has(sourceName) && !normalizedNames.has(targetName)) continue;
        matched.push(fact);
        if (matched.length >= limit) return matched;
      }
      return matched;
    },
  };
}

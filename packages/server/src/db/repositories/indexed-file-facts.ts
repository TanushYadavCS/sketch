import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { IndexedFileFactRaw } from "../../connectors/types";
import type { DB } from "../schema";

export type IndexedFileFactType =
  | "attendee"
  | "correspondent"
  | "assignee"
  | "author"
  | "parent_entity"
  | "structural_seed"
  | "person_seed"
  | "llm_extracted"
  | "llm_relation";

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
  | "seeded"
  | "works_at"
  | "engaged_with"
  | "leads"
  | "contributes_to"
  | "builds"
  | "part_of"
  | "partner_of";

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

export function buildIndexedFileFactKey(input: UpsertIndexedFileFactInput): string {
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
  } else if (input.factType === "structural_seed") {
    if (!hasString(raw, "sourceType") && (!hasString(raw, "providerFileId") || !hasString(raw, "fileType"))) {
      throw new Error("structural_seed facts require raw.sourceType or raw provider file metadata");
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
  }

  return JSON.stringify(input.raw);
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

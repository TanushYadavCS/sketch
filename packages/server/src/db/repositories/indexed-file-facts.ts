import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { IndexedFileFactRaw } from "../../connectors/types";
import type { DB } from "../schema";

export type IndexedFileFactType =
  | "attendee"
  | "assignee"
  | "author"
  | "parent_entity"
  | "structural_seed"
  | "person_seed"
  | "llm_extracted";

export type IndexedFileFactRelation = "attended" | "assigned" | "authored" | "mentioned" | "seeded";

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

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
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

  if (input.factType === "attendee") {
    if (!hasString(raw, "providerFileId") || !isRecord(raw.attendee)) {
      throw new Error("attendee facts require raw.providerFileId and raw.attendee");
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

    async tombstoneStaleFactsForConnector(connectorConfigId: string, syncRunId: string): Promise<string[]> {
      const stale = await db
        .selectFrom("indexed_file_facts")
        .select("indexed_file_id")
        .where("connector_config_id", "=", connectorConfigId)
        .where("deleted_at", "is", null)
        .where((eb) => eb.or([eb("last_seen_sync_run_id", "is", null), eb("last_seen_sync_run_id", "!=", syncRunId)]))
        .execute();
      const now = new Date().toISOString();
      await db
        .updateTable("indexed_file_facts")
        .set({ deleted_at: now, materialized_at: null, updated_at: now })
        .where("connector_config_id", "=", connectorConfigId)
        .where("deleted_at", "is", null)
        .where((eb) => eb.or([eb("last_seen_sync_run_id", "is", null), eb("last_seen_sync_run_id", "!=", syncRunId)]))
        .execute();
      return [...new Set(stale.map((row) => row.indexed_file_id).filter((id): id is string => Boolean(id)))];
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
  };
}

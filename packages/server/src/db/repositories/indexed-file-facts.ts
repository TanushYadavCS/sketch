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
  | "person_seed";

export type IndexedFileFactRelation = "attended" | "assigned" | "authored" | "mentioned" | "seeded";

export interface UpsertIndexedFileFactInput {
  indexedFileId?: string | null;
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
  }

  return JSON.stringify(input.raw);
}

export function createIndexedFileFactRepository(db: Kysely<DB>) {
  return {
    async upsertFact(input: UpsertIndexedFileFactInput): Promise<void> {
      const now = new Date().toISOString();
      const subjectEmail = normalizeEmail(input.subjectEmail) || null;
      const raw = validateRaw(input);
      await db
        .insertInto("indexed_file_facts")
        .values({
          id: randomUUID(),
          indexed_file_id: input.indexedFileId ?? null,
          source: input.source,
          fact_type: input.factType,
          relation: input.relation,
          subject_name: input.subjectName?.trim() || null,
          subject_email: subjectEmail,
          subject_source: input.subjectSource ?? null,
          subject_source_id: input.subjectSourceId ?? null,
          context_snippet: input.contextSnippet ?? null,
          raw,
          fact_key: buildIndexedFileFactKey(input),
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("fact_key").doUpdateSet({
            subject_name: input.subjectName?.trim() || null,
            subject_email: subjectEmail,
            context_snippet: input.contextSnippet ?? null,
            raw,
            updated_at: now,
          }),
        )
        .execute();
    },
  };
}

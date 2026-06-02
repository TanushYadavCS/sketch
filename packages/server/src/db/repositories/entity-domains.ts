import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { isPg } from "../dialect";
import type { DB, EntitiesTable } from "../schema";

export type DomainKind = "corporate" | "personal" | "shared";
export type RelationshipConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type EntityRelationshipType =
  | "works_at"
  | "engaged_with"
  | "leads"
  | "contributes_to"
  | "builds"
  | "part_of"
  | "partner_of";

export interface UpsertDomainInput {
  entityId: string | null;
  domain: string;
  kind: DomainKind;
  source: string;
  confidence?: number;
  isPrimary?: boolean;
}

export interface UpsertWorksAtInput {
  personEntityId: string;
  companyEntityId: string;
  confidence: RelationshipConfidence;
  confidenceScore: number;
  source: string;
  validFrom?: string;
}

export interface UpsertDomainObservationInput {
  domain: string;
  proposedCompanyName: string;
  observedPersonEntityId: string;
  evidenceFileId: string;
  firstObservedByUserId?: string | null;
}

export interface UpsertRelationshipInput {
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: EntityRelationshipType;
  confidence: RelationshipConfidence;
  confidenceScore: number;
  source: string;
  validFrom?: string;
}

export interface AddRelationshipEvidenceInput {
  relationshipId: string;
  indexedFileId: string;
  chunkIndex?: number;
  note?: string | null;
  sourceFactId?: string | null;
}

/**
 * Lowercase + trim the part after `@`. Returns null for malformed input.
 * Subdomains are conservative: `mail.acme.com` only normalizes to `acme.com`
 * if `acme.com` is already known, and that check lives in the caller (so the
 * normalizer itself stays a pure function). Here we just lowercase the host
 * as the email carried it.
 */
export function normalizeEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 0 || at === trimmed.length - 1) return null;
  const host = trimmed.slice(at + 1).toLowerCase();
  if (host.length === 0 || !host.includes(".")) return null;
  return host;
}

/**
 * Propose a company display name from a raw domain. `habuild.in` → `Habuild`,
 * `oliver-wyman.com` → `Oliver Wyman`. The result is a hint for the candidate
 * row — ECR-05 will route this through `proposeEntity` for real review.
 */
export function proposeCompanyNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // fall through
  }
  return [];
}

export function createEntityDomainsRepository(db: Kysely<DB>) {
  async function upsertRelationship(input: UpsertRelationshipInput): Promise<string> {
    const validFrom = input.validFrom ?? "";
    const id = randomUUID();
    const greatest = isPg(db)
      ? sql`GREATEST(entity_relationships.confidence_score, EXCLUDED.confidence_score)`
      : sql`max(entity_relationships.confidence_score, EXCLUDED.confidence_score)`;
    await sql`
      INSERT INTO entity_relationships
        (id, source_entity_id, target_entity_id, relationship_type, confidence, confidence_score, source, valid_from, valid_to, created_at, updated_at)
      VALUES
        (${id}, ${input.sourceEntityId}, ${input.targetEntityId}, ${input.relationshipType}, ${input.confidence}, ${input.confidenceScore}, ${input.source}, ${validFrom}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (source_entity_id, target_entity_id, relationship_type, valid_from)
      DO UPDATE SET
        confidence = EXCLUDED.confidence,
        confidence_score = ${greatest},
        source = EXCLUDED.source,
        updated_at = CURRENT_TIMESTAMP
    `.execute(db);
    const row = await db
      .selectFrom("entity_relationships")
      .select("id")
      .where("source_entity_id", "=", input.sourceEntityId)
      .where("target_entity_id", "=", input.targetEntityId)
      .where("relationship_type", "=", input.relationshipType)
      .where("valid_from", "=", validFrom)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  return {
    normalizeEmailDomain,

    async isPersonalOrShared(domain: string): Promise<boolean> {
      const row = await db.selectFrom("entity_domains").select("kind").where("domain", "=", domain).executeTakeFirst();
      if (!row) return false;
      return row.kind === "personal" || row.kind === "shared";
    },

    async lookupCompanyByDomain(domain: string): Promise<EntitiesTable | null> {
      const row = await db
        .selectFrom("entity_domains")
        .innerJoin("entities", "entities.id", "entity_domains.entity_id")
        .selectAll("entities")
        .where("entity_domains.domain", "=", domain)
        .where("entity_domains.kind", "=", "corporate")
        .where("entity_domains.entity_id", "is not", null)
        .executeTakeFirst();
      return (row ?? null) as EntitiesTable | null;
    },

    async upsertDomain(input: UpsertDomainInput): Promise<void> {
      const existing = await db
        .selectFrom("entity_domains")
        .selectAll()
        .where("domain", "=", input.domain)
        .executeTakeFirst();
      if (existing) {
        // Manual overrides win. Don't downgrade source from manual → observed/llm,
        // and don't flip kind out from under the operator.
        if (existing.source === "manual") {
          if (existing.entity_id === null && input.entityId && existing.kind === input.kind) {
            await db
              .updateTable("entity_domains")
              .set({ entity_id: input.entityId })
              .where("id", "=", existing.id)
              .execute();
          }
          return;
        }
        if (existing.kind === input.kind && existing.entity_id === input.entityId) return;
        await db
          .updateTable("entity_domains")
          .set({
            entity_id: input.entityId,
            kind: input.kind,
            source: input.source,
            confidence: input.confidence ?? existing.confidence,
            is_primary: input.isPrimary ? 1 : existing.is_primary,
          })
          .where("id", "=", existing.id)
          .execute();
        return;
      }
      await db
        .insertInto("entity_domains")
        .values({
          id: randomUUID(),
          entity_id: input.entityId,
          domain: input.domain,
          kind: input.kind,
          is_primary: input.isPrimary ? 1 : 0,
          confidence: input.confidence ?? 1.0,
          source: input.source,
        })
        .execute();
    },

    upsertRelationship,

    async upsertWorksAt(input: UpsertWorksAtInput): Promise<string> {
      return upsertRelationship({
        sourceEntityId: input.personEntityId,
        targetEntityId: input.companyEntityId,
        relationshipType: "works_at",
        confidence: input.confidence,
        confidenceScore: input.confidenceScore,
        source: input.source,
        validFrom: input.validFrom,
      });
    },

    async addEvidence(input: AddRelationshipEvidenceInput): Promise<void> {
      const chunkIndex = input.chunkIndex ?? -1;
      const note = input.note ?? null;
      const evidenceKey = input.sourceFactId
        ? `fact:${input.sourceFactId}`
        : `note:${input.relationshipId}:${input.indexedFileId}:${chunkIndex}:${note ?? ""}`;
      await db
        .insertInto("entity_relationship_evidence")
        .values({
          id: randomUUID(),
          relationship_id: input.relationshipId,
          indexed_file_id: input.indexedFileId,
          chunk_index: chunkIndex,
          source_fact_id: input.sourceFactId ?? null,
          evidence_key: evidenceKey,
          note,
        })
        .onConflict((oc) =>
          oc.columns(["relationship_id", "evidence_key"]).doUpdateSet({
            note,
          }),
        )
        .execute();
    },

    async deleteEvidenceForSourceFacts(sourceFactIds: string[]): Promise<number> {
      if (sourceFactIds.length === 0) return 0;
      const result = await db
        .deleteFrom("entity_relationship_evidence")
        .where("source_fact_id", "in", sourceFactIds)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async deleteCoMentionEvidenceForRelationships(
      relationshipIds: string[],
      keepEvidenceKeys: Set<string> = new Set(),
    ): Promise<number> {
      if (relationshipIds.length === 0) return 0;
      let query = db
        .deleteFrom("entity_relationship_evidence")
        .where("relationship_id", "in", relationshipIds)
        .where("source_fact_id", "is", null)
        .where("note", "like", "co_mention:%");
      const keep = [...keepEvidenceKeys];
      if (keep.length > 0) {
        query = query.where("evidence_key", "not in", keep);
      }
      const result = await query.executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async cleanupEmptyRelationships(): Promise<number> {
      const result = await db
        .deleteFrom("entity_relationships")
        .where("id", "not in", db.selectFrom("entity_relationship_evidence").select("relationship_id").distinct())
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async upsertDomainObservation(input: UpsertDomainObservationInput): Promise<void> {
      // Read-modify-write inside a transaction — JSON merging differs enough
      // between SQLite and Postgres that doing it in pure SQL costs more than
      // it saves. The unique index on (type, domain) keeps concurrent inserts
      // from creating duplicate rows; one of the two will block, retry, and
      // see the other's row on the second pass.
      await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("entity_candidates")
          .selectAll()
          .where("type", "=", "domain_observation")
          .where("domain", "=", input.domain)
          .executeTakeFirst();

        const now = new Date().toISOString();
        if (existing) {
          const people = parseJsonArray(existing.observed_person_entity_ids);
          const files = parseJsonArray(existing.evidence_file_ids);
          const seenFiles = parseJsonArray(existing.seen_file_ids);
          let changed = false;
          if (!people.includes(input.observedPersonEntityId)) {
            people.push(input.observedPersonEntityId);
            changed = true;
          }
          if (!files.includes(input.evidenceFileId)) {
            files.push(input.evidenceFileId);
            changed = true;
          }
          if (!seenFiles.includes(input.evidenceFileId)) {
            seenFiles.push(input.evidenceFileId);
            changed = true;
          }
          if (!changed) return;
          await trx
            .updateTable("entity_candidates")
            .set({
              observed_person_entity_ids: JSON.stringify(people),
              evidence_file_ids: JSON.stringify(files),
              seen_file_ids: JSON.stringify(seenFiles),
              // seen_count tracks DISTINCT observed people for this candidate type.
              seen_count: people.length,
              updated_at: now,
            })
            .where("id", "=", existing.id)
            .execute();
          return;
        }

        await trx
          .insertInto("entity_candidates")
          .values({
            id: randomUUID(),
            name: input.proposedCompanyName,
            type: "domain_observation",
            variations: JSON.stringify([]),
            first_seen_file_id: input.evidenceFileId,
            seen_file_ids: JSON.stringify([input.evidenceFileId]),
            seen_count: 1,
            promoted_entity_id: null,
            domain: input.domain,
            proposed_company_name: input.proposedCompanyName,
            first_observed_by_user_id: input.firstObservedByUserId ?? null,
            observed_person_entity_ids: JSON.stringify([input.observedPersonEntityId]),
            evidence_file_ids: JSON.stringify([input.evidenceFileId]),
            created_at: now,
            updated_at: now,
          })
          .execute();
      });
    },
  };
}

export type EntityDomainsRepository = ReturnType<typeof createEntityDomainsRepository>;

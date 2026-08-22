import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { compactEntityNameKey } from "../../entities/name-keys";
import { isPersonalOrSharedDomain } from "../../entities/personal-domains";
import { ProjectBindingError, assertNoPartOfCycle } from "../../entities/project-bindings";
import {
  HUMAN_RELATIONSHIP_SOURCES,
  PROTECTED_RELATIONSHIP_SOURCES,
  PROTECTED_RELATIONSHIP_TYPES,
} from "../../entities/relationship-provenance";
import { isPg } from "../dialect";
import type { DB, EntitiesTable } from "../schema";
import { whereLiveEntity } from "./entities";

export type DomainKind = "corporate" | "personal" | "shared";
export type RelationshipConfidence = "CONFIRMED" | "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export type EntityRelationshipType =
  | "works_at"
  | "engaged_with"
  | "leads"
  | "contributes_to"
  | "builds"
  | "part_of"
  | "member_of"
  | "engagement_for"
  | "partner_of"
  | "deal_for"
  | "primary_contact";

type LoggerWarn = (obj: Record<string, unknown>, msg: string) => void;

export interface UpsertDomainInput {
  entityId: string | null;
  domain: string;
  kind: DomainKind;
  source: string;
  confidence?: number;
  isPrimary?: boolean;
}

export type AuthoritativeDomainUpsertResult =
  | "inserted"
  | "updated"
  | "unchanged"
  | "skipped_personal_or_shared"
  | "skipped_manual_conflict"
  | "skipped_auto_conflict";

export interface UpsertAuthoritativeCorporateDomainInput {
  entityId: string;
  domain: string;
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

export function relationshipSourceRank(source: string | null | undefined): number {
  if (source === "structural_assignee") return 3;
  if (source === "llm_extraction") return 2;
  if (source === "co_mention") return 1;
  return 0;
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

export function normalizeWebsiteDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutAngleBrackets = trimmed.replace(/^<+|>+$/g, "");
  const withoutPathOnlyPrefix = withoutAngleBrackets.startsWith("//")
    ? `https:${withoutAngleBrackets}`
    : withoutAngleBrackets;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(withoutPathOnlyPrefix)
    ? withoutPathOnlyPrefix
    : `https://${withoutPathOnlyPrefix}`;
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  while (host.startsWith("www.")) host = host.slice(4);
  if (!host.includes(".") || isIP(host) !== 0) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/**
 * Multi-label public suffixes where the registrable label sits one further left
 * than a single-label TLD. Hand-maintained (no public-suffix-list dependency);
 * covers the ccTLD shapes that show up in this data. `x.co.in` → SLD `x`, not
 * `co`.
 */
const COMPOUND_TLD_SUFFIXES: ReadonlySet<string> = new Set([
  "co.in",
  "co.uk",
  "co.jp",
  "co.nz",
  "co.kr",
  "co.za",
  "com.au",
  "com.br",
  "com.sg",
  "com.mx",
  "com.tr",
  "ac.in",
  "ac.uk",
  "ac.jp",
  "org.in",
  "org.uk",
  "net.in",
  "gov.in",
  "gov.uk",
  "edu.in",
  "bank.in",
]);

/**
 * Propose a company display name from a raw domain. Uses the registrable
 * second-level label (the one left of the public suffix), NOT the leftmost
 * label, so a subdomain host does not become the name: `habuild.in` → `Habuild`,
 * `oliver-wyman.com` → `Oliver Wyman`, `support.aws.com` → `Aws`,
 * `xwf.google.com` → `Google`, `x.co.in` → `X`. The result is a hint for the
 * candidate row — ECR-05 will route this through `proposeEntity` for real review.
 */
export function proposeCompanyNameFromDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  const labels = normalized.split(".").filter((s) => s.length > 0);
  let base: string;
  if (labels.length <= 1) {
    base = labels[0] ?? normalized;
  } else {
    const suffixLen = COMPOUND_TLD_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
    const sldIndex = labels.length - 1 - suffixLen;
    // The input is nothing but a public suffix (e.g. `co.in`) — there is no
    // registrable label to name a company after, so refuse rather than mint a
    // bogus "Co" candidate. An empty name is skipped by the promotion sweep.
    if (sldIndex < 0) return "";
    base = labels[sldIndex];
  }
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

function domainMatchesName(domain: string, name: string): boolean {
  const nameKey = compactEntityNameKey("company", name);
  if (!nameKey) return false;
  const normalizedDomain = normalizeWebsiteDomain(domain) ?? domain.trim().toLowerCase();
  const labels = normalizedDomain.split(".").filter(Boolean);
  if (labels.length === 0) return false;
  const candidates = new Set<string>([labels.join(" ")]);
  if (labels.length > 1) {
    candidates.add(labels.slice(0, -1).join(" "));
    candidates.add(labels[labels.length - 2]);
  }
  for (const candidate of candidates) {
    if (compactEntityNameKey("company", candidate) === nameKey) return true;
  }
  return false;
}

export function createEntityDomainsRepository(db: Kysely<DB>, opts?: { logger?: { warn: LoggerWarn } }) {
  /**
   * `part_of` sweep writers skip cycle-forming edges by returning null, while
   * interactive acceptance throws before reaching this repository so callers can
   * surface a typed user-facing conflict.
   */
  async function upsertRelationship(input: UpsertRelationshipInput): Promise<string | null> {
    const validFrom = input.validFrom ?? "";
    if (input.relationshipType === "part_of") {
      try {
        await assertNoPartOfCycle(db, input.sourceEntityId, input.targetEntityId);
      } catch (err) {
        if (err instanceof ProjectBindingError && err.code === "WOULD_CYCLE") {
          opts?.logger?.warn(
            {
              sourceEntityId: input.sourceEntityId,
              targetEntityId: input.targetEntityId,
              relationshipType: input.relationshipType,
              source: input.source,
            },
            "Skipped part_of relationship that would create a cycle",
          );
          return null;
        }
        throw err;
      }
    }
    const id = randomUUID();
    const incomingRank = relationshipSourceRank(input.source);
    const existingRank = sql<number>`CASE entity_relationships.source
      WHEN 'structural_assignee' THEN 3
      WHEN 'llm_extraction' THEN 2
      WHEN 'co_mention' THEN 1
      ELSE 0
    END`;
    const preserveRankedOwner = sql<boolean>`EXCLUDED.relationship_type = 'contributes_to' AND ${incomingRank} < ${existingRank}`;
    const humanSources = sql.join(HUMAN_RELATIONSHIP_SOURCES.map((source) => sql.lit(source)));
    const preserveHumanOwner = sql<boolean>`entity_relationships.source IN (${humanSources}) AND EXCLUDED.source NOT IN (${humanSources})`;
    const preserveExisting = sql<boolean>`(${preserveRankedOwner}) OR (${preserveHumanOwner})`;
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
        confidence = CASE
          WHEN ${preserveExisting} THEN entity_relationships.confidence
          ELSE EXCLUDED.confidence
        END,
        confidence_score = ${greatest},
        source = CASE
          WHEN ${preserveExisting} THEN entity_relationships.source
          ELSE EXCLUDED.source
        END,
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
    normalizeWebsiteDomain,

    async isPersonalOrShared(domain: string): Promise<boolean> {
      // The code constant wins over any DB row: a poisoned `corporate` row for
      // gmail.com must never flip this to false. It also keeps the guard alive
      // when the migration-064 seed has been cleared by a rebuild.
      if (isPersonalOrSharedDomain(domain)) return true;
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
        .where(whereLiveEntity())
        .executeTakeFirst();
      return (row ?? null) as EntitiesTable | null;
    },

    async getCompanyIdsByDomain(domain: string): Promise<string[]> {
      const rows = await db
        .selectFrom("entity_domains")
        .innerJoin("entities", "entities.id", "entity_domains.entity_id")
        .select("entity_domains.entity_id")
        .where("entity_domains.domain", "=", domain.toLowerCase())
        .where("entity_domains.kind", "=", "corporate")
        .where("entity_domains.entity_id", "is not", null)
        .where(whereLiveEntity())
        .execute();
      return rows.flatMap((row) => (row.entity_id ? [row.entity_id] : []));
    },

    async findCorporateDomainMatchingName(name: string): Promise<string | null> {
      const rows = await db.selectFrom("entity_domains").select("domain").where("kind", "=", "corporate").execute();
      for (const row of rows) {
        if (domainMatchesName(row.domain, name)) return row.domain;
      }
      return null;
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

    async upsertAuthoritativeCorporateDomain(
      input: UpsertAuthoritativeCorporateDomainInput,
    ): Promise<AuthoritativeDomainUpsertResult> {
      const domain = input.domain.toLowerCase();
      const existing = await db
        .selectFrom("entity_domains")
        .selectAll()
        .where("domain", "=", domain)
        .executeTakeFirst();
      if (existing) {
        if (existing.kind === "personal" || existing.kind === "shared") return "skipped_personal_or_shared";
        if (existing.entity_id && existing.entity_id !== input.entityId) {
          return existing.source === "manual" ? "skipped_manual_conflict" : "skipped_auto_conflict";
        }
        if (existing.source === "manual") {
          if (!existing.entity_id) {
            await db
              .updateTable("entity_domains")
              .set({ entity_id: input.entityId, is_primary: input.isPrimary ? 1 : existing.is_primary })
              .where("id", "=", existing.id)
              .execute();
            return "updated";
          }
          return "unchanged";
        }
        await db
          .updateTable("entity_domains")
          .set({
            entity_id: input.entityId,
            kind: "corporate",
            source: input.source,
            confidence: Math.max(Number(existing.confidence), input.confidence ?? 1.0),
            is_primary: input.isPrimary ? 1 : existing.is_primary,
          })
          .where("id", "=", existing.id)
          .execute();
        return "updated";
      }

      await db
        .insertInto("entity_domains")
        .values({
          id: randomUUID(),
          entity_id: input.entityId,
          domain,
          kind: "corporate",
          is_primary: input.isPrimary ? 1 : 0,
          confidence: input.confidence ?? 1.0,
          source: input.source,
        })
        .execute();
      return "inserted";
    },

    upsertRelationship,

    async upsertWorksAt(input: UpsertWorksAtInput): Promise<string> {
      const relationshipId = await upsertRelationship({
        sourceEntityId: input.personEntityId,
        targetEntityId: input.companyEntityId,
        relationshipType: "works_at",
        confidence: input.confidence,
        confidenceScore: input.confidenceScore,
        source: input.source,
        validFrom: input.validFrom,
      });
      if (!relationshipId) throw new Error("works_at relationship unexpectedly skipped");
      return relationshipId;
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

    async deleteStructuralAssigneeEvidenceForRelationships(
      relationshipIds: string[],
      keepEvidenceKeys: Set<string> = new Set(),
    ): Promise<number> {
      if (relationshipIds.length === 0) return 0;
      let query = db
        .deleteFrom("entity_relationship_evidence")
        .where("relationship_id", "in", relationshipIds)
        .where("note", "like", "structural_assignee:%");
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
        .where((eb) => eb.not(eb.and([eb("relationship_type", "=", "works_at"), eb("source", "=", "email_domain")])))
        .where((eb) =>
          eb.not(
            eb.and([
              eb("source", "in", [...PROTECTED_RELATIONSHIP_SOURCES]),
              eb("relationship_type", "in", [...PROTECTED_RELATIONSHIP_TYPES]),
            ]),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("entity_relationship_evidence")
                .select(sql`1`.as("x"))
                .whereRef("entity_relationship_evidence.relationship_id", "=", "entity_relationships.id"),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async deleteRelationshipEvidenceForFiles(fileIds: string[]): Promise<number> {
      if (fileIds.length === 0) return 0;
      const result = await db
        .deleteFrom("entity_relationship_evidence")
        .where("indexed_file_id", "in", fileIds)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async relationshipIdsWithEvidenceInFiles(fileIds: string[]): Promise<string[]> {
      if (fileIds.length === 0) return [];
      const rows = await db
        .selectFrom("entity_relationship_evidence")
        .select("relationship_id")
        .distinct()
        .where("indexed_file_id", "in", fileIds)
        .execute();
      return rows.map((row) => row.relationship_id);
    },

    async deleteEmptyRelationshipsByIds(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const result = await db
        .deleteFrom("entity_relationships")
        .where("id", "in", ids)
        .where((eb) =>
          eb.not(
            eb.and([
              eb("source", "in", [...PROTECTED_RELATIONSHIP_SOURCES]),
              eb("relationship_type", "in", [...PROTECTED_RELATIONSHIP_TYPES]),
            ]),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("entity_relationship_evidence")
                .select(sql`1`.as("x"))
                .whereRef("entity_relationship_evidence.relationship_id", "=", "entity_relationships.id"),
            ),
          ),
        )
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

import { whereLiveEntity } from "../db/repositories/entities";
import { inferAffiliationFromEmail } from "./affiliations";
import { registerEntity } from "./materialize-deps";
import { isString, readJsonObject } from "./materialize-json";
import { createMentionFromFact } from "./materialize-mentions";
import type { EntityRow, IndexedFileFactRow, MaterializeDeps, MaterializeResult } from "./materialize-types";
import { proposeEntity } from "./propose";
import { type RankedCandidate, rankPersonLlmMention } from "./rank";

const PERSON_FACT_RELATION = {
  attendee: "attended",
  correspondent: "corresponded",
  assignee: "assigned",
  author: "authored",
  llm_extracted: "mentioned",
} as const;

export async function materializePersonSeed(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  if (!fact.subject_name || !fact.subject_source || !fact.subject_source_id) {
    return { kind: "skipped", reason: "missing_person_seed_subject" };
  }
  const triggeredByUserId = deps.resolveOwner(fact);
  if (!triggeredByUserId) return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };
  const raw = readJsonObject(fact.raw);
  const subtype = raw.subtype === "internal" ? "internal" : "external";
  const result = await proposeEntity(
    {
      entityRepo: deps.entityRepo,
      reviewRepo: deps.reviewRepo,
      domainsRepo: deps.domainsRepo,
      lookup: deps.lookup,
      readEmail: deps.readEmail,
      onEntityResolved: deps.onEntityResolved,
    },
    {
      name: fact.subject_name,
      email: fact.subject_email ?? null,
      entityType: "person",
      subtype,
      source: fact.subject_source,
      sourceId: fact.subject_source_id,
      evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
      triggeredByUserId,
      strictPersonScopeGate: true,
    },
  );
  if (result.kind === "queued") return { kind: "queued", reviewId: result.reviewId };
  const entity = result.entity as unknown as EntityRow;
  deps.index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity);
  registerEntity(deps.index, entity);
  await inferAffiliationFromEmail(
    { db: deps.db, domainsRepo: deps.domainsRepo },
    {
      personEntityId: entity.id,
      email: fact.subject_email,
      evidenceFileId: fact.indexed_file_id,
      firstObservedByUserId: triggeredByUserId,
    },
  );
  await deps.onEntityResolved(entity);
  return { kind: "structural", entity };
}

async function buildPersonRankerContext(
  deps: MaterializeDeps,
  indexedFileId: string | null,
): Promise<{
  fileId: string;
  extractedPersons: Array<{ entityId: string }>;
  extractedCompanies: Array<{ entityId: string; domain?: string }>;
  contextCompanies: Array<{ entityId: string }>;
}> {
  if (!indexedFileId) {
    return { fileId: "", extractedPersons: [], extractedCompanies: [], contextCompanies: [] };
  }
  const mentions = await deps.db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entity_mentions.entity_id", "entity_mentions.confidence", "entities.source_type"])
    .where("entity_mentions.indexed_file_id", "=", indexedFileId)
    .where(whereLiveEntity())
    .execute();

  const extractedPersons = mentions
    .filter((row) => row.source_type === "person" && row.confidence === "EXTRACTED")
    .map((row) => ({ entityId: row.entity_id }));
  const extractedCompanyIds = mentions
    .filter((row) => row.source_type === "company" && row.confidence === "EXTRACTED")
    .map((row) => row.entity_id);
  const contextCompanies = mentions
    .filter((row) => row.source_type === "company")
    .map((row) => ({ entityId: row.entity_id }));
  const domainRows =
    extractedCompanyIds.length > 0
      ? await deps.db
          .selectFrom("entity_domains")
          .select(["entity_id", "domain"])
          .where("entity_id", "in", extractedCompanyIds)
          .execute()
      : [];
  const domainsByEntity = new Map(domainRows.map((row) => [row.entity_id, row.domain]));

  return {
    fileId: indexedFileId,
    extractedPersons,
    extractedCompanies: extractedCompanyIds.map((entityId) => ({ entityId, domain: domainsByEntity.get(entityId) })),
    contextCompanies,
  };
}

async function loadWorksAtCompanies(
  deps: MaterializeDeps,
  personEntityIds: string[],
): Promise<Map<string, Set<string>>> {
  if (personEntityIds.length === 0) return new Map();
  const rows = await deps.db
    .selectFrom("entity_relationships")
    .select(["source_entity_id", "target_entity_id"])
    .where("relationship_type", "=", "works_at")
    .where("source_entity_id", "in", personEntityIds)
    .where("valid_to", "is", null)
    .execute();
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = out.get(row.source_entity_id);
    if (bucket) bucket.add(row.target_entity_id);
    else out.set(row.source_entity_id, new Set([row.target_entity_id]));
  }
  return out;
}

export async function materializePersonFact(
  deps: MaterializeDeps,
  fact: IndexedFileFactRow,
): Promise<MaterializeResult> {
  if (!fact.subject_name) {
    return { kind: "skipped", reason: "missing_person_subject" };
  }
  const factType = fact.fact_type as keyof typeof PERSON_FACT_RELATION;
  const relation = PERSON_FACT_RELATION[factType];
  const confidence = fact.fact_type === "llm_extracted" ? "INFERRED" : "EXTRACTED";
  const mentionSource = fact.fact_type === "llm_extracted" ? "llm_extraction" : `${fact.source}_${fact.fact_type}`;
  const subtype = fact.subject_email ? "external" : "external";

  let entity: EntityRow | null = null;
  if (fact.subject_source && fact.subject_source_id) {
    const refKey = `${fact.subject_source}:${fact.subject_source_id}`;
    const cached = deps.index.bySourceRef.get(refKey);
    if (cached) {
      entity = cached;
    }
  }

  let resultKind: "entity_created" | "entity_linked" = "entity_linked";
  if (!entity) {
    const source = fact.subject_source ?? fact.source;
    const sourceId =
      fact.subject_source_id ?? `${fact.indexed_file_id ?? "no-file"}:${fact.subject_email ?? fact.subject_name}`;
    const triggeredByUserId = deps.resolveOwner(fact);
    if (!triggeredByUserId) {
      return { kind: "skipped_missing_owner", reason: "missing_fact_owner" };
    }

    const raw = readJsonObject(fact.raw);
    const variations = Array.isArray(raw.variations) ? raw.variations.filter(isString) : [];
    let precomputedCandidates: RankedCandidate[] | undefined;
    let skipFuzzy = false;

    if (fact.fact_type === "llm_extracted") {
      const candidates = deps.lookup.listByType("person");
      const context = await buildPersonRankerContext(deps, fact.indexed_file_id);
      const worksAtByPerson = await loadWorksAtCompanies(
        deps,
        candidates.map((candidate) => candidate.id),
      );
      const decision = rankPersonLlmMention(
        { name: fact.subject_name, aliases: variations, entityType: "person" },
        candidates,
        context,
        (entityId) => [...(worksAtByPerson.get(entityId) ?? [])],
      );
      if (decision.kind === "confident_match") {
        entity = decision.entity as unknown as EntityRow;
        resultKind = "entity_linked";
      } else if (decision.kind === "ambiguous_existing") {
        precomputedCandidates = decision.candidates;
      } else if (decision.kind === "ambiguous_new_entity") {
        precomputedCandidates = decision.candidates;
      } else if (decision.kind === "confident_no_match") {
        skipFuzzy = true;
      }
    }

    if (!entity) {
      const result = await proposeEntity(
        {
          entityRepo: deps.entityRepo,
          reviewRepo: deps.reviewRepo,
          domainsRepo: deps.domainsRepo,
          lookup: deps.lookup,
          readEmail: deps.readEmail,
          onEntityResolved: deps.onEntityResolved,
        },
        {
          name: fact.subject_name,
          email: fact.subject_email ?? null,
          entityType: "person",
          subtype,
          source,
          sourceId,
          evidence: fact.indexed_file_id ? [{ indexedFileId: fact.indexed_file_id }] : [],
          triggeredByUserId,
          aliases: variations,
          precomputedCandidates,
          skipFuzzy,
        },
      );
      if (result.kind === "queued") {
        if (fact.fact_type === "llm_extracted") {
          return { kind: "queued_held", reviewId: result.reviewId, reason: "llm_ambiguous" };
        }
        return { kind: "queued", reviewId: result.reviewId };
      }
      entity = result.entity as unknown as EntityRow;
      resultKind = result.kind === "created" ? "entity_created" : "entity_linked";
      registerEntity(deps.index, entity);
      if (fact.subject_source && fact.subject_source_id) {
        deps.index.bySourceRef.set(`${fact.subject_source}:${fact.subject_source_id}`, entity);
      }
    }
  }

  if (entity && fact.subject_email) {
    await inferAffiliationFromEmail(
      { db: deps.db, domainsRepo: deps.domainsRepo },
      {
        personEntityId: entity.id,
        email: fact.subject_email,
        evidenceFileId: fact.indexed_file_id,
        firstObservedByUserId: fact.created_by_user_id,
      },
    );
    await deps.onEntityResolved(entity);
  }

  if (!entity || !fact.indexed_file_id) return { kind: resultKind, entity, mentionWritten: false };
  await createMentionFromFact(deps, {
    entityId: entity.id,
    indexedFileId: fact.indexed_file_id,
    contextSnippet: fact.context_snippet ?? null,
    confidence,
    source: mentionSource,
    relation,
  });
  return { kind: resultKind, entity, mentionWritten: true };
}

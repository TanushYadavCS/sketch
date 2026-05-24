import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB, EntitiesTable } from "../db/schema";
import { type Entity, type EntityLookup, proposeEntity } from "./propose";

export const DOMAIN_PROMOTION_THRESHOLD = 1;

export interface DomainSweepResult {
  scanned: number;
  promoted: number;
  linkedExisting: number;
  pendingFuzzy: number;
  worksAtCreated: number;
}

export class FinalizerConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalizerConflict";
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
  return [];
}

function readEmail(entity: Entity): string | null {
  if (!entity.metadata) return null;
  try {
    const metadata = JSON.parse(entity.metadata);
    return typeof metadata.email === "string" ? metadata.email : null;
  } catch {
    return null;
  }
}

function makeLookup(entities: Entity[]): EntityLookup {
  return {
    getByNormalizedName: () => [],
    getByAlias: () => [],
    listByType: (t) => entities.filter((e) => e.source_type === t),
  };
}

async function attachDomainCandidate(db: Kysely<DB>, reviewId: string, candidateId: string): Promise<void> {
  await db
    .insertInto("entity_review_domain_candidates")
    .values({ review_id: reviewId, domain_candidate_id: candidateId })
    .onConflict((oc) => oc.columns(["review_id", "domain_candidate_id"]).doNothing())
    .execute();
}

export async function finalizeDomainPromotion(
  db: Kysely<DB>,
  input: {
    candidateId: string;
    domain: string;
    companyEntityId: string;
    evidenceFileIds: string[];
    observedPersonEntityIds: string[];
  },
): Promise<void> {
  const candidate = await db
    .selectFrom("entity_candidates")
    .select(["id", "promoted_entity_id"])
    .where("id", "=", input.candidateId)
    .executeTakeFirst();
  if (!candidate) return;
  if (candidate.promoted_entity_id) {
    if (candidate.promoted_entity_id === input.companyEntityId) return;
    throw new FinalizerConflict(
      `domain candidate ${input.candidateId} already promoted to ${candidate.promoted_entity_id}`,
    );
  }

  const domainsRepo = createEntityDomainsRepository(db);
  const entityRepo = createEntityRepository(db);
  await domainsRepo.upsertDomain({
    entityId: input.companyEntityId,
    domain: input.domain,
    kind: "corporate",
    source: "observed",
    confidence: 0.9,
    isPrimary: true,
  });

  for (const personId of input.observedPersonEntityIds) {
    const relationshipId = await domainsRepo.upsertWorksAt({
      personEntityId: personId,
      companyEntityId: input.companyEntityId,
      confidence: "INFERRED",
      confidenceScore: 0.9,
      source: "email_domain",
    });
    for (const fileId of input.evidenceFileIds) {
      await domainsRepo.addEvidence(relationshipId, fileId, -1, `domain_promotion:${input.domain}`);
    }
  }

  for (const fileId of input.evidenceFileIds) {
    await entityRepo.createMention({
      entityId: input.companyEntityId,
      indexedFileId: fileId,
      confidence: "INFERRED",
      source: "email_domain",
      relation: "mentioned",
    });
  }

  const updated = await db
    .updateTable("entity_candidates")
    .set({ promoted_entity_id: input.companyEntityId, updated_at: new Date().toISOString() })
    .where("id", "=", input.candidateId)
    .where("promoted_entity_id", "is", null)
    .execute();
  if (Number(updated[0]?.numUpdatedRows ?? 0) > 0) return;

  const refreshed = await db
    .selectFrom("entity_candidates")
    .select("promoted_entity_id")
    .where("id", "=", input.candidateId)
    .executeTakeFirst();
  if (refreshed?.promoted_entity_id && refreshed.promoted_entity_id !== input.companyEntityId) {
    throw new FinalizerConflict(
      `domain candidate ${input.candidateId} promoted concurrently to ${refreshed.promoted_entity_id}`,
    );
  }
}

export async function finalizeLinkedDomainCandidates(db: Kysely<DB>, reviewId: string, companyEntityId: string) {
  const rows = await db
    .selectFrom("entity_review_domain_candidates")
    .innerJoin("entity_candidates", "entity_candidates.id", "entity_review_domain_candidates.domain_candidate_id")
    .selectAll("entity_candidates")
    .where("entity_review_domain_candidates.review_id", "=", reviewId)
    .execute();

  for (const candidate of rows) {
    if (!candidate.domain) continue;
    await finalizeDomainPromotion(db, {
      candidateId: candidate.id,
      domain: candidate.domain,
      companyEntityId,
      evidenceFileIds: parseStringArray(candidate.evidence_file_ids),
      observedPersonEntityIds: parseStringArray(candidate.observed_person_entity_ids),
    });
  }
}

export async function sweepDomainPromotions(db: Kysely<DB>, logger: Logger): Promise<DomainSweepResult> {
  const result: DomainSweepResult = {
    scanned: 0,
    promoted: 0,
    linkedExisting: 0,
    pendingFuzzy: 0,
    worksAtCreated: 0,
  };

  const domainsRepo = createEntityDomainsRepository(db);
  const entityRepo = createEntityRepository(db);
  const candidates = await db
    .selectFrom("entity_candidates")
    .selectAll()
    .where("type", "=", "domain_observation")
    .where("promoted_entity_id", "is", null)
    .where("seen_count", ">=", DOMAIN_PROMOTION_THRESHOLD)
    .execute();

  result.scanned = candidates.length;
  const allEntities = (await db.selectFrom("entities").selectAll().execute()) as Selectable<EntitiesTable>[];
  const lookup = makeLookup(allEntities);

  for (const candidate of candidates) {
    const domain = candidate.domain;
    const proposedName = candidate.proposed_company_name ?? candidate.name;
    if (!domain || !proposedName) continue;
    const observedPeople = parseStringArray(candidate.observed_person_entity_ids);
    const evidenceFiles = parseStringArray(candidate.evidence_file_ids);

    const existingCorporate = await domainsRepo.lookupCompanyByDomain(domain);
    if (existingCorporate) {
      await finalizeDomainPromotion(db, {
        candidateId: candidate.id,
        domain,
        companyEntityId: existingCorporate.id,
        evidenceFileIds: evidenceFiles,
        observedPersonEntityIds: observedPeople,
      });
      result.linkedExisting++;
      result.worksAtCreated += observedPeople.length;
      continue;
    }

    const proposal = await proposeEntity(
      {
        entityRepo,
        reviewRepo: createEntityReviewRepo(db),
        lookup,
        readEmail,
      },
      {
        name: proposedName,
        entityType: "company",
        subtype: "external",
        source: "domain_promotion",
        sourceId: `domain:${domain}`,
        evidence: evidenceFiles.map((indexedFileId) => ({ indexedFileId, note: `domain_promotion:${domain}` })),
        triggeredByUserId: candidate.first_observed_by_user_id ?? "system",
        metadata: { origin: "domain_promotion", domain },
      },
    );

    if (proposal.kind === "queued") {
      await attachDomainCandidate(db, proposal.reviewId, candidate.id);
      result.pendingFuzzy++;
      logger.info({ domain, proposedName, reviewId: proposal.reviewId }, "Domain candidate queued for review");
      continue;
    }

    await finalizeDomainPromotion(db, {
      candidateId: candidate.id,
      domain,
      companyEntityId: proposal.entity.id,
      evidenceFileIds: evidenceFiles,
      observedPersonEntityIds: observedPeople,
    });
    if (proposal.kind === "created") result.promoted++;
    else result.linkedExisting++;
    result.worksAtCreated += observedPeople.length;
  }

  if (result.scanned > 0) {
    logger.info({ result }, "Domain promotion sweep complete");
  }
  return result;
}

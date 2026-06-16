/**
 * ELP-02 affiliation inference — three load-bearing tests covering distinct
 * failure modes:
 *
 * 1. Personal/shared seed domains block `works_at` inference. If this breaks,
 *    we silently declare "57 people work at gmail.com".
 * 2. Threshold promotion auto-creates a collision-free company and writes the
 *    works_at edges. If this breaks, the candidate accumulation path
 *    delivers no graph value.
 * 3. Recreate (reset → replay → sweep) rebuilds the same `works_at` edges
 *    that live sync produces. If this breaks, recreate silently loses
 *    affiliation data and recreate parity is no longer a reliable backfill.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepDomainPromotions } from "../connectors/smart-enrichment";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { inferAffiliationFromEmail, isProviderManagedEmailDomain } from "./affiliations";
import { recreateEntityGraph } from "./recreate";
import { confirmReview } from "./resolve";

const ADMIN_ID = "admin-elp02";
const CONNECTOR_ID = "cfg-elp02";

async function seedAdminAndConnector(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: ADMIN_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "fireflies",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<string> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: id,
      file_type: "meeting",
      content_category: "meeting",
      source: "fireflies",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: now,
    })
    .execute();
  return id;
}

async function seedPersonSeedFact(
  db: Kysely<DB>,
  args: { fileId: string; name: string; email: string; sourceId: string },
): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: args.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ADMIN_ID,
    contentHash: `hash-${args.fileId}`,
    source: "fireflies",
    factType: "person_seed",
    relation: "seeded",
    subjectName: args.name,
    subjectEmail: args.email,
    subjectSource: "fireflies",
    subjectSourceId: args.sourceId,
    raw: { subtype: "external" },
  });
}

describe("ELP-02: affiliation inference", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdminAndConnector(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("personal-domain seeds block works_at inference and candidate accumulation", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);
    // gmail.com is one of the migration-seeded personal rows.
    const fileId = await seedFile(db, "f1");
    const person = await entityRepo.upsertPersonEntity({
      name: "Alex Personal",
      email: "alex@gmail.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "person-gmail",
    });

    await inferAffiliationFromEmail(
      { db, domainsRepo },
      { personEntityId: person.id, email: "alex@gmail.com", evidenceFileId: fileId },
    );

    const relationships = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(relationships).toHaveLength(0);
    const observations = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("type", "=", "domain_observation")
      .execute();
    expect(observations).toHaveLength(0);
    // Personal/shared seed row is still present (sanity).
    const gmailRow = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "gmail.com")
      .executeTakeFirst();
    expect(gmailRow?.kind).toBe("personal");
    expect(gmailRow?.entity_id).toBeNull();
  });

  it("a single demo prospect promotes the company immediately (threshold=1) with a works_at edge", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);
    const fileId = await seedFile(db, "file-solo");
    const person = await entityRepo.upsertPersonEntity({
      name: "Solo Prospect",
      email: "solo@solodemo.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "solo-1",
    });
    await inferAffiliationFromEmail(
      { db, domainsRepo },
      { personEntityId: person.id, email: "solo@solodemo.com", evidenceFileId: fileId },
    );

    const result = await sweepDomainPromotions(db, createTestLogger());
    expect(result.promoted).toBe(1);
    expect(result.worksAtCreated).toBe(1);

    const corporate = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "solodemo.com")
      .executeTakeFirstOrThrow();
    expect(corporate.kind).toBe("corporate");
    expect(corporate.entity_id).not.toBeNull();
    const worksAt = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("source_entity_id", "=", person.id)
      .where("relationship_type", "=", "works_at")
      .execute();
    expect(worksAt).toHaveLength(1);

    // Mention timeline: the company should show up in entity_mentions for
    // the evidence file. Without this the UI drawer reads "No mentions yet"
    // even when the works_at graph is healthy.
    const companyMentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", corporate.entity_id as string)
      .execute();
    expect(companyMentions).toHaveLength(1);
    expect(companyMentions[0].indexed_file_id).toBe(fileId);
    expect(companyMentions[0].source).toBe("email_domain");
  });

  it("role-account local-parts (hello@, support@, info@) skip works_at and candidate accumulation", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);
    const fileId = await seedFile(db, "file-role");
    const sharedMailbox = await entityRepo.upsertPersonEntity({
      name: "Notifications Bot",
      email: "support@vendorco.com",
      subtype: "external",
      source: "fireflies",
      sourceId: "vendor-support",
    });
    await inferAffiliationFromEmail(
      { db, domainsRepo },
      { personEntityId: sharedMailbox.id, email: "support@vendorco.com", evidenceFileId: fileId },
    );

    const observations = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("type", "=", "domain_observation")
      .execute();
    expect(observations).toHaveLength(0);
    const rels = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(rels).toHaveLength(0);
  });

  it("provider-managed calendar domains skip works_at and candidate accumulation", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);
    const fileId = await seedFile(db, "file-calendar-resource");
    const calendarResource = await entityRepo.upsertPersonEntity({
      name: "Calendar Resource",
      email: "c_room@group.calendar.google.com",
      subtype: "external",
      source: "google_calendar",
      sourceId: "calendar-resource",
    });

    await inferAffiliationFromEmail(
      { db, domainsRepo },
      {
        personEntityId: calendarResource.id,
        email: "c_room@group.calendar.google.com",
        evidenceFileId: fileId,
      },
    );

    expect(isProviderManagedEmailDomain("group.v.calendar.google.com")).toBe(true);
    const observations = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("type", "=", "domain_observation")
      .execute();
    expect(observations).toHaveLength(0);
    const rels = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(rels).toHaveLength(0);
  });

  it("multiple people on the same novel domain produce one company and N distinct works_at edges", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);

    const personIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const fileId = await seedFile(db, `file-charlie-${i}`);
      const person = await entityRepo.upsertPersonEntity({
        name: `Charlie Person ${i}`,
        email: `person${i}@charlie.com`,
        subtype: "external",
        source: "fireflies",
        sourceId: `charlie-${i}`,
      });
      personIds.push(person.id);
      await inferAffiliationFromEmail(
        { db, domainsRepo },
        { personEntityId: person.id, email: `person${i}@charlie.com`, evidenceFileId: fileId },
      );
    }

    // Pre-sweep: structured candidate has 5 observed people, no promotion yet.
    const candidatePre = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("type", "=", "domain_observation")
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(candidatePre.seen_count).toBe(5);
    expect(candidatePre.promoted_entity_id).toBeNull();

    const result = await sweepDomainPromotions(db, createTestLogger());
    expect(result.promoted).toBe(1);
    expect(result.worksAtCreated).toBe(5);
    expect(result.pendingFuzzy).toBe(0);

    const corporateDomain = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(corporateDomain.kind).toBe("corporate");
    expect(corporateDomain.entity_id).not.toBeNull();

    const worksAt = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "works_at")
      .where("target_entity_id", "=", corporateDomain.entity_id as string)
      .execute();
    expect(worksAt).toHaveLength(5);
    expect(new Set(worksAt.map((r) => r.source_entity_id))).toEqual(new Set(personIds));
    expect(worksAt.every((r) => r.confidence === "INFERRED" && r.source === "email_domain")).toBe(true);

    // Second sweep is a no-op — `promoted_entity_id` is set, so the candidate
    // is filtered out and no new relationships appear.
    const second = await sweepDomainPromotions(db, createTestLogger());
    expect(second.scanned).toBe(0);
    const worksAtAfter = await db.selectFrom("entity_relationships").selectAll().execute();
    expect(worksAtAfter).toHaveLength(5);
  });

  it("threshold promotion pauses on fuzzy collision, leaving the candidate pending for ECR-05", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);

    // Pre-existing company "Charlie Health" should fuzzy-collide with the
    // proposed name "Charlie" derived from charlie.com.
    await entityRepo.upsertEntity({
      name: "Charlie Health",
      sourceType: "company",
      status: "confirmed",
    });

    for (let i = 0; i < 5; i++) {
      const fileId = await seedFile(db, `file-charlie-${i}`);
      const person = await entityRepo.upsertPersonEntity({
        name: `Charlie Person ${i}`,
        email: `person${i}@charlie.com`,
        subtype: "external",
        source: "fireflies",
        sourceId: `charlie-${i}`,
      });
      await inferAffiliationFromEmail(
        { db, domainsRepo },
        { personEntityId: person.id, email: `person${i}@charlie.com`, evidenceFileId: fileId },
      );
    }

    const result = await sweepDomainPromotions(db, createTestLogger());
    expect(result.pendingFuzzy).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.worksAtCreated).toBe(0);

    const candidate = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("type", "=", "domain_observation")
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(candidate.promoted_entity_id).toBeNull();

    const corporateDomain = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirst();
    expect(corporateDomain).toBeUndefined();

    const link = await db.selectFrom("entity_review_domain_candidates").selectAll().executeTakeFirstOrThrow();
    const review = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", link.review_id)
      .executeTakeFirstOrThrow();
    expect(review.entity_type).toBe("company");
    expect(review.status).toBe("pending");
    expect(link.domain_candidate_id).toBe(candidate.id);
  });

  it("confirming queued domain promotion finalizes domain, works_at edges, mentions, and candidate", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    const entityRepo = createEntityRepository(db);
    const company = await entityRepo.upsertEntity({
      name: "Charlie Health",
      sourceType: "company",
      status: "confirmed",
    });

    for (let i = 0; i < 3; i++) {
      const fileId = await seedFile(db, `file-confirm-charlie-${i}`);
      const person = await entityRepo.upsertPersonEntity({
        name: `Confirm Charlie Person ${i}`,
        email: `confirm${i}@charlie.com`,
        subtype: "external",
        source: "fireflies",
        sourceId: `confirm-charlie-${i}`,
      });
      await inferAffiliationFromEmail(
        { db, domainsRepo },
        { personEntityId: person.id, email: `confirm${i}@charlie.com`, evidenceFileId: fileId },
      );
    }

    await sweepDomainPromotions(db, createTestLogger());
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    if (!review.candidate_generated_at) throw new Error("missing candidate_generated_at");

    await confirmReview({ db, userId: ADMIN_ID }, review.id, { candidateGeneratedAt: review.candidate_generated_at });

    const candidate = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(candidate.promoted_entity_id).toBe(company.id);

    const domain = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(domain.entity_id).toBe(company.id);

    const worksAt = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("target_entity_id", "=", company.id)
      .where("relationship_type", "=", "works_at")
      .execute();
    expect(worksAt).toHaveLength(3);

    const mentions = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", company.id).execute();
    expect(mentions.map((m) => m.indexed_file_id).sort()).toEqual([
      "file-confirm-charlie-0",
      "file-confirm-charlie-1",
      "file-confirm-charlie-2",
    ]);
  });

  it("recreate replays facts and triggers threshold promotion identically to live sync", async () => {
    // Five durable person_seed facts with a novel corporate domain. No
    // pre-existing company; this is the replay analogue of plan acceptance
    // test 18 — recreate must reproduce the same graph shape (one promoted
    // company, one corporate domain row, five works_at edges) as live sync
    // crossing the threshold organically.
    const names = ["Charlie Adams", "Priya Rao", "Mateo Silva", "Noor Khan", "Elena Ivers"];
    for (let i = 0; i < names.length; i++) {
      const fileId = await seedFile(db, `charlie-file-${i}`);
      await seedPersonSeedFact(db, {
        fileId,
        name: names[i],
        email: `person${i}@charlie.com`,
        sourceId: `charlie-${i}`,
      });
    }

    const summary = await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: ADMIN_ID,
      skipEnrichment: true,
    });
    expect(summary.replay.factsRead).toBe(5);

    const corporateDomain = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(corporateDomain.kind).toBe("corporate");
    expect(corporateDomain.source).toBe("observed");
    expect(corporateDomain.entity_id).not.toBeNull();

    const worksAt = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "works_at")
      .where("target_entity_id", "=", corporateDomain.entity_id as string)
      .execute();
    expect(worksAt).toHaveLength(5);

    // Running recreate a second time is idempotent — same counts, no growth.
    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: ADMIN_ID,
      skipEnrichment: true,
    });
    const worksAtAfter = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "works_at")
      .execute();
    expect(worksAtAfter).toHaveLength(5);

    // Personal/shared seeds survive reset (they're source='manual').
    const gmail = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "gmail.com")
      .executeTakeFirstOrThrow();
    expect(gmail.kind).toBe("personal");
    expect(gmail.source).toBe("manual");
  });

  it("recreate preserves and relinks manual corporate domain overrides", async () => {
    const entityRepo = createEntityRepository(db);
    const oldCompany = await entityRepo.upsertEntity({
      name: "Manual Charlie",
      sourceType: "company",
      status: "confirmed",
    });
    await db
      .insertInto("entity_domains")
      .values({
        id: "manual-charlie-domain",
        entity_id: oldCompany.id,
        domain: "charlie.com",
        kind: "corporate",
        is_primary: 1,
        confidence: 1,
        source: "manual",
      })
      .execute();

    const names = ["Manual Charlie", "Iris Quinn", "Omar Reed", "Lina Soto", "Victor Tan"];
    for (let i = 0; i < names.length; i++) {
      const fileId = await seedFile(db, `manual-charlie-file-${i}`);
      await seedPersonSeedFact(db, {
        fileId,
        name: names[i],
        email: `manual${i}@charlie.com`,
        sourceId: `manual-charlie-${i}`,
      });
    }

    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: ADMIN_ID,
      skipEnrichment: true,
    });

    const domain = await db
      .selectFrom("entity_domains")
      .selectAll()
      .where("domain", "=", "charlie.com")
      .executeTakeFirstOrThrow();
    expect(domain.id).toBe("manual-charlie-domain");
    expect(domain.kind).toBe("corporate");
    expect(domain.source).toBe("manual");
    expect(domain.entity_id).not.toBeNull();
    expect(domain.entity_id).not.toBe(oldCompany.id);

    const linkedCompany = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", domain.entity_id as string)
      .executeTakeFirstOrThrow();
    expect(linkedCompany.source_type).toBe("company");

    const worksAt = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "works_at")
      .where("target_entity_id", "=", domain.entity_id as string)
      .execute();
    expect(worksAt).toHaveLength(5);
  });
});

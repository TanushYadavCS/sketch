import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityDomainsRepository, normalizeWebsiteDomain, relationshipSourceRank } from "./entity-domains";

describe("entity domains repository", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  async function seedCompany(id: string, name: string) {
    await seedEntity(id, name, "company");
  }

  async function seedEntity(id: string, name: string, sourceType: string) {
    if (!db) throw new Error("missing db");
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: sourceType,
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedFile(id: string) {
    if (!db) throw new Error("missing db");
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values({ id: "domain-user", name: "Domain User", email: "domain@example.com" })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "domain-connector",
        connector_type: "fireflies",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "domain-user",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "domain-connector",
        provider_file_id: id,
        file_name: `${id}.txt`,
        file_type: "meeting",
        content_category: "meeting",
        source: "fireflies",
        content_hash: `hash-${id}`,
        is_archived: 0,
        synced_at: now,
      })
      .execute();
  }

  it("normalizes website domains without treating URL paths as hosts", () => {
    expect(normalizeWebsiteDomain("https://www.acme.com/path?q=1")).toBe("acme.com");
    expect(normalizeWebsiteDomain("acme.com/about")).toBe("acme.com");
    expect(normalizeWebsiteDomain("localhost:3000")).toBeNull();
    expect(normalizeWebsiteDomain("127.0.0.1")).toBeNull();
  });

  it("ranks contributes_to sources for conflict ownership", () => {
    expect(relationshipSourceRank("structural_assignee")).toBe(3);
    expect(relationshipSourceRank("llm_extraction")).toBe(2);
    expect(relationshipSourceRank("co_mention")).toBe(1);
    expect(relationshipSourceRank("manual")).toBe(0);
  });

  it("claims safe authoritative corporate domains and skips personal/shared seeds", async () => {
    db = await createTestDb();
    await seedCompany("acme", "Acme Corp");
    const domainsRepo = createEntityDomainsRepository(db);

    await expect(
      domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: "acme",
        domain: "acme.com",
        source: "zoho_crm",
        confidence: 1,
        isPrimary: true,
      }),
    ).resolves.toBe("inserted");
    await expect(
      domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: "acme",
        domain: "gmail.com",
        source: "zoho_crm",
        confidence: 1,
        isPrimary: true,
      }),
    ).resolves.toBe("skipped_personal_or_shared");

    const rows = await db
      .selectFrom("entity_domains")
      .select(["domain", "kind", "source", "entity_id"])
      .where("domain", "in", ["acme.com", "gmail.com"])
      .orderBy("domain")
      .execute();
    expect(rows).toEqual([
      { domain: "acme.com", kind: "corporate", source: "zoho_crm", entity_id: "acme" },
      { domain: "gmail.com", kind: "personal", source: "manual", entity_id: null },
    ]);
  });

  it("isPersonalOrShared recognizes providers from the code constant even with no seed row", async () => {
    db = await createTestDb();
    const domainsRepo = createEntityDomainsRepository(db);
    // Simulate a rebuild/purge that wiped the migration-064 personal seed.
    await db.deleteFrom("entity_domains").execute();

    expect(await domainsRepo.isPersonalOrShared("gmail.com")).toBe(true);
    expect(await domainsRepo.isPersonalOrShared("ICLOUD.COM")).toBe(true);
    expect(await domainsRepo.isPersonalOrShared("acme.com")).toBe(false);

    // A poisoned corporate row must not flip a known provider back to false.
    await db
      .insertInto("entity_domains")
      .values({
        id: "d-poison",
        entity_id: null,
        domain: "gmail.com",
        kind: "corporate",
        is_primary: 0,
        confidence: 0.9,
        source: "observed",
      })
      .execute();
    expect(await domainsRepo.isPersonalOrShared("gmail.com")).toBe(true);
  });

  it("does not reassign manually or automatically owned domains to CRM Accounts", async () => {
    db = await createTestDb();
    await seedCompany("acme", "Acme Corp");
    await seedCompany("globex", "Globex");
    const domainsRepo = createEntityDomainsRepository(db);
    await domainsRepo.upsertDomain({
      entityId: "globex",
      domain: "manual.com",
      kind: "corporate",
      source: "manual",
      confidence: 1,
      isPrimary: true,
    });
    await domainsRepo.upsertDomain({
      entityId: "globex",
      domain: "auto.com",
      kind: "corporate",
      source: "observed",
      confidence: 0.8,
      isPrimary: true,
    });

    await expect(
      domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: "acme",
        domain: "manual.com",
        source: "zoho_crm",
        confidence: 1,
      }),
    ).resolves.toBe("skipped_manual_conflict");
    await expect(
      domainsRepo.upsertAuthoritativeCorporateDomain({
        entityId: "acme",
        domain: "auto.com",
        source: "zoho_crm",
        confidence: 1,
      }),
    ).resolves.toBe("skipped_auto_conflict");

    const rows = await db
      .selectFrom("entity_domains")
      .select(["domain", "source", "entity_id"])
      .where("domain", "in", ["auto.com", "manual.com"])
      .orderBy("domain")
      .execute();
    expect(rows).toEqual([
      { domain: "auto.com", source: "observed", entity_id: "globex" },
      { domain: "manual.com", source: "manual", entity_id: "globex" },
    ]);
  });

  it("lets higher ranked contributes_to sources take ownership on conflict", async () => {
    db = await createTestDb();
    await seedEntity("person-rank-up", "Priya", "person");
    await seedEntity("project-rank-up", "Project Atlas", "project");
    const domainsRepo = createEntityDomainsRepository(db);

    await domainsRepo.upsertRelationship({
      sourceEntityId: "person-rank-up",
      targetEntityId: "project-rank-up",
      relationshipType: "contributes_to",
      confidence: "INFERRED",
      confidenceScore: 0.84,
      source: "co_mention",
    });
    await domainsRepo.upsertRelationship({
      sourceEntityId: "person-rank-up",
      targetEntityId: "project-rank-up",
      relationshipType: "contributes_to",
      confidence: "EXTRACTED",
      confidenceScore: 0.9,
      source: "llm_extraction",
    });

    const row = await db.selectFrom("entity_relationships").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source: "llm_extraction",
      confidence: "EXTRACTED",
      confidence_score: 0.9,
    });
  });

  it("preserves source and confidence when an existing contributes_to source outranks the incoming source", async () => {
    db = await createTestDb();
    await seedEntity("person-rank-guard", "Meera", "person");
    await seedEntity("project-rank-guard", "Project Guard", "project");
    const domainsRepo = createEntityDomainsRepository(db);

    await domainsRepo.upsertRelationship({
      sourceEntityId: "person-rank-guard",
      targetEntityId: "project-rank-guard",
      relationshipType: "contributes_to",
      confidence: "INFERRED",
      confidenceScore: 0.9,
      source: "structural_assignee",
    });
    await domainsRepo.upsertRelationship({
      sourceEntityId: "person-rank-guard",
      targetEntityId: "project-rank-guard",
      relationshipType: "contributes_to",
      confidence: "EXTRACTED",
      confidenceScore: 0.97,
      source: "llm_extraction",
    });

    const row = await db.selectFrom("entity_relationships").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source: "structural_assignee",
      confidence: "INFERRED",
      confidence_score: 0.97,
    });
  });

  it("prunes structural assignee evidence by task note while preserving other evidence", async () => {
    db = await createTestDb();
    await seedEntity("person-prune", "Nina", "person");
    await seedEntity("project-prune", "Project Prune", "project");
    await seedFile("prune-file");
    const domainsRepo = createEntityDomainsRepository(db);
    const relationshipId = await domainsRepo.upsertRelationship({
      sourceEntityId: "person-prune",
      targetEntityId: "project-prune",
      relationshipType: "contributes_to",
      confidence: "INFERRED",
      confidenceScore: 0.9,
      source: "structural_assignee",
    });
    const keepNote = "structural_assignee:task:keep-task";
    const staleNote = "structural_assignee:task:stale-task";
    await domainsRepo.addEvidence({ relationshipId, indexedFileId: "prune-file", note: keepNote, sourceFactId: null });
    await domainsRepo.addEvidence({ relationshipId, indexedFileId: "prune-file", note: staleNote, sourceFactId: null });
    await domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: "prune-file",
      note: "llm_relation:contributes_to",
      sourceFactId: null,
    });

    const removed = await domainsRepo.deleteStructuralAssigneeEvidenceForRelationships(
      [relationshipId],
      new Set([`note:${relationshipId}:prune-file:-1:${keepNote}`]),
    );

    const evidence = await db.selectFrom("entity_relationship_evidence").select(["note"]).orderBy("note").execute();
    expect(removed).toBe(1);
    expect(evidence.map((row) => row.note)).toEqual(["llm_relation:contributes_to", keepNote]);
  });
});

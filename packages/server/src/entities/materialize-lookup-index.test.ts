import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { personScopeKey, personScopeKeyId } from "./affiliations";
import { buildLookupIndex, buildMaterializeDeps, registerEntity } from "./materialize-deps";
import { materializeLlmExtractedFact } from "./materialize-llm-mentions";
import { materializeStructuralSeed } from "./materialize-structural";
import type { IndexEntityRow } from "./materialize-types";
import { normalizeEntityMatchName } from "./name-keys";

async function seedEntity(
  db: Kysely<DB>,
  row: {
    id: string;
    name: string;
    sourceType?: string;
    aliases?: string[];
    provenanceTier?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: row.id,
      name: row.name,
      source_type: row.sourceType ?? "company",
      subtype: null,
      aliases: row.aliases ? JSON.stringify(row.aliases) : null,
      metadata: row.metadata ? JSON.stringify(row.metadata) : null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: row.provenanceTier ?? "declared",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedDomain(db: Kysely<DB>, id: string, entityId: string, domain: string): Promise<void> {
  await db
    .insertInto("entity_domains")
    .values({
      id,
      entity_id: entityId,
      domain,
      kind: "corporate",
      is_primary: 0,
      confidence: 1,
      source: "test",
    })
    .execute();
}

async function seedWorksAt(db: Kysely<DB>, id: string, personId: string, companyId: string): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: personId,
      target_entity_id: companyId,
      relationship_type: "works_at",
      confidence: "INFERRED",
      confidence_score: 0.9,
      source: "test",
    })
    .execute();
}

async function seedSourceRef(db: Kysely<DB>, id: string, entityId: string, source: string, sourceId: string) {
  await db
    .insertInto("entity_source_refs")
    .values({ id, entity_id: entityId, source, source_id: sourceId, last_seen_at: "2026" })
    .execute();
}

async function seedOwnerFile(db: Kysely<DB>): Promise<{ ownerId: string; connectorId: string; fileId: string }> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "owner-1",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: "connector-1",
      provider_file_id: "file-1",
      file_name: "Apollo Notes",
      file_type: "document",
      content_category: "document",
      content: "Apollo Program and ApolloProgram refer to the same product.",
      source: "linear",
      content_hash: "hash-file-1",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
  return { ownerId: "owner-1", connectorId: "connector-1", fileId: "file-1" };
}

describe("lookup index row sharing", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("builds person scope keys with the same entries as per-person resolution", async () => {
    await seedEntity(db, { id: "company-acme", name: "Acme", sourceType: "company" });
    await seedEntity(db, { id: "company-works", name: "Works Co", sourceType: "company" });
    await seedDomain(db, "domain-acme", "company-acme", "acme.com");
    await seedEntity(db, {
      id: "person-shared-a",
      name: "Shared One",
      sourceType: "person",
      metadata: { email: "one@habuild.in" },
    });
    await seedEntity(db, {
      id: "person-shared-b",
      name: "Shared Two",
      sourceType: "person",
      metadata: { email: "two@habuild.in" },
    });
    await seedEntity(db, {
      id: "person-corporate",
      name: "Corporate Person",
      sourceType: "person",
      metadata: { email: "corp@acme.com" },
    });
    await seedEntity(db, {
      id: "person-personal",
      name: "Personal Person",
      sourceType: "person",
      metadata: { email: "personal@gmail.com" },
    });
    await seedEntity(db, { id: "person-no-email", name: "No Email", sourceType: "person", metadata: {} });
    await seedWorksAt(db, "works-1", "person-no-email", "company-works");

    const domainsRepo = createEntityDomainsRepository(db);
    const persons = await db
      .selectFrom("entities")
      .select(["id", "metadata"])
      .where("source_type", "=", "person")
      .orderBy("id", "asc")
      .execute();
    const expected = new Map<string, string[]>();
    for (const person of persons) {
      const keys = new Set<string>();
      const metadata = person.metadata ? (JSON.parse(person.metadata) as { email?: string }) : {};
      const scope = await personScopeKey(metadata.email ?? null, domainsRepo);
      if (scope) keys.add(personScopeKeyId(scope));
      const worksAt = await db
        .selectFrom("entity_relationships")
        .select("target_entity_id")
        .where("source_entity_id", "=", person.id)
        .where("relationship_type", "=", "works_at")
        .where("valid_to", "is", null)
        .execute();
      for (const row of worksAt) keys.add(personScopeKeyId({ kind: "company", value: row.target_entity_id }));
      expected.set(person.id, [...keys].sort());
    }

    const deps = await buildMaterializeDeps(db);
    const actual = new Map(
      [...deps.index.personScopeKeysByEntityId].map(([entityId, keys]) => [entityId, [...keys].sort()]),
    );

    expect(actual).toEqual(expected);
    expect(actual.get("person-shared-a")).toEqual(["domain:habuild.in"]);
    expect(actual.get("person-shared-b")).toEqual(["domain:habuild.in"]);
  });

  it("uses the built company domain map for corporate person scope keys", async () => {
    await seedEntity(db, { id: "company-zoho", name: "Zoho Corp", sourceType: "company" });
    await seedDomain(db, "domain-zoho", "company-zoho", "zoho.test");
    await seedEntity(db, {
      id: "person-zoho",
      name: "Zoho Person",
      sourceType: "person",
      metadata: { email: "person@zoho.test" },
    });

    const index = await buildLookupIndex(db, { types: ["person", "company"] });

    expect(index.personScopeKeysByEntityId.get("person-zoho")).toEqual(["company:company-zoho"]);
  });

  it("shares a single row instance across the type, name, alias, and source-ref indexes", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company", aliases: ["Acme Corp"] });
    await seedSourceRef(db, "ref-1", "acme", "hubspot", "company-1");
    await seedSourceRef(db, "ref-2", "acme", "salesforce", "account-1");

    const deps = await buildMaterializeDeps(db);
    const { index } = deps;

    const nameKey = normalizeEntityMatchName("company", "Acme");
    const aliasKey = normalizeEntityMatchName("company", "Acme Corp");
    const byType = index.entitiesByType.get("company") ?? [];
    const byName = index.byNormalizedName.get(nameKey) ?? [];
    const byAlias = index.byNormalizedAlias.get(aliasKey) ?? [];
    const ref1 = index.bySourceRef.get("hubspot:company-1");
    const ref2 = index.bySourceRef.get("salesforce:account-1");

    const shared = byType.find((e) => e.id === "acme");
    expect(shared).toBeDefined();
    expect(byName).toContain(shared);
    expect(byAlias).toContain(shared);
    expect(ref1).toBe(shared);
    expect(ref2).toBe(shared);

    const instances = new Set<IndexEntityRow>([
      shared as IndexEntityRow,
      ...byName,
      ...byAlias,
      ref1 as IndexEntityRow,
      ref2 as IndexEntityRow,
    ]);
    expect(instances.size).toBe(1);
  });

  it("omits wide columns not needed by matching from index rows", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company" });
    await db
      .updateTable("entities")
      .set({ ai_brief: "a very long generated brief" })
      .where("id", "=", "acme")
      .execute();

    const deps = await buildMaterializeDeps(db);
    const shared = (deps.index.entitiesByType.get("company") ?? []).find((e) => e.id === "acme");

    expect(shared).toBeDefined();
    expect((shared as Record<string, unknown>).ai_brief).toBeUndefined();
    expect(shared?.name).toBe("Acme");
    expect(shared?.source_type).toBe("company");
  });

  it("reflows a registerEntity update through the type, name, and alias buckets", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company", aliases: ["Acme Corp"] });

    const deps = await buildMaterializeDeps(db);
    const { index } = deps;

    const oldKey = normalizeEntityMatchName("company", "Acme");
    const aliasKey = normalizeEntityMatchName("company", "Acme Corp");
    const original = (index.entitiesByType.get("company") ?? []).find((e) => e.id === "acme") as IndexEntityRow;
    const updated: IndexEntityRow = { ...original, name: "Acme Renamed" };
    registerEntity(index, updated);

    const newKey = normalizeEntityMatchName("company", "Acme Renamed");
    const byType = index.entitiesByType.get("company") ?? [];
    const renamed = byType.find((e) => e.id === "acme");

    expect(renamed).toBe(updated);
    expect(index.byNormalizedName.get(newKey) ?? []).toContain(updated);
    expect((index.byNormalizedName.get(oldKey) ?? []).some((e) => e.id === "acme")).toBe(false);
    expect(index.byNormalizedAlias.get(aliasKey) ?? []).toContain(updated);
  });

  it("includes structurally registered entities when a candidate pool is built later", async () => {
    const { ownerId, connectorId, fileId } = await seedOwnerFile(db);
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: connectorId,
      createdByUserId: ownerId,
      contentHash: "hash-file-1",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "ApolloProgram",
      subjectSource: "llm_extraction",
      subjectSourceId: "llm:apollo-program-compact",
      raw: {
        contentHash: "hash-file-1",
        promptVersion: "llm-extraction-v13",
        model: "test",
        mention: "ApolloProgram",
        type: "team",
        variations: [],
        confidence: 0.95,
      },
    });
    const llmFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_source_id", "=", "llm:apollo-program-compact")
      .executeTakeFirstOrThrow();
    const deps = await buildMaterializeDeps(db, { llmPromotionThreshold: 1 });
    const structural = await materializeStructuralSeed(deps, {
      ...llmFact,
      id: "structural-apollo-program",
      fact_type: "structural_seed",
      source: "linear",
      subject_name: "Apollo Program",
      subject_source: "linear",
      subject_source_id: "product:apollo-program",
      raw: JSON.stringify({ sourceType: "team" }),
    });
    expect(structural.kind).toBe("structural");
    if (structural.kind !== "structural") throw new Error("expected structural seed");
    expect((deps.index.entitiesByType.get("team") ?? []).map((entity) => entity.id)).toContain(structural.entity.id);
    expect((deps.index.dedupEntriesByType.get("team") ?? []).map((entry) => entry.entityId)).toContain(
      structural.entity.id,
    );
    expect(
      deps.lookup.findNameDedupCandidates?.("team", "ApolloProgram").map((candidate) => candidate.entity.id),
    ).toEqual([structural.entity.id]);

    const linked = await materializeLlmExtractedFact(deps, llmFact);

    expect(linked.kind).toBe("entity_linked");
    if (linked.kind !== "entity_linked") throw new Error("expected linked entity");
    expect(linked.entity.id).toBe(structural.entity.id);
    const products = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("source_type", "=", "team")
      .where("deleted_at", "is", null)
      .execute();
    expect(products).toEqual([{ id: structural.entity.id, name: "Apollo Program" }]);
  });

  it("removes old names from a not-yet-built candidate pool when an entity is re-registered", async () => {
    await seedEntity(db, { id: "orion", name: "Orion Module", sourceType: "product" });
    const deps = await buildMaterializeDeps(db);
    const original = (deps.index.entitiesByType.get("product") ?? []).find((e) => e.id === "orion");
    if (!original) throw new Error("missing seeded product");

    registerEntity(deps.index, { ...original, name: "Zephyr Module" });

    expect(deps.lookup.findNameDedupCandidates?.("product", "OrionModule")).toEqual([]);
    expect(
      deps.lookup.findNameDedupCandidates?.("product", "ZephyrModule").map((candidate) => candidate.entity.id),
    ).toEqual(["orion"]);
  });
});

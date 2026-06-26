import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import { up as cleanupOrphanEntities } from "../migrations/090-orphan-entity-cleanup";
import type { DB } from "../schema";
import { createConnectorRepository } from "./connectors";
import { createEntityRepository, normalizeContactPointValue } from "./entities";

async function seedConnectorConfig(db: Kysely<DB>, id = "config-test"): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: `user-${id}`,
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(
  db: Kysely<DB>,
  id: string,
  connectorId = "config-test",
  opts: { sourceCreatedAt?: string | null; sourceUpdatedAt?: string | null } = {},
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorId,
      provider_file_id: `provider-${id}`,
      file_name: `${id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: opts.sourceUpdatedAt ?? null,
      source_created_at: opts.sourceCreatedAt ?? null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

describe("createEntityRepository createMention", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
    await seedConnectorConfig(db);
    await seedIndexedFile(db, "file-1");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists caller-supplied declared and structural provenance tiers on creation", async () => {
    const declared = await repo.upsertEntity({
      name: "Manual Product",
      sourceType: "product",
      provenanceTier: "declared",
    });
    const structural = await repo.upsertEntityFromTool({
      name: "Seeded Project",
      sourceType: "project",
      source: "linear",
      sourceId: "linear-seeded-project",
      provenanceTier: "structural",
    });

    const rows = await db
      .selectFrom("entities")
      .select(["id", "provenance_tier"])
      .where("id", "in", [declared.id, structural.id])
      .orderBy("provenance_tier", "asc")
      .execute();
    expect(rows).toEqual([
      { id: declared.id, provenance_tier: "declared" },
      { id: structural.id, provenance_tier: "structural" },
    ]);
  });

  it("is idempotent for the same entity, file, and relation", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Beetu",
      email: "beetu@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:beetu",
    });

    const input = {
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED" as const,
      source: "fireflies_attendee",
      relation: "attended" as const,
    };

    await repo.createMention(input);
    await repo.createMention(input);

    const rows = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", entity.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indexed_file_id: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
  });

  it("promotes inferred mentions when an extracted fact arrives for the same relation", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Beetu",
      email: "beetu@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:beetu",
    });

    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      contextSnippet: "Beetu appears in body text",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      contextSnippet: "Parent folder",
      confidence: "EXTRACTED",
      source: "parent_entity",
      relation: "mentioned",
    });

    const rows = await db.selectFrom("entity_mentions").selectAll().where("entity_id", "=", entity.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indexed_file_id: "file-1",
      context_snippet: "Parent folder",
      confidence: "EXTRACTED",
      source: "parent_entity",
      relation: "mentioned",
    });
  });

  it("allows distinct relations for the same entity and file", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Beetu",
      email: "beetu@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:beetu",
    });

    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "assignee",
      relation: "assigned",
    });

    const rows = await db
      .selectFrom("entity_mentions")
      .select(["relation"])
      .where("entity_id", "=", entity.id)
      .orderBy("relation")
      .execute();
    expect(rows.map((r) => r.relation)).toEqual(["assigned", "attended"]);
  });

  it("deleteMentionsForFile preserves EXTRACTED mentions and clears the rest", async () => {
    const db = await createTestDb();
    await seedConnectorConfig(db);
    await seedIndexedFile(db, "file-1");
    const repo = createEntityRepository(db);
    const entity = await repo.upsertPersonEntity({
      name: "Saurabh",
      email: "saurabh@canvasx.ai",
      subtype: "external",
      source: "fireflies",
      sourceId: "fireflies:saurabh",
    });
    // EXTRACTED — from a durable fact. Must survive.
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "fireflies_attendee",
      relation: "attended",
    });
    // INFERRED — content-derived. Should be wiped on re-enrichment.
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    await repo.deleteMentionsForFile("file-1");

    const remaining = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "relation"])
      .where("indexed_file_id", "=", "file-1")
      .execute();
    expect(remaining).toEqual([{ confidence: "EXTRACTED", relation: "attended" }]);

    await db.destroy();
  });
});

describe("createEntityRepository hotness", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("uses source activity rather than mention enrichment time", async () => {
    const recentSourceAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const oldSourceAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await seedIndexedFile(db, "recent-source", "config-test", {
      sourceCreatedAt: recentSourceAt,
      sourceUpdatedAt: recentSourceAt,
    });
    await seedIndexedFile(db, "old-source", "config-test", {
      sourceCreatedAt: oldSourceAt,
      sourceUpdatedAt: oldSourceAt,
    });

    const recentEntity = await repo.upsertPersonEntity({
      name: "Recent Entity",
      email: "recent@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:recent",
    });
    const oldEntity = await repo.upsertPersonEntity({
      name: "Old Entity",
      email: "old@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:old",
    });

    await repo.createMention({
      entityId: recentEntity.id,
      indexedFileId: "recent-source",
      confidence: "EXTRACTED",
      source: "seed",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: oldEntity.id,
      indexedFileId: "old-source",
      confidence: "EXTRACTED",
      source: "seed",
      relation: "mentioned",
    });

    await repo.updateHotness(recentEntity.id);
    await repo.updateHotness(oldEntity.id);

    const rows = await db
      .selectFrom("entities")
      .select(["id", "hotness"])
      .where("id", "in", [recentEntity.id, oldEntity.id])
      .execute();
    const hotnessById = new Map(rows.map((row) => [row.id, row.hotness]));

    expect(hotnessById.get(recentEntity.id)).toBeGreaterThan(0.2);
    expect(hotnessById.get(oldEntity.id)).toBeLessThan(0.01);
  });

  it("falls back from ISO-shaped invalid source_updated_at to valid source_created_at", async () => {
    const recentSourceAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldMentionAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await seedIndexedFile(db, "mixed-source", "config-test", {
      sourceCreatedAt: recentSourceAt,
      sourceUpdatedAt: "0000-00-00T00:00:00.000Z",
    });
    const entity = await repo.upsertPersonEntity({
      name: "Fallback Entity",
      email: "fallback@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:fallback",
    });

    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-fallback",
        entity_id: entity.id,
        indexed_file_id: "mixed-source",
        chunk_index: null,
        context_snippet: null,
        confidence: "EXTRACTED",
        source: "seed",
        relation: "mentioned",
        mentioned_at: oldMentionAt,
      })
      .execute();

    await repo.updateHotness(entity.id);

    const row = await db
      .selectFrom("entities")
      .select(["hotness"])
      .where("id", "=", entity.id)
      .executeTakeFirstOrThrow();
    expect(row.hotness).toBeGreaterThan(0.4);
  });

  it("parses noncanonical source timestamps on the fallback path", async () => {
    const recentSourceAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace("Z", "+05:30");
    const oldSourceAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const oldMentionAt = oldSourceAt;
    await seedIndexedFile(db, "legacy-offset-source", "config-test", {
      sourceCreatedAt: oldSourceAt,
      sourceUpdatedAt: recentSourceAt,
    });
    const entity = await repo.upsertPersonEntity({
      name: "Legacy Offset Entity",
      email: "legacy-offset@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:legacy-offset",
    });

    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-legacy-offset",
        entity_id: entity.id,
        indexed_file_id: "legacy-offset-source",
        chunk_index: null,
        context_snippet: null,
        confidence: "EXTRACTED",
        source: "seed",
        relation: "mentioned",
        mentioned_at: oldMentionAt,
      })
      .execute();

    await repo.updateHotness(entity.id);

    const row = await db
      .selectFrom("entities")
      .select(["hotness"])
      .where("id", "=", entity.id)
      .executeTakeFirstOrThrow();
    expect(row.hotness).toBeGreaterThan(0.4);
  });
});

describe("createEntityRepository deleteEntitiesForFiles", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
    await seedConnectorConfig(db);
    await seedIndexedFile(db, "file-1");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("deletes relation endpoint entities whose only support is deleted file evidence", async () => {
    const source = await repo.upsertPersonEntity({
      name: "Source Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "relation:source",
    });
    const target = await repo.upsertPersonEntity({
      name: "Target Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "relation:target",
    });
    await db
      .insertInto("entity_relationships")
      .values({
        id: "rel-1",
        source_entity_id: source.id,
        target_entity_id: target.id,
        relationship_type: "knows",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_relation",
      })
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "rel-ev-1",
        relationship_id: "rel-1",
        indexed_file_id: "file-1",
        note: null,
        source_fact_id: null,
      })
      .execute();

    await expect(repo.countEntitiesForFiles(["file-1"])).resolves.toBe(2);
    await expect(repo.deleteEntitiesForFiles(["file-1"])).resolves.toBe(2);

    await expect(repo.getEntity(target.id)).resolves.toBeUndefined();
  });

  it("retains entities still supported by files outside the delete set", async () => {
    await seedIndexedFile(db, "file-2");
    const entity = await repo.upsertPersonEntity({
      name: "Shared Person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "shared-person",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-2",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    await expect(repo.countEntitiesForFiles(["file-1"])).resolves.toBe(0);
    await expect(repo.deleteEntitiesForFiles(["file-1"])).resolves.toBe(0);
    await expect(repo.getEntity(entity.id)).resolves.toMatchObject({ id: entity.id });
  });

  it("retains team seeds even when their only file support is deleted", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Team Seed",
      subtype: "internal",
      source: "team",
      sourceId: "team:seed",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "file-1",
      confidence: "EXTRACTED",
      source: "team",
      relation: "mentioned",
    });

    await expect(repo.countEntitiesForFiles(["file-1"])).resolves.toBe(0);
    await expect(repo.deleteEntitiesForFiles(["file-1"])).resolves.toBe(0);
    await expect(repo.getEntity(entity.id)).resolves.toMatchObject({ id: entity.id });
  });

  it("retains entities supported only by a cross-linked file owned by another connector", async () => {
    await seedConnectorConfig(db, "config-other");
    await seedIndexedFile(db, "owned-elsewhere", "config-other");
    await db
      .insertInto("connector_files")
      .values({ connector_config_id: "config-test", indexed_file_id: "owned-elsewhere" })
      .execute();
    const entity = await repo.upsertPersonEntity({
      name: "Cross Linked Person",
      subtype: "external",
      source: "llm_extraction",
      sourceId: "cross-linked",
    });
    await repo.createMention({
      entityId: entity.id,
      indexedFileId: "owned-elsewhere",
      confidence: "INFERRED",
      source: "llm_extraction",
      relation: "mentioned",
    });

    const ownedIds = await createConnectorRepository(db).getOwnedFileIdsForConnector("config-test");

    expect(ownedIds).toEqual(["file-1"]);
    await expect(repo.deleteEntitiesForFiles(ownedIds)).resolves.toBe(0);
    await expect(repo.getEntity(entity.id)).resolves.toMatchObject({ id: entity.id });
  });
});

describe("090-orphan-entity-cleanup migration", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("removes unsupported LLM relation entities while retaining team seeds", async () => {
    const orphan = await repo.upsertPersonEntity({
      name: "Unsupported Relation Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "deleted-file:person",
    });
    const teamSeed = await repo.upsertPersonEntity({
      name: "Directory Person",
      subtype: "internal",
      source: "team",
      sourceId: "team:directory-person",
    });

    await cleanupOrphanEntities(db as unknown as Kysely<unknown>);

    await expect(repo.getEntity(orphan.id)).resolves.toBeUndefined();
    await expect(repo.getEntity(teamSeed.id)).resolves.toMatchObject({ id: teamSeed.id });
  });
});

describe("createEntityRepository contact points", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityRepository(db);
    await db
      .insertInto("users")
      .values({
        id: "user-1",
        name: "User One",
        email: "user@example.com",
        password_hash: "hash",
      })
      .execute();
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("normalizes supported contact point kinds", () => {
    expect(normalizeContactPointValue("email", " SIMRAN@ACME.COM ")).toBe("simran@acme.com");
    expect(normalizeContactPointValue("phone", "00 1 (415) 555-1234")).toBe("+14155551234");
    expect(normalizeContactPointValue("whatsapp", "+1 415 555 1234")).toBe("+14155551234");
    expect(normalizeContactPointValue("linkedin", "https://www.linkedin.com/in/Simran-Suri/")).toBe("simran-suri");
    expect(normalizeContactPointValue("linkedin", "@Simran-Suri")).toBe("simran-suri");
  });

  it("deduplicates and preserves contact point provenance", async () => {
    const entity = await repo.upsertPersonEntity({
      name: "Simran Suri",
      email: "simran@acme.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:simran",
    });

    await repo.upsertContactPoint({
      entityId: entity.id,
      kind: "email",
      value: "SIMRAN@ACME.COM",
      displayValue: "SIMRAN@ACME.COM",
      source: "gmail",
      connectorConfigId: "config-test",
      createdByUserId: "user-1",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      lastContactedAt: "2026-01-02T00:00:00.000Z",
      makePrimary: true,
    });
    await repo.upsertContactPoint({
      entityId: entity.id,
      kind: "email",
      value: "simran@acme.com",
      label: "work",
      source: "manual",
      verifiedAt: "2026-01-03T00:00:00.000Z",
      lastContactedAt: "2026-01-01T00:00:00.000Z",
    });

    const rows = await repo.getContactPointsForEntity(entity.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "email",
      value: "simran@acme.com",
      display_value: "SIMRAN@ACME.COM",
      label: "work",
      source: "manual",
      connector_config_id: "config-test",
      created_by_user_id: "user-1",
      verified_at: "2026-01-03T00:00:00.000Z",
      last_contacted_at: "2026-01-02T00:00:00.000Z",
      is_primary: 1,
    });
  });

  it("finds people by either contact point email or metadata email", async () => {
    const metadataOnly = await repo.upsertPersonEntity({
      name: "Metadata Person",
      email: "metadata@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "seed:metadata",
    });
    const contactOnly = await repo.upsertEntity({
      name: "Contact Person",
      sourceType: "person",
      subtype: "external",
    });
    await repo.upsertContactPoint({
      entityId: contactOnly.id,
      kind: "email",
      value: "contact@example.com",
      source: "gmail",
    });
    const company = await repo.upsertEntity({
      name: "Contact Company",
      sourceType: "company",
      subtype: "external",
    });
    await repo.upsertContactPoint({
      entityId: company.id,
      kind: "email",
      value: "contact@example.com",
      source: "gmail",
    });

    await expect(repo.getPersonEntitiesByEmail("METADATA@example.com")).resolves.toMatchObject([
      { id: metadataOnly.id },
    ]);
    await expect(repo.getPersonEntitiesByEmail("CONTACT@example.com")).resolves.toMatchObject([{ id: contactOnly.id }]);
    await expect(repo.getPersonEntitiesByEmails(["METADATA@example.com", "CONTACT@example.com"])).resolves.toEqual(
      new Map([
        ["metadata@example.com", [expect.objectContaining({ id: metadataOnly.id })]],
        ["contact@example.com", [expect.objectContaining({ id: contactOnly.id })]],
      ]),
    );
  });
});

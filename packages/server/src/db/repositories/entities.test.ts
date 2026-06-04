import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository, normalizeContactPointValue } from "./entities";

async function seedConnectorConfig(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "config-test",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: "user-1",
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "config-test",
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
      source_updated_at: null,
      source_created_at: null,
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
  });
});

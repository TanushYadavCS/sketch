import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { materializeUnmaterializedFacts } from "./materialize-replay";

const ADMIN_ID = "admin-1";
const CONNECTOR_ID = "cfg-person-scope";

async function seedFile(db: Kysely<DB>): Promise<void> {
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
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ADMIN_ID,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "file-1",
      file_name: "file-1",
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: "hash-1",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function upsertPersonSeed(
  db: Kysely<DB>,
  input: { name: string; email?: string | null; sourceId: string },
): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: "file-1",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ADMIN_ID,
    contentHash: "hash-1",
    source: "connector",
    factType: "person_seed",
    relation: "seeded",
    subjectName: input.name,
    subjectEmail: input.email ?? null,
    subjectSource: "connector",
    subjectSourceId: input.sourceId,
    raw: { subtype: "external" },
  });
}

async function createCompanyWithDomain(db: Kysely<DB>, id: string, name: string, domain: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "company",
      subtype: "external",
      aliases: null,
      metadata: "{}",
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  await createEntityDomainsRepository(db).upsertDomain({
    entityId: id,
    domain,
    kind: "corporate",
    source: "test",
  });
}

async function people(db: Kysely<DB>) {
  return db.selectFrom("entities").selectAll().where("source_type", "=", "person").orderBy("name").execute();
}

describe("materializePersonSeed company-scoped dedup", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedFile(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("links same-name seeds at the same mapped company even when the incoming email is new", async () => {
    await createCompanyWithDomain(db, "company-acme", "Acme", "acme.com");
    await upsertPersonSeed(db, { name: "Ashish Banka", email: "ashish@acme.com", sourceId: "person-1" });
    await upsertPersonSeed(db, { name: "ASHISH BANKA", email: "ashish.alt@acme.com", sourceId: "person-2" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.queued).toBe(0);
    expect(await people(db)).toHaveLength(1);
  });

  it("links same-name seeds at the same unmapped corporate domain using the weak bare-domain scope", async () => {
    await upsertPersonSeed(db, { name: "Ashish Banka", email: "ashish@acme.com", sourceId: "person-1" });
    await upsertPersonSeed(db, { name: "ASHISH BANKA", email: "ashish.alt@acme.com", sourceId: "person-2" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.queued).toBe(0);
    expect(await people(db)).toHaveLength(1);
  });

  it("creates a second same-name person when mapped corporate domains point to different companies", async () => {
    await createCompanyWithDomain(db, "company-acme", "Acme", "acme.com");
    await createCompanyWithDomain(db, "company-globex", "Globex", "globex.com");
    await upsertPersonSeed(db, { name: "Ashish Banka", email: "ashish@acme.com", sourceId: "person-1" });
    await upsertPersonSeed(db, { name: "Ashish Banka", email: "ashish@globex.com", sourceId: "person-2" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.queued).toBe(0);
    expect(await people(db)).toHaveLength(2);
  });

  it("queues personal, candidate-unscoped, and name-only same-name seeds", async () => {
    const domainsRepo = createEntityDomainsRepository(db);
    await domainsRepo.upsertDomain({ entityId: null, domain: "gmail.com", kind: "personal", source: "test" });
    await createCompanyWithDomain(db, "company-acme", "Acme", "acme.com");

    const entityRepo = createEntityRepository(db);
    await entityRepo.createPersonEntity({
      name: "Gmail Ashish",
      email: "ashish@acme.com",
      subtype: "external",
      source: "existing",
      sourceId: "gmail-existing",
    });
    await upsertPersonSeed(db, { name: "Gmail Ashish", email: "ashish@gmail.com", sourceId: "gmail-incoming" });

    await entityRepo.createPersonEntity({
      name: "Unscoped Ashish",
      subtype: "external",
      source: "existing",
      sourceId: "unscoped-existing",
    });
    await upsertPersonSeed(db, {
      name: "Unscoped Ashish",
      email: "unscoped@acme.com",
      sourceId: "unscoped-incoming",
    });

    await entityRepo.createPersonEntity({
      name: "Name Only Ashish",
      email: "nameonly@acme.com",
      subtype: "external",
      source: "existing",
      sourceId: "name-only-existing",
    });
    await upsertPersonSeed(db, { name: "Name Only Ashish", sourceId: "name-only-incoming" });

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.queued).toBe(3);
    expect(await db.selectFrom("entity_review_queue").selectAll().execute()).toHaveLength(3);
  });
});

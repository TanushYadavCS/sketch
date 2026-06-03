import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityDomainsRepository, normalizeWebsiteDomain } from "./entity-domains";

describe("entity domains repository", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  async function seedCompany(id: string, name: string) {
    if (!db) throw new Error("missing db");
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  it("normalizes website domains without treating URL paths as hosts", () => {
    expect(normalizeWebsiteDomain("https://www.acme.com/path?q=1")).toBe("acme.com");
    expect(normalizeWebsiteDomain("acme.com/about")).toBe("acme.com");
    expect(normalizeWebsiteDomain("localhost:3000")).toBeNull();
    expect(normalizeWebsiteDomain("127.0.0.1")).toBeNull();
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
});

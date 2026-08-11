import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { connectorFactories } from "../connectors/registry";
import type { Connector, SyncedItem } from "../connectors/types";
import { createEntityRepository } from "../db/repositories/entities";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";

const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";
const CONNECTOR_ID = "gmail-domain-promotion";
const originalGmailFactory = connectorFactories.gmail;

function testGmailConnector(items: SyncedItem[]): Connector {
  return {
    type: "gmail",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: true,
    emitsCorrespondentFacts: true,
    async validateCredentials() {},
    async *sync() {
      for (const item of items) yield item;
    },
    async getCursor() {
      return null;
    },
  };
}

function emailItem(id: string, email: string, name: string): SyncedItem {
  return {
    providerFileId: id,
    providerUrl: null,
    fileName: `${id}.eml`,
    fileType: "email",
    contentCategory: "document",
    content: `Message with ${name}`,
    sourcePath: null,
    contentHash: `hash-${id}-${email}`,
    sourceCreatedAt: "2026-08-11T00:00:00.000Z",
    sourceUpdatedAt: "2026-08-11T00:00:00.000Z",
    attendees: [{ name, email }],
  };
}

async function seedAdmin(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
    skipEntityLinking: true,
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

async function seedConnector(db: Kysely<DB>, ownerId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "gmail",
      auth_type: "system",
      credentials: JSON.stringify({ type: "system" }),
      created_by: ownerId,
      scope_config: "{}",
      sync_status: "active",
    })
    .execute();
}

async function seedCompany(db: Kysely<DB>, name: string) {
  const entity = await createEntityRepository(db).upsertEntity({
    name,
    sourceType: "company",
    status: "confirmed",
    provenanceTier: "declared",
  });
  await db.updateTable("entities").set({ hotness: 0 }).where("id", "=", entity.id).execute();
  return entity;
}

async function triggerSyncAndWait(app: ReturnType<typeof createApp>, cookie: string): Promise<void> {
  const start = await app.request(`/api/connectors/${CONNECTOR_ID}/syncs`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  expect(start.status).toBe(201);

  await vi.waitFor(
    async () => {
      const res = await app.request(`/api/connectors/${CONNECTOR_ID}`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { connector: { syncStatus: string; errorMessage: string | null } };
      expect(body.connector.errorMessage).toBeNull();
      expect(body.connector.syncStatus).toBe("active");
    },
    { timeout: 15_000, interval: 50 },
  );
}

async function listCompanies(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request("/api/entities?type=company&sort=name&limit=200", { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    entities: Array<{ id: string; name: string; sourceType: string }>;
    total: number;
  };
}

describe("domain promotion through connector sync", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestPgDb();
    const ownerId = await seedAdmin(db);
    await seedConnector(db, ownerId);
    app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger: createTestLogger() });
    cookie = await login(app);
  });

  afterEach(async () => {
    connectorFactories.gmail = originalGmailFactory;
    await db.destroy();
  });

  it("links a strict-normalized domain promotion to the existing company instead of creating a twin", async () => {
    const oxane = await seedCompany(db, "Oxane Partners");
    connectorFactories.gmail = () =>
      testGmailConnector([emailItem("oxane-mail", "rhea@oxanepartners.com", "Rhea Rao")]);

    await triggerSyncAndWait(app, cookie);

    const companies = await listCompanies(app, cookie);
    const oxaneCompanies = companies.entities.filter((entity) => entity.name.toLowerCase().includes("oxane"));
    expect(
      oxaneCompanies.map((entity) => ({ id: entity.id, name: entity.name, sourceType: entity.sourceType })),
    ).toEqual([{ id: oxane.id, name: "Oxane Partners", sourceType: "company" }]);

    const domain = await db
      .selectFrom("entity_domains")
      .select(["entity_id", "domain", "kind", "is_primary"])
      .where("domain", "=", "oxanepartners.com")
      .executeTakeFirst();
    expect(domain).toEqual({ entity_id: oxane.id, domain: "oxanepartners.com", kind: "corporate", is_primary: 1 });
  });

  /**
   * A lone token-set candidate is the shape that discriminates the auto-link
   * gate. With two or more candidates the pre-existing hotness-margin rule in
   * `pickConfirmedCanonical` already declines, so a two-candidate fixture
   * passes with or without the gate and proves nothing. With exactly one,
   * `decideNameCandidates` linked unconditionally before this PR.
   */
  it("queues a lone token-set domain match instead of auto-linking it", async () => {
    const gamma = await seedCompany(db, "Gamma Beta Alpha");
    connectorFactories.gmail = () =>
      testGmailConnector([emailItem("alpha-beta-gamma-mail", "maya@alpha-beta-gamma.com", "Maya Shah")]);

    await triggerSyncAndWait(app, cookie);

    const companies = await listCompanies(app, cookie);
    expect(companies.entities.map((entity) => entity.name).sort()).toEqual(["Gamma Beta Alpha"]);

    const linkedDomain = await db
      .selectFrom("entity_domains")
      .select(["entity_id"])
      .where("domain", "=", "alpha-beta-gamma.com")
      .executeTakeFirst();
    expect(linkedDomain).toBeUndefined();

    const reviewRes = await app.request("/api/entity-review?types=company", { headers: { Cookie: cookie } });
    expect(reviewRes.status).toBe(200);
    const review = (await reviewRes.json()) as {
      total: number;
      rows: Array<{ proposed_name: string; candidate_reason: string; candidate_entity_id: string | null }>;
    };
    expect(review.total).toBe(1);
    expect(review.rows[0]).toMatchObject({
      proposed_name: "Alpha Beta Gamma",
      candidate_reason: "token-set",
      candidate_entity_id: gamma.id,
    });
  });

  it("still creates a genuinely new company and skips a well-known vendor domain", async () => {
    connectorFactories.gmail = () =>
      testGmailConnector([
        emailItem("deltaforge-mail", "neha@deltaforge.io", "Neha Kapoor"),
        emailItem("stripe-mail", "lee@stripe.com", "Lee Wong"),
      ]);

    await triggerSyncAndWait(app, cookie);

    const companies = await listCompanies(app, cookie);
    expect(companies.entities.map((entity) => entity.name)).toEqual(["Deltaforge"]);
    expect(companies.entities.some((entity) => entity.name.toLowerCase() === "stripe")).toBe(false);

    const domains = await db
      .selectFrom("entity_domains")
      .select(["domain", "kind", "entity_id"])
      .where("domain", "in", ["deltaforge.io", "stripe.com"])
      .orderBy("domain")
      .execute();
    expect(domains).toEqual([{ domain: "deltaforge.io", kind: "corporate", entity_id: companies.entities[0].id }]);
  });
});

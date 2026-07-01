import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import type { ProposeEntityType } from "../entities/propose";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const CONNECTOR_ID = "connector-1";
const PRODUCT_BIRTH_GATE_TYPES: Set<ProposeEntityType> = new Set(["project", "product", "team"]);
const PRODUCT_LIVE_TYPES: Set<ProposeEntityType> = new Set(["product"]);

async function seedAdmin(db: Kysely<DB>): Promise<{ id: string }> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return { id: admin.id };
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function seedConnector(db: Kysely<DB>, ownerId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ownerId,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.md`,
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function upsertLlmProductMention(db: Kysely<DB>, fileId: string, name: string, ownerId: string): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: ownerId,
    contentHash: `hash-${fileId}`,
    source: "llm_extraction",
    factType: "llm_extracted",
    relation: "mentioned",
    subjectName: name,
    subjectSource: "llm_extraction",
    subjectSourceId: `${fileId}:hash-${fileId}:llm-extraction-v8:${name}`,
    raw: {
      contentHash: `hash-${fileId}`,
      promptVersion: "llm-extraction-v8",
      model: "gemini",
      mention: name,
      type: "product",
      variations: [],
    },
  });
}

async function countProducts(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .where("source_type", "=", "product")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countReviewRows(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_review_queue")
    .select((eb) => eb.fn.count<number>("id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("declared products API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const admin = await seedAdmin(db);
    adminId = admin.id;
    app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    cookie = await login(app);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("declares a new product immediately as a single declared entity", async () => {
    const res = await app.request("/api/products", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Canvas Copilot", aliases: ["Canvas AI"] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: { id: string; name: string; aliases: string[]; provenance_tier: string };
    };
    expect(body.entity).toMatchObject({
      name: "Canvas Copilot",
      aliases: ["Canvas AI"],
      provenance_tier: "declared",
    });
    expect(await countProducts(db)).toBe(1);

    const listRes = await app.request("/api/products", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { products: Array<{ id: string; name: string }> };
    expect(listBody.products).toEqual([
      { id: body.entity.id, name: "Canvas Copilot", aliases: ["Canvas AI"], hotness: 0, provenance_tier: "declared" },
    ]);
  });

  it("upgrades an existing inferred product in place without creating a duplicate", async () => {
    const repo = createEntityRepository(db);
    const inferred = await repo.createEntity({
      name: "Claude-3",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "inferred",
    });

    const res = await app.request("/api/products", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Claude 3" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { id: string; provenance_tier: string } };
    expect(body.entity).toMatchObject({ id: inferred.id, provenance_tier: "declared" });
    expect(await countProducts(db)).toBe(1);
    const row = await db.selectFrom("entities").selectAll().where("id", "=", inferred.id).executeTakeFirstOrThrow();
    expect(row.provenance_tier).toBe("declared");
  });

  it("links later LLM product mentions to the declared product without a new entity or review row", async () => {
    await seedConnector(db, adminId);
    await seedFile(db, "file-1");
    const declareRes = await app.request("/api/products", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Canvas Copilot" }),
    });
    const declared = (await declareRes.json()) as { entity: { id: string } };
    await upsertLlmProductMention(db, "file-1", "Canvas Copilot", adminId);

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: PRODUCT_BIRTH_GATE_TYPES,
      birthGateLiveTypes: PRODUCT_LIVE_TYPES,
      birthGateDryRun: true,
    });

    expect(await countProducts(db)).toBe(1);
    expect(await countReviewRows(db)).toBe(0);
    const mentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", declared.entity.id)
      .execute();
    expect(mentions).toHaveLength(1);
  });

  it("lists human_confirmed products alongside declared ones, excluding inferred", async () => {
    const repo = createEntityRepository(db);
    await repo.createEntity({
      name: "Declared One",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "declared",
    });
    await repo.createEntity({
      name: "Confirmed One",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "human_confirmed",
    });
    await repo.createEntity({
      name: "Inferred One",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "inferred",
    });

    const res = await app.request("/api/products", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Array<{ name: string; provenance_tier: string }> };
    expect(body.products.map((p) => p.name)).toEqual(["Confirmed One", "Declared One"]);
    expect(body.products.map((p) => p.provenance_tier)).toEqual(["human_confirmed", "declared"]);
  });
});

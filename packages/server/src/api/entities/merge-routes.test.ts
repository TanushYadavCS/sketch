import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/password";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function userIdByEmail(db: Kysely<DB>, email: string): Promise<string> {
  const user = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirstOrThrow();
  return user.id;
}

async function seedConnector(db: Kysely<DB>, userId: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id: "merge-config",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: userId,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "merge-config",
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
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType = "person") {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedRelationship(db: Kysely<DB>, id: string, source: string, target: string) {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: source,
      target_entity_id: target,
      relationship_type: "works_at",
      confidence: "high",
      confidence_score: 0.9,
      source: "test",
      valid_from: "",
    })
    .execute();
}

describe("entity merge routes - happy path + preview agree", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    adminId = await userIdByEmail(db, ADMIN_EMAIL);
    await seedConnector(db, adminId);
    await seedFile(db, "file-a");
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("previews, merges, and lists history without returning moves", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await seedEntity(db, "company", "Acme", "company");
    await db
      .insertInto("entity_source_refs")
      .values({ id: "ref-loser", entity_id: "loser", source: "seed", source_id: "loser", last_seen_at: "2026" })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: "mention-survivor",
          entity_id: "survivor",
          indexed_file_id: "file-a",
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: "2026",
        },
        {
          id: "mention-loser",
          entity_id: "loser",
          indexed_file_id: "file-a",
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: "2026",
        },
      ])
      .execute();
    await seedRelationship(db, "rel-loser-company", "loser", "company");

    const previewRes = await app.request("/api/entities/survivor/merge-preview?against=loser", {
      headers: { Cookie: adminCookie },
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.counts.sourceRefs).toBe(1);
    expect(preview.counts.mentions).toBe(1);
    expect(preview.counts.relationships).toBe(1);
    expect(preview.collisions.mentions).toBe(1);

    const mergeRes = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "survivor", loserId: "loser" }),
    });
    expect(mergeRes.status).toBe(200);
    const merged = await mergeRes.json();
    expect(merged.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "entity_source_refs", rowId: "ref-loser" }),
        expect.objectContaining({ table: "entity_mentions", collided: true }),
        expect.objectContaining({ table: "entity_relationships", rowId: "rel-loser-company" }),
      ]),
    );

    const listRes = await app.request("/api/entities/merges?entityId=survivor", { headers: { Cookie: adminCookie } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.merges).toEqual([
      expect.objectContaining({
        id: merged.mergeId,
        survivor_entity_id: "survivor",
        merged_entity_id: "loser",
        entity_type: "person",
        unmerged_at: null,
      }),
    ]);
    expect(list.merges[0]).not.toHaveProperty("moves");
  });
});

describe("entity merge routes - unmerge + LIFO supersede", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("blocks an older unmerge until the latest merge is reversed", async () => {
    await seedEntity(db, "a", "A");
    await seedEntity(db, "b", "B");
    await seedEntity(db, "c", "C");

    const firstRes = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "b", loserId: "a" }),
    });
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json();

    const latestRes = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "c", loserId: "b" }),
    });
    expect(latestRes.status).toBe(200);
    const latest = await latestRes.json();

    const blocked = await app.request(`/api/entities/merges/${first.mergeId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("MERGE_SUPERSEDED");

    const ok = await app.request(`/api/entities/merges/${latest.mergeId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    await expect(db.selectFrom("entities").selectAll().where("id", "=", "b").executeTakeFirst()).resolves.toMatchObject(
      {
        deleted_at: null,
        merged_into_entity_id: null,
      },
    );
  });
});

describe("entity merge routes - guard + validation", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("requires admin access and separates dry-run blocking from mutating errors", async () => {
    for (const request of [
      app.request("/api/entities/person/merge-preview?against=company", { headers: { Cookie: memberCookie } }),
      app.request("/api/entities/merges", {
        method: "POST",
        headers: { Cookie: memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ survivorId: "person", loserId: "company" }),
      }),
      app.request("/api/entities/merges/missing", { method: "DELETE", headers: { Cookie: memberCookie } }),
    ]) {
      const res = await request;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "OWNER_SCOPE_DENIED", message: "admin required" } });
    }

    await seedEntity(db, "person", "Person", "person");
    await seedEntity(db, "company", "Company", "company");

    const previewRes = await app.request("/api/entities/person/merge-preview?against=company", {
      headers: { Cookie: adminCookie },
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.blocked).toBe("TYPE_MISMATCH");
    expect(Object.values(preview.counts).every((count) => count === 0)).toBe(true);
    expect(Object.values(preview.collisions).every((count) => count === 0)).toBe(true);
    expect(preview.selfLoopsDropped).toBe(0);

    const mergeRes = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "person", loserId: "company" }),
    });
    expect(mergeRes.status).toBe(422);
    expect((await mergeRes.json()).error.code).toBe("TYPE_MISMATCH");

    const missingId = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "person" }),
    });
    expect(missingId.status).toBe(400);
  });
});

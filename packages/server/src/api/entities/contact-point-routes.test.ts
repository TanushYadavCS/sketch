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

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return response.headers.get("set-cookie") ?? "";
}

async function seedEntity(db: Kysely<DB>, id: string, sourceType = "person") {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name: id,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

describe("entity contact point routes", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    const settings = createSettingsRepository(db);
    const users = createUserRepository(db);
    const passwordHash = await hashPassword(PASSWORD);
    await settings.create();
    await users.create({ name: "admin", email: ADMIN_EMAIL, emailVerified: true, passwordHash, authRole: "admin" });
    await users.create({ name: "member", email: MEMBER_EMAIL, emailVerified: true, passwordHash, authRole: "member" });
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    await seedEntity(db, "person-a");
    await seedEntity(db, "person-b");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("allows the same email on different people but rejects it twice on one person", async () => {
    const create = (entityId: string, value: string) =>
      app.request(`/api/entities/${entityId}/contact-points`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "email", value }),
      });

    expect((await create("person-a", "Shared@Example.com")).status).toBe(201);
    expect((await create("person-b", "shared@example.com")).status).toBe(201);
    const duplicate = await create("person-a", "shared@example.com");
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: "CONTACT_POINT_EXISTS" } });
  });

  it("supports multiple values, edit, delete, and a single primary", async () => {
    const first = await app.request("/api/entities/person-a/contact-points", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "phone", value: "+14155550101" }),
    });
    const second = await app.request("/api/entities/person-a/contact-points", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "phone", value: "+14155550102", makePrimary: true }),
    });
    const firstBody = (await first.json()) as { contactPoint: { id: string; isPrimary: boolean } };
    const secondBody = (await second.json()) as { contactPoint: { id: string; isPrimary: boolean } };
    expect(firstBody.contactPoint.isPrimary).toBe(true);
    expect(secondBody.contactPoint.isPrimary).toBe(true);

    const rows = await db
      .selectFrom("entity_contact_points")
      .select(["id", "is_primary"])
      .where("entity_id", "=", "person-a")
      .where("kind", "=", "phone")
      .execute();
    expect(rows.filter((row) => row.is_primary === 1)).toHaveLength(1);

    const edited = await app.request(`/api/entities/person-a/contact-points/${firstBody.contactPoint.id}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "+14155550103" }),
    });
    expect(edited.status).toBe(200);
    const removed = await app.request(`/api/entities/person-a/contact-points/${secondBody.contactPoint.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(removed.status).toBe(204);
  });

  it("keeps mutations admin-only", async () => {
    const response = await app.request("/api/entities/person-a/contact-points", {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "email", value: "member@example.com" }),
    });
    expect(response.status).toBe(403);
  });
});

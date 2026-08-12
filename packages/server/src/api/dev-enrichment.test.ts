/**
 * The failure mode this file exists for: the debug surface reaching a tenant.
 *
 * Two independent gates have to hold — the routes must not mount at all without
 * `DEV_TOOLS_ENABLED`, and with the flag on they must still refuse a non-admin.
 * A regression in either one leaks internal pipeline behaviour to a customer,
 * which is the reason the surface is separate from the product in the first place.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({ name: "admin", email: ADMIN_EMAIL, emailVerified: true, passwordHash: hash, authRole: "admin" });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
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

describe("Dev enrichment trace routes", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("does not mount without DEV_TOOLS_ENABLED, even for an admin", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const cookie = await login(app, ADMIN_EMAIL);

    const list = await app.request("/api/dev/enrichment-runs", { headers: { Cookie: cookie } });
    const start = await app.request("/api/dev/enrichment-runs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: "anything" }),
    });

    expect(list.status).toBe(404);
    expect(start.status).toBe(404);
  });

  it("refuses a non-admin once the flag is on", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const cookie = await login(app, MEMBER_EMAIL);

    const list = await app.request("/api/dev/enrichment-runs", { headers: { Cookie: cookie } });
    const start = await app.request("/api/dev/enrichment-runs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: "anything" }),
    });

    expect(list.status).toBe(403);
    expect(start.status).toBe(403);
  });

  it("serves an admin the run list and rejects an unknown file", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const cookie = await login(app, ADMIN_EMAIL);

    const list = await app.request("/api/dev/enrichment-runs", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveProperty("runs");

    const start = await app.request("/api/dev/enrichment-runs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: "does-not-exist" }),
    });
    expect(start.status).toBe(404);
  });
});

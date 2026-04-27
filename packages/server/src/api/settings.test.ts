/**
 * Security tests for the settings API.
 *
 * Verifies GET /api/settings/search does not return the raw gemini_api_key —
 * should return geminiApiKeyConfigured (boolean) instead.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  await settings.create();
  await users.create({
    name: normalizedEmail.split("@")[0],
    email: normalizedEmail,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("Settings API — security", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  describe("GET /api/settings/search — API key masking", () => {
    it("does not expose the raw gemini_api_key when one is set", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({ geminiApiKey: "AIza-super-secret-key-12345" });

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      // The raw key must not appear anywhere in the response
      expect(body.geminiApiKey).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("AIza-super-secret-key-12345");
      // Instead, a boolean flag indicating whether a key is configured
      expect(typeof body.geminiApiKeyConfigured).toBe("boolean");
      expect(body.geminiApiKeyConfigured).toBe(true);
    });

    it("returns geminiApiKeyConfigured: false when no key is set", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.geminiApiKey).toBeUndefined();
      expect(body.geminiApiKeyConfigured).toBe(false);
    });
  });
});

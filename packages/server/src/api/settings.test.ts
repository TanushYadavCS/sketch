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

async function loginMember(app: ReturnType<typeof createApp>, db: Kysely<DB>) {
  const users = createUserRepository(db);
  const hash = await hashPassword("memberpassword123");
  await users.create({
    name: "member",
    email: "member@test.com",
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "member@test.com", password: "memberpassword123" }),
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

  describe("PUT /api/settings/search — input normalization", () => {
    it("trims surrounding whitespace from a pasted gemini_api_key before storing", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ geminiApiKey: "  AIza-super-secret-key-12345\n" }),
      });
      expect(res.status).toBe(200);

      const stored = await createSettingsRepository(db).get();
      expect(stored?.gemini_api_key).toBe("AIza-super-secret-key-12345");
      expect(stored?.embedding_provider).toBe("gemini");
    });

    it("round-trips embedding provider selection", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const putRes = await app.request("/api/settings/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ embeddingProvider: "gemini" }),
      });
      expect(putRes.status).toBe(200);
      expect((await putRes.json()).embeddingProvider).toBe("gemini");

      const getRes = await app.request("/api/settings/search", {
        headers: { Cookie: adminCookie },
      });
      expect((await getRes.json()).embeddingProvider).toBe("gemini");

      const stored = await createSettingsRepository(db).get();
      expect(stored?.embedding_provider).toBe("gemini");
    });

    it("does not overwrite an explicit embedding provider when saving a Gemini key", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({ embeddingProvider: "openrouter" });
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ geminiApiKey: "AIza-super-secret-key-12345" }),
      });

      expect(res.status).toBe(200);
      const stored = await settings.get();
      expect(stored?.gemini_api_key).toBe("AIza-super-secret-key-12345");
      expect(stored?.embedding_provider).toBe("openrouter");
    });
  });

  describe("/api/settings/access", () => {
    it("round-trips adminCanReadAllFiles for admins", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const initialRes = await app.request("/api/settings/access", { headers: { Cookie: adminCookie } });
      expect(initialRes.status).toBe(200);
      await expect(initialRes.json()).resolves.toEqual({ adminCanReadAllFiles: false });

      const updateRes = await app.request("/api/settings/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ adminCanReadAllFiles: true }),
      });
      expect(updateRes.status).toBe(200);
      await expect(updateRes.json()).resolves.toEqual({ adminCanReadAllFiles: true });

      const afterRes = await app.request("/api/settings/access", { headers: { Cookie: adminCookie } });
      expect(afterRes.status).toBe(200);
      await expect(afterRes.json()).resolves.toEqual({ adminCanReadAllFiles: true });
    });

    it("requires admin access", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await loginMember(app, db);

      const getRes = await app.request("/api/settings/access", { headers: { Cookie: memberCookie } });
      expect(getRes.status).toBe(403);

      const putRes = await app.request("/api/settings/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ adminCanReadAllFiles: true }),
      });
      expect(putRes.status).toBe(403);
    });

    it("validates the update payload", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ adminCanReadAllFiles: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("/api/settings/api-key", () => {
    it("generates, returns, and revokes the Sketch API key", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const emptyRes = await app.request("/api/settings/api-key", { headers: { Cookie: adminCookie } });
      expect(emptyRes.status).toBe(200);
      await expect(emptyRes.json()).resolves.toEqual({ configured: false, apiKey: null });

      const createRes = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { configured: boolean; apiKey: string };
      expect(created.configured).toBe(true);
      expect(created.apiKey).toMatch(/^sk_live_/);

      const getRes = await app.request("/api/settings/api-key", { headers: { Cookie: adminCookie } });
      expect(getRes.status).toBe(200);
      await expect(getRes.json()).resolves.toEqual({ configured: true, apiKey: created.apiKey });

      const deleteRes = await app.request("/api/settings/api-key", {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(deleteRes.status).toBe(200);
      await expect(deleteRes.json()).resolves.toEqual({ success: true });

      const afterDeleteRes = await app.request("/api/settings/api-key", { headers: { Cookie: adminCookie } });
      await expect(afterDeleteRes.json()).resolves.toEqual({ configured: false, apiKey: null });
    });

    it("requires an admin session", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await loginMember(app, db);

      const res = await app.request("/api/settings/api-key", { headers: { Cookie: memberCookie } });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("encrypts the Sketch API key when ENCRYPTION_KEY is set", async () => {
      const encryptedConfig = createTestConfig({
        ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
      const encryptedSettings = createSettingsRepository(db, encryptedConfig.ENCRYPTION_KEY);
      await db.updateTable("settings").set({ jwt_secret: null }).where("id", "=", "default").execute();
      await encryptedSettings.update({ jwtSecret: "jwt-secret-for-encrypted-settings" });
      const app = createApp(db, encryptedConfig, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { apiKey: string };

      const raw = await db
        .selectFrom("settings")
        .select("sketch_api_key")
        .where("id", "=", "default")
        .executeTakeFirst();
      expect(raw?.sketch_api_key).not.toBe(body.apiKey);
      expect(raw?.sketch_api_key?.startsWith("enc:")).toBe(true);

      const decrypted = await encryptedSettings.get();
      expect(decrypted?.sketch_api_key).toBe(body.apiKey);
    });
  });

  describe("PUT /api/settings/identity — org context", () => {
    it("round-trips disambiguation guidance and handles empty or malformed org context", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const putRes = await app.request("/api/settings/identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          orgName: "Canvas Labs",
          orgContext: {
            description: "AI services company. Sketch is one of our products.",
            disambiguationGuidance: "A dataset or a UI tab is not a product.",
          },
        }),
      });
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as {
        orgName: string;
        orgContext: { description?: string; disambiguationGuidance?: string } | null;
      };
      expect(putBody.orgName).toBe("Canvas Labs");
      expect(putBody.orgContext?.description).toBe("AI services company. Sketch is one of our products.");
      expect(putBody.orgContext?.disambiguationGuidance).toBe("A dataset or a UI tab is not a product.");

      const getRes = await app.request("/api/settings/identity", { headers: { Cookie: adminCookie } });
      const getBody = (await getRes.json()) as {
        orgContext: { description?: string; disambiguationGuidance?: string } | null;
      };
      expect(getBody.orgContext?.description).toBe("AI services company. Sketch is one of our products.");
      expect(getBody.orgContext?.disambiguationGuidance).toBe("A dataset or a UI tab is not a product.");

      const emptyRes = await app.request("/api/settings/identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          orgContext: { description: " ", disambiguationGuidance: " " },
        }),
      });
      expect(emptyRes.status).toBe(200);
      const emptyBody = (await emptyRes.json()) as { orgContext: unknown };
      expect(emptyBody.orgContext).toBeNull();

      await db.updateTable("settings").set({ org_context: "{not valid json" }).where("id", "=", "default").execute();
      const afterCorruption = await app.request("/api/settings/identity", { headers: { Cookie: adminCookie } });
      expect(afterCorruption.status).toBe(200);
      const corruptBody = (await afterCorruption.json()) as { orgContext: unknown };
      expect(corruptBody.orgContext).toBeNull();
    });
  });
});

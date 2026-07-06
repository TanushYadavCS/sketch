import { SignJWT } from "jose";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "./auth/jwt";
import { hashPassword } from "./auth/password";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import type { DB } from "./db/schema";
import { createApp } from "./http";
import { createTestConfig, createTestDb } from "./test-utils";
import type { PairingCallbacks, WhatsAppBot } from "./whatsapp/bot";

const config = createTestConfig();

/** Helper to insert an admin account into the settings table. */
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
}

describe("HTTP health endpoint", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // Already destroyed in some tests
    }
  });

  describe("GET /api/health", () => {
    it("returns 200 with ok status when DB is working", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.db).toBe("ok");
      expect(typeof body.uptime).toBe("number");
    });

    it("returns 500 with error status when DB is destroyed", async () => {
      const app = createApp(db, config);
      await db.destroy();

      const res = await app.request("/api/health");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.status).toBe("error");
      expect(body.db).toBe("error");
    });
  });

  describe("SPA catch-all", () => {
    it("returns 200 with HTML for unknown non-API routes (SPA routing)", async () => {
      const app = createApp(db, config);
      const res = await app.request("/nonexistent");
      // When web dist exists, serves index.html; otherwise 404
      expect([200, 404]).toContain(res.status);
    });

    it("returns 404 for unknown /api/* routes", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/nonexistent");
      // Without admin setup, returns 503 (setup required); with setup, 404
      expect([404, 503]).toContain(res.status);
    });
  });
});

describe("managed login redirect", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function makePlatformToken(email: string, role: "admin" | "member") {
    return new SignJWT({ sub: "user-123", email, role })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode("managed-secret-at-least-32chars-long"));
  }

  it("redirects /login to MANAGED_URL/login when no valid platform session exists", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );

    const res = await app.request("/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.getsketch.ai/login");
  });

  it("preserves return_to when redirecting /login to managed login", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );

    const returnTo = "https://tenant.getsketch.ai/oauth/authorize?client_id=client";
    const res = await app.request(`/login?return_to=${encodeURIComponent(returnTo)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://app.getsketch.ai/login?return_to=${encodeURIComponent(returnTo)}`,
    );
  });

  it("redirects non-API HTML routes to MANAGED_URL/login when no valid platform session exists", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );

    const res = await app.request("/channels");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.getsketch.ai/login");
  });

  it("preserves integration setup links when redirecting to managed login", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai/platform/",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );

    const res = await app.request("/integrations?connect=github");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://app.getsketch.ai/platform/login?return_to=${encodeURIComponent("/integrations?connect=github")}`,
    );
  });

  it("does not affect API routes", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );

    const res = await app.request("/api/users");
    expect([401, 403]).toContain(res.status);
  });

  it("allows HTML routes through when the platform session cookie is valid", async () => {
    const app = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://app.getsketch.ai",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
    );
    const token = await makePlatformToken("admin@test.com", "admin");

    const res = await app.request("/channels", {
      headers: { Cookie: `sketch_platform_session=${token}` },
    });

    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(302);
  });

  it("serves the normal login page when MANAGED_URL is not set", async () => {
    const app = createApp(db, createTestConfig());
    const res = await app.request("/login");

    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(302);
  });
});

describe("magic link return_to", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("preserves a safe integrations return path through verification", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const app = createApp(db, createTestConfig({ BASE_URL: "https://sketch.test" }), {
      logger: logger as never,
    });
    const returnTo = "/integrations?connect=github";

    const requestRes = await app.request("/api/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email: "admin@test.com", returnTo }),
    });
    expect(requestRes.status).toBe(200);

    const magicLinkUrl = logger.info.mock.calls
      .map(([data]) => (data as { magicLinkUrl?: string }).magicLinkUrl)
      .find(Boolean);
    expect(magicLinkUrl).toBeDefined();

    const url = new URL(magicLinkUrl as string);
    expect(url.searchParams.get("return_to")).toBe(returnTo);

    const verifyRes = await app.request(`${url.pathname}${url.search}`);
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("location")).toBe(returnTo);
  });
});

describe("WhatsApp endpoints", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  function makeMockWhatsApp(overrides: Partial<WhatsAppBot> = {}): WhatsAppBot {
    return {
      isConfigured: false,
      isConnected: false,
      phoneNumber: null,
      startPairing: async () => {},
      cancelPairing: () => {},
      disconnect: async () => {},
      ...overrides,
    } as WhatsAppBot;
  }

  /** Login and return the session cookie string. */
  async function loginAdmin(app: ReturnType<typeof createApp>) {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return res.headers.get("set-cookie") ?? "";
  }

  describe("GET /api/channels/whatsapp/pair", () => {
    it("returns 400 when bot is already connected", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const whatsapp = makeMockWhatsApp({ isConnected: true } as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("ALREADY_CONNECTED");
    });

    it("returns 409 when pairing is already in progress", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });

      const whatsapp = makeMockWhatsApp({
        startPairing: () => new Promise<void>(() => {}),
      } as unknown as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      // First request starts pairing
      const res1 = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      res1.text().catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      // Second request should get 409
      const res2 = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      expect(res2.status).toBe(409);

      const body = await res2.json();
      expect(body.error.code).toBe("PAIRING_IN_PROGRESS");
    });

    it("returns SSE stream with qr and connected events", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });

      const whatsapp = makeMockWhatsApp({
        startPairing: async (callbacks: PairingCallbacks) => {
          await callbacks.onQr("test-qr-data-123");
          await callbacks.onConnected("+919876543210");
        },
      } as unknown as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();
      expect(text).toContain('event: qr\ndata: {"qr":"test-qr-data-123"}');
      expect(text).toContain('event: connected\ndata: {"phoneNumber":"+919876543210"}');
    });

    it("returns SSE stream with error event on failure", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });

      const whatsapp = makeMockWhatsApp({
        startPairing: async (callbacks: PairingCallbacks) => {
          await callbacks.onQr("qr-before-failure");
          await callbacks.onError("QR code expired");
        },
      } as unknown as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const text = await res.text();
      expect(text).toContain("event: qr");
      expect(text).toContain('event: error\ndata: {"message":"QR code expired"}');
    });
  });

  describe("GET /api/channels/whatsapp", () => {
    it("returns connected false with null phone when bot is disconnected", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const whatsapp = makeMockWhatsApp({ isConnected: false, phoneNumber: null } as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.connected).toBe(false);
      expect(body.phoneNumber).toBeNull();
    });

    it("returns connected true with phone number when bot is connected", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const whatsapp = makeMockWhatsApp({
        isConnected: true,
        phoneNumber: "+919876543210",
      } as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.connected).toBe(true);
      expect(body.phoneNumber).toBe("+919876543210");
    });
  });

  describe("DELETE /api/channels/whatsapp", () => {
    it("returns 400 when not connected", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const whatsapp = makeMockWhatsApp({ isConnected: false } as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp", { method: "DELETE", headers: { Cookie: cookie } });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("NOT_CONNECTED");
    });

    it("disconnects successfully when connected", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const disconnectFn = vi.fn();
      const whatsapp = makeMockWhatsApp({
        isConnected: true,
        disconnect: disconnectFn,
      } as unknown as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp", { method: "DELETE", headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(disconnectFn).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/channels/whatsapp/pair", () => {
    it("returns 400 when no pairing in progress", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const whatsapp = makeMockWhatsApp();
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp/pair", { method: "DELETE", headers: { Cookie: cookie } });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("NO_PAIRING");
    });

    it("cancels an in-progress pairing", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });

      // Mock where cancelPairing resolves the startPairing promise (like real sock.ws.close())
      let resolvePairing: (() => void) | null = null;
      const whatsapp = makeMockWhatsApp({
        startPairing: async (callbacks: PairingCallbacks) => {
          await new Promise<void>((r) => {
            resolvePairing = r;
          });
          await callbacks.onError("Connection closed");
        },
        cancelPairing: () => {
          resolvePairing?.();
        },
      } as unknown as Partial<WhatsAppBot>);
      const app = createApp(db, config, { whatsapp });
      const cookie = await loginAdmin(app);

      // Start pairing
      const res1 = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      res1.text().catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      // Cancel it — should wait for startPairing to resolve before responding
      const res = await app.request("/api/channels/whatsapp/pair", { method: "DELETE", headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe("endpoints absent without WhatsApp bot", () => {
    it("returns 404 for /api/channels/whatsapp/pair when no bot provided", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp/pair", { headers: { Cookie: cookie } });
      expect(res.status).toBe(404);
    });

    it("returns 404 for /api/channels/whatsapp when no bot provided", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/channels/whatsapp", { headers: { Cookie: cookie } });
      expect(res.status).toBe(404);
    });
  });
});

describe("Slack disconnect endpoint", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  /** Login and return the session cookie string. */
  async function loginAdmin(app: ReturnType<typeof createApp>) {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return res.headers.get("set-cookie") ?? "";
  }

  it("returns 400 when Slack is not configured", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const app = createApp(db, config, { getSlack: () => null });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/slack", { method: "DELETE", headers: { Cookie: cookie } });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("disconnects successfully when Slack is configured", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const disconnectFn = vi.fn();
    const fakeSlack = { stop: vi.fn() } as unknown as import("./slack/bot").SlackBot;
    const app = createApp(db, config, {
      getSlack: () => fakeSlack,
      onSlackDisconnect: disconnectFn,
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/slack", { method: "DELETE", headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(disconnectFn).toHaveBeenCalled();
  });
});

describe("GET /api/channels/status — WhatsApp states", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function loginAdmin(app: ReturnType<typeof createApp>) {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return res.headers.get("set-cookie") ?? "";
  }

  it("returns not-connected when WhatsApp is disconnected", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const whatsapp = {
      isConnected: false,
      phoneNumber: null,
    } as unknown as WhatsAppBot;
    const app = createApp(db, config, { whatsapp });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/status", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    const wa = body.channels.find((ch: { platform: string }) => ch.platform === "whatsapp");
    expect(wa.configured).toBe(false);
    expect(wa.connected).toBeNull();
    expect(wa.phoneNumber).toBeNull();
  });

  it("returns connected with phone number when WhatsApp is connected", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const whatsapp = {
      isConnected: true,
      phoneNumber: "+919876543210",
    } as unknown as WhatsAppBot;
    const app = createApp(db, config, { whatsapp });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/status", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    const wa = body.channels.find((ch: { platform: string }) => ch.platform === "whatsapp");
    expect(wa.configured).toBe(true);
    expect(wa.connected).toBe(true);
    expect(wa.phoneNumber).toBe("+919876543210");
  });

  it("returns not-connected when no WhatsApp dep provided", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const app = createApp(db, config);
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/status", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    const wa = body.channels.find((ch: { platform: string }) => ch.platform === "whatsapp");
    expect(wa.configured).toBe(false);
    expect(wa.connected).toBeNull();
    expect(wa.phoneNumber).toBeNull();
  });
});

describe("Auth endpoints", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  describe("POST /api/auth/login", () => {
    it("returns 401 with invalid credentials", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "wrong@test.com", password: "wrong" }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 200 with valid credentials and sets cookie", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.email).toBe("admin@test.com");
      expect(res.headers.get("set-cookie")).toContain("sketch_session=");
    });

    it("returns 400 when email or password missing", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com" }),
      });
      expect(res.status).toBe(400);
    });

    it("backfills jwt_secret and logs in when account predates JWT migration", async () => {
      const settings = createSettingsRepository(db);
      const users = createUserRepository(db);
      const hash = await hashPassword("testpassword123");
      await db.insertInto("settings").values({ id: "default" }).execute();
      await users.create({
        name: "admin",
        email: "admin@test.com",
        emailVerified: true,
        passwordHash: hash,
        authRole: "admin",
      });

      const app = createApp(db, config);
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("sketch_session=");

      const row = await settings.get();
      expect(row?.jwt_secret).toBeTruthy();
      expect(row?.jwt_secret).toHaveLength(64);
    });

    it("returns 503 when no admin account exists", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "testtest" }),
      });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/auth/session", () => {
    it("returns authenticated false when no cookie", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/auth/session");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(false);
    });

    it("returns authenticated true with valid session", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      const adminUser = await users.findByEmail("admin@test.com");
      if (!adminUser) throw new Error("Admin user missing");
      const app = createApp(db, config);

      const loginRes = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      const cookie = loginRes.headers.get("set-cookie") ?? "";

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe("admin");
      expect(body.userId).toBe(adminUser.id);
      expect(body.name).toBe("admin");
      expect(body.email).toBe("admin@test.com");
    });
  });

  describe("GET /api/auth/session — managed SSO", () => {
    const MANAGED_SECRET = "managed-test-secret-at-least-32chars-long";

    async function makePlatformToken(
      email: string,
      role: "admin" | "member" | "customer" = "customer",
      secret = MANAGED_SECRET,
    ): Promise<string> {
      return new SignJWT({ sub: "a0000000-0000-0000-0000-000000000001", email, role })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(new TextEncoder().encode(secret));
    }

    async function makeExpiredPlatformToken(email: string): Promise<string> {
      return new SignJWT({ sub: "a0000000-0000-0000-0000-000000000001", email, role: "customer" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(new TextEncoder().encode(MANAGED_SECRET));
    }

    it("returns authenticated when valid platform cookie and user exists", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      await users.create({ name: "Platform User", email: "platform@test.com", authRole: "admin" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makePlatformToken("platform@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.email).toBe("platform@test.com");
      expect(body.role).toBe("admin");
    });

    it("uses auth_role for managed platform cookie sessions", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      const user = await users.create({ name: "Platform Admin", email: "platform-admin@test.com", authRole: "admin" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makePlatformToken("platform-admin@test.com", "admin");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe("admin");
      expect(body.userId).toBe(user.id);
      expect(body.email).toBe("platform-admin@test.com");
    });

    it("returns authenticated with member details for member users", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      const user = await users.create({ name: "Member User", email: "member@test.com", authRole: "member" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makePlatformToken("member@test.com", "member");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe("member");
      expect(body.userId).toBe(user.id);
      expect(body.name).toBe("Member User");
      expect(body.email).toBe("member@test.com");
    });

    it("returns authenticated false when user not found in tenant", async () => {
      await seedAdmin(db);
      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makePlatformToken("unknown@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(false);
    });

    it("returns authenticated false when platform cookie is invalid", async () => {
      await seedAdmin(db);
      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makePlatformToken("admin@test.com", "customer", "wrong-secret-that-is-at-least-32chars");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(false);
    });

    it("returns authenticated false when platform cookie is expired", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      await users.create({ name: "Platform User", email: "platform@test.com", authRole: "admin" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const token = await makeExpiredPlatformToken("platform@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(false);
    });

    it("local session takes priority over platform cookie", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      const adminUser = await users.findByEmail("admin@test.com");
      if (!adminUser) throw new Error("Admin user missing");
      await users.create({ name: "Platform User", email: "platform@test.com", authRole: "member" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);

      const loginRes = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      const localCookie = loginRes.headers.get("set-cookie") ?? "";
      const platformToken = await makePlatformToken("platform@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `${localCookie}; sketch_platform_session=${platformToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe("admin");
      expect(body.userId).toBe(adminUser.id);
      expect(body.email).toBe("admin@test.com");
    });

    it("falls through to platform cookie when local session is invalid", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      await users.create({ name: "Platform User", email: "platform@test.com", authRole: "admin" });

      const managedConfig = createTestConfig({ MANAGED_AUTH_SECRET: MANAGED_SECRET });
      const app = createApp(db, managedConfig);
      const platformToken = await makePlatformToken("platform@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_session=invalid.token.here; sketch_platform_session=${platformToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(body.email).toBe("platform@test.com");
    });

    it("ignores platform cookie when MANAGED_AUTH_SECRET is not configured", async () => {
      await seedAdmin(db);
      const users = createUserRepository(db);
      await users.create({ name: "Platform User", email: "platform@test.com", authRole: "admin" });

      const app = createApp(db, config);
      const token = await makePlatformToken("platform@test.com");

      const res = await app.request("/api/auth/session", {
        headers: { Cookie: `sketch_platform_session=${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.authenticated).toBe(false);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears cookie and returns authenticated false", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const app = createApp(db, config);

      const loginRes = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      const cookie = loginRes.headers.get("set-cookie") ?? "";

      const logoutRes = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(logoutRes.status).toBe(200);
      const logoutBody = await logoutRes.json();
      expect(logoutBody.authenticated).toBe(false);

      // After logout, browser no longer sends the cookie
      const sessionRes = await app.request("/api/auth/session");
      const body = await sessionRes.json();
      expect(body.authenticated).toBe(false);
    });
  });
});

describe("Auth middleware", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function loginAdmin(app: ReturnType<typeof createApp>) {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return loginRes.headers.get("set-cookie") ?? "";
  }

  it("blocks protected routes without auth when onboarding is complete", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const whatsapp = {
      isConnected: false,
      phoneNumber: null,
      startPairing: async () => {},
      disconnect: async () => {},
    } as unknown as WhatsAppBot;
    const app = createApp(db, config, { whatsapp });

    const res = await app.request("/api/channels/whatsapp");
    expect(res.status).toBe(401);
  });

  it("allows protected routes with valid session when onboarding is complete", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const whatsapp = { isConnected: true, phoneNumber: null } as unknown as WhatsAppBot;
    const app = createApp(db, config, { whatsapp });

    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/whatsapp", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it("allows /api/health without auth", async () => {
    await seedAdmin(db);
    const app = createApp(db, config);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  it("returns 503 for protected routes when setup incomplete", async () => {
    const app = createApp(db, config);

    const res = await app.request("/api/channels/status");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("SETUP_REQUIRED");
  });

  it("allows whatsapp routes during onboarding with valid session", async () => {
    await seedAdmin(db);
    const whatsapp = { isConnected: false, phoneNumber: null } as unknown as WhatsAppBot;
    const app = createApp(db, config, { whatsapp });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/channels/whatsapp", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  it("allows public setup routes when setup is incomplete", async () => {
    const app = createApp(db, config);
    const res = await app.request("/api/setup/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(false);
  });

  it("requires auth for protected setup routes when onboarding is complete", async () => {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const app = createApp(db, config);

    const res = await app.request("/api/setup/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key" }),
    });
    expect(res.status).toBe(401);
  });

  it("requires auth for protected setup routes after admin account exists", async () => {
    await seedAdmin(db);
    const app = createApp(db, config);

    const res = await app.request("/api/setup/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "xoxb-test", appToken: "xapp-test" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows protected setup routes with valid session while onboarding is incomplete", async () => {
    await seedAdmin(db);
    const app = createApp(db, config);
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/setup/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ orgName: "Acme", botName: "Sketch" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("Setup endpoints", () => {
  let db: Kysely<DB>;
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
      fetchSpy = null;
    }
    try {
      await db.destroy();
    } catch {}
  });

  async function loginAdmin(app: ReturnType<typeof createApp>, email = "admin@test.com", password = "testpassword123") {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return loginRes.headers.get("set-cookie") ?? "";
  }

  describe("GET /api/setup/status", () => {
    it("returns completed false when no settings", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.completed).toBe(false);
      expect(body.currentStep).toBe(0);
    });

    it("returns completed false after account creation but before completion", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const res = await app.request("/api/setup/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.completed).toBe(false);
      expect(body.currentStep).toBe(2);
      expect(body.adminEmail).toBe("admin@test.com");
    });

    it("advances currentStep as setup data is persisted", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      const app = createApp(db, config);

      await settings.update({ orgName: "Acme", botName: "Sketch" });
      let res = await app.request("/api/setup/status");
      let body = await res.json();
      expect(body.currentStep).toBe(3);

      await settings.update({ slackBotToken: "xoxb-token", slackAppToken: "xapp-token" });
      res = await app.request("/api/setup/status");
      body = await res.json();
      expect(body.currentStep).toBe(4);

      await settings.update({ llmProvider: "anthropic", anthropicApiKey: "sk-ant-test-key" });
      res = await app.request("/api/setup/status");
      body = await res.json();
      expect(body.currentStep).toBe(5);
    });

    it("returns completed true after onboarding completion", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);
      await app.request("/api/setup/complete", { method: "POST", headers: { Cookie: cookie } });

      const res = await app.request("/api/setup/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.completed).toBe(true);
    });
  });

  describe("POST /api/setup/slack/verify", () => {
    it("verifies Slack tokens using auth.test and apps.connections.open", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);
      const botToken = "xoxb-valid-token";
      const appToken = "xapp-valid-token";

      fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(JSON.stringify({ ok: true, team: "Test Workspace" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      const res = await app.request("/api/setup/slack/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ botToken, appToken }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.workspaceName).toBe("Test Workspace");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [authUrl, authOptions] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(authUrl).toBe("https://slack.com/api/auth.test");
      expect(authOptions.method).toBe("POST");
      expect(authOptions.headers).toMatchObject({
        Authorization: `Bearer ${botToken}`,
      });
      const [connUrl, connOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(connUrl).toBe("https://slack.com/api/apps.connections.open");
      expect(connOptions.headers).toMatchObject({
        Authorization: `Bearer ${appToken}`,
      });
    });

    it("returns INVALID_SLACK_TOKENS when auth.test fails", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as Response,
      );

      const res = await app.request("/api/setup/slack/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ botToken: "xoxb-invalid", appToken: "xapp-invalid" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_SLACK_TOKENS");
    });
  });

  describe("POST /api/setup/llm/verify", () => {
    it("verifies Anthropic API key and returns success", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "msg_123", type: "message" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as Response,
      );

      const res = await app.request("/api/setup/llm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-valid" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
    });

    it("returns INVALID_LLM_SETTINGS when Anthropic verification fails", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }) as Response,
      );

      const res = await app.request("/api/setup/llm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-invalid" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_LLM_SETTINGS");
    });
  });

  describe("POST /api/setup/account", () => {
    it("creates admin account and returns success", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@new.com", password: "securepass123" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(res.headers.get("set-cookie")).toContain("sketch_session=");

      // Verify account was created but setup not yet completed
      const statusRes = await app.request("/api/setup/status");
      const status = await statusRes.json();
      expect(status.completed).toBe(false);
    });

    it("stores password hashed, not plaintext", async () => {
      const app = createApp(db, config);
      await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@new.com", password: "securepass123" }),
      });

      const users = createUserRepository(db);
      const user = await users.findByEmail("admin@new.com");
      expect(user?.password_hash).not.toBe("securepass123");
      expect(user?.password_hash).toContain(":");
    });

    it("creates an authenticated session for subsequent setup steps", async () => {
      const app = createApp(db, config);
      const accountRes = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@new.com", password: "securepass123" }),
      });
      const cookie = accountRes.headers.get("set-cookie") ?? "";

      const identityRes = await app.request("/api/setup/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ orgName: "Acme", botName: "Sketch" }),
      });
      expect(identityRes.status).toBe(200);
    });

    it("updates credentials when admin already exists and onboarding is incomplete", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "another@admin.com", password: "securepass123" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const users = createUserRepository(db);
      const row = await users.findByEmail("another@admin.com");
      expect(row?.auth_role).toBe("admin");
      expect(row?.password_hash).not.toBeNull();

      const oldLogin = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
      });
      expect(oldLogin.status).toBe(401);

      const newLogin = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "another@admin.com", password: "securepass123" }),
      });
      expect(newLogin.status).toBe(200);
    });

    it("rejects account updates after onboarding is completed", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });

      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "another@admin.com", password: "securepass123" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("ONBOARDING_COMPLETE");
    });

    it("rejects invalid email", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "notanemail", password: "securepass123" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects short password", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@new.com", password: "short" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing fields", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/setup/slack", () => {
    it("rejects invalid Slack tokens and does not persist them", async () => {
      await seedAdmin(db);
      const app = createApp(db, config, {
        onSlackTokensUpdated: async () => {
          throw new Error("invalid_auth");
        },
      });
      const cookie = await loginAdmin(app);
      const res = await app.request("/api/setup/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          botToken: "xoxb-invalid",
          appToken: "xapp-invalid",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_SLACK_TOKENS");

      const settings = createSettingsRepository(db);
      const row = await settings.get();
      expect(row?.slack_bot_token).toBeNull();
      expect(row?.slack_app_token).toBeNull();
    });

    it("persists Slack tokens only after successful validation", async () => {
      await seedAdmin(db);
      let callbackCalled = false;
      const app = createApp(db, config, {
        onSlackTokensUpdated: async () => {
          callbackCalled = true;
        },
      });
      const cookie = await loginAdmin(app);
      const res = await app.request("/api/setup/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          botToken: "xoxb-valid-token",
          appToken: "xapp-valid-token",
        }),
      });

      expect(res.status).toBe(200);
      expect(callbackCalled).toBe(true);

      const settings = createSettingsRepository(db);
      const row = await settings.get();
      expect(row?.slack_bot_token).toBe("xoxb-valid-token");
      expect(row?.slack_app_token).toBe("xapp-valid-token");
    });
  });

  describe("POST /api/setup/identity", () => {
    it("returns setup required when admin account does not exist", async () => {
      const app = createApp(db, config);
      const res = await app.request("/api/setup/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgName: "Acme", botName: "Sketch" }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("SETUP_REQUIRED");
    });

    it("stores latest identity when updated multiple times during onboarding", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      let res = await app.request("/api/setup/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ orgName: "Acme", botName: "Sketch" }),
      });
      expect(res.status).toBe(200);

      res = await app.request("/api/setup/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ orgName: "Acme Labs", botName: "Sketch Pro" }),
      });
      expect(res.status).toBe(200);

      const settings = createSettingsRepository(db);
      const row = await settings.get();
      expect(row?.org_name).toBe("Acme Labs");
      expect(row?.bot_name).toBe("Sketch Pro");

      const statusRes = await app.request("/api/setup/status");
      const status = await statusRes.json();
      expect(status.orgName).toBe("Acme Labs");
      expect(status.botName).toBe("Sketch Pro");
    });

    it("trims organization and bot names before persisting", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/setup/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ orgName: "  Acme Labs  ", botName: "  Sketch Pro  " }),
      });
      expect(res.status).toBe(200);

      const settings = createSettingsRepository(db);
      const row = await settings.get();
      expect(row?.org_name).toBe("Acme Labs");
      expect(row?.bot_name).toBe("Sketch Pro");
    });
  });

  describe("POST /api/setup/llm", () => {
    it("persists anthropic provider and clears bedrock credentials", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({
        llmProvider: "bedrock",
        awsAccessKeyId: "AKIA-old",
        awsSecretAccessKey: "secret-old",
        awsRegion: "us-east-1",
      });
      let callbackCount = 0;
      const app = createApp(db, config, {
        onLlmSettingsUpdated: async () => {
          callbackCount += 1;
        },
      });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/setup/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-live" }),
      });
      expect(res.status).toBe(200);
      expect(callbackCount).toBe(1);

      const row = await settings.get();
      expect(row?.llm_provider).toBe("anthropic");
      expect(row?.anthropic_api_key).toBe("sk-ant-live");
      expect(row?.aws_access_key_id).toBeNull();
      expect(row?.aws_secret_access_key).toBeNull();
      expect(row?.aws_region).toBeNull();
    });

    it("persists bedrock provider and clears anthropic key", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({
        llmProvider: "anthropic",
        anthropicApiKey: "sk-ant-old",
      });
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/setup/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          provider: "bedrock",
          awsAccessKeyId: "  AKIA-new  ",
          awsSecretAccessKey: "  secret-new  ",
          awsRegion: "  us-west-2  ",
        }),
      });
      expect(res.status).toBe(200);

      const row = await settings.get();
      expect(row?.llm_provider).toBe("bedrock");
      expect(row?.anthropic_api_key).toBeNull();
      expect(row?.aws_access_key_id).toBe("AKIA-new");
      expect(row?.aws_secret_access_key).toBe("secret-new");
      expect(row?.aws_region).toBe("us-west-2");
    });
  });

  describe("POST /api/setup/complete", () => {
    it("stores onboarding completion timestamp", async () => {
      await seedAdmin(db);
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/setup/complete", {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const settings = createSettingsRepository(db);
      const row = await settings.get();
      expect(row?.onboarding_completed_at).toBeTruthy();
    });
  });
});

describe("Settings endpoints", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function loginAdmin(app: ReturnType<typeof createApp>) {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return loginRes.headers.get("set-cookie") ?? "";
  }

  describe("GET /api/settings/identity", () => {
    it("returns default bot name and null org when no identity configured", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({ onboardingCompletedAt: new Date().toISOString() });
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/settings/identity", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.orgName).toBeNull();
      expect(body.botName).toBe("Sketch");
    });

    it("returns persisted identity values", async () => {
      await seedAdmin(db);
      const settings = createSettingsRepository(db);
      await settings.update({
        orgName: "Acme Labs",
        botName: "Sketch Pro",
        onboardingCompletedAt: new Date().toISOString(),
      });
      const app = createApp(db, config);
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/settings/identity", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.orgName).toBe("Acme Labs");
      expect(body.botName).toBe("Sketch Pro");
    });
  });
});

describe("Users API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function setupAdmin(app: ReturnType<typeof createApp>) {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    return loginRes.headers.get("set-cookie") ?? "";
  }

  describe("GET /api/users", () => {
    it("returns list of users", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const { createUserRepository } = await import("./db/repositories/users");
      const users = createUserRepository(db);
      await users.create({ name: "Alice", slackUserId: "U001" });
      await users.create({ name: "Bob", whatsappNumber: "+919876543210" });

      const res = await app.request("/api/users", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.users).toHaveLength(3);
      const names = body.users.map((u: { name: string }) => u.name);
      expect(names).toContain("admin");
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    });

    it("returns the setup admin when no other users exist", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.users).toHaveLength(1);
      expect(body.users[0].email).toBe("admin@test.com");
    });
  });

  describe("POST /api/users", () => {
    it("creates user with name and whatsappNumber", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Charlie", whatsappNumber: "+14155551234" }),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.user.name).toBe("Charlie");
      expect(body.user.whatsapp_number).toBe("+14155551234");
      expect(body.user.id).toBeDefined();
    });

    it("rejects missing name", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappNumber: "+14155551234" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid phone format", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Dave", whatsappNumber: "12345" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 on duplicate whatsapp_number", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Eve", whatsappNumber: "+14155559999" }),
      });

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Frank", whatsappNumber: "+14155559999" }),
      });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error.code).toBe("CONFLICT");
    });
  });

  describe("PATCH /api/users/:id", () => {
    it("updates name", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const createRes = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Grace", whatsappNumber: "+14155550001" }),
      });
      const { user: created } = await createRes.json();

      const res = await app.request(`/api/users/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Gracie" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.name).toBe("Gracie");
      expect(body.user.whatsapp_number).toBe("+14155550001");
    });

    it("updates whatsappNumber", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const createRes = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Hank", whatsappNumber: "+14155550002" }),
      });
      const { user: created } = await createRes.json();

      const res = await app.request(`/api/users/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappNumber: "+14155550003" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.whatsapp_number).toBe("+14155550003");
    });

    it("allows admins to promote another human user to admin", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);
      const users = createUserRepository(db);
      const target = await users.create({ name: "Target User", email: "target@test.com" });

      const res = await app.request(`/api/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ authRole: "admin" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.auth_role).toBe("admin");
      await expect(users.findById(target.id)).resolves.toMatchObject({ auth_role: "admin" });
    });

    it("allows admins to demote another admin to member", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);
      const users = createUserRepository(db);
      const target = await users.create({
        name: "Second Admin",
        email: "second-admin@test.com",
        authRole: "admin",
      });

      const res = await app.request(`/api/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ authRole: "member" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.auth_role).toBe("member");
      await expect(users.findById(target.id)).resolves.toMatchObject({ auth_role: "member" });
    });

    it("rejects auth role changes from members", async () => {
      const app = createApp(db, config);
      await setupAdmin(app);
      const settings = createSettingsRepository(db);
      const jwtSecret = (await settings.get())?.jwt_secret;
      if (!jwtSecret) throw new Error("JWT secret missing");

      const users = createUserRepository(db);
      const caller = await users.create({ name: "Member Caller", email: "caller@test.com" });
      const target = await users.create({ name: "Target User", email: "target-member@test.com" });
      const memberCookie = `sketch_session=${await signJwt(caller.id, "member", jwtSecret)}`;

      const res = await app.request(`/api/users/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ authRole: "admin" }),
      });
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
      await expect(users.findById(target.id)).resolves.toMatchObject({ auth_role: "member" });
    });

    it("rejects changing your own auth role", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);
      const users = createUserRepository(db);
      const admin = await users.findByEmail("admin@test.com");
      if (!admin) throw new Error("Admin user missing");

      const res = await app.request(`/api/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ authRole: "member" }),
      });
      expect(res.status).toBe(403);

      await expect(users.findById(admin.id)).resolves.toMatchObject({ auth_role: "admin" });
    });

    it("returns 404 for unknown id", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users/nonexistent-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Ghost" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 on duplicate whatsappNumber", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Ivy", whatsappNumber: "+14155550010" }),
      });

      const createRes = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Jack", whatsappNumber: "+14155550011" }),
      });
      const { user: jack } = await createRes.json();

      const res = await app.request(`/api/users/${jack.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappNumber: "+14155550010" }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /api/users/:id", () => {
    it("removes user", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const createRes = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Kim", whatsappNumber: "+14155550020" }),
      });
      const { user: created } = await createRes.json();

      const res = await app.request(`/api/users/${created.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);

      const getRes = await app.request("/api/users", { headers: { Cookie: cookie } });
      const getBody = await getRes.json();
      expect(getBody.users).toHaveLength(1);
      expect(getBody.users[0].email).toBe("admin@test.com");
    });

    it("removes user with dependent rows", async () => {
      await sql`PRAGMA foreign_keys = ON`.execute(db);
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);
      const users = createUserRepository(db);
      const admin = await users.findByEmail("admin@test.com");
      if (!admin) throw new Error("Admin user missing");
      const manager = await users.create({ name: "Manager", email: "manager@test.com" });
      const report = await users.create({ name: "Report", email: "report@test.com", reportsTo: manager.id });

      await db
        .insertInto("user_provider_identities")
        .values({
          id: "identity-manager",
          user_id: manager.id,
          provider: "google_drive",
          provider_user_id: "provider-manager",
          provider_email: "manager@test.com",
        })
        .execute();
      await db
        .insertInto("inbox_messages")
        .values({
          id: "inbox-manager",
          sender_user_id: admin.id,
          recipient_user_id: manager.id,
          message: "Please review this",
          platform: "slack",
        })
        .execute();

      const res = await app.request(`/api/users/${manager.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      await expect(users.findById(manager.id)).resolves.toBeUndefined();
      await expect(users.findById(report.id)).resolves.toMatchObject({ reports_to: null });
      await expect(
        db.selectFrom("user_provider_identities").select("id").where("user_id", "=", manager.id).execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("inbox_messages")
          .select("id")
          .where((eb) => eb.or([eb("sender_user_id", "=", manager.id), eb("recipient_user_id", "=", manager.id)]))
          .execute(),
      ).resolves.toEqual([]);
    });

    it("returns 404 for unknown id", async () => {
      const app = createApp(db, config);
      const cookie = await setupAdmin(app);

      const res = await app.request("/api/users/nonexistent-id", {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
    });
  });
});

describe("RBAC", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  /** Seed admin, create admin user row, complete onboarding, return admin cookie + jwt_secret. */
  async function setupWithAdmin(app: ReturnType<typeof createApp>) {
    await seedAdmin(db);
    const settings = createSettingsRepository(db);
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
    });
    const adminCookie = loginRes.headers.get("set-cookie") ?? "";
    const row = await settings.get();
    const jwtSecret = row?.jwt_secret as string;
    return { adminCookie, jwtSecret };
  }

  /** Create a member user and return a member session cookie. */
  async function createMemberSession(jwtSecret: string) {
    const users = createUserRepository(db);
    const user = await users.create({ name: "Member User" });
    const token = await signJwt(user.id, "member", jwtSecret);
    return { memberId: user.id, memberCookie: `sketch_session=${token}` };
  }

  describe("read routes allow members", () => {
    it("GET /api/users", async () => {
      const app = createApp(db, config);
      const { jwtSecret } = await setupWithAdmin(app);
      const { memberCookie } = await createMemberSession(jwtSecret);

      const res = await app.request("/api/users", { headers: { Cookie: memberCookie } });
      expect(res.status).toBe(200);
    });

    it("GET /api/skills", async () => {
      const app = createApp(db, config);
      const { jwtSecret } = await setupWithAdmin(app);
      const { memberCookie } = await createMemberSession(jwtSecret);

      const res = await app.request("/api/skills", { headers: { Cookie: memberCookie } });
      expect(res.status).toBe(200);
    });
  });

  describe("member ownership checks", () => {
    it("PATCH /api/users/:id allows editing own profile", async () => {
      const app = createApp(db, config);
      const { jwtSecret } = await setupWithAdmin(app);
      const { memberId, memberCookie } = await createMemberSession(jwtSecret);

      const res = await app.request(`/api/users/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.name).toBe("Updated Name");
    });

    it("PATCH /api/users/:id allows editing another user's profile", async () => {
      const app = createApp(db, config);
      const { jwtSecret } = await setupWithAdmin(app);
      const { memberCookie } = await createMemberSession(jwtSecret);

      // Create another user
      const users = createUserRepository(db);
      const other = await users.create({ name: "Other User" });

      const res = await app.request(`/api/users/${other.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ name: "Updated by Peer" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.user.name).toBe("Updated by Peer");
    });

    it("POST /api/users/:id/verification returns 400 NO_EMAIL for user without email", async () => {
      const app = createApp(db, config);
      const { jwtSecret } = await setupWithAdmin(app);
      const { memberCookie } = await createMemberSession(jwtSecret);

      const users = createUserRepository(db);
      const other = await users.create({ name: "Other" });

      const res = await app.request(`/api/users/${other.id}/verification`, {
        method: "POST",
        headers: { Cookie: memberCookie },
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("NO_EMAIL");
    });
  });
});

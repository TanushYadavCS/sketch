/**
 * Tests for auth middleware — existing local auth and managed SSO (Phase 7).
 *
 * The managed SSO path checks `sketch_platform_session` (signed with MANAGED_AUTH_SECRET)
 * before falling through to the existing `sketch_session` local auth path.
 */
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import type { createSettingsRepository } from "../db/repositories/settings";
import { type AuthMiddlewareOpts, createAuthMiddleware } from "./middleware";

const LOCAL_JWT_SECRET = "local-test-secret-at-least-32chars-long";
const MANAGED_AUTH_SECRET = "managed-test-secret-at-least-32chars-long";
const MANAGED_URL = "https://app.sketch.dev";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

const mockSettings = {
  get: async () => ({
    admin_email: "admin@test.com",
    jwt_secret: LOCAL_JWT_SECRET,
    onboarding_completed_at: new Date().toISOString(),
    admin_password_hash: null,
    slack_bot_token: null,
    slack_app_token: null,
    slack_signing_secret: null,
    slack_channel_id: null,
    anthropic_api_key: null,
    anthropic_model: null,
    smtp_host: null,
    smtp_port: null,
    smtp_user: null,
    smtp_password: null,
    smtp_from: null,
    whatsapp_pairing_code: null,
    whatsapp_phone_number: null,
    whatsapp_jid: null,
    base_url: null,
    openai_api_key: null,
    google_client_id: null,
    google_client_secret: null,
    google_service_account: null,
    enrichment_enabled: null,
    enrichment_schedule: null,
    enrichment_last_run_at: null,
  }),
} as unknown as SettingsRepo;

function createTestApp(settings: SettingsRepo, opts?: AuthMiddlewareOpts) {
  const app = new Hono();
  app.use("/api/*", createAuthMiddleware(settings, opts));
  app.get("/api/test", (c) => c.json({ role: c.get("role"), sub: c.get("sub") }));
  return app;
}

async function makeExpiredPlatformToken(): Promise<string> {
  return new SignJWT({ sub: "admin@test.com", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(MANAGED_AUTH_SECRET));
}

describe("auth middleware - existing local auth", () => {
  it("returns 401 when no cookie is present", async () => {
    const app = createTestApp(mockSettings);
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
  });

  it("returns 200 with role and sub when valid local session cookie is present", async () => {
    const app = createTestApp(mockSettings);
    const token = await signJwt("admin@test.com", "admin", LOCAL_JWT_SECRET);
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.sub).toBe("admin@test.com");
  });

  it("returns 401 when local session cookie is expired or invalid", async () => {
    const app = createTestApp(mockSettings);
    const res = await app.request("/api/test", {
      headers: { Cookie: "sketch_session=not.a.valid.token" },
    });
    expect(res.status).toBe(401);
  });

  it("passes public paths without auth", async () => {
    const app = createTestApp(mockSettings);
    const res = await app.request("/api/auth/login");
    expect([200, 404, 405]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });
});

describe("auth middleware - managed SSO", () => {
  const findUserByEmail = vi.fn(async (email: string) => {
    if (email === "admin@test.com") return { id: "user-1", role: "admin" as const };
    if (email === "member@test.com") return { id: "user-2", role: "member" as const };
    return null;
  });

  beforeEach(() => {
    findUserByEmail.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when managedAuthSecret is not set, only local auth works", async () => {
    const app = createTestApp(mockSettings);
    const token = await signJwt("admin@test.com", "admin", LOCAL_JWT_SECRET);
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.sub).toBe("admin@test.com");
  });

  it("valid platform cookie is accepted and user is looked up by email", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const token = await signJwt("admin@test.com", "admin", MANAGED_AUTH_SECRET);
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_platform_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.sub).toBe("admin@test.com");
    expect(findUserByEmail).toHaveBeenCalledWith("admin@test.com");
  });

  it("returns 403 when platform cookie email has no matching local user", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const token = await signJwt("unknown@test.com", "member", MANAGED_AUTH_SECRET);
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_platform_session=${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("redirects to MANAGED_URL/login when platform cookie has wrong signature", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const badToken = await signJwt("admin@test.com", "admin", "wrong-secret-that-is-at-least-32chars");
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_platform_session=${badToken}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${MANAGED_URL}/login`);
  });

  it("redirects to MANAGED_URL/login when platform cookie JWT is expired", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const expiredToken = await makeExpiredPlatformToken();
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_platform_session=${expiredToken}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${MANAGED_URL}/login`);
  });

  it("falls through to local auth when platform cookie is absent", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const localToken = await signJwt("admin@test.com", "admin", LOCAL_JWT_SECRET);
    const res = await app.request("/api/test", {
      headers: { Cookie: `sketch_session=${localToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.sub).toBe("admin@test.com");
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it("platform cookie takes precedence when both cookies are present", async () => {
    const app = createTestApp(mockSettings, {
      managedAuthSecret: MANAGED_AUTH_SECRET,
      managedUrl: MANAGED_URL,
      findUserByEmail,
    });
    const platformToken = await signJwt("member@test.com", "member", MANAGED_AUTH_SECRET);
    const localToken = await signJwt("admin@test.com", "admin", LOCAL_JWT_SECRET);
    const res = await app.request("/api/test", {
      headers: {
        Cookie: `sketch_platform_session=${platformToken}; sketch_session=${localToken}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("member");
    expect(body.sub).toBe("member@test.com");
    expect(findUserByEmail).toHaveBeenCalledWith("member@test.com");
  });
});

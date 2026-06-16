import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import {
  googleConnectorFromQuery,
  googleScopesFor,
  initialGoogleScopeConfig,
  oauthRoutes,
  resolveOrigin,
  shouldRunGoogleFirstSync,
} from "./oauth";

/**
 * Exercises the origin used to build OAuth redirect URIs. The production bug:
 * behind a TLS-terminating proxy the request reaches Node as plain HTTP, so the
 * redirect URI was built with `http://`, failing the provider's exact-match
 * check (AADSTS50011). Multi-tenant hosts rule out a single configured BASE_URL,
 * so the scheme must come from `X-Forwarded-Proto`.
 */
async function originFor(headers: Record<string, string>, baseUrl?: string): Promise<string> {
  const app = new Hono();
  app.get("/probe", (c) => c.text(resolveOrigin(c, baseUrl)));
  const res = await app.request("http://capmobfinance.getsketch.ai/probe", { headers });
  return res.text();
}

describe("resolveOrigin", () => {
  it("upgrades to https from X-Forwarded-Proto behind a TLS-terminating proxy", async () => {
    expect(await originFor({ "x-forwarded-proto": "https", host: "capmobfinance.getsketch.ai" })).toBe(
      "https://capmobfinance.getsketch.ai",
    );
  });

  it("prefers an explicit BASE_URL override over the request and forwarded headers", async () => {
    expect(await originFor({ "x-forwarded-proto": "http", host: "evil.example" }, "https://override.example")).toBe(
      "https://override.example",
    );
  });

  it("falls back to the request origin when no forwarded headers are present", async () => {
    expect(await originFor({ host: "capmobfinance.getsketch.ai" })).toBe("http://capmobfinance.getsketch.ai");
  });
});

describe("Google OAuth connector routing", () => {
  it("maps Google Calendar authorize requests to the calendar connector and scope", () => {
    expect(googleConnectorFromQuery("google_calendar")).toBe("google_calendar");
    expect(googleConnectorFromQuery("calendar")).toBe("google_calendar");
    expect(googleScopesFor("google_calendar")).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(googleScopesFor("google_calendar")).toContain("https://www.googleapis.com/auth/userinfo.email");
  });

  it("starts Calendar OAuth with an empty selectable scope instead of auto-syncing every calendar", () => {
    expect(initialGoogleScopeConfig("google_calendar")).toEqual({ calendarIds: [] });
    expect(shouldRunGoogleFirstSync("google_calendar")).toBe(false);
    expect(shouldRunGoogleFirstSync("gmail")).toBe(true);
  });
});

function createMicrosoftOauthTestApp(opts: { tenant?: string; settingsTenant?: string } = {}) {
  const userId = "user-1";
  const app = new Hono();
  const settings = {
    get: vi.fn(async () =>
      opts.settingsTenant
        ? {
            microsoft_oauth_client_id: "settings-cid",
            microsoft_oauth_client_secret: "settings-csec",
            microsoft_oauth_tenant: opts.settingsTenant,
          }
        : null,
    ),
  };
  const identities = { upsert: vi.fn() };
  const connectors = {
    findByTypeAndOwner: vi.fn(async () => null),
    createConfig: vi.fn(),
  };
  const users = {};
  const db = {};

  app.use("/microsoft/*", async (c, next) => {
    c.set("sub", userId);
    await next();
  });
  app.route(
    "/",
    oauthRoutes(
      settings as unknown as Parameters<typeof oauthRoutes>[0],
      identities as unknown as Parameters<typeof oauthRoutes>[1],
      connectors as unknown as Parameters<typeof oauthRoutes>[2],
      users as unknown as Parameters<typeof oauthRoutes>[3],
      db as unknown as Parameters<typeof oauthRoutes>[4],
      createTestLogger(),
      {
        microsoftClientId: "env-cid",
        microsoftClientSecret: "env-csec",
        microsoftTenant: opts.tenant ?? "tenant-id",
      },
    ),
  );

  return { app, userId };
}

describe("Microsoft OAuth callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps admin consent provider errors to admin_consent_required", async () => {
    const { app } = createMicrosoftOauthTestApp();

    const res = await app.request(
      "/microsoft/callback?error=access_denied&error_description=AADSTS90094%3A%20admin%20consent%20required",
      { redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/files?oauth=error&connector=outlook&reason=admin_consent_required");
  });

  it("keeps a plain user cancellation mapped to denied", async () => {
    const { app } = createMicrosoftOauthTestApp();

    const res = await app.request("/microsoft/callback?error=access_denied&error_subcode=cancel", {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/files?oauth=error&connector=outlook&reason=denied");
  });

  it("accepts a state-validated Teams admin consent callback without exchanging a token", async () => {
    const { app } = createMicrosoftOauthTestApp();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected token exchange"));
    const authorize = await app.request("/microsoft/admin-consent?connector=teams", { redirect: "manual" });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state");

    const res = await app.request(`/microsoft/callback?admin_consent=True&state=${encodeURIComponent(state ?? "")}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/files?oauth=admin_consent_granted&connector=teams");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects missing or forged Teams admin consent callback state", async () => {
    const { app } = createMicrosoftOauthTestApp();
    const missing = await app.request("/microsoft/callback?admin_consent=True", { redirect: "manual" });
    const forged = await app.request("/microsoft/callback?admin_consent=True&state=user-1%3Ateams%3Aforged", {
      redirect: "manual",
    });

    expect(missing.status).toBe(302);
    expect(forged.status).toBe(302);
    expect(missing.headers.get("location")).toBe("/files?oauth=error&reason=invalid_state");
    expect(forged.headers.get("location")).toBe("/files?oauth=error&connector=teams&reason=invalid_state");
  });

  it("accepts a state-validated Outlook admin consent callback", async () => {
    const { app } = createMicrosoftOauthTestApp();
    const authorize = await app.request("/microsoft/admin-consent?connector=outlook", { redirect: "manual" });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state");

    const res = await app.request(`/microsoft/callback?admin_consent=True&state=${encodeURIComponent(state ?? "")}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/files?oauth=admin_consent_granted&connector=outlook");
  });
});

describe("Microsoft admin consent route", () => {
  it("builds a Teams admin consent URL with the configured tenant and Graph default scope", async () => {
    const { app, userId } = createMicrosoftOauthTestApp();

    const res = await app.request("/microsoft/admin-consent?connector=teams", { redirect: "manual" });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/tenant-id/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe("env-cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/api/oauth/microsoft/callback");
    expect(url.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(url.searchParams.get("state")).toContain(`${userId}:teams:`);
  });

  it("uses organizations instead of common for Teams admin consent", async () => {
    const { app } = createMicrosoftOauthTestApp({ tenant: "common" });

    const res = await app.request("/microsoft/admin-consent?connector=teams", { redirect: "manual" });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(location).not.toContain("/common/v2.0/adminconsent");
  });

  it("builds an Outlook admin consent URL", async () => {
    const { app, userId } = createMicrosoftOauthTestApp();

    const res = await app.request("/microsoft/admin-consent?connector=outlook", { redirect: "manual" });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/tenant-id/v2.0/adminconsent");
    expect(url.searchParams.get("state")).toContain(`${userId}:outlook:`);
  });

  it("rejects a non-Microsoft connector", async () => {
    const { app } = createMicrosoftOauthTestApp();

    const res = await app.request("/microsoft/admin-consent?connector=google_drive", { redirect: "manual" });

    expect(res.status).toBe(400);
  });
});

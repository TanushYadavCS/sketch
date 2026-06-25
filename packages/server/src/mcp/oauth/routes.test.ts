import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../../auth/api-token";
import { signJwt } from "../../auth/jwt";
import { hashPassword } from "../../auth/password";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

const BASE_URL = "https://sketch.test";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "test-code-verifier-with-enough-entropy-for-pkce";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function setupSession(email = "mcp-oauth@example.com") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const user = await users.create({
    name: "MCP OAuth User",
    email,
    emailVerified: true,
    passwordHash: await hashPassword("testpassword123"),
    authRole: "member",
  });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("Missing jwt secret");
  return {
    user,
    cookie: `sketch_session=${await signJwt(user.id, "member", row.jwt_secret)}`,
  };
}

function createTestApp() {
  return createApp(db, createTestConfig({ BASE_URL }), { logger: createTestLogger() });
}

async function registerClaudeClient(app: ReturnType<typeof createTestApp>) {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read",
      client_name: "Claude",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret: string; scope: string };
}

async function authorize(app: ReturnType<typeof createTestApp>, input: { clientId: string; cookie: string }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge(CODE_VERIFIER),
    code_challenge_method: "S256",
    state: "test-state",
    scope: "mcp:read",
    resource: `${BASE_URL}/mcp`,
  });

  const consent = await app.request(`/oauth/authorize?${params.toString()}`, { headers: { Cookie: input.cookie } });
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Connect Claude to Sketch");

  const approve = await app.request("/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: input.cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE_URL,
    },
    body: new URLSearchParams({
      decision: "approve",
      client_id: input.clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge(CODE_VERIFIER),
      scope: "mcp:read",
      state: "test-state",
      resource: `${BASE_URL}/mcp`,
    }).toString(),
  });

  expect(approve.status).toBe(302);
  const location = approve.headers.get("location");
  expect(location).toBeTruthy();
  const redirect = new URL(location ?? REDIRECT_URI);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("state")).toBe("test-state");
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");
  return code;
}

async function exchangeCode(
  app: ReturnType<typeof createTestApp>,
  input: { clientId: string; clientSecret: string; code: string; verifier?: string },
) {
  const res = await app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: input.verifier ?? CODE_VERIFIER,
    }).toString(),
  });
  return res;
}

function mcpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-03-26",
  };
}

describe("MCP OAuth routes", () => {
  it("publishes OAuth metadata without the experimental flag", async () => {
    await setupSession();
    const app = createTestApp();

    const protectedResource = await app.request("/.well-known/oauth-protected-resource");
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
    });

    const authorizationServer = await app.request("/.well-known/oauth-authorization-server");
    expect(authorizationServer.status).toBe(200);
    await expect(authorizationServer.json()).resolves.toMatchObject({
      issuer: BASE_URL,
      registration_endpoint: `${BASE_URL}/oauth/register`,
    });
  });

  it("connects through DCR, consent, PKCE token exchange, and MCP tool listing", async () => {
    const { cookie } = await setupSession();
    const app = createTestApp();
    const client = await registerClaudeClient(app);
    const code = await authorize(app, { clientId: client.client_id, cookie });

    const tokenRes = await exchangeCode(app, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
    });

    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokenBody.access_token).toMatch(/^sko_/);
    expect(tokenBody.refresh_token).toMatch(/^skr_/);
    expect(tokenBody.scope).toBe("mcp:read");

    const listTools = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(tokenBody.access_token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listTools.status).toBe(200);
    const body = (await listTools.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "sketch_get_entity_context",
      "sketch_get_file_content",
      "sketch_search",
      "sketch_search_entities",
    ]);
  });

  it("sends managed unauthenticated OAuth users to platform login with the tenant return URL", async () => {
    const app = createApp(
      db,
      createTestConfig({
        BASE_URL,
        MANAGED_URL: "https://app.getsketch.ai/platform/",
        MANAGED_AUTH_SECRET: "managed-secret-at-least-32chars-long",
      }),
      { logger: createTestLogger() },
    );
    const client = await registerClaudeClient(app);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge(CODE_VERIFIER),
      code_challenge_method: "S256",
      state: "test-state",
      scope: "mcp:read",
      resource: `${BASE_URL}/mcp`,
    });

    const res = await app.request(`/oauth/authorize?${params.toString()}`, { redirect: "manual" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://app.getsketch.ai/platform/login");
    const returnTo = new URL(location.searchParams.get("return_to") ?? "");
    expect(returnTo.origin + returnTo.pathname).toBe(`${BASE_URL}/oauth/authorize`);
    expect(returnTo.searchParams.get("client_id")).toBe(client.client_id);
    expect(returnTo.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("rejects authorize requests with unregistered redirect URIs without redirecting", async () => {
    const app = createTestApp();
    const client = await registerClaudeClient(app);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://attacker.example/callback",
      code_challenge: codeChallenge(CODE_VERIFIER),
      code_challenge_method: "S256",
      state: "test-state",
      scope: "mcp:read",
      resource: `${BASE_URL}/mcp`,
    });

    const res = await app.request(`/oauth/authorize?${params.toString()}`, { redirect: "manual" });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("Invalid redirect URI");
  });

  it("rejects authorize form posts with unregistered redirect URIs without redirecting", async () => {
    const app = createTestApp();
    const client = await registerClaudeClient(app);

    const res = await app.request("/oauth/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: BASE_URL,
      },
      body: new URLSearchParams({
        decision: "deny",
        client_id: client.client_id,
        redirect_uri: "https://attacker.example/callback",
        code_challenge: codeChallenge(CODE_VERIFIER),
        scope: "mcp:read",
        state: "test-state",
        resource: `${BASE_URL}/mcp`,
      }).toString(),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("Invalid redirect URI");
  });

  it("enforces PKCE and single-use authorization codes", async () => {
    const { cookie } = await setupSession();
    const app = createTestApp();
    const client = await registerClaudeClient(app);
    const code = await authorize(app, { clientId: client.client_id, cookie });

    const invalidPkce = await exchangeCode(app, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
      verifier: "wrong-verifier",
    });
    expect(invalidPkce.status).toBe(400);

    const consumed = await exchangeCode(app, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
    });
    expect(consumed.status).toBe(400);
  });

  it("rotates refresh tokens", async () => {
    const { cookie } = await setupSession();
    const app = createTestApp();
    const client = await registerClaudeClient(app);
    const code = await authorize(app, { clientId: client.client_id, cookie });
    const tokenRes = await exchangeCode(app, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
    });
    const tokenBody = (await tokenRes.json()) as { refresh_token: string };

    const refresh = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokenBody.refresh_token,
      }).toString(),
    });
    expect(refresh.status).toBe(200);
    const refreshBody = (await refresh.json()) as { access_token: string; refresh_token: string };
    expect(refreshBody.access_token).toMatch(/^sko_/);
    expect(refreshBody.refresh_token).toMatch(/^skr_/);
    expect(refreshBody.refresh_token).not.toBe(tokenBody.refresh_token);

    const reuse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokenBody.refresh_token,
      }).toString(),
    });
    expect(reuse.status).toBe(400);
  });

  it("keeps PAT access working and rejects non-Sketch tokens with OAuth discovery", async () => {
    const { user } = await setupSession();
    const app = createTestApp();
    const plaintext = generateApiToken();
    await createApiTokenRepository(db).create({
      userId: user.id,
      name: "Claude Code",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });

    const patRes = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(plaintext),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(patRes.status).toBe(200);

    const invalid = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("sk_live_wrong"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });
});

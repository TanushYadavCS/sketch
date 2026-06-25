import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { SESSION_COOKIE } from "../../api/auth";
import { resolveBaseUrl } from "../../api/shared";
import {
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  getApiTokenDisplayPrefix,
  hashApiToken,
} from "../../auth/api-token";
import { verifyJwt } from "../../auth/jwt";
import {
  generateAuthorizationCode,
  generateOAuthClientId,
  generateOAuthClientSecret,
  getAuthorizationCodeExpiresAt,
  hashOAuthSecret,
  verifyPkceS256,
} from "../../auth/oauth-token";
import type { Config } from "../../config";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import {
  createOAuthAuthorizationCodeRepository,
  parseAuthorizationCodeScopes,
} from "../../db/repositories/oauth-authorization-codes";
import { createOAuthClientRepository, parseOAuthClientJson } from "../../db/repositories/oauth-clients";
import type { createSettingsRepository } from "../../db/repositories/settings";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createManagedLoginUrl } from "../../managed-url";
import { createTokenBucketRateLimiter } from "../server/rate-limit";

const MCP_SCOPE = "mcp:read";
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const PLATFORM_COOKIE = "sketch_platform_session";
const registerLimiter = createTokenBucketRateLimiter({ capacity: 30, refillPerMinute: 30 });

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

const registerSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post"]).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  client_name: z.string().max(120).optional(),
});

const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(32),
  code_challenge_method: z.literal("S256"),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

function normalizeScopes(scope?: string): string[] | null {
  const scopes = scope?.trim() ? scope.trim().split(/\s+/) : [MCP_SCOPE];
  return scopes.every((value) => value === MCP_SCOPE) ? scopes : null;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function formValue(body: URLSearchParams, key: string): string | null {
  const value = body.get(key);
  return value?.trim() ? value : null;
}

function oauthError(error: string, description: string, status = 400) {
  return { body: { error, error_description: description }, status };
}

function redirectWithOAuthError(redirectUri: string, error: string, state?: string | null): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  return target.toString();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function resolveSessionUser(params: {
  c: import("hono").Context;
  settings: SettingsRepo;
  users: UserRepo;
  config: Config;
}): Promise<{ id: string; email: string | null } | null> {
  const settingsRow = await params.settings.get();
  const localToken = getCookie(params.c, SESSION_COOKIE);
  if (localToken && settingsRow?.jwt_secret) {
    const payload = await verifyJwt(localToken, settingsRow.jwt_secret);
    if (payload?.sub) {
      let user = await params.users.findById(payload.sub);
      if (!user && payload.sub.includes("@")) user = await params.users.findByEmail(payload.sub);
      if (user && user.type !== "agent" && user.type !== "external") return { id: user.id, email: user.email };
    }
  }

  const platformToken = getCookie(params.c, PLATFORM_COOKIE);
  if (platformToken && params.config.MANAGED_AUTH_SECRET) {
    const payload = await verifyJwt(platformToken, params.config.MANAGED_AUTH_SECRET);
    if (payload?.email) {
      const user = await params.users.findByEmail(payload.email);
      if (user && user.type !== "agent" && user.type !== "external") return { id: user.id, email: user.email };
    }
  }

  return null;
}

async function authenticateClient(params: {
  client: Awaited<ReturnType<ReturnType<typeof createOAuthClientRepository>["findByClientId"]>>;
  body: URLSearchParams;
}): Promise<boolean> {
  if (!params.client) return false;
  if (params.client.token_endpoint_auth_method === "none") return true;
  const secret = formValue(params.body, "client_secret");
  return !!secret && params.client.client_secret_hash === hashOAuthSecret(secret);
}

function consentPage(params: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string | null;
}) {
  const hidden = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["code_challenge", params.codeChallenge],
    ["scope", params.scope],
    ["state", params.state ?? ""],
    ["resource", params.resource ?? ""],
  ]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const clientName = escapeHtml(params.clientName);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Connect ${clientName} to Sketch</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
      main { width: min(420px, calc(100vw - 32px)); background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 28px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 20px; color: #475569; line-height: 1.5; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; }
      button { border: 0; border-radius: 6px; padding: 10px 14px; font-weight: 600; cursor: pointer; }
      .secondary { background: #e2e8f0; color: #0f172a; }
      .primary { background: #0f172a; color: white; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect ${clientName} to Sketch</h1>
      <p>Allow this connector to read Sketch MCP context available to your verified email addresses.</p>
      <form method="post" action="/oauth/authorize">
        ${hidden}
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
          <button class="primary" type="submit" name="decision" value="approve">Allow</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

export function mcpOAuthRoutes(params: {
  db: Kysely<DB>;
  settings: SettingsRepo;
  users: UserRepo;
  config: Config;
  logger: Logger;
}) {
  const routes = new Hono();
  const clients = createOAuthClientRepository(params.db);
  const codes = createOAuthAuthorizationCodeRepository(params.db);
  const apiTokens = createApiTokenRepository(params.db);

  routes.get("/.well-known/oauth-protected-resource", (c) => {
    const baseUrl = resolveBaseUrl(c, params.config);
    return c.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      resource_name: "Sketch MCP",
      scopes_supported: [MCP_SCOPE],
    });
  });

  routes.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = resolveBaseUrl(c, params.config);
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: [MCP_SCOPE],
    });
  });

  routes.post("/oauth/register", async (c) => {
    const limiterKey = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
    if (!registerLimiter.consume(limiterKey)) {
      return c.json(oauthError("slow_down", "Too many client registration requests").body, 429);
    }

    const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(oauthError("invalid_client_metadata", "Invalid registration request").body, 400);
    if (!parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
      return c.json(oauthError("invalid_redirect_uri", "Redirect URIs must be HTTPS or localhost HTTP").body, 400);
    }

    const grantTypes = parsed.data.grant_types ?? ["authorization_code", "refresh_token"];
    const responseTypes = parsed.data.response_types ?? ["code"];
    const scopes = normalizeScopes(parsed.data.scope);
    if (!scopes || !grantTypes.includes("authorization_code") || !responseTypes.includes("code")) {
      return c.json(oauthError("invalid_client_metadata", "Unsupported grant, response type, or scope").body, 400);
    }

    const authMethod = parsed.data.token_endpoint_auth_method ?? "client_secret_post";
    const clientId = generateOAuthClientId();
    const clientSecret = authMethod === "client_secret_post" ? generateOAuthClientSecret() : null;
    await clients.create({
      clientId,
      clientSecretHash: clientSecret ? hashOAuthSecret(clientSecret) : null,
      clientName: parsed.data.client_name ?? null,
      redirectUris: parsed.data.redirect_uris,
      grantTypes,
      scopes,
      tokenEndpointAuthMethod: authMethod,
    });

    params.logger.info({ clientId, authMethod }, "Registered OAuth MCP client");

    return c.json(
      {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: parsed.data.redirect_uris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: authMethod,
        scope: scopes.join(" "),
      },
      201,
    );
  });

  routes.get("/oauth/authorize", async (c) => {
    const query = authorizeQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) return c.text("Invalid authorization request", 400);

    const client = await clients.findByClientId(query.data.client_id);
    if (!client) return c.text("Unknown OAuth client", 400);
    const clientJson = parseOAuthClientJson(client);
    const scopes = normalizeScopes(query.data.scope);
    const baseUrl = resolveBaseUrl(c, params.config);
    if (!clientJson.redirectUris.includes(query.data.redirect_uri)) {
      return c.text("Invalid redirect URI", 400);
    }
    if (
      !scopes ||
      !scopes.every((scope) => clientJson.scopes.includes(scope)) ||
      (query.data.resource && query.data.resource !== `${baseUrl}/mcp`)
    ) {
      return c.redirect(redirectWithOAuthError(query.data.redirect_uri, "invalid_request", query.data.state));
    }

    const user = await resolveSessionUser({ c, settings: params.settings, users: params.users, config: params.config });
    if (!user) {
      const returnTo = `${new URL(c.req.url).pathname}${new URL(c.req.url).search}`;
      if (params.config.MANAGED_URL) {
        const loginUrl = createManagedLoginUrl(params.config.MANAGED_URL);
        loginUrl.searchParams.set("return_to", new URL(returnTo, baseUrl).toString());
        return c.redirect(loginUrl.toString());
      }
      return c.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }

    return c.html(
      consentPage({
        clientName: client.client_name ?? "Claude",
        clientId: query.data.client_id,
        redirectUri: query.data.redirect_uri,
        codeChallenge: query.data.code_challenge,
        state: query.data.state ?? null,
        scope: scopes.join(" "),
        resource: query.data.resource ?? null,
      }),
    );
  });

  routes.post("/oauth/authorize", async (c) => {
    const origin = c.req.header("Origin");
    const baseUrl = resolveBaseUrl(c, params.config);
    if (origin && origin !== baseUrl) return c.text("Invalid origin", 403);

    const body = new URLSearchParams(await c.req.text());
    const redirectUri = formValue(body, "redirect_uri");
    const state = formValue(body, "state");
    if (!redirectUri) return c.text("Missing redirect URI", 400);

    const clientId = formValue(body, "client_id");
    if (!clientId) return c.text("Missing client ID", 400);
    const client = await clients.findByClientId(clientId);
    if (!client) return c.text("Unknown OAuth client", 400);
    const clientJson = parseOAuthClientJson(client);
    if (!clientJson.redirectUris.includes(redirectUri)) {
      return c.text("Invalid redirect URI", 400);
    }

    if (formValue(body, "decision") !== "approve") {
      return c.redirect(redirectWithOAuthError(redirectUri, "access_denied", state));
    }

    const codeChallenge = formValue(body, "code_challenge");
    const scopes = normalizeScopes(formValue(body, "scope") ?? undefined);
    const resource = formValue(body, "resource");
    if (!codeChallenge || !scopes) return c.redirect(redirectWithOAuthError(redirectUri, "invalid_request", state));

    const user = await resolveSessionUser({ c, settings: params.settings, users: params.users, config: params.config });
    if (!user) return c.redirect(redirectWithOAuthError(redirectUri, "invalid_request", state));

    if (!scopes.every((scope) => clientJson.scopes.includes(scope)) || (resource && resource !== `${baseUrl}/mcp`)) {
      return c.redirect(redirectWithOAuthError(redirectUri, "invalid_request", state));
    }

    const code = generateAuthorizationCode();
    await codes.create({
      codeHash: hashOAuthSecret(code),
      clientId,
      userId: user.id,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      expiresAt: getAuthorizationCodeExpiresAt(),
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return c.redirect(target.toString());
  });

  routes.post("/oauth/token", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    const grantType = formValue(body, "grant_type");
    const clientId = formValue(body, "client_id");
    if (!clientId) return c.json(oauthError("invalid_request", "Missing client_id").body, 400);

    const client = await clients.findByClientId(clientId);
    if (!(await authenticateClient({ client, body }))) {
      return c.json(oauthError("invalid_client", "Invalid OAuth client").body, 401);
    }

    if (grantType === "authorization_code") {
      const code = formValue(body, "code");
      const redirectUri = formValue(body, "redirect_uri");
      const codeVerifier = formValue(body, "code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        return c.json(oauthError("invalid_request", "Missing authorization code parameters").body, 400);
      }

      const row = await codes.consumeValid(hashOAuthSecret(code));
      if (
        !row ||
        row.client_id !== clientId ||
        row.redirect_uri !== redirectUri ||
        !verifyPkceS256(codeVerifier, row.code_challenge)
      ) {
        return c.json(oauthError("invalid_grant", "Invalid authorization code").body, 400);
      }

      const scopes = parseAuthorizationCodeScopes(row);
      const accessToken = generateOAuthAccessToken();
      const refreshToken = generateOAuthRefreshToken();
      await apiTokens.createOAuth({
        userId: row.user_id,
        name: client?.client_name ?? "OAuth MCP client",
        tokenHash: hashApiToken(accessToken),
        prefix: getApiTokenDisplayPrefix(accessToken),
        clientId,
        scopes,
        refreshTokenHash: hashApiToken(refreshToken),
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      });

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: scopes.join(" "),
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = formValue(body, "refresh_token");
      if (!refreshToken) return c.json(oauthError("invalid_request", "Missing refresh_token").body, 400);

      const refreshTokenHash = hashApiToken(refreshToken);
      const row = await apiTokens.findByRefreshHash(refreshTokenHash);
      if (!row || row.client_id !== clientId)
        return c.json(oauthError("invalid_grant", "Invalid refresh token").body, 400);

      const accessToken = generateOAuthAccessToken();
      const nextRefreshToken = generateOAuthRefreshToken();
      const rotated = await apiTokens.rotateOAuthToken(row.id, {
        previousRefreshTokenHash: refreshTokenHash,
        tokenHash: hashApiToken(accessToken),
        prefix: getApiTokenDisplayPrefix(accessToken),
        refreshTokenHash: hashApiToken(nextRefreshToken),
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      });
      if (!rotated) return c.json(oauthError("invalid_grant", "Invalid refresh token").body, 400);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: nextRefreshToken,
        scope: row.scopes ? (JSON.parse(row.scopes) as string[]).join(" ") : MCP_SCOPE,
      });
    }

    return c.json(oauthError("unsupported_grant_type", "Unsupported grant type").body, 400);
  });

  routes.post("/oauth/revoke", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    const token = formValue(body, "token");
    if (!token) return c.json({});

    const tokenHash = hashApiToken(token);
    const row = token.startsWith("skr_")
      ? await apiTokens.findByRefreshHash(tokenHash)
      : await apiTokens.findByHash(tokenHash);
    if (row) await apiTokens.revoke(row.user_id, row.id);
    return c.json({});
  });

  return routes;
}

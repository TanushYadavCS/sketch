/**
 * OAuth redirect flow for per-user Google Drive connections.
 *
 * Two endpoints:
 * - GET /google/authorize — redirects user to Google's consent screen
 * - GET /google/callback — Google redirects here with auth code, exchanges for tokens
 *
 * The authorize endpoint encodes userId + nonce in the state param.
 * The callback verifies the nonce, exchanges the code, saves tokens,
 * creates a connector_config, and redirects to a frontend success page.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { verifyJwt } from "../auth/jwt";
import type { Config } from "../config";
import { ensureValidToken } from "../connectors/google-drive";
import { runConnectorSync } from "../connectors/sync";
import type { ConnectorType, OAuthCredentials } from "../connectors/types";
import type { createConnectorRepository } from "../db/repositories/connectors";
import type { createProviderIdentityRepository } from "../db/repositories/provider-identities";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { SESSION_COOKIE } from "./auth";
import { denyIfNotAdmin } from "./auth-helpers";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type IdentityRepo = ReturnType<typeof createProviderIdentityRepository>;
type ConnectorRepo = ReturnType<typeof createConnectorRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

const googleConfigSchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_OAUTH_CONNECTORS = new Set<ConnectorType>(["google_drive", "gmail"]);

/** In-memory nonce store. Entries expire after 10 minutes. */
const pendingStates = new Map<string, { userId: string; connectorType: ConnectorType; expiresAt: number }>();

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}

function googleConnectorFromQuery(value: string | undefined): ConnectorType {
  return value === "gmail" ? "gmail" : "google_drive";
}

function googleScopesFor(connectorType: ConnectorType): string {
  const providerScope = connectorType === "gmail" ? GMAIL_SCOPE : DRIVE_SCOPE;
  return `${providerScope} ${USERINFO_SCOPE}`;
}

function googleConnectorName(connectorType: ConnectorType): string {
  return connectorType === "gmail" ? "Gmail" : "Google Drive";
}

function parseGoogleState(state: string): { userId: string; connectorType: ConnectorType; nonce: string } | null {
  const parts = state.split(":");
  if (parts.length === 2) {
    return { userId: parts[0], connectorType: "google_drive", nonce: parts[1] };
  }
  if (parts.length !== 3) return null;
  const connectorType = parts[1] as ConnectorType;
  if (!GOOGLE_OAUTH_CONNECTORS.has(connectorType)) return null;
  return { userId: parts[0], connectorType, nonce: parts[2] };
}

export function oauthRoutes(
  settings: SettingsRepo,
  identities: IdentityRepo,
  connectors: ConnectorRepo,
  users: UserRepo,
  db: Kysely<DB>,
  logger: Logger,
  baseUrl?: string,
  appConfig?: Config,
) {
  const routes = new Hono();

  /**
   * GET /google/authorize
   * Derives the current user from the session, then redirects to Google's OAuth consent screen.
   */
  routes.get("/google/authorize", async (c) => {
    // Resolve user from session JWT
    const config = await settings.get();
    const token = getCookie(c, SESSION_COOKIE);
    const payload = token && config?.jwt_secret ? await verifyJwt(token, config.jwt_secret) : null;
    if (!payload?.sub) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }
    let user = await users.findById(payload.sub);
    if (!user && payload.sub.includes("@")) {
      user = await users.findByEmail(payload.sub);
    }
    if (!user) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }
    const userId = user.id;
    const connectorType = googleConnectorFromQuery(c.req.query("connector"));

    if (!config?.google_oauth_client_id || !config?.google_oauth_client_secret) {
      return c.json(
        {
          error: {
            code: "OAUTH_CLIENT_NOT_CONFIGURED",
            message: `Ask your admin to configure ${googleConnectorName(connectorType)} first`,
            connector: connectorType,
          },
        },
        412,
      );
    }

    cleanupExpiredStates();

    const nonce = randomBytes(16).toString("hex");
    const state = `${userId}:${connectorType}:${nonce}`;
    pendingStates.set(nonce, { userId, connectorType, expiresAt: Date.now() + 10 * 60 * 1000 });

    // Build the callback URL from BASE_URL or the request's origin
    const origin = baseUrl ?? new URL(c.req.url).origin;
    const redirectUri = `${origin}/api/oauth/google/callback`;

    const params = new URLSearchParams({
      client_id: config.google_oauth_client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: googleScopesFor(connectorType),
      access_type: "offline",
      prompt: "consent",
      state,
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  /**
   * GET /google/callback?code=...&state=...
   * Exchanges auth code for tokens, saves to DB, redirects to frontend.
   */
  routes.get("/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      logger.warn({ error }, "Google OAuth denied");
      return c.redirect("/files?oauth=error&reason=denied");
    }

    if (!code || !state) {
      return c.redirect("/files?oauth=error&reason=missing_params");
    }

    // Parse and verify state
    const parsedState = parseGoogleState(state);
    if (!parsedState) {
      return c.redirect("/files?oauth=error&reason=invalid_state");
    }

    const { userId, connectorType, nonce } = parsedState;

    cleanupExpiredStates();
    const pending = pendingStates.get(nonce);
    if (!pending || pending.userId !== userId || pending.connectorType !== connectorType) {
      return c.redirect("/files?oauth=error&reason=invalid_state");
    }
    pendingStates.delete(nonce);

    const config = await settings.get();
    if (!config?.google_oauth_client_id || !config?.google_oauth_client_secret) {
      return c.redirect("/files?oauth=error&reason=not_configured");
    }

    // Per-user uniqueness: one Google connection per user and connector. If one exists,
    // bounce the user back with a "rotate via the manage UI" affordance instead
    // of stacking orphan rows.
    const existingConnector = await connectors.findByTypeAndOwner(connectorType, userId);
    if (existingConnector) {
      return c.redirect(`/files?oauth=error&reason=already_connected&connectorId=${existingConnector.id}`);
    }

    // Build redirect URI from BASE_URL or request origin (must match authorize step)
    const origin = baseUrl ?? new URL(c.req.url).origin;
    const redirectUri = `${origin}/api/oauth/google/callback`;

    try {
      // Exchange auth code for tokens
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.google_oauth_client_id,
          client_secret: config.google_oauth_client_secret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        logger.error({ status: tokenRes.status, body: errBody }, "Google token exchange failed");
        return c.redirect("/files?oauth=error&reason=token_exchange");
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        token_type: string;
      };

      if (!tokenData.refresh_token) {
        logger.error("No refresh_token in response — user may have already authorized this app");
        return c.redirect("/files?oauth=error&reason=no_refresh_token");
      }

      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

      // Fetch Google user info to get email
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userInfo = userInfoRes.ok
        ? ((await userInfoRes.json()) as { email?: string; id?: string })
        : { email: undefined, id: undefined };

      const providerEmail = userInfo.email ?? null;
      const providerUserId = userInfo.email ?? userInfo.id ?? userId;

      // Save to user_provider_identities
      await identities.upsert({
        userId,
        provider: connectorType,
        providerUserId,
        providerEmail,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: expiresAt,
      });

      // Create a connector_config with this user's tokens (no scope yet — user picks drives/folders next)
      const oauthCreds: OAuthCredentials = {
        type: "oauth",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        client_id: config.google_oauth_client_id,
        client_secret: config.google_oauth_client_secret,
      };

      const validCreds = await ensureValidToken(oauthCreds);

      const connectorConfig = await connectors.createConfig({
        connectorType,
        authType: "oauth",
        credentials: JSON.stringify(validCreds),
        scopeConfig: JSON.stringify({}),
        createdBy: userId,
      });

      logger.info(
        { userId, connectorId: connectorConfig.id, connectorType, providerEmail },
        "Google OAuth tokens saved",
      );

      // Gmail has no post-connect scope-picker step to kick off the first sync
      // (unlike Drive's folder picker), so connecting would otherwise leave the
      // user on an empty Files list. Start a background sync with default scope.
      if (connectorType === "gmail") {
        runConnectorSync(db, connectorConfig.id, logger, appConfig).catch((err) => {
          logger.error({ err, connectorId: connectorConfig.id }, "Gmail first sync failed");
        });
      }

      return c.redirect(`/files?oauth=success&connectorId=${connectorConfig.id}`);
    } catch (err) {
      logger.error({ err, userId }, "OAuth callback failed");
      return c.redirect("/files?oauth=error&reason=internal");
    }
  });

  /** GET /google/status — check if Google OAuth is configured. */
  routes.get("/google/status", async (c) => {
    const config = await settings.get();
    return c.json({
      configured: !!(config?.google_oauth_client_id && config?.google_oauth_client_secret),
      clientId: config?.google_oauth_client_id ?? null,
      baseUrl: baseUrl ?? null,
    });
  });

  /** PUT /google/config — save Google OAuth client_id + client_secret. Admin-only. */
  routes.put("/google/config", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => ({}));
    const parsed = googleConfigSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    await settings.update({
      googleOauthClientId: parsed.data.clientId.trim(),
      googleOauthClientSecret: parsed.data.clientSecret.trim(),
    });

    return c.json({ success: true });
  });

  return routes;
}

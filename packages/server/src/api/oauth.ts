/**
 * OAuth redirect flows for file connectors.
 *
 * Each provider exposes an authorize endpoint that redirects the user to the
 * provider consent screen and a callback endpoint that exchanges the auth code.
 *
 * The authorize endpoint encodes userId + nonce in the state param.
 * The callback verifies the nonce, exchanges the code, saves tokens,
 * creates a connector_config, and redirects to a frontend success page.
 */
import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { verifyJwt } from "../auth/jwt";
import type { Config } from "../config";
import { GOOGLE_CALENDAR_SCOPE } from "../connectors/google-calendar";
import { ensureValidToken } from "../connectors/google-drive";
import {
  createMicrosoftGraphClient,
  microsoftAdminConsentEndpoint,
  microsoftAuthorizeEndpoint,
  microsoftTokenEndpoint,
  resolveMicrosoftOAuthConfig,
} from "../connectors/microsoft-graph";
import { OUTLOOK_MICROSOFT_SCOPE } from "../connectors/outlook";
import { getConnector } from "../connectors/registry";
import { runConnectorSync } from "../connectors/sync";
import { TEAMS_MICROSOFT_SCOPE } from "../connectors/teams";
import type { ConnectorType, OAuthCredentials } from "../connectors/types";
import { validateZohoCrmCredentials } from "../connectors/zoho-crm";
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

const oauthClientConfigSchema = z.object({
  clientId: z.string().min(1, "clientId is required"),
  clientSecret: z.string().min(1, "clientSecret is required"),
});

const microsoftOAuthClientConfigSchema = oauthClientConfigSchema.extend({
  tenant: z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    z
      .string()
      .trim()
      .min(1, "tenant is required")
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/, "tenant must be a directory ID, verified domain, or tenant alias"),
  ),
});

const ZOHO_REGIONS = ["com", "eu", "in", "com.au", "jp", "ca", "sa"] as const;
const zohoRegionSchema = z.enum(ZOHO_REGIONS);

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_OAUTH_CONNECTORS = new Set<ConnectorType>(["google_drive", "google_calendar", "gmail"]);
const MICROSOFT_OAUTH_CONNECTORS = new Set<ConnectorType>(["outlook", "teams"]);
const ZOHO_SCOPE = "ZohoCRM.modules.ALL,ZohoCRM.users.READ,ZohoCRM.org.READ,ZohoCRM.settings.READ";
const MICROSOFT_GRAPH_ADMIN_CONSENT_SCOPE = "https://graph.microsoft.com/.default";

/** In-memory nonce store. Entries expire after 10 minutes. */
const pendingStates = new Map<
  string,
  { userId: string; expiresAt: number; connectorType?: ConnectorType; region?: (typeof ZOHO_REGIONS)[number] }
>();

/**
 * Resolves the public origin (`scheme://host`) used to build OAuth redirect URIs.
 *
 * Multi-tenant deployments serve each tenant on its own host (e.g.
 * `capmobfinance.getsketch.ai`), so a single configured origin cannot be used.
 * We derive it from the request instead. Behind a TLS-terminating proxy the
 * internal hop to Node is plain HTTP, so `c.req.url` reports `http://`; the
 * proxy's `X-Forwarded-Proto`/`X-Forwarded-Host` headers carry the real public
 * scheme and host and take precedence. An explicit `baseUrl` override (BASE_URL)
 * wins when set, which is handy for local development.
 */
export function resolveOrigin(c: Context, baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl;
  const requestUrl = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || requestUrl.protocol.replace(/:$/, "");
  const host = forwardedHost || requestUrl.host;
  return `${proto}://${host}`;
}

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}

export function googleConnectorFromQuery(value: string | undefined): ConnectorType {
  if (value === "gmail") return "gmail";
  if (value === "google_calendar" || value === "calendar") return "google_calendar";
  return "google_drive";
}

export function googleScopesFor(connectorType: ConnectorType): string {
  const providerScope =
    connectorType === "gmail" ? GMAIL_SCOPE : connectorType === "google_calendar" ? GOOGLE_CALENDAR_SCOPE : DRIVE_SCOPE;
  return `${providerScope} ${USERINFO_SCOPE}`;
}

function googleConnectorName(connectorType: ConnectorType): string {
  if (connectorType === "gmail") return "Gmail";
  if (connectorType === "google_calendar") return "Google Calendar";
  return "Google Drive";
}

export function initialGoogleScopeConfig(connectorType: ConnectorType): Record<string, unknown> {
  return connectorType === "google_calendar" ? { calendarIds: [] } : {};
}

export function shouldRunGoogleFirstSync(connectorType: ConnectorType): boolean {
  return connectorType === "gmail";
}

function microsoftConnectorFromQuery(value: string | undefined): ConnectorType {
  return value === "teams" ? "teams" : "outlook";
}

function microsoftScopesFor(connectorType: ConnectorType): string {
  return connectorType === "teams" ? TEAMS_MICROSOFT_SCOPE : OUTLOOK_MICROSOFT_SCOPE;
}

function microsoftConnectorName(connectorType: ConnectorType): string {
  return connectorType === "teams" ? "Microsoft Teams" : "Outlook";
}

function extractMicrosoftConsentRequiredCode(errorDescription: string | undefined): string | undefined {
  return errorDescription?.match(/\bAADSTS(?:90094|65001)\b/)?.[0];
}

function microsoftOAuthErrorReason(errorDescription: string | undefined, errorSubcode: string | undefined): string {
  const consentRequiredCode = extractMicrosoftConsentRequiredCode(errorDescription);
  if (
    consentRequiredCode ||
    errorSubcode === "consent_required" ||
    errorDescription?.includes("error_subcode=consent_required")
  ) {
    return "admin_consent_required";
  }
  return "denied";
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

function parseMicrosoftState(state: string): { userId: string; connectorType: ConnectorType; nonce: string } | null {
  const parts = state.split(":");
  if (parts.length === 2) {
    return { userId: parts[0], connectorType: "outlook", nonce: parts[1] };
  }
  if (parts.length !== 3) return null;
  const connectorType = parts[1] as ConnectorType;
  if (!MICROSOFT_OAUTH_CONNECTORS.has(connectorType)) return null;
  return { userId: parts[0], connectorType, nonce: parts[2] };
}

export function oauthRoutes(
  settings: SettingsRepo,
  identities: IdentityRepo,
  connectors: ConnectorRepo,
  users: UserRepo,
  db: Kysely<DB>,
  logger: Logger,
  opts:
    | string
    | {
        baseUrl?: string;
        appConfig?: Config;
        zohoClientId?: string;
        zohoClientSecret?: string;
        microsoftClientId?: string;
        microsoftClientSecret?: string;
        microsoftTenant?: string;
      } = {},
) {
  const routes = new Hono();
  const baseUrl = typeof opts === "string" ? opts : opts.baseUrl;
  const appConfig = typeof opts === "string" ? undefined : opts.appConfig;
  const zohoClientId = typeof opts === "string" ? undefined : opts.zohoClientId;
  const zohoClientSecret = typeof opts === "string" ? undefined : opts.zohoClientSecret;
  const microsoftClientId = typeof opts === "string" ? undefined : opts.microsoftClientId;
  const microsoftClientSecret = typeof opts === "string" ? undefined : opts.microsoftClientSecret;
  const microsoftTenant = typeof opts === "string" ? "common" : (opts.microsoftTenant ?? "common");

  function isCanvasCredentialSource(): boolean {
    return appConfig?.CONNECTOR_CREDENTIAL_SOURCE === "canvas";
  }

  function isLocalCredentialEncryptionMissing(): boolean {
    return appConfig?.CONNECTOR_CREDENTIAL_SOURCE === "local" && !appConfig.ENCRYPTION_KEY;
  }

  function encryptionRequiredResponse(c: Context, connectorType: ConnectorType) {
    return c.json(
      {
        error: {
          code: "ENCRYPTION_REQUIRED",
          message: "Local OAuth credentials require ENCRYPTION_KEY so credentials are encrypted at rest",
          connector: connectorType,
        },
      },
      400,
    );
  }

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

    if (isCanvasCredentialSource()) {
      return c.json(
        {
          error: {
            code: "CANVAS_CREDENTIAL_SOURCE_REQUIRED",
            message: `${googleConnectorName(connectorType)} credentials are managed by Canvas in this deployment.`,
            connector: connectorType,
          },
        },
        400,
      );
    }

    if (isLocalCredentialEncryptionMissing()) {
      return encryptionRequiredResponse(c, connectorType);
    }

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
    const origin = resolveOrigin(c, baseUrl);
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

    if (isCanvasCredentialSource()) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=canvas_credential_source`);
    }

    if (isLocalCredentialEncryptionMissing()) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=encryption_required`);
    }

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
    const origin = resolveOrigin(c, baseUrl);
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
        scopeConfig: JSON.stringify(initialGoogleScopeConfig(connectorType)),
        createdBy: userId,
      });

      logger.info(
        { userId, connectorId: connectorConfig.id, connectorType, providerEmail },
        "Google OAuth tokens saved",
      );

      if (shouldRunGoogleFirstSync(connectorType)) {
        runConnectorSync(db, connectorConfig.id, logger, appConfig).catch((err) => {
          logger.error({ err, connectorId: connectorConfig.id, connectorType }, "Google first sync failed");
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

  routes.get("/microsoft/authorize", async (c) => {
    const connectorType = microsoftConnectorFromQuery(c.req.query("connector"));
    const connectorName = microsoftConnectorName(connectorType);

    if (isCanvasCredentialSource()) {
      return c.json(
        {
          error: {
            code: "CANVAS_CREDENTIAL_SOURCE_REQUIRED",
            message: `${connectorName} credentials are managed by Canvas in this deployment.`,
            connector: connectorType,
          },
        },
        400,
      );
    }

    if (isLocalCredentialEncryptionMissing()) {
      return encryptionRequiredResponse(c, connectorType);
    }

    const config = await settings.get();
    const { clientId, clientSecret, tenant } = resolveMicrosoftOAuthConfig(config, {
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
      tenant: microsoftTenant,
    });

    if (!clientId || !clientSecret || !tenant) {
      return c.json(
        {
          error: {
            code: "OAUTH_CLIENT_NOT_CONFIGURED",
            message: `Set Microsoft OAuth credentials in settings or the server environment before connecting ${connectorName}`,
            connector: connectorType,
          },
        },
        412,
      );
    }

    const userId = c.get("sub");
    if (!userId || typeof userId !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    const existingConnector = await connectors.findByTypeAndOwner(connectorType, userId);
    if (existingConnector) {
      return c.json(
        {
          error: {
            code: "ALREADY_CONNECTED",
            message: `${connectorName} is already connected for this user.`,
            connector: connectorType,
          },
        },
        409,
      );
    }

    cleanupExpiredStates();

    const nonce = randomBytes(16).toString("hex");
    const state = `${userId}:${connectorType}:${nonce}`;
    pendingStates.set(nonce, { userId, connectorType, expiresAt: Date.now() + 10 * 60 * 1000 });

    const origin = resolveOrigin(c, baseUrl);
    const redirectUri = `${origin}/api/oauth/microsoft/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: microsoftScopesFor(connectorType),
      prompt: "select_account",
      state,
    });

    return c.redirect(`${microsoftAuthorizeEndpoint(tenant)}?${params.toString()}`);
  });

  routes.get("/microsoft/admin-consent", async (c) => {
    const connectorParam = c.req.query("connector");
    if (!connectorParam || !MICROSOFT_OAUTH_CONNECTORS.has(connectorParam as ConnectorType)) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_CONNECTOR",
            message: "Microsoft admin consent requires a Microsoft connector (Outlook or Teams)",
            connector: connectorParam ?? null,
          },
        },
        400,
      );
    }
    const connectorType = connectorParam as ConnectorType;

    if (isCanvasCredentialSource()) {
      return c.json(
        {
          error: {
            code: "CANVAS_CREDENTIAL_SOURCE_REQUIRED",
            message: "Microsoft OAuth credentials are managed by Canvas in this deployment.",
            connector: connectorType,
          },
        },
        400,
      );
    }

    if (isLocalCredentialEncryptionMissing()) {
      return encryptionRequiredResponse(c, connectorType);
    }

    const config = await settings.get();
    const { clientId, clientSecret, tenant } = resolveMicrosoftOAuthConfig(config, {
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
      tenant: microsoftTenant,
    });

    if (!clientId || !clientSecret || !tenant) {
      return c.json(
        {
          error: {
            code: "OAUTH_CLIENT_NOT_CONFIGURED",
            message:
              "Set Microsoft OAuth credentials in settings or the server environment before granting admin consent",
            connector: connectorType,
          },
        },
        412,
      );
    }

    const userId = c.get("sub");
    if (!userId || typeof userId !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    cleanupExpiredStates();

    const nonce = randomBytes(16).toString("hex");
    const state = `${userId}:${connectorType}:${nonce}`;
    pendingStates.set(nonce, { userId, connectorType, expiresAt: Date.now() + 10 * 60 * 1000 });

    const origin = resolveOrigin(c, baseUrl);
    const redirectUri = `${origin}/api/oauth/microsoft/callback`;
    const adminConsentTenant = tenant === "common" ? "organizations" : tenant;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: MICROSOFT_GRAPH_ADMIN_CONSENT_SCOPE,
    });

    return c.redirect(`${microsoftAdminConsentEndpoint(adminConsentTenant)}?${params.toString()}`);
  });

  routes.get("/microsoft/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");
    const errorSubcode = c.req.query("error_subcode");
    const adminConsent = c.req.query("admin_consent");

    if (error) {
      const connectorType = state ? (parseMicrosoftState(state)?.connectorType ?? "outlook") : "outlook";
      const aadstsCode = extractMicrosoftConsentRequiredCode(errorDescription);
      const reason = microsoftOAuthErrorReason(errorDescription, errorSubcode);
      logger.warn(
        { error, aadstsCode, consentRequired: reason === "admin_consent_required" },
        "Microsoft OAuth denied",
      );
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=${reason}`);
    }

    if (adminConsent === "True" || adminConsent === "true") {
      const parsedState = state ? parseMicrosoftState(state) : null;
      if (!parsedState) {
        return c.redirect("/files?oauth=error&reason=invalid_state");
      }

      const { userId, connectorType, nonce } = parsedState;
      cleanupExpiredStates();
      const pending = pendingStates.get(nonce);
      if (!pending || pending.userId !== userId || pending.connectorType !== connectorType) {
        return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=invalid_state`);
      }
      pendingStates.delete(nonce);

      return c.redirect(`/files?oauth=admin_consent_granted&connector=${connectorType}`);
    }

    if (!code || !state) {
      return c.redirect("/files?oauth=error&connector=outlook&reason=missing_params");
    }

    const parsedState = parseMicrosoftState(state);
    if (!parsedState) {
      return c.redirect("/files?oauth=error&connector=outlook&reason=invalid_state");
    }

    const { userId, connectorType, nonce } = parsedState;

    cleanupExpiredStates();
    const pending = pendingStates.get(nonce);
    if (!pending || pending.userId !== userId || pending.connectorType !== connectorType) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=invalid_state`);
    }
    pendingStates.delete(nonce);

    if (isCanvasCredentialSource()) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=canvas_credential_source`);
    }

    if (isLocalCredentialEncryptionMissing()) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=encryption_required`);
    }

    const config = await settings.get();
    const { clientId, clientSecret, tenant } = resolveMicrosoftOAuthConfig(config, {
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
      tenant: microsoftTenant,
    });

    if (!clientId || !clientSecret || !tenant) {
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=not_configured`);
    }

    const origin = resolveOrigin(c, baseUrl);
    const redirectUri = `${origin}/api/oauth/microsoft/callback`;
    const scope = microsoftScopesFor(connectorType);

    try {
      const existingConnector = await connectors.findByTypeAndOwner(connectorType, userId);
      if (existingConnector) {
        return c.redirect(
          `/files?oauth=error&connector=${connectorType}&reason=already_connected&connectorId=${existingConnector.id}`,
        );
      }

      const tokenRes = await fetch(microsoftTokenEndpoint(tenant), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        logger.error({ status: tokenRes.status, body: errBody }, "Microsoft token exchange failed");
        return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=token_exchange`);
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        token_type?: string;
      };

      if (!tokenData.refresh_token) {
        logger.error("No Microsoft refresh_token in response");
        return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=no_refresh_token`);
      }

      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      const oauthCreds: OAuthCredentials = {
        type: "oauth",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
        client_id: clientId,
        client_secret: clientSecret,
        scope,
        tenant,
      };

      await getConnector(connectorType).validateCredentials(oauthCreds);
      const profile = await fetchMicrosoftCurrentUser(oauthCreds, logger);
      const providerEmail = profile.mail ?? profile.userPrincipalName ?? null;
      const providerUserId = profile.id ?? providerEmail ?? userId;

      await identities.upsert({
        userId,
        provider: "microsoft",
        providerUserId,
        providerEmail,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: expiresAt,
      });

      const connectorConfig = await connectors.createConfig({
        connectorType,
        authType: "oauth",
        credentials: JSON.stringify(oauthCreds),
        scopeConfig: JSON.stringify({}),
        createdBy: userId,
        credentialHint: providerEmail,
      });

      logger.info(
        { userId, connectorId: connectorConfig.id, connectorType, providerEmail },
        "Microsoft OAuth tokens saved",
      );

      runConnectorSync(db, connectorConfig.id, logger, appConfig).catch((err) => {
        logger.error({ err, connectorId: connectorConfig.id, connectorType }, "Microsoft first sync failed");
      });

      return c.redirect(`/files?oauth=success&connector=${connectorType}&connectorId=${connectorConfig.id}`);
    } catch (err) {
      logger.error({ err, userId }, "Microsoft OAuth callback failed");
      return c.redirect(`/files?oauth=error&connector=${connectorType}&reason=internal`);
    }
  });

  routes.get("/microsoft/status", async (c) => {
    const config = await settings.get();
    const { clientId, clientSecret, tenant, source } = resolveMicrosoftOAuthConfig(config, {
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
      tenant: microsoftTenant,
    });
    const envConfigured = !!(microsoftClientId && microsoftClientSecret);
    return c.json({
      configured: !!(clientId && clientSecret && tenant),
      envConfigured,
      settingsConfigured: source === "settings",
      clientId: clientId ?? null,
      baseUrl: baseUrl ?? null,
      tenant: tenant ?? null,
    });
  });

  routes.get("/zoho/authorize", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (isLocalCredentialEncryptionMissing()) {
      return encryptionRequiredResponse(c, "zoho_crm");
    }

    if (!zohoClientId || !zohoClientSecret) {
      return c.json(
        {
          error: {
            code: "OAUTH_CLIENT_NOT_CONFIGURED",
            message: "Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET before connecting Zoho CRM",
            connector: "zoho_crm",
          },
        },
        412,
      );
    }

    const parsedRegion = zohoRegionSchema.safeParse(c.req.query("region"));
    if (!parsedRegion.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `region must be one of: ${ZOHO_REGIONS.join(", ")}`,
          },
        },
        400,
      );
    }

    const userId = c.get("sub");
    if (!userId || typeof userId !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    // Fail fast if Zoho CRM is already connected. The callback enforces this
    // too, but blocking before the redirect prevents a re-consent at Zoho from
    // rotating/invalidating the live connection's refresh token.
    const existingZoho = await connectors.findConfigsByType("zoho_crm");
    if (existingZoho.some((config) => config.sync_status !== "disabled")) {
      return c.json(
        {
          error: {
            code: "ALREADY_CONNECTED",
            message: "Zoho CRM is already connected. Disconnect the existing connection before reconnecting.",
            connector: "zoho_crm",
          },
        },
        409,
      );
    }

    cleanupExpiredStates();

    const nonce = randomBytes(16).toString("hex");
    const state = `${userId}:${nonce}`;
    pendingStates.set(nonce, { userId, region: parsedRegion.data, expiresAt: Date.now() + 10 * 60 * 1000 });

    const origin = resolveOrigin(c, baseUrl);
    const redirectUri = `${origin}/api/oauth/zoho/callback`;

    const params = new URLSearchParams({
      client_id: zohoClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ZOHO_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    return c.redirect(`${zohoAccountsServer(parsedRegion.data)}/oauth/v2/auth?${params.toString()}`);
  });

  routes.get("/zoho/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      logger.warn({ error }, "Zoho CRM OAuth denied");
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=denied");
    }

    if (!code || !state) {
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=missing_params");
    }

    const colonIdx = state.indexOf(":");
    if (colonIdx === -1) {
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=invalid_state");
    }

    const userId = state.substring(0, colonIdx);
    const nonce = state.substring(colonIdx + 1);

    cleanupExpiredStates();
    const pending = pendingStates.get(nonce);
    if (!pending || pending.userId !== userId || !pending.region) {
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=invalid_state");
    }
    pendingStates.delete(nonce);

    if (isLocalCredentialEncryptionMissing()) {
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=encryption_required");
    }

    if (!zohoClientId || !zohoClientSecret) {
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=not_configured");
    }

    const accountsServer =
      c.req.query("accounts-server") ?? c.req.query("accounts_server") ?? zohoAccountsServer(pending.region);
    const origin = resolveOrigin(c, baseUrl);
    const redirectUri = `${origin}/api/oauth/zoho/callback`;

    try {
      const existingZoho = await connectors.findConfigsByType("zoho_crm");
      if (existingZoho.some((config) => config.sync_status !== "disabled")) {
        return c.redirect("/files?oauth=error&connector=zoho_crm&reason=already_connected");
      }

      const tokenRes = await fetch(`${accountsServer}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: zohoClientId,
          client_secret: zohoClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        logger.error({ status: tokenRes.status, body: errBody }, "Zoho CRM token exchange failed");
        return c.redirect("/files?oauth=error&connector=zoho_crm&reason=token_exchange");
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        api_domain?: string;
      };

      if (!tokenData.refresh_token) {
        logger.error("No Zoho CRM refresh_token in response");
        return c.redirect("/files?oauth=error&connector=zoho_crm&reason=no_refresh_token");
      }
      if (!tokenData.api_domain) {
        logger.error("No Zoho CRM api_domain in token response");
        return c.redirect("/files?oauth=error&connector=zoho_crm&reason=no_api_domain");
      }

      const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();
      const oauthCreds: OAuthCredentials = {
        type: "oauth",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
        client_id: zohoClientId,
        client_secret: zohoClientSecret,
        accounts_server: accountsServer,
        api_domain: tokenData.api_domain,
        region: pending.region,
      };

      await validateZohoCrmCredentials(oauthCreds);
      const hint = await fetchZohoCurrentUserHint(oauthCreds, logger);

      const connectorConfig = await connectors.createConfig({
        connectorType: "zoho_crm",
        authType: "oauth",
        credentials: JSON.stringify(oauthCreds),
        scopeConfig: JSON.stringify({ region: pending.region, accountsServer, apiDomain: tokenData.api_domain }),
        createdBy: userId,
        credentialHint: hint,
      });

      logger.info({ userId, connectorId: connectorConfig.id, region: pending.region }, "Zoho CRM OAuth tokens saved");

      runConnectorSync(db, connectorConfig.id, logger, appConfig).catch((err) => {
        logger.error({ err, connectorId: connectorConfig.id }, "Zoho CRM first sync failed");
      });

      return c.redirect(`/files?oauth=success&connector=zoho_crm&connectorId=${connectorConfig.id}`);
    } catch (err) {
      logger.error({ err, userId }, "Zoho CRM OAuth callback failed");
      return c.redirect("/files?oauth=error&connector=zoho_crm&reason=internal");
    }
  });

  routes.get("/zoho/status", (c) => {
    return c.json({
      configured: !!(zohoClientId && zohoClientSecret),
      clientId: zohoClientId ?? null,
      baseUrl: baseUrl ?? null,
      regions: ZOHO_REGIONS,
    });
  });

  /** PUT /google/config — save Google OAuth client_id + client_secret. Admin-only. */
  routes.put("/google/config", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => ({}));
    const parsed = oauthClientConfigSchema.safeParse(body);
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

  /** PUT /microsoft/config — save Microsoft OAuth client_id, tenant, and client_secret. Admin-only. */
  routes.put("/microsoft/config", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => ({}));
    const parsed = microsoftOAuthClientConfigSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    await settings.update({
      microsoftOauthClientId: parsed.data.clientId.trim(),
      microsoftOauthClientSecret: parsed.data.clientSecret.trim(),
      microsoftOauthTenant: parsed.data.tenant,
    });

    return c.json({ success: true });
  });

  return routes;
}

function zohoAccountsServer(region: (typeof ZOHO_REGIONS)[number]): string {
  return `https://accounts.zoho.${region}`;
}

async function fetchZohoCurrentUserHint(credentials: OAuthCredentials, logger: Logger): Promise<string | null> {
  if (!credentials.api_domain || !credentials.access_token) return null;

  try {
    const res = await fetch(`${credentials.api_domain}/crm/v6/users?type=CurrentUser`, {
      headers: { Authorization: `Zoho-oauthtoken ${credentials.access_token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { users?: Array<{ email?: string; full_name?: string; id?: string }> };
    const user = body.users?.[0];
    return user?.email ?? user?.full_name ?? user?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Zoho CRM current user hint");
    return null;
  }
}

async function fetchMicrosoftCurrentUser(
  credentials: OAuthCredentials,
  logger: Logger,
): Promise<{ id?: string; mail?: string | null; userPrincipalName?: string | null }> {
  try {
    const graph = createMicrosoftGraphClient(credentials, {
      scope: credentials.scope,
      tenant: credentials.tenant,
    });
    return graph.request<{ id?: string; mail?: string | null; userPrincipalName?: string | null }>("/me", {
      params: { $select: "id,mail,userPrincipalName" },
    });
  } catch (err) {
    logger.warn({ err }, "Failed to fetch Microsoft current user hint");
    return {};
  }
}

/**
 * API middleware — setup mode detection and auth enforcement.
 *
 * Setup mode:
 * - Before an admin account exists, only setup status/account + public paths
 *   are accessible. All other API routes return 503.
 * - After an admin exists but onboarding is incomplete, only /api/setup/*
 *   routes are accessible, and non-public setup routes require auth.
 *
 * Auth: when an admin account exists, all non-public API routes require
 * a valid JWT session cookie. Role and subject are set on the Hono context.
 */
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { verifyJwt } from "../auth/jwt";
import type { createSettingsRepository } from "../db/repositories/settings";
import { managedLoginHref } from "../managed-url";
import { SESSION_COOKIE } from "./auth";

declare module "hono" {
  interface ContextVariableMap {
    role: "admin" | "member";
    sub: string;
    /** Caller's primary email — used by file-access RBAC. Null if the user row has no email. */
    email: string | null;
    /** Org setting: when true, admins bypass per-file content RBAC for direct HTTP reads. */
    adminCanReadAllFiles: boolean;
  }
}

const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/session",
  "/api/auth/verify-email",
  "/api/auth/magic-link",
  "/api/auth/magic-link/verify",
  "/api/health",
  "/api/oauth/google/callback",
  "/api/oauth/microsoft/callback",
  "/api/oauth/zoho/callback",
]);
const SETUP_PATHS_PREFIX = "/api/setup";
const PUBLIC_SETUP_PATHS = new Set(["/api/setup/status", "/api/setup/account"]);
const ONBOARDING_PATHS_PREFIX = "/api/channels/whatsapp";
const PLATFORM_COOKIE = "sketch_platform_session";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

export interface AuthMiddlewareOpts {
  managedAuthSecret?: string;
  managedUrl?: string;
  findUserByEmail?: (email: string) => Promise<{ id: string; authRole?: string | null; email?: string | null } | null>;
  verifySketchApiKey?: (token: string) => Promise<boolean>;
  hasLocalAdmin?: () => Promise<boolean>;
  resolveLocalSessionUser?: (
    sub: string,
  ) => Promise<{ id: string; authRole?: string | null; email?: string | null } | null>;
}

function toAuthRole(value: string | null | undefined): "admin" | "member" {
  return value === "admin" ? "admin" : "member";
}

function canUseSketchApiKey(path: string, method: string): boolean {
  if (method === "GET" && path === "/api/users") return true;
  if (method === "GET" && path === "/api/channels/slack") return true;
  if (method === "GET" && path === "/api/channels/whatsapp/groups") return true;
  if (method === "POST" && path === "/api/channels/whatsapp/groups/sync") return true;
  if (method === "POST" && path === "/api/agent-runs") return true;
  if (method === "GET" && path.startsWith("/api/agent-sessions/") && path.endsWith("/messages")) return true;
  if (method === "GET" && (path === "/api/workflows" || path.startsWith("/api/workflows/"))) return true;
  if (method === "POST" && path.startsWith("/api/workflows/") && path.endsWith("/runs")) return true;
  return false;
}

function requiresSketchApiKey(path: string, method: string): boolean {
  if (method === "POST" && path === "/api/agent-runs") return true;
  if (method === "GET" && path.startsWith("/api/agent-sessions/") && path.endsWith("/messages")) return true;
  if (method === "GET" && (path === "/api/workflows" || path.startsWith("/api/workflows/"))) return true;
  if (method === "POST" && path.startsWith("/api/workflows/") && path.endsWith("/runs")) return true;
  return false;
}

export function createAuthMiddleware(settings: SettingsRepo, opts?: AuthMiddlewareOpts) {
  let cachedSecret: string | null = null;

  return async (c: Context, next: Next) => {
    const path = c.req.path;

    // System routes have their own bearer token auth — skip JWT middleware entirely.
    if (path.startsWith("/api/system/")) {
      return next();
    }

    const isSetupPath = path.startsWith(SETUP_PATHS_PREFIX);
    const isPublicPath = PUBLIC_PATHS.has(path);
    const isPublicSetupPath = PUBLIC_SETUP_PATHS.has(path);

    // Setup bootstrap paths are always accessible.
    if (isPublicSetupPath) {
      return next();
    }

    let setupComplete = false;
    let hasAdmin = false;
    let jwtSecret: string | null = null;
    let adminCanReadAllFiles = false;
    try {
      const row = await settings.get();
      setupComplete = Boolean(row?.onboarding_completed_at);
      hasAdmin = opts?.hasLocalAdmin ? await opts.hasLocalAdmin() : Boolean(row?.admin_email);
      jwtSecret = row?.jwt_secret ?? null;
      if (jwtSecret) cachedSecret = jwtSecret;
      adminCanReadAllFiles = row?.admin_can_read_all_files === 1;
    } catch {
      // DB unavailable — let public paths through, block everything else
    }

    // WhatsApp pairing routes are needed during onboarding step 3 — treat
    // them like setup paths so they're accessible before onboarding completes.
    const isOnboardingPath = path.startsWith(ONBOARDING_PATHS_PREFIX);

    // Setup bootstrap mode (no admin yet): only public paths + setup bootstrap.
    if (!setupComplete && !hasAdmin) {
      if (isPublicPath) {
        return next();
      }
      return c.json({ error: { code: "SETUP_REQUIRED", message: "Onboarding not complete" } }, 503);
    }

    // During onboarding after admin exists, allow setup + whatsapp routes (auth still required).
    if (!setupComplete && !isSetupPath && !isOnboardingPath) {
      if (isPublicPath) {
        return next();
      }
      return c.json({ error: { code: "SETUP_REQUIRED", message: "Onboarding not complete" } }, 503);
    }

    // Public paths pass through.
    if (isPublicPath) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const apiKeyRoute = canUseSketchApiKey(path, c.req.method);
    if (authHeader?.startsWith("Bearer ") && opts?.verifySketchApiKey && apiKeyRoute) {
      const token = authHeader.slice("Bearer ".length);
      if (await opts.verifySketchApiKey(token)) {
        c.set("role", "admin");
        c.set("sub", "sketch-api-key");
        c.set("email", null);
        c.set("adminCanReadAllFiles", adminCanReadAllFiles);
        return next();
      }
    }
    if (requiresSketchApiKey(path, c.req.method)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Valid Sketch API key required" } }, 401);
    }

    // Managed SSO: check platform cookie first when configured.
    if (opts?.managedAuthSecret) {
      const platformToken = getCookie(c, PLATFORM_COOKIE);
      if (platformToken) {
        const payload = await verifyJwt(platformToken, opts.managedAuthSecret);
        if (!payload || !payload.email) {
          return c.redirect(managedLoginHref(opts.managedUrl));
        }

        const user = await opts.findUserByEmail?.(payload.email);
        if (!user) {
          return c.json({ error: { code: "FORBIDDEN", message: "User not found in this tenant" } }, 403);
        }

        c.set("role", toAuthRole(user.authRole));
        c.set("sub", user.id);
        c.set("email", user.email ?? payload.email ?? null);
        c.set("adminCanReadAllFiles", adminCanReadAllFiles);
        return next();
      }
    }

    // Local auth: existing sketch_session cookie.
    const secret = jwtSecret ?? cachedSecret;
    if (!secret) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
    }

    const payload = await verifyJwt(token, secret);
    if (!payload) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Session expired" } }, 401);
    }

    if (opts?.resolveLocalSessionUser) {
      const user = await opts.resolveLocalSessionUser(payload.sub);
      if (!user) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Session expired" } }, 401);
      }
      c.set("role", toAuthRole(user.authRole));
      c.set("sub", user.id);
      c.set("email", user.email ?? payload.email ?? null);
    } else {
      c.set("role", payload.role);
      c.set("sub", payload.sub);
      c.set("email", payload.email ?? null);
    }
    c.set("adminCanReadAllFiles", adminCanReadAllFiles);

    return next();
  };
}

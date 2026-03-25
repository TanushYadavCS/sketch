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
import { SESSION_COOKIE } from "./auth";

declare module "hono" {
  interface ContextVariableMap {
    role: "admin" | "member";
    sub: string;
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
]);
const SETUP_PATHS_PREFIX = "/api/setup";
const PUBLIC_SETUP_PATHS = new Set(["/api/setup/status", "/api/setup/account"]);
const ONBOARDING_PATHS_PREFIX = "/api/channels/whatsapp";
const PLATFORM_COOKIE = "sketch_platform_session";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

export interface AuthMiddlewareOpts {
  managedAuthSecret?: string;
  managedUrl?: string;
  findUserByEmail?: (email: string) => Promise<{ id: string; role: "admin" | "member" } | null>;
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
    try {
      const row = await settings.get();
      setupComplete = Boolean(row?.onboarding_completed_at);
      hasAdmin = Boolean(row?.admin_email);
      jwtSecret = row?.jwt_secret ?? null;
      if (jwtSecret) cachedSecret = jwtSecret;
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

    // Managed SSO: check platform cookie first when configured.
    if (opts?.managedAuthSecret) {
      const platformToken = getCookie(c, PLATFORM_COOKIE);
      if (platformToken) {
        const payload = await verifyJwt(platformToken, opts.managedAuthSecret);
        if (!payload) {
          const loginUrl = opts.managedUrl ? `${opts.managedUrl}/login` : "/login";
          return c.redirect(loginUrl);
        }

        const user = await opts.findUserByEmail?.(payload.sub);
        if (!user) {
          return c.json({ error: { code: "FORBIDDEN", message: "User not found in this tenant" } }, 403);
        }

        c.set("role", user.role);
        c.set("sub", payload.sub);
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

    c.set("role", payload.role);
    c.set("sub", payload.sub);

    return next();
  };
}

export function requireAdmin() {
  return async (c: Context, next: Next) => {
    const role = c.get("role");
    if (role !== "admin") {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin access required" } }, 403);
    }
    return next();
  };
}

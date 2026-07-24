/**
 * Auth routes — admin login (password), member login (magic link), session management.
 * JWTs are signed with a per-deployment secret stored in the settings table,
 * so sessions survive server restarts. Cookie-based with httpOnly, sameSite=lax.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { verifyEmailToken } from "../auth/email-verify";
import { signJwt, verifyJwt } from "../auth/jwt";
import {
  type VerifiedUser,
  createRateLimitedMagicLinkToken,
  findValidMagicLinkUserId,
  findVerifiedUserByEmail,
  verifyMagicLinkToken,
} from "../auth/magic-link";
import { verifyPassword } from "../auth/password";
import type { Config } from "../config";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { resolveBaseUrl } from "./shared";

export type MagicLinkSender = (opts: {
  user: Pick<VerifiedUser, "id" | "name" | "email" | "slack_user_id" | "whatsapp_number">;
  magicLinkUrl: string;
  botName: string;
}) => Promise<string[]>;

export const SESSION_COOKIE = "sketch_session";
const PLATFORM_COOKIE = "sketch_platform_session";
const MAGIC_LINK_CONFIRMATION_COOKIE = "sketch_magic_link_confirmation";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const MAGIC_LINK_CONFIRMATION_MAX_AGE = 5 * 60;

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type AuthRole = "admin" | "member";

function toAuthRole(value: string | null | undefined): AuthRole {
  return value === "admin" ? "admin" : "member";
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("/login")) return null;
  return trimmed;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function magicLinkConfirmationPage(
  token: string,
  confirmation: string,
  returnTo: string | null,
  styleNonce: string,
): string {
  const returnToInput = returnTo ? `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Confirm sign in</title>
  <style nonce="${escapeHtml(styleNonce)}">
    :root {
      color-scheme: dark;
      font-family:
        Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      font-synthesis: none;
    }

    * {
      box-sizing: border-box;
    }

    body {
      min-width: 320px;
      min-height: 100vh;
      margin: 0;
      color: #f5f5f6;
      background: #000000;
      -webkit-font-smoothing: antialiased;
    }

    .shell {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 48px 20px;
    }

    .auth {
      width: min(100%, 400px);
      transform: translateY(-3vh);
    }

    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 9px;
      margin-bottom: 34px;
      color: #fafafa;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.025em;
    }

    .brand-mark {
      display: block;
      width: 28px;
      height: 28px;
      object-fit: contain;
    }

    .card {
      padding: 26px 36px 28px;
      overflow: hidden;
      border: 1px solid #292927;
      border-radius: 14px;
      background: #1b1b1a;
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
      text-align: center;
    }

    .status {
      display: grid;
      width: 48px;
      height: 48px;
      margin: 0 auto 18px;
      place-items: center;
      border-radius: 999px;
      color: #eeeeec;
      background: #383836;
    }

    .status svg {
      width: 22px;
      height: 22px;
    }

    h1 {
      margin: 0;
      color: #fafafa;
      font-size: 21px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -0.025em;
    }

    .description {
      max-width: 310px;
      margin: 9px auto 24px;
      color: #8d8d89;
      font-size: 14px;
      line-height: 1.5;
    }

    form {
      margin: 0;
    }

    button {
      display: flex;
      width: 100%;
      min-height: 44px;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 18px;
      border: 1px solid #f2f2f0;
      border-radius: 8px;
      color: #111113;
      background: #f2f2f0;
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.3),
        inset 0 -1px rgba(0, 0, 0, 0.08);
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition:
        background-color 140ms ease,
        transform 140ms ease,
        box-shadow 140ms ease;
    }

    button:hover {
      background: #ffffff;
    }

    button:active {
      transform: translateY(1px);
      box-shadow: inset 0 1px rgba(0, 0, 0, 0.12);
    }

    button:focus-visible {
      outline: 2px solid #09090b;
      outline-offset: 2px;
      box-shadow: 0 0 0 4px #a1a1aa;
    }

    .arrow {
      font-size: 17px;
      line-height: 1;
      transition: transform 140ms ease;
    }

    button:hover .arrow {
      transform: translateX(2px);
    }

    .security-note {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      margin: 17px 0 0;
      color: #858581;
      font-size: 12px;
      line-height: 1.4;
    }

    .lock {
      position: relative;
      width: 9px;
      height: 7px;
      border-radius: 2px;
      background: #71717a;
    }

    .lock::before {
      position: absolute;
      top: -5px;
      left: 2px;
      width: 5px;
      height: 6px;
      border: 1.5px solid #71717a;
      border-bottom: 0;
      border-radius: 5px 5px 0 0;
      content: "";
    }

    @media (max-width: 480px) {
      .shell {
        align-items: start;
        padding: 56px 16px 24px;
      }

      .auth {
        transform: none;
      }

      .brand {
        margin-bottom: 28px;
      }

      .card {
        padding: 26px 24px 28px;
        border-radius: 14px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button,
      .arrow {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="auth">
      <div class="brand">
        <img class="brand-mark" src="/logos/sketch-icon-dark.png" alt="">
        <span>Sketch</span>
      </div>
      <section class="card" aria-labelledby="confirmation-title">
        <div class="status" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3 19 6v5c0 4.5-2.7 8.3-7 10-4.3-1.7-7-5.5-7-10V6l7-3Z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <h1 id="confirmation-title">Confirm sign in</h1>
        <p class="description">Continue to securely sign in to your Sketch workspace.</p>
        <form method="post" action="/api/auth/magic-link/confirmation" autocomplete="off">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="confirmation" value="${escapeHtml(confirmation)}">
          ${returnToInput}
          <button type="submit">Sign in <span class="arrow" aria-hidden="true">→</span></button>
        </form>
        <p class="security-note"><span class="lock" aria-hidden="true"></span>This secure link can only be used once.</p>
      </section>
    </div>
  </main>
</body>
</html>`;
}

function setMagicLinkConfirmationHeaders(c: Context, styleNonce: string): void {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${styleNonce}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
}

function matchesConfirmationCookie(cookie: string | undefined, confirmation: unknown): confirmation is string {
  if (!cookie || typeof confirmation !== "string") return false;
  const cookieBytes = Buffer.from(cookie);
  const confirmationBytes = Buffer.from(confirmation);
  return cookieBytes.length === confirmationBytes.length && timingSafeEqual(cookieBytes, confirmationBytes);
}

export async function createSession(c: Context, sub: string, role: AuthRole, jwtSecret: string): Promise<void> {
  const token = await signJwt(sub, role, jwtSecret);
  setSessionCookie(c, token, isSecure(c));
}

export function authRoutes(
  settings: SettingsRepo,
  db: Kysely<DB>,
  deps: {
    config: Config;
    logger: Logger;
    userRepo: ReturnType<typeof createUserRepository>;
    sendMagicLink: MagicLinkSender;
  },
) {
  const routes = new Hono();

  routes.post("/login", async (c) => {
    const configuredAdmin = await deps.userRepo.findFirstLocalAdmin();
    if (!configuredAdmin) {
      return c.json({ error: { code: "SETUP_REQUIRED", message: "Admin account not configured" } }, 503);
    }

    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Email and password required" } }, 400);
    }

    const user = await deps.userRepo.findByEmail(body.email);
    const passwordMatch = user?.password_hash ? await verifyPassword(body.password, user.password_hash) : false;

    if (!user || !passwordMatch) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } }, 401);
    }

    // Agents and external users do not have dashboard access. Mirror the
    // generic "Invalid credentials" response so we do not leak the existence
    // of a non-human row with the same email.
    if (user.type === "agent" || user.type === "external") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } }, 401);
    }

    let row = await settings.get();
    if (!row) {
      await settings.create();
      row = await settings.get();
    }
    if (!row) {
      return c.json({ error: { code: "SERVER_ERROR", message: "JWT secret not available" } }, 500);
    }

    // Backfill jwt_secret for accounts created before the JWT migration
    let jwtSecret = row.jwt_secret;
    if (!jwtSecret) {
      jwtSecret = randomBytes(32).toString("hex");
      await settings.update({ jwtSecret });
    }

    await createSession(c, user.id, toAuthRole(user.auth_role), jwtSecret);
    return c.json({ authenticated: true, email: user.email });
  });

  routes.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ authenticated: false });
  });

  /**
   * Two-phase session check: local sketch_session first, then managed
   * sketch_platform_session (when MANAGED_AUTH_SECRET is configured).
   * Falls through from local to managed so an expired local cookie
   * doesn't block a valid platform session.
   */
  routes.get("/session", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const row = await settings.get();
      if (row?.jwt_secret) {
        const payload = await verifyJwt(token, row.jwt_secret);
        if (payload) {
          let user = await db.selectFrom("users").selectAll().where("id", "=", payload.sub).executeTakeFirst();

          if (!user && payload.sub.includes("@")) {
            user = await db.selectFrom("users").selectAll().where("email", "=", payload.sub).executeTakeFirst();
          }

          if (user) {
            const role = toAuthRole(user.auth_role);
            await createSession(c, user.id, role, row.jwt_secret);
            return c.json({
              authenticated: true,
              role,
              userId: user.id,
              name: user.name,
              email: user.email,
            });
          }
        }
      }
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }

    if (deps.config.MANAGED_AUTH_SECRET) {
      const platformToken = getCookie(c, PLATFORM_COOKIE);
      if (platformToken) {
        const payload = await verifyJwt(platformToken, deps.config.MANAGED_AUTH_SECRET);
        if (payload?.email) {
          const user = await db.selectFrom("users").selectAll().where("email", "=", payload.email).executeTakeFirst();
          if (user) {
            const role = toAuthRole(user.auth_role);
            return c.json({
              authenticated: true,
              role,
              userId: user.id,
              name: user.name,
              email: user.email,
            });
          }
        }
      }
    }

    return c.json({ authenticated: false });
  });

  routes.get("/verify-email", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.redirect("/?verification=invalid");
    }

    const result = await verifyEmailToken(db, token);
    if (!result) {
      return c.redirect("/?verification=invalid");
    }

    return c.redirect("/?verification=success");
  });

  // --- Magic link login ---

  routes.post("/magic-link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; returnTo?: unknown };
    if (!body.email) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Email required" } }, 400);
    }

    const email = body.email.toLowerCase().trim();
    const returnTo = safeReturnTo(body.returnTo);

    const noChannelsResponse = { success: true, channels: [] as string[] };

    const user = await findVerifiedUserByEmail(db, email);
    if (!user) return c.json(noChannelsResponse);

    const token = await createRateLimitedMagicLinkToken(db, user.id);
    if (!token) return c.json(noChannelsResponse);

    const baseUrl = resolveBaseUrl(c, deps.config);
    const magicLink = new URL("/api/auth/magic-link/verify", `${baseUrl}/`);
    magicLink.searchParams.set("token", token);
    if (returnTo) magicLink.searchParams.set("return_to", returnTo);
    const magicLinkUrl = magicLink.toString();

    const settingsRow = await settings.get();
    const botName = settingsRow?.bot_name ?? "Sketch";

    const channels = await deps.sendMagicLink({ user, magicLinkUrl, botName });

    if (channels.length === 0) {
      deps.logger.info({ magicLinkUrl }, "Magic link (no delivery channels configured)");
    }

    return c.json({ success: true, channels });
  });

  routes.get("/magic-link/verify", async (c) => {
    const token = c.req.query("token");
    const returnTo = safeReturnTo(c.req.query("return_to"));
    if (!token) {
      return c.redirect("/login?error=invalid_link");
    }

    const userId = await findValidMagicLinkUserId(db, token);
    if (!userId) {
      return c.redirect("/login?error=expired_link");
    }

    const user = await deps.userRepo.findById(userId);
    if (!user) {
      return c.redirect("/login?error=expired_link");
    }
    if (user.type === "agent" || user.type === "external") {
      return c.redirect("/login?error=invalid_link");
    }

    const confirmation = randomBytes(32).toString("hex");
    const styleNonce = randomBytes(16).toString("base64");
    setCookie(c, MAGIC_LINK_CONFIRMATION_COOKIE, confirmation, {
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Strict",
      path: "/api/auth/magic-link/confirmation",
      maxAge: MAGIC_LINK_CONFIRMATION_MAX_AGE,
    });
    setMagicLinkConfirmationHeaders(c, styleNonce);
    return c.html(magicLinkConfirmationPage(token, confirmation, returnTo, styleNonce));
  });

  routes.post("/magic-link/confirmation", async (c) => {
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | File>;
    const token = body.token;
    const returnTo = safeReturnTo(body.return_to);
    const confirmationCookie = getCookie(c, MAGIC_LINK_CONFIRMATION_COOKIE);
    if (typeof token !== "string" || !matchesConfirmationCookie(confirmationCookie, body.confirmation)) {
      return c.redirect("/login?error=invalid_link");
    }

    const userId = await findValidMagicLinkUserId(db, token);
    if (!userId) {
      return c.redirect("/login?error=expired_link");
    }

    const settingsRow = await settings.get();
    if (!settingsRow?.jwt_secret) {
      return c.redirect("/login?error=server_error");
    }

    const user = await deps.userRepo.findById(userId);
    if (!user) {
      return c.redirect("/login?error=expired_link");
    }
    if (user.type === "agent" || user.type === "external") {
      return c.redirect("/login?error=invalid_link");
    }

    const consumedUserId = await verifyMagicLinkToken(db, token);
    if (consumedUserId !== user.id) {
      return c.redirect("/login?error=expired_link");
    }

    deleteCookie(c, MAGIC_LINK_CONFIRMATION_COOKIE, { path: "/api/auth/magic-link/confirmation" });
    await createSession(c, user.id, toAuthRole(user.auth_role), settingsRow.jwt_secret);
    return c.redirect(returnTo ?? "/");
  });

  return routes;
}

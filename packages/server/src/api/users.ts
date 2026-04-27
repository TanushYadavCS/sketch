/**
 * Users API — CRUD for managing team members.
 * Primary use case: admin adds WhatsApp users so they can message the bot.
 * Slack users are auto-created on first DM and appear here as read-only.
 */
import { emailSchema, whatsappNumberSchema } from "@sketch/shared";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { countRecentTokens, createVerificationToken } from "../auth/email-verify";
import type { Config } from "../config";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createEmailTransport, sendVerificationEmail } from "../email";

import { getSmtpConfig, resolveBaseUrl } from "./shared";

type UserRepo = ReturnType<typeof createUserRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type UserRow = Awaited<ReturnType<UserRepo["findById"]>>;

interface UserRoutesDeps {
  settings: SettingsRepo;
  db: Kysely<DB>;
  logger: Logger;
  config: Config;
}

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: emailSchema.nullable().optional(),
  whatsappNumber: whatsappNumberSchema.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  type: z.enum(["human", "agent"]).optional(),
  role: z.string().max(100).nullable().optional(),
  reportsTo: z.string().nullable().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  email: emailSchema.nullable().optional(),
  whatsappNumber: whatsappNumberSchema.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  role: z.string().max(100).nullable().optional(),
  reportsTo: z.string().nullable().optional(),
});

function serializeUser(user: NonNullable<UserRow>) {
  const { password_hash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

async function sendOrLogVerification(
  deps: UserRoutesDeps,
  userId: string,
  email: string,
  baseUrl: string,
): Promise<{ sent: boolean }> {
  const token = await createVerificationToken(deps.db, userId, email);
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  const settingsRow = await deps.settings.get();
  if (!settingsRow) return { sent: false };

  const smtp = getSmtpConfig(settingsRow);
  if (smtp) {
    const transport = createEmailTransport(smtp);
    await sendVerificationEmail(transport, email, verifyUrl, settingsRow.bot_name ?? "Sketch", smtp.from);
    return { sent: true };
  }

  deps.logger.info({ email, verifyUrl }, "SMTP not configured — verification URL logged for dev");
  return { sent: false };
}

export function userRoutes(users: UserRepo, deps: UserRoutesDeps) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const list = await users.list();
    return c.json({ users: list.map(serializeUser) });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const reportsTo = parsed.data.reportsTo ?? null;
    if (reportsTo) {
      const manager = await users.findById(reportsTo);
      if (!manager) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "reportsTo references a user that does not exist" } },
          400,
        );
      }
    }

    try {
      const user = await users.create({
        name: parsed.data.name,
        email: parsed.data.email ?? undefined,
        whatsappNumber: parsed.data.whatsappNumber ?? undefined,
        description: parsed.data.description ?? undefined,
        type: parsed.data.type ?? "human",
        role: parsed.data.role ?? undefined,
        reportsTo: reportsTo ?? undefined,
      });

      // Agents do not have email auth flows — skip verification
      let verificationSent = false;
      if (user.email && user.type !== "agent") {
        const baseUrl = resolveBaseUrl(c, deps.config);
        const result = await sendOrLogVerification(deps, user.id, user.email, baseUrl);
        verificationSent = result.sent;
      }

      return c.json({ user: serializeUser(user), verificationSent }, 201);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return c.json(
          { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
          409,
        );
      }
      throw err;
    }
  });

  routes.patch("/:id", async (c) => {
    const id = c.req.param("id");

    const existing = await users.findById(id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const reportsToValue = parsed.data.reportsTo;
    if (reportsToValue != null) {
      if (reportsToValue === id) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: "Cannot report to yourself" } }, 400);
      }
      const manager = await users.findById(reportsToValue);
      if (!manager) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "reportsTo references a user that does not exist" } },
          400,
        );
      }
    }

    try {
      const emailValue = (parsed.data as { email?: string | null }).email;
      const emailChanged = emailValue !== undefined && emailValue !== (existing.email ?? null);

      const user = await users.update(id, {
        name: parsed.data.name,
        email: emailValue,
        whatsappNumber: parsed.data.whatsappNumber,
        description: parsed.data.description,
        role: parsed.data.role,
        reportsTo: reportsToValue,
      });

      // Send verification email when email changes to a non-null value
      let verificationSent = false;
      if (emailChanged && user.email) {
        const baseUrl = resolveBaseUrl(c, deps.config);
        const result = await sendOrLogVerification(deps, id, user.email, baseUrl);
        verificationSent = result.sent;
      }

      return c.json({ user: serializeUser(user), verificationSent });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return c.json(
          { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
          409,
        );
      }
      throw err;
    }
  });

  // Resend verification email
  routes.post("/:id/verification", async (c) => {
    const id = c.req.param("id");

    const user = await users.findById(id);
    if (!user) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }
    if (!user.email) {
      return c.json({ error: { code: "NO_EMAIL", message: "User has no email address" } }, 400);
    }
    if (user.email_verified_at) {
      return c.json({ error: { code: "ALREADY_VERIFIED", message: "Email is already verified" } }, 400);
    }

    // Rate limit: max 5 per hour
    const recentCount = await countRecentTokens(deps.db, id);
    if (recentCount >= 5) {
      return c.json(
        { error: { code: "RATE_LIMITED", message: "Too many verification emails. Try again later." } },
        429,
      );
    }

    const baseUrl = resolveBaseUrl(c, deps.config);
    const result = await sendOrLogVerification(deps, id, user.email, baseUrl);

    return c.json({ success: true, sent: result.sent });
  });

  routes.delete("/:id", async (c) => {
    const sub = c.get("sub");
    const id = c.req.param("id");
    if (id === sub) {
      return c.json({ error: { code: "FORBIDDEN", message: "Cannot delete your own account" } }, 403);
    }
    const existing = await users.findById(id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }
    if (sub.includes("@") && existing.email?.toLowerCase() === sub.toLowerCase()) {
      return c.json({ error: { code: "FORBIDDEN", message: "Cannot delete your own account" } }, 403);
    }

    // Archive any per-user connectors (Fireflies etc.) before removing the user.
    // Scrubs credentials and disables future syncs; leaves indexed_files intact so
    // other attendees still see previously-synced meetings via file_access.
    try {
      const result = await createConnectorRepository(deps.db).archiveConnectorsForOwner(id);
      if (result.archived > 0) {
        deps.logger.info({ userId: id, count: result.archived }, "Archived connectors after user removal");
      }
    } catch (err) {
      deps.logger.error({ err, userId: id }, "Failed to archive user connectors");
    }

    await users.remove(id);
    return c.json({ success: true });
  });

  return routes;
}

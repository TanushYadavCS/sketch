import { randomUUID } from "node:crypto";
/**
 * Users API — CRUD for managing team members.
 * Primary use case: admin adds WhatsApp users so they can message the bot.
 * Slack users are auto-created on first DM and appear here as read-only.
 */
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  emailSchema,
  isKnownAgentToolName,
  parseAllowedTools,
  whatsappNumberSchema,
} from "@sketch/shared";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { countRecentTokens, createVerificationToken } from "../auth/email-verify";
import type { Config } from "../config";
import type { createChannelRepository } from "../db/repositories/channels";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createEmailTransport, sendVerificationEmail } from "../email";
import { ManagedMemberRegistrationError, type ManagedMemberRegistrationInput } from "../managed-members";
import type { SlackBot } from "../slack/bot";

import { getSmtpConfig, resolveBaseUrl } from "./shared";

type UserRepo = ReturnType<typeof createUserRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type ChannelRepo = ReturnType<typeof createChannelRepository>;
type WhatsAppGroupRepo = ReturnType<typeof createWhatsAppGroupRepository>;
type UserRow = Awaited<ReturnType<UserRepo["findById"]>>;

interface UserRoutesDeps {
  settings: SettingsRepo;
  db: Kysely<DB>;
  logger: Logger;
  config: Config;
  channels?: ChannelRepo;
  whatsappGroups?: WhatsAppGroupRepo;
  getSlack?: () => SlackBot | null;
  registerManagedMember?: (input: ManagedMemberRegistrationInput) => Promise<unknown>;
}

const allowedToolsSchema = z.array(z.string().refine(isKnownAgentToolName, "Unknown tool name")).nullable().optional();
const slackChannelIdsSchema = z.array(z.string().min(1)).optional();
const whatsappGroupJidsSchema = z.array(z.string().min(1)).optional();

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: emailSchema.nullable().optional(),
  whatsappNumber: whatsappNumberSchema.nullable().optional(),
  description: z.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
  type: z.enum(["human", "agent"]).optional(),
  role: z.string().max(100).nullable().optional(),
  reportsTo: z.string().nullable().optional(),
  allowedTools: allowedToolsSchema,
  slackChannelIds: slackChannelIdsSchema,
  whatsappGroupJids: whatsappGroupJidsSchema,
  isWhatsappFallback: z.boolean().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  email: emailSchema.nullable().optional(),
  whatsappNumber: whatsappNumberSchema.nullable().optional(),
  description: z.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
  role: z.string().max(100).nullable().optional(),
  authRole: z.enum(["admin", "member"]).optional(),
  reportsTo: z.string().nullable().optional(),
  allowedTools: allowedToolsSchema,
  slackChannelIds: slackChannelIdsSchema,
  whatsappGroupJids: whatsappGroupJidsSchema,
  isWhatsappFallback: z.boolean().optional(),
});

function serializeUser(
  user: NonNullable<UserRow>,
  slackChannelIds: string[] = [],
  whatsappGroupJids: string[] = [],
  isWhatsappFallback = false,
) {
  const { password_hash: _passwordHash, allowed_tools, ...safeUser } = user;
  return {
    ...safeUser,
    allowed_tools: parseAllowedTools(allowed_tools),
    slack_channel_ids: slackChannelIds,
    whatsapp_group_jids: whatsappGroupJids,
    is_whatsapp_fallback: isWhatsappFallback,
  };
}

async function findMissingWhatsAppGroups(repo: WhatsAppGroupRepo, jids: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const jid of jids) {
    const existing = await repo.getByJid(jid);
    if (!existing) missing.push(jid);
  }
  return missing;
}

async function ensureSlackChannelsExist(
  channels: ChannelRepo,
  getSlack: (() => SlackBot | null) | undefined,
  slackChannelIds: string[],
  logger: Logger,
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  for (const slackChannelId of slackChannelIds) {
    const existing = await channels.findBySlackChannelId(slackChannelId);
    if (existing) continue;
    const slackBot = getSlack?.();
    if (!slackBot) {
      missing.push(slackChannelId);
      continue;
    }
    try {
      const info = await slackBot.getChannelInfo(slackChannelId);
      await channels.upsertBySlackChannelId({
        slackChannelId,
        name: info.name,
        type: info.type,
      });
    } catch (err) {
      logger.warn({ err, slackChannelId }, "Failed to look up Slack channel info while binding agent");
      missing.push(slackChannelId);
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

function serializeApiUser(user: NonNullable<UserRow>) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    hasSlackIdentity: !!user.slack_user_id,
    hasWhatsappIdentity: !!user.whatsapp_number,
    type: user.type,
    role: user.role,
  };
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

function humanContactError() {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Email and WhatsApp number are required for human members",
    },
  };
}

async function ensureContactAvailable(
  users: UserRepo,
  contact: { email: string; whatsappNumber: string },
  excludeUserId?: string,
): Promise<"ok" | "conflict"> {
  const [byEmail, byWhatsapp] = await Promise.all([
    users.findByEmail(contact.email),
    users.findByWhatsappNumber(contact.whatsappNumber),
  ]);
  if (byEmail && byEmail.id !== excludeUserId) return "conflict";
  if (byWhatsapp && byWhatsapp.id !== excludeUserId) return "conflict";
  return "ok";
}

function managedRegistrationResponse(err: unknown) {
  if (err instanceof ManagedMemberRegistrationError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code === "CONFLICT" ? "CONFLICT" : "MANAGED_MEMBER_REGISTRATION_FAILED",
          message: err.message,
        },
      },
    };
  }
  return {
    status: 502,
    body: {
      error: {
        code: "MANAGED_MEMBER_REGISTRATION_FAILED",
        message: "Managed member registration failed",
      },
    },
  };
}

export function userRoutes(users: UserRepo, deps: UserRoutesDeps) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const list = await users.list();
    if (c.get("sub") === "sketch-api-key") {
      return c.json({ users: list.map(serializeApiUser) });
    }
    const slackBindings = deps.channels ? await deps.channels.listAllSlackChannelBindings() : [];
    const slackByAgent = new Map<string, string[]>();
    for (const b of slackBindings) {
      const arr = slackByAgent.get(b.agentUserId) ?? [];
      arr.push(b.slackChannelId);
      slackByAgent.set(b.agentUserId, arr);
    }
    const waBindings = deps.whatsappGroups ? await deps.whatsappGroups.listAllAgentBindings() : [];
    const waByAgent = new Map<string, string[]>();
    for (const b of waBindings) {
      const arr = waByAgent.get(b.agentUserId) ?? [];
      arr.push(b.jid);
      waByAgent.set(b.agentUserId, arr);
    }
    const settingsRow = await deps.settings.get();
    const fallbackAgentId = settingsRow?.whatsapp_fallback_agent_id ?? null;
    return c.json({
      users: list.map((u) =>
        serializeUser(u, slackByAgent.get(u.id) ?? [], waByAgent.get(u.id) ?? [], u.id === fallbackAgentId),
      ),
    });
  });

  routes.get("/external", async (c) => {
    const list = await users.listExternal();
    return c.json({
      users: list.map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        created_at: u.created_at,
      })),
    });
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

    const userType = parsed.data.type ?? "human";
    const humanEmail = parsed.data.email?.trim().toLowerCase() ?? null;
    const humanWhatsappNumber = parsed.data.whatsappNumber ?? null;

    if (userType === "human" && (!humanEmail || !humanWhatsappNumber)) {
      return c.json(humanContactError(), 400);
    }

    if (userType === "human" && parsed.data.whatsappNumber) {
      const existing = await users.findByWhatsappNumber(parsed.data.whatsappNumber);
      if (existing && existing.type === "external") {
        return c.json(
          {
            error: {
              code: "EXTERNAL_USER_EXISTS",
              message: "This WhatsApp number is already linked to an external user.",
            },
            promotionCandidate: { id: existing.id, type: existing.type, whatsapp_number: existing.whatsapp_number },
          },
          409,
        );
      }
    }

    if (userType === "human" && humanEmail && humanWhatsappNumber) {
      const available = await ensureContactAvailable(users, { email: humanEmail, whatsappNumber: humanWhatsappNumber });
      if (available === "conflict") {
        return c.json(
          { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
          409,
        );
      }
    }

    if (parsed.data.allowedTools !== undefined && userType !== "agent") {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "allowedTools can only be set on agents" } }, 400);
    }
    if (parsed.data.slackChannelIds !== undefined && userType !== "agent") {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "slackChannelIds can only be set on agents" } }, 400);
    }
    if (parsed.data.slackChannelIds !== undefined && !deps.channels) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: "Slack channel bindings are not available in this environment" },
        },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && userType !== "agent") {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "whatsappGroupJids can only be set on agents" } },
        400,
      );
    }
    if (parsed.data.isWhatsappFallback !== undefined && userType !== "agent") {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "isWhatsappFallback can only be set on agents" } },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && !deps.whatsappGroups) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "WhatsApp group bindings are not available in this environment",
          },
        },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && deps.whatsappGroups) {
      const missing = await findMissingWhatsAppGroups(deps.whatsappGroups, parsed.data.whatsappGroupJids);
      if (missing.length > 0) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: `Could not resolve WhatsApp group(s): ${missing.join(", ")}`,
            },
          },
          400,
        );
      }
    }

    /**
     * Resolve Slack channels before inserting the user row so a bad channel
     * id can't orphan an agent. ensureSlackChannelsExist may upsert local
     * channel rows by querying the Slack API; that is intentional and runs
     * regardless of whether we eventually persist the user.
     */
    if (parsed.data.slackChannelIds && deps.channels) {
      const ensured = await ensureSlackChannelsExist(
        deps.channels,
        deps.getSlack,
        parsed.data.slackChannelIds,
        deps.logger,
      );
      if (!ensured.ok) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: `Could not resolve Slack channel(s): ${ensured.missing.join(", ")}`,
            },
          },
          400,
        );
      }
    }

    try {
      const id = randomUUID();
      if (userType === "human" && humanEmail && humanWhatsappNumber && deps.registerManagedMember) {
        try {
          await deps.registerManagedMember({
            tenantUserId: id,
            email: humanEmail,
            name: parsed.data.name,
            phoneNumber: humanWhatsappNumber,
            sendInvite: true,
          });
        } catch (err) {
          const response = managedRegistrationResponse(err);
          return c.json(response.body, response.status as 400);
        }
      }

      const user = await users.create({
        id,
        name: parsed.data.name,
        email: humanEmail ?? undefined,
        whatsappNumber: humanWhatsappNumber ?? undefined,
        description: parsed.data.description ?? undefined,
        type: userType,
        role: parsed.data.role ?? undefined,
        reportsTo: reportsTo ?? undefined,
        allowedTools: parsed.data.allowedTools ?? undefined,
      });

      let boundSlackChannelIds: string[] = [];
      if (parsed.data.slackChannelIds && deps.channels) {
        await deps.channels.setAgentForSlackChannelIds(user.id, parsed.data.slackChannelIds);
        boundSlackChannelIds = parsed.data.slackChannelIds;
      }

      let boundWhatsAppGroupJids: string[] = [];
      if (parsed.data.whatsappGroupJids && deps.whatsappGroups) {
        await deps.whatsappGroups.setAgentForJids(user.id, parsed.data.whatsappGroupJids);
        boundWhatsAppGroupJids = parsed.data.whatsappGroupJids;
      }

      let isWhatsappFallback = false;
      if (parsed.data.isWhatsappFallback === true && user.type === "agent") {
        await deps.settings.update({ whatsappFallbackAgentId: user.id });
        isWhatsappFallback = true;
      }

      // Agents do not have email auth flows — skip verification
      let verificationSent = false;
      if (user.email && user.type !== "agent") {
        const baseUrl = resolveBaseUrl(c, deps.config);
        const result = await sendOrLogVerification(deps, user.id, user.email, baseUrl);
        verificationSent = result.sent;
      }

      return c.json(
        {
          user: serializeUser(user, boundSlackChannelIds, boundWhatsAppGroupJids, isWhatsappFallback),
          verificationSent,
        },
        201,
      );
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

    if (parsed.data.authRole !== undefined) {
      if (c.get("role") !== "admin") {
        return c.json({ error: { code: "FORBIDDEN", message: "Admin role required" } }, 403);
      }
      if (id === c.get("sub")) {
        return c.json({ error: { code: "FORBIDDEN", message: "Cannot change your own auth role" } }, 403);
      }
      if (existing.type !== "human") {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "authRole can only be changed for human users" } },
          400,
        );
      }
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

    if (parsed.data.allowedTools !== undefined && existing.type !== "agent") {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "allowedTools can only be set on agents" } }, 400);
    }
    if (parsed.data.slackChannelIds !== undefined && existing.type !== "agent") {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "slackChannelIds can only be set on agents" } }, 400);
    }
    if (parsed.data.slackChannelIds !== undefined && !deps.channels) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: "Slack channel bindings are not available in this environment" },
        },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && existing.type !== "agent") {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "whatsappGroupJids can only be set on agents" } },
        400,
      );
    }
    if (parsed.data.isWhatsappFallback !== undefined && existing.type !== "agent") {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "isWhatsappFallback can only be set on agents" } },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && !deps.whatsappGroups) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "WhatsApp group bindings are not available in this environment",
          },
        },
        400,
      );
    }
    if (parsed.data.whatsappGroupJids !== undefined && deps.whatsappGroups) {
      const missing = await findMissingWhatsAppGroups(deps.whatsappGroups, parsed.data.whatsappGroupJids);
      if (missing.length > 0) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: `Could not resolve WhatsApp group(s): ${missing.join(", ")}`,
            },
          },
          400,
        );
      }
    }

    /**
     * Resolve Slack channels before mutating the user row so a bad channel
     * id can't leave the request half-applied (e.g. name changed but
     * channel binding skipped).
     */
    if (parsed.data.slackChannelIds !== undefined && deps.channels) {
      const ensured = await ensureSlackChannelsExist(
        deps.channels,
        deps.getSlack,
        parsed.data.slackChannelIds,
        deps.logger,
      );
      if (!ensured.ok) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: `Could not resolve Slack channel(s): ${ensured.missing.join(", ")}`,
            },
          },
          400,
        );
      }
    }

    try {
      const rawEmailValue = (parsed.data as { email?: string | null }).email;
      const emailValue = rawEmailValue == null ? rawEmailValue : rawEmailValue.trim().toLowerCase();
      const emailChanged = emailValue !== undefined && emailValue !== (existing.email ?? null);
      const nextEmail = emailValue === undefined ? existing.email : emailValue;
      const nextWhatsappNumber =
        parsed.data.whatsappNumber === undefined ? existing.whatsapp_number : parsed.data.whatsappNumber;

      if (existing.type === "human") {
        if (!nextEmail || !nextWhatsappNumber) {
          return c.json(humanContactError(), 400);
        }

        const available = await ensureContactAvailable(
          users,
          { email: nextEmail, whatsappNumber: nextWhatsappNumber },
          existing.id,
        );
        if (available === "conflict") {
          return c.json(
            { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
            409,
          );
        }

        if (deps.registerManagedMember) {
          try {
            await deps.registerManagedMember({
              tenantUserId: existing.id,
              email: nextEmail,
              name: parsed.data.name ?? existing.name,
              phoneNumber: nextWhatsappNumber,
              sendInvite: false,
            });
          } catch (err) {
            const response = managedRegistrationResponse(err);
            return c.json(response.body, response.status as 400);
          }
        }
      }

      const user = await users.update(id, {
        name: parsed.data.name,
        email: emailValue,
        whatsappNumber: parsed.data.whatsappNumber,
        description: parsed.data.description,
        role: parsed.data.role,
        authRole: parsed.data.authRole,
        reportsTo: reportsToValue,
        allowedTools: parsed.data.allowedTools,
      });

      if (parsed.data.slackChannelIds !== undefined && deps.channels) {
        await deps.channels.setAgentForSlackChannelIds(user.id, parsed.data.slackChannelIds);
      }

      if (parsed.data.whatsappGroupJids !== undefined && deps.whatsappGroups) {
        await deps.whatsappGroups.setAgentForJids(user.id, parsed.data.whatsappGroupJids);
      }

      if (parsed.data.isWhatsappFallback !== undefined && existing.type === "agent") {
        const settingsRow = await deps.settings.get();
        const currentFallback = settingsRow?.whatsapp_fallback_agent_id ?? null;
        if (parsed.data.isWhatsappFallback === true) {
          await deps.settings.update({ whatsappFallbackAgentId: user.id });
        } else if (parsed.data.isWhatsappFallback === false && currentFallback === user.id) {
          await deps.settings.update({ whatsappFallbackAgentId: null });
        }
      }

      const boundSlackChannelIds = deps.channels ? await deps.channels.listSlackChannelIdsByAgent(user.id) : [];
      const boundWhatsAppGroupJids = deps.whatsappGroups ? await deps.whatsappGroups.listJidsByAgent(user.id) : [];
      const settingsRowAfter = await deps.settings.get();
      const isWhatsappFallback = settingsRowAfter?.whatsapp_fallback_agent_id === user.id;

      // Send verification email when email changes to a non-null value
      let verificationSent = false;
      if (emailChanged && user.email) {
        const baseUrl = resolveBaseUrl(c, deps.config);
        const result = await sendOrLogVerification(deps, id, user.email, baseUrl);
        verificationSent = result.sent;
      }

      return c.json({
        user: serializeUser(user, boundSlackChannelIds, boundWhatsAppGroupJids, isWhatsappFallback),
        verificationSent,
      });
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

  routes.post("/:id/promote", async (c) => {
    const id = c.req.param("id");
    const existing = await users.findById(id);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }
    if (existing.type !== "external") {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Only external users can be promoted" } }, 400);
    }

    const body = await c.req.json();
    const promoteSchema = z.object({
      name: z.string().min(1),
      email: emailSchema,
      role: z.string().max(100).nullable().optional(),
    });
    const parsed = promoteSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    if (!existing.whatsapp_number) {
      return c.json(humanContactError(), 400);
    }

    const email = parsed.data.email.trim().toLowerCase();
    const available = await ensureContactAvailable(
      users,
      { email, whatsappNumber: existing.whatsapp_number },
      existing.id,
    );
    if (available === "conflict") {
      return c.json(
        { error: { code: "CONFLICT", message: "This email or number is already linked to another member" } },
        409,
      );
    }

    if (deps.registerManagedMember) {
      try {
        await deps.registerManagedMember({
          tenantUserId: existing.id,
          email,
          name: parsed.data.name,
          phoneNumber: existing.whatsapp_number,
          sendInvite: true,
        });
      } catch (err) {
        const response = managedRegistrationResponse(err);
        return c.json(response.body, response.status as 400);
      }
    }

    await deps.db
      .updateTable("users")
      .set({
        type: "human",
        name: parsed.data.name,
        email,
        role: parsed.data.role ?? null,
      })
      .where("id", "=", id)
      .execute();

    const promoted = await users.findById(id);
    if (!promoted) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    let verificationSent = false;
    if (promoted.email) {
      const baseUrl = resolveBaseUrl(c, deps.config);
      const result = await sendOrLogVerification(deps, promoted.id, promoted.email, baseUrl);
      verificationSent = result.sent;
    }

    return c.json({ user: serializeUser(promoted), verificationSent });
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
    // Fail-noisy: if archival throws we let the 500 surface so the admin retries
    // rather than silently leaving credentials in DB after the user row is gone.
    const result = await createConnectorRepository(deps.db, deps.config.ENCRYPTION_KEY).archiveConnectorsForOwner(id);
    if (result.archived > 0) {
      deps.logger.info({ userId: id, count: result.archived }, "Archived connectors after user removal");
    }

    await users.remove(id);
    return c.json({ success: true });
  });

  return routes;
}

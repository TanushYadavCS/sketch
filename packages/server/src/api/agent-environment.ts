import { type AgentEnvironmentShareTargetInput, isReservedAgentEnvName } from "@sketch/shared";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { createAgentEnvironmentVariableRepository } from "../db/repositories/agent-environment-variables";
import { AgentEnvironmentVariableShareConflictError } from "../db/repositories/agent-environment-variables";
import type { createChannelRepository } from "../db/repositories/channels";
import type { createUserRepository } from "../db/repositories/users";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { SlackBot } from "../slack/bot";

type AgentEnvironmentRepo = ReturnType<typeof createAgentEnvironmentVariableRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;
type ChannelRepo = ReturnType<typeof createChannelRepository>;
type WhatsAppGroupsRepo = ReturnType<typeof createWhatsAppGroupRepository>;

interface AgentEnvironmentRouteDeps {
  users: UserRepo;
  channels: ChannelRepo;
  whatsappGroups: WhatsAppGroupsRepo;
  getSlack?: () => SlackBot | null;
  logger?: Logger;
}

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, numbers, and underscores. Start with a letter or underscore.");

const createVariableSchema = z.object({
  name: envNameSchema,
  value: z.string(),
  isSecret: z.boolean(),
});

const updateVariableSchema = z.object({
  value: z.string(),
});

const shareTargetSchema = z.object({
  type: z.enum(["user", "slack_channel", "whatsapp_group", "org"]),
  id: z.string().min(1),
});

const replaceSharesSchema = z.object({
  targets: z.array(shareTargetSchema),
});

function validationError(message: string) {
  return { error: { code: "VALIDATION_ERROR", message } };
}

async function ensureSlackChannelExists(
  slackChannelId: string,
  deps: AgentEnvironmentRouteDeps,
): Promise<{ ok: true } | { ok: false }> {
  const existing = await deps.channels.findBySlackChannelId(slackChannelId);
  if (existing) return { ok: true };

  const slackBot = deps.getSlack?.();
  if (!slackBot) return { ok: false };

  try {
    const info = await slackBot.getChannelInfo(slackChannelId);
    await deps.channels.upsertBySlackChannelId({
      slackChannelId,
      name: info.name,
      type: info.type,
    });
    return { ok: true };
  } catch (err) {
    deps.logger?.warn({ err, slackChannelId }, "Failed to look up Slack channel info while sharing agent env var");
    return { ok: false };
  }
}

async function validateShareTargets(
  targets: AgentEnvironmentShareTargetInput[],
  deps: AgentEnvironmentRouteDeps,
  role: string | undefined,
): Promise<{ status: 400 | 403; message: string } | null> {
  for (const target of targets) {
    if (target.type === "org") {
      if (target.id !== "default") return { status: 400, message: "Org share target must use id 'default'." };
      if (role !== "admin") return { status: 403, message: "Admin access is required to share with the entire org." };
    }

    if (target.type === "user") {
      const user = await deps.users.findById(target.id);
      if (!user || user.type === "external") return { status: 400, message: "Share target user was not found." };
    }

    if (target.type === "slack_channel") {
      const ensured = await ensureSlackChannelExists(target.id, deps);
      if (!ensured.ok) return { status: 400, message: "Share target Slack channel was not found." };
    }

    if (target.type === "whatsapp_group") {
      const group = await deps.whatsappGroups.getByJid(target.id);
      if (!group) return { status: 400, message: "Share target WhatsApp group was not found." };
    }
  }
  return null;
}

export function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return true;
  if (!err || typeof err !== "object") return false;
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  if (code === "23505") return true;
  return isUniqueConstraintError(cause);
}

export function agentEnvironmentRoutes(envVars: AgentEnvironmentRepo, deps: AgentEnvironmentRouteDeps) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = c.get("sub");
    return c.json({ variables: await envVars.list(userId) });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createVariableSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(validationError(message), 400);
    }
    if (isReservedAgentEnvName(parsed.data.name)) {
      return c.json(validationError("This environment variable name is reserved by Sketch."), 400);
    }

    try {
      const variable = await envVars.create(c.get("sub"), parsed.data);
      return c.json({ variable }, 201);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return c.json(
          { error: { code: "CONFLICT", message: "An environment variable with this name already exists." } },
          409,
        );
      }
      throw err;
    }
  });

  routes.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateVariableSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(validationError(message), 400);
    }

    const variable = await envVars.updateValue(c.req.param("id"), c.get("sub"), parsed.data.value);
    if (!variable) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
    }
    return c.json({ variable });
  });

  routes.post("/:id/shares", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = replaceSharesSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(validationError(message), 400);
    }

    const isOwned = await envVars.existsForOwner(c.req.param("id"), c.get("sub"));
    if (!isOwned) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
    }

    const validation = await validateShareTargets(parsed.data.targets, deps, c.get("role"));
    if (validation) {
      return c.json(validationError(validation.message), validation.status);
    }

    try {
      const variable = await envVars.replaceShares(c.req.param("id"), c.get("sub"), c.get("sub"), parsed.data.targets);
      if (!variable) {
        return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
      }
      return c.json({ variable });
    } catch (err) {
      if (err instanceof AgentEnvironmentVariableShareConflictError) {
        return c.json({ error: { code: "CONFLICT", message: err.message } }, 409);
      }
      if (isUniqueConstraintError(err)) {
        return c.json({ error: { code: "CONFLICT", message: "This share already exists." } }, 409);
      }
      throw err;
    }
  });

  routes.delete("/:id/shares/:shareId", async (c) => {
    const removed = await envVars.deleteShare(c.req.param("id"), c.get("sub"), c.req.param("shareId"));
    if (!removed) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable share not found" } }, 404);
    }
    return c.json({ success: true });
  });

  routes.delete("/:id", async (c) => {
    const removed = await envVars.remove(c.req.param("id"), c.get("sub"));
    if (!removed) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
    }
    return c.json({ success: true });
  });

  return routes;
}

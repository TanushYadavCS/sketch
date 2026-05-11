import { randomBytes } from "node:crypto";
import { whatsappNumberSchema } from "@sketch/shared";
/**
 * System API routes — internal management endpoints authenticated by bearer token.
 * Used by managed deployments to update configuration (e.g. Slack tokens) remotely.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { createMcpServerRepository } from "../db/repositories/mcp-servers";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import { upsertSlackIdentity } from "../slack/upsert-identity";
import { upsertWhatsAppIdentity } from "../whatsapp/upsert-identity";

type InboxMessagesRepo = ReturnType<typeof createInboxMessagesRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type McpServersRepo = ReturnType<typeof createMcpServerRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

type SlackTokensCallback = (tokens: { botToken: string; appToken?: string }) => unknown;

interface SystemDeps {
  systemSecret: string;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  onSlackTokensUpdated?: Function;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  onLlmSettingsUpdated?: Function;
  userRepo?: UserRepo;
  inboxMessagesRepo?: InboxMessagesRepo;
  mcpServers?: McpServersRepo;
  sendSlackDmToSlackUser?: (params: {
    slackUserId: string;
    message: string;
  }) => Promise<{ channelId: string; messageRef: string }>;
  sendDm?: (params: {
    userId: string;
    platform: "slack" | "whatsapp";
    message: string;
  }) => Promise<{ channelId: string; messageRef: string }>;
  whatsappStatus?: () => { connected: boolean; phoneNumber: string | null; pairingInProgress: boolean };
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  startWhatsAppPairing?: Function;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  cancelWhatsAppPairing?: Function;
  disconnectWhatsApp?: () => Promise<void>;
}

const tokenSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().optional(),
});

const identitySchema = z.object({
  adminEmail: z.string().email(),
  adminPasswordHash: z.string().min(1).nullable().optional(),
  orgName: z.string().optional(),
  botName: z.string().optional(),
  name: z.string().optional(),
  whatsappNumber: whatsappNumberSchema.optional(),
});

const llmSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("anthropic"),
    apiKey: z.string().min(1),
    modelId: z.string().optional(),
  }),
  z.object({
    provider: z.literal("bedrock"),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    region: z.string().min(1),
    modelId: z.string().optional(),
  }),
  z.object({
    provider: z.literal("openrouter_bedrock"),
    apiKey: z.string().min(1),
    modelId: z.string().min(1),
  }),
]);

const systemUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1),
});

const systemBulkUsersSchema = z.object({
  users: z.array(
    z
      .object({
        email: z.string().email().optional(),
        name: z.string().trim().min(1),
        slackUserId: z.string().trim().min(1).optional(),
        whatsappNumber: whatsappNumberSchema.optional(),
      })
      .refine((row) => row.slackUserId || row.whatsappNumber, {
        message: "slackUserId or whatsappNumber is required",
      })
      .refine((row) => !row.slackUserId || row.email, {
        message: "email is required for Slack users",
      }),
  ),
});

const canvasIntegrationSchema = z.object({
  apiKey: z.string().min(1),
  apiUrl: z.string().url(),
});

const onboardingWorkflowMetadataSchema = z.object({
  openingMessageSent: z.boolean().optional(),
});

const onboardingIntroductionsSchema = z.object({
  adminEmail: z.string().email().optional(),
  channel: z.enum(["slack", "whatsapp"]).optional(),
  orgName: z.string().trim().min(1).optional(),
  whatsappNumbers: z.array(whatsappNumberSchema).optional(),
});

const whatsappPairingValidationSchema = z.object({
  adminWhatsappNumber: whatsappNumberSchema,
});

function generateSketchApiKey(): string {
  return `sk_live_${randomBytes(32).toString("base64url")}`;
}

function buildOpeningIntroMessage(botName: string): string {
  return `I've added your team to ${botName}. Who should I introduce myself to first? Reply with names or @mentions.`;
}

function buildInitialIntroMetadata(originalMessage: string) {
  return {
    stage: "awaiting_recipients",
    source: "managed_slack_onboarding",
    originalMessage,
    openingMessageSent: false,
    instructions: [
      "If the admin provides names or @mentions, resolve them against the team directory.",
      "Draft the intro message and ask for confirmation before sending.",
      "If the admin says something unrelated, answer normally and remind them this intro task is still pending.",
    ],
    selectedUserIds: [],
    selectedNames: [],
    draftMessage: null,
    nudgeIfUnrelated: true,
  };
}

function parseWorkflowMetadata(value: string | null): { openingMessageSent?: boolean } {
  if (!value) return {};
  try {
    const parsed = onboardingWorkflowMetadataSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

class SystemUserSyncConflictError extends Error {}

function buildWhatsAppIntroMessage(botName: string, orgName: string | null | undefined): string {
  const orgLabel = orgName?.trim() || "your workspace";
  return `Hi, I'm ${botName}, your AI coworker in ${orgLabel}. You can message me here when you need help with your workspace.`;
}

function normalizeWhatsappNumberForComparison(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

async function verifyAnthropicApiKey(apiKey: string): Promise<void> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "Ping" }],
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("invalid_auth");
  }

  if (!response.ok) {
    throw new Error("verification_failed");
  }
}

export function systemRoutes(settings: SettingsRepo, deps: SystemDeps) {
  const routes = new Hono();

  async function ensureSettingsRow() {
    if (!(await settings.get())) {
      await settings.create();
    }
  }

  routes.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || auth !== `Bearer ${deps.systemSecret}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid system secret" } }, 401);
    }
    return next();
  });

  routes.put("/api-key", async (c) => {
    await ensureSettingsRow();

    const row = await settings.get();
    if (row?.sketch_api_key) {
      return c.json({ configured: true, apiKey: row.sketch_api_key });
    }

    const apiKey = generateSketchApiKey();
    await settings.update({ sketchApiKey: apiKey });
    return c.json({ configured: true, apiKey });
  });

  routes.put("/slack/tokens", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "botToken is required" } }, 400);
    }

    const { botToken, appToken } = parsed.data;
    await settings.update({
      slackBotToken: botToken,
      ...(appToken ? { slackAppToken: appToken } : {}),
    });

    if (deps.onSlackTokensUpdated) {
      const cb = deps.onSlackTokensUpdated as SlackTokensCallback;
      await cb({ botToken, ...(appToken ? { appToken } : {}) });
    }

    return c.json({ success: true });
  });

  routes.put("/identity", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = identitySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const { adminEmail, adminPasswordHash, orgName, botName, whatsappNumber } = parsed.data;
    const normalizedAdminEmail = adminEmail.trim().toLowerCase();

    const existingUser = deps.userRepo ? await deps.userRepo.findByEmail(normalizedAdminEmail) : undefined;
    if (deps.userRepo && whatsappNumber !== undefined) {
      const existingByWhatsapp = await deps.userRepo.findByWhatsappNumber(whatsappNumber);
      if (existingByWhatsapp && existingByWhatsapp.id !== existingUser?.id) {
        return c.json(
          {
            error: {
              code: "CONFLICT",
              message: "WhatsApp number is already linked to another user",
            },
          },
          409,
        );
      }
    }

    const existing = await settings.get();
    if (existing) {
      await settings.update({
        ...(orgName !== undefined ? { orgName } : {}),
        ...(botName !== undefined ? { botName } : {}),
      });
    } else {
      await settings.create({
        ...(orgName !== undefined ? { orgName } : {}),
        ...(botName !== undefined ? { botName } : {}),
      });
    }

    if (deps.userRepo) {
      const displayName = parsed.data.name || normalizedAdminEmail.split("@")[0];
      if (existingUser) {
        await deps.userRepo.update(existingUser.id, {
          name: displayName,
          email: normalizedAdminEmail,
          emailVerified: true,
          ...(adminPasswordHash !== undefined ? { passwordHash: adminPasswordHash } : {}),
          ...(whatsappNumber !== undefined ? { whatsappNumber } : {}),
          authRole: "admin",
        });
      } else {
        await deps.userRepo.create({
          name: displayName,
          email: normalizedAdminEmail,
          emailVerified: true,
          passwordHash: adminPasswordHash ?? null,
          ...(whatsappNumber !== undefined ? { whatsappNumber } : {}),
          authRole: "admin",
        });
      }
    }

    return c.json({ ok: true });
  });

  routes.put("/llm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = llmSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const data = parsed.data;
    await ensureSettingsRow();

    if (data.provider === "anthropic") {
      try {
        await verifyAnthropicApiKey(data.apiKey);
      } catch {
        return c.json({ error: { code: "INVALID_LLM_CREDENTIALS", message: "Invalid Anthropic API key" } }, 400);
      }
      await settings.update({
        llmProvider: "anthropic",
        anthropicApiKey: data.apiKey,
        modelId: data.modelId,
      });
    } else if (data.provider === "bedrock") {
      // TODO: Bedrock credential verification deferred -- no existing verification logic for AWS credentials
      await settings.update({
        llmProvider: "bedrock",
        awsAccessKeyId: data.accessKeyId,
        awsSecretAccessKey: data.secretAccessKey,
        awsRegion: data.region,
        modelId: data.modelId,
      });
    } else {
      // openrouter_bedrock: caller (platform provisioner) just minted the key, no verification call.
      // anthropic_api_key column reused for the OR virtual key, model_id holds the <model>@preset/<alias> composite.
      await settings.update({
        llmProvider: "openrouter_bedrock",
        anthropicApiKey: data.apiKey,
        modelId: data.modelId,
      });
    }

    if (deps.onLlmSettingsUpdated) {
      await deps.onLlmSettingsUpdated();
    }

    return c.json({ ok: true });
  });

  routes.get("/llm", async (c) => {
    const row = await settings.get();
    if (!row) {
      return c.json({ provider: null, modelId: null });
    }
    return c.json({
      provider: row.llm_provider ?? null,
      modelId: row.model_id ?? null,
    });
  });

  routes.post("/users", async (c) => {
    if (!deps.userRepo) {
      return c.json({ error: { code: "NOT_FOUND", message: "User management not available" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = systemUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const email = parsed.data.email.toLowerCase();
    const existing = await deps.userRepo.findByEmail(email);
    if (existing) {
      return c.json({ ok: true, userId: existing.id });
    }

    const user = await deps.userRepo.create({
      email,
      name: parsed.data.name,
      emailVerified: true,
    });

    return c.json({ ok: true, userId: user.id });
  });

  routes.put("/users", async (c) => {
    if (!deps.userRepo) {
      return c.json({ error: { code: "NOT_FOUND", message: "User management not available" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = systemBulkUsersSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    try {
      const result = await deps.userRepo.transaction(async (users) => {
        let created = 0;
        let updated = 0;

        for (const user of parsed.data.users) {
          let rowCreated = false;
          let rowUpdated = false;

          if (user.slackUserId) {
            const slackResult = await upsertSlackIdentity(users, {
              name: user.name,
              email: user.email as string,
              slackUserId: user.slackUserId,
            });
            if (slackResult.status === "conflict") {
              throw new SystemUserSyncConflictError(
                `User ${slackResult.conflict.email} is already linked to another Slack user`,
              );
            }
            if (slackResult.status === "created") rowCreated = true;
            if (slackResult.status === "updated") rowUpdated = true;
          }

          if (user.whatsappNumber) {
            const whatsappResult = await upsertWhatsAppIdentity(users, {
              name: user.name,
              email: user.email,
              whatsappNumber: user.whatsappNumber,
            });
            if (whatsappResult.status === "conflict") {
              throw new SystemUserSyncConflictError("User is already linked to a different WhatsApp identity");
            }
            if (whatsappResult.status === "created") rowCreated = true;
            if (whatsappResult.status === "updated") rowUpdated = true;
          }

          if (rowCreated) created += 1;
          else if (rowUpdated) updated += 1;
        }

        return { created, updated };
      });

      return c.json({ ok: true, created: result.created, updated: result.updated });
    } catch (error) {
      if (!(error instanceof SystemUserSyncConflictError)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: error.message,
          },
        },
        409,
      );
    }
  });

  routes.get("/whatsapp", (c) => {
    const status = deps.whatsappStatus?.() ?? { connected: false, phoneNumber: null, pairingInProgress: false };
    return c.json(status);
  });

  routes.post("/whatsapp/validate-pairing", async (c) => {
    if (!deps.whatsappStatus || !deps.disconnectWhatsApp) {
      return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp pairing validation not available" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = whatsappPairingValidationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const status = deps.whatsappStatus();
    if (!status.connected || !status.phoneNumber) {
      return c.json({ error: { code: "NOT_CONNECTED", message: "WhatsApp is not connected" } }, 409);
    }

    const pairedNumber = whatsappNumberSchema.safeParse(status.phoneNumber);
    if (!pairedNumber.success) {
      return c.json({ error: { code: "BAD_GATEWAY", message: "Paired WhatsApp number is invalid" } }, 502);
    }

    if (
      normalizeWhatsappNumberForComparison(pairedNumber.data) ===
      normalizeWhatsappNumberForComparison(parsed.data.adminWhatsappNumber)
    ) {
      await deps.disconnectWhatsApp?.();
      return c.json(
        {
          error: {
            code: "SAME_AS_ADMIN_WHATSAPP",
            message: "Use a different WhatsApp number for Sketch. The admin number cannot scan this QR.",
            phoneNumber: pairedNumber.data,
          },
        },
        409,
      );
    }

    return c.json({ ok: true, connected: true, phoneNumber: pairedNumber.data });
  });

  routes.get("/whatsapp/pair", async (c) => {
    if (!deps.startWhatsAppPairing) {
      return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp pairing not available" } }, 404);
    }
    return deps.startWhatsAppPairing(c);
  });

  routes.delete("/whatsapp/pair", async (c) => {
    if (deps.cancelWhatsAppPairing) {
      deps.cancelWhatsAppPairing();
    }
    return c.json({ ok: true });
  });

  routes.put("/integrations/canvas", async (c) => {
    if (!deps.mcpServers) {
      return c.json({ error: { code: "NOT_FOUND", message: "MCP servers not available" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = canvasIntegrationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const { apiKey, apiUrl } = parsed.data;
    const credentials = JSON.stringify({ apiKey });
    const mcpUrl = `${apiUrl}/mcp`;

    const existing = await deps.mcpServers.findByType("canvas");
    if (existing) {
      await deps.mcpServers.update(existing.id, { credentials, apiUrl, url: mcpUrl });
    } else {
      await deps.mcpServers.create({
        type: "canvas",
        displayName: "Canvas",
        url: mcpUrl,
        apiUrl,
        credentials,
        mode: "skill",
      });
    }

    return c.json({ ok: true });
  });

  routes.post("/onboarding-introductions", async (c) => {
    if (!deps.userRepo) {
      return c.json({ error: { code: "NOT_FOUND", message: "Onboarding introductions not available" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = onboardingIntroductionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: parsed.error.message } }, 400);
    }

    const settingsRow = await settings.get();
    const adminEmail = parsed.data.adminEmail?.trim().toLowerCase();
    const admin = adminEmail ? await deps.userRepo.findByEmail(adminEmail) : await deps.userRepo.findFirstAdmin();
    if (!admin) {
      return c.json({ error: { code: "NOT_FOUND", message: "Admin user not found" } }, 404);
    }
    if (adminEmail && admin.auth_role !== "admin") {
      return c.json({ error: { code: "BAD_REQUEST", message: "User is not an admin" } }, 400);
    }

    if (parsed.data.channel === "whatsapp") {
      if (!deps.sendDm) {
        return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp introductions not available" } }, 404);
      }
      if (!admin.whatsapp_number) {
        return c.json(
          {
            error: {
              code: "CONFLICT",
              message: "Admin WhatsApp number is required for WhatsApp introductions",
            },
          },
          409,
        );
      }

      const requestedNumbers = parsed.data.whatsappNumbers ?? [];
      const targetUsers = new Map<string, { id: string; whatsapp_number: string | null }>();
      const missingNumbers: string[] = [];
      targetUsers.set(admin.id, admin);
      for (const whatsappNumber of requestedNumbers) {
        const user = await deps.userRepo.findByWhatsappNumber(whatsappNumber);
        if (user?.whatsapp_number) {
          targetUsers.set(user.id, user);
        } else {
          missingNumbers.push(whatsappNumber);
        }
      }

      if (targetUsers.size === 0) {
        return c.json({ error: { code: "BAD_REQUEST", message: "No WhatsApp users found for introductions" } }, 400);
      }

      const message = buildWhatsAppIntroMessage(
        settingsRow?.bot_name ?? "Sketch",
        parsed.data.orgName ?? settingsRow?.org_name,
      );
      const deliveries: Array<{
        userId?: string;
        whatsappNumber?: string;
        ok: boolean;
        channelId?: string;
        messageRef?: string;
        error?: string;
      }> = [];
      for (const whatsappNumber of missingNumbers) {
        deliveries.push({
          whatsappNumber,
          ok: false,
          error: "WhatsApp user not found",
        });
      }
      for (const user of targetUsers.values()) {
        try {
          const delivery = await deps.sendDm({ userId: user.id, platform: "whatsapp", message });
          deliveries.push({
            userId: user.id,
            ok: true,
            channelId: delivery.channelId,
            messageRef: delivery.messageRef,
          });
        } catch (error) {
          deliveries.push({
            userId: user.id,
            ok: false,
            error: error instanceof Error ? error.message : "Delivery failed",
          });
        }
      }

      const failed = deliveries.filter((delivery) => !delivery.ok);
      return c.json(
        {
          ok: failed.length === 0,
          status: failed.length === 0 ? "sent" : "partial_failure",
          sent: deliveries.length - failed.length,
          failed: failed.length,
          deliveries,
        },
        failed.length === 0 ? 200 : 207,
      );
    }

    if (!deps.inboxMessagesRepo || !deps.sendSlackDmToSlackUser) {
      return c.json({ error: { code: "NOT_FOUND", message: "Slack introductions not available" } }, 404);
    }
    if (!admin.slack_user_id) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Admin user has no Slack identity" } }, 400);
    }

    const openingMessage = buildOpeningIntroMessage(settingsRow?.bot_name ?? "Sketch");
    const existing = await deps.inboxMessagesRepo.findUnresolvedByRecipientAndKind(
      admin.id,
      "managed_onboarding_intro",
    );

    if (existing) {
      const metadata = parseWorkflowMetadata(existing.metadata);
      if (metadata.openingMessageSent) {
        return c.json({ ok: true, status: "already_exists" });
      }

      try {
        const delivery = await deps.sendSlackDmToSlackUser({
          slackUserId: admin.slack_user_id,
          message: openingMessage,
        });
        await deps.inboxMessagesRepo.updateWorkflow(existing.id, {
          openingMessageSent: true,
          openingMessageChannelId: delivery.channelId,
          openingMessageRef: delivery.messageRef,
        });
        return c.json({ ok: true, status: "started" });
      } catch {
        return c.json(
          {
            error: {
              code: "OPENING_MESSAGE_FAILED",
              message: "Failed to deliver the admin onboarding introduction message",
            },
          },
          502,
        );
      }
    }

    const workflow = await deps.inboxMessagesRepo.create({
      senderUserId: admin.id,
      recipientUserId: admin.id,
      message: openingMessage,
      kind: "managed_onboarding_intro",
      metadata: buildInitialIntroMetadata(openingMessage),
      resolutionMode: "explicit",
      platform: "slack",
    });

    try {
      const delivery = await deps.sendSlackDmToSlackUser({
        slackUserId: admin.slack_user_id,
        message: openingMessage,
      });
      await deps.inboxMessagesRepo.updateWorkflow(workflow.id, {
        openingMessageSent: true,
        openingMessageChannelId: delivery.channelId,
        openingMessageRef: delivery.messageRef,
      });
      return c.json({ ok: true, status: "started" });
    } catch {
      return c.json(
        {
          error: {
            code: "OPENING_MESSAGE_FAILED",
            message: "Failed to deliver the admin onboarding introduction message",
          },
        },
        502,
      );
    }
  });

  routes.post("/onboarding/complete", async (c) => {
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    return c.json({ ok: true });
  });

  return routes;
}

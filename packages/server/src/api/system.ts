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
  whatsappStatus?: () => { connected: boolean; phoneNumber: string | null; pairingInProgress: boolean };
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  startWhatsAppPairing?: Function;
  // biome-ignore lint/complexity/noBannedTypes: Function is needed here to accommodate Vitest mock types in tests
  cancelWhatsAppPairing?: Function;
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
    z.object({
      email: z.string().email(),
      name: z.string().trim().min(1),
      slackUserId: z.string().trim().min(1),
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
});

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

class SystemUserSyncConflictError extends Error {
  constructor(
    readonly conflict: {
      email: string;
      existingSlackUserId: string;
      incomingSlackUserId: string;
    },
  ) {
    super(`User ${conflict.email} is already linked to Slack user ${conflict.existingSlackUserId}`);
  }
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

  routes.use("/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || auth !== `Bearer ${deps.systemSecret}`) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid system secret" } }, 401);
    }
    return next();
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

    const { adminEmail, adminPasswordHash, orgName, botName } = parsed.data;
    const normalizedAdminEmail = adminEmail.trim().toLowerCase();

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
      const existingUser = await deps.userRepo.findByEmail(normalizedAdminEmail);
      if (existingUser) {
        await deps.userRepo.update(existingUser.id, {
          name: displayName,
          email: normalizedAdminEmail,
          emailVerified: true,
          ...(adminPasswordHash !== undefined ? { passwordHash: adminPasswordHash } : {}),
          authRole: "admin",
        });
      } else {
        await deps.userRepo.create({
          name: displayName,
          email: normalizedAdminEmail,
          emailVerified: true,
          passwordHash: adminPasswordHash ?? null,
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
          const upsertResult = await upsertSlackIdentity(users, {
            name: user.name,
            email: user.email,
            slackUserId: user.slackUserId,
          });

          if (upsertResult.status === "created") created += 1;
          if (upsertResult.status === "updated") updated += 1;

          if (upsertResult.status === "conflict") {
            throw new SystemUserSyncConflictError(upsertResult.conflict);
          }
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
    if (!deps.userRepo || !deps.inboxMessagesRepo || !deps.sendSlackDmToSlackUser) {
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

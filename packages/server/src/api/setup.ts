/**
 * Setup API routes for the onboarding wizard.
 * Only status/account are public; subsequent setup steps require auth.
 */
import { randomBytes } from "node:crypto";
import { isLlmProvider } from "@sketch/shared";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword } from "../auth/password";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import { slackApiCall } from "../slack/api";
import { createSession } from "./auth";
import { denyIfNotAdmin } from "./auth-helpers";

async function verifySlackTokens(botToken: string, appToken: string): Promise<{ workspaceName?: string }> {
  const auth = await slackApiCall(botToken, "auth.test");
  await slackApiCall(appToken, "apps.connections.open");
  return { workspaceName: auth.team };
}

const createAccountSchema = z.object({
  email: z.email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const identitySchema = z.object({
  orgName: z.string().min(1, "Organization name is required").max(200, "Organization name is too long"),
  botName: z.string().min(1, "Bot name is required").max(100, "Bot name is too long"),
});

const slackSchema = z.object({
  botToken: z
    .string()
    .min(1, "Bot token is required")
    .refine((value) => value.startsWith("xoxb-"), {
      message: "Bot token must start with xoxb-",
    }),
  appToken: z
    .string()
    .min(1, "App-level token is required")
    .refine((value) => value.startsWith("xapp-"), {
      message: "App-level token must start with xapp-",
    }),
});

const llmSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("anthropic"),
    apiKey: z
      .string()
      .min(1, "API key is required")
      .refine((value) => value.startsWith("sk-ant-"), {
        message: "API key must start with sk-ant-",
      }),
  }),
  z.object({
    provider: z.literal("bedrock"),
    awsAccessKeyId: z.string().min(1, "AWS Access Key ID is required"),
    awsSecretAccessKey: z.string().min(1, "AWS Secret Access Key is required"),
    awsRegion: z.string().min(1, "AWS Region is required"),
  }),
]);

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

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

/**
 * Dependencies for the setup routes. `experimentalFlag` mirrors
 * config.EXPERIMENTAL_FLAG and is surfaced on /status so the web UI can gate
 * experimental surfaces (see CLAUDE.md "Feature Gating").
 */
interface SetupDeps {
  managedUrl?: string;
  experimentalFlag?: boolean;
  onSlackTokensUpdated?: (tokens?: { botToken: string; appToken: string }) => Promise<void>;
  onLlmSettingsUpdated?: () => Promise<void>;
  userRepo?: UserRepo;
}

async function ensureSettings(settings: SettingsRepo) {
  let row = await settings.get();
  if (!row) {
    await settings.create();
    row = await settings.get();
  }
  if (!row?.jwt_secret) {
    const jwtSecret = randomBytes(32).toString("hex");
    await settings.update({ jwtSecret });
    row = await settings.get();
  }
  return row;
}

async function upsertSetupAdmin(userRepo: UserRepo, email: string, passwordHash: string) {
  const existingAdmin = await userRepo.findFirstLocalAdmin();
  const existingByEmail = await userRepo.findByEmail(email);

  if (existingByEmail) {
    const user = await userRepo.update(existingByEmail.id, {
      name: existingByEmail.name || email.split("@")[0],
      email,
      emailVerified: true,
      passwordHash,
      authRole: "admin",
    });
    if (existingAdmin && existingAdmin.id !== existingByEmail.id) {
      await userRepo.update(existingAdmin.id, { passwordHash: null, authRole: "member" });
    }
    return user;
  }

  if (existingAdmin) {
    return userRepo.update(existingAdmin.id, {
      name: existingAdmin.name || email.split("@")[0],
      email,
      emailVerified: true,
      passwordHash,
      authRole: "admin",
    });
  }

  return userRepo.create({
    name: email.split("@")[0],
    email,
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
}

export function setupRoutes(settings: SettingsRepo, deps: SetupDeps = {}) {
  const routes = new Hono();

  /**
   * Reports onboarding progress as a step index. Self-hosted runs the full flow
   * (admin -> identity -> Slack -> LLM); managed deployments skip the Slack step,
   * going straight from identity (2) to LLM (4).
   */
  routes.get("/status", async (c) => {
    const row = await settings.get();
    const adminUser = deps.userRepo ? await deps.userRepo.findFirstLocalAdmin() : undefined;
    const hasAdmin = Boolean(adminUser ?? row?.admin_email);
    const hasIdentity = Boolean(row?.org_name?.trim() && row?.bot_name?.trim());
    const hasSlack = Boolean(row?.slack_bot_token?.trim() && row?.slack_app_token?.trim());
    const hasAnthropic = row?.llm_provider === "anthropic" && Boolean(row?.anthropic_api_key?.trim());
    const hasBedrock =
      row?.llm_provider === "bedrock" &&
      Boolean(row?.aws_access_key_id?.trim() && row?.aws_secret_access_key?.trim() && row?.aws_region?.trim());
    const hasOpenRouter =
      row?.llm_provider === "openrouter" && Boolean(row?.anthropic_api_key?.trim() && row?.model_id?.trim());
    const hasLlm = Boolean(hasAnthropic || hasBedrock || hasOpenRouter);
    const provider = row?.llm_provider;
    const llmProvider = isLlmProvider(provider) ? provider : null;
    const isCompleted = Boolean(row?.onboarding_completed_at);
    const isManaged = Boolean(deps.managedUrl);
    let currentStep: number;
    if (isCompleted) {
      currentStep = 5;
    } else if (hasLlm) {
      currentStep = 5;
    } else if (isManaged) {
      currentStep = hasIdentity ? 4 : hasAdmin ? 2 : 0;
    } else {
      currentStep = hasSlack ? 4 : hasIdentity ? 3 : hasAdmin ? 2 : 0;
    }
    return c.json({
      completed: isCompleted,
      currentStep,
      adminEmail: adminUser?.email ?? row?.admin_email ?? null,
      orgName: row?.org_name ?? null,
      botName: row?.bot_name ?? "Sketch",
      slackConnected: hasSlack,
      llmConnected: hasLlm,
      llmProvider,
      experimentalFlag: deps.experimentalFlag ?? false,
      ...(deps.managedUrl ? { managedUrl: deps.managedUrl } : {}),
    });
  });

  routes.post("/slack/verify", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (deps.managedUrl) {
      return c.json({ error: { code: "FORBIDDEN", message: "Slack is managed via Marketplace" } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = slackSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    try {
      const { workspaceName } = await verifySlackTokens(parsed.data.botToken.trim(), parsed.data.appToken.trim());
      return c.json({ success: true, workspaceName });
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_SLACK_TOKENS",
            message: "Invalid Slack tokens. Check Bot Token and App-Level Token, then try again.",
          },
        },
        400,
      );
    }
  });

  routes.post("/account", async (c) => {
    const existing = await settings.get();
    if (existing?.onboarding_completed_at) {
      return c.json({ error: { code: "ONBOARDING_COMPLETE", message: "Setup is already complete" } }, 409);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createAccountSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const email = parsed.data.email.toLowerCase().trim();

    if (!existing) {
      await settings.create();
    } else if (!existing.jwt_secret) {
      await settings.update({ jwtSecret: randomBytes(32).toString("hex") });
    }

    let adminUser: Awaited<ReturnType<UserRepo["findById"]>> | undefined;
    if (deps.userRepo) {
      adminUser = await upsertSetupAdmin(deps.userRepo, email, passwordHash);
    } else {
      await settings.update({ adminEmail: email, adminPasswordHash: passwordHash });
    }

    const row = await ensureSettings(settings);
    if (!row?.jwt_secret) {
      return c.json({ error: { code: "SERVER_ERROR", message: "JWT secret not available" } }, 500);
    }
    await createSession(c, adminUser?.id ?? email, "admin", row.jwt_secret);
    return c.json({ success: true });
  });

  routes.post("/identity", async (c) => {
    const existing = await settings.get();
    const hasAdmin = deps.userRepo
      ? Boolean(await deps.userRepo.findFirstLocalAdmin())
      : Boolean(existing?.admin_email);
    if (!hasAdmin) {
      return c.json(
        { error: { code: "SETUP_INCOMPLETE", message: "Admin account must be created before setting identity" } },
        409,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = identitySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    await settings.update({
      orgName: parsed.data.orgName.trim(),
      botName: deps.managedUrl ? "Sketch" : parsed.data.botName.trim(),
    });

    return c.json({ success: true });
  });

  routes.post("/slack", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (deps.managedUrl) {
      return c.json({ error: { code: "FORBIDDEN", message: "Slack is managed via Marketplace" } }, 403);
    }

    const existing = await settings.get();
    const hasAdmin = deps.userRepo
      ? Boolean(await deps.userRepo.findFirstLocalAdmin())
      : Boolean(existing?.admin_email);
    if (!hasAdmin) {
      return c.json(
        { error: { code: "SETUP_INCOMPLETE", message: "Admin account must be created before configuring Slack" } },
        409,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = slackSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    const botToken = parsed.data.botToken.trim();
    const appToken = parsed.data.appToken.trim();
    if (deps.onSlackTokensUpdated) {
      try {
        await deps.onSlackTokensUpdated({ botToken, appToken });
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_SLACK_TOKENS",
              message: "Invalid Slack tokens. Check Bot Token and App-Level Token, then try again.",
            },
          },
          400,
        );
      }
    }
    await settings.update({
      slackBotToken: botToken,
      slackAppToken: appToken,
    });

    return c.json({ success: true });
  });

  routes.post("/llm/verify", async (c) => {
    const existing = await settings.get();
    const hasAdmin = deps.userRepo
      ? Boolean(await deps.userRepo.findFirstLocalAdmin())
      : Boolean(existing?.admin_email);
    if (!hasAdmin) {
      return c.json(
        { error: { code: "SETUP_INCOMPLETE", message: "Admin account must be created before configuring LLM" } },
        409,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = llmSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    if (parsed.data.provider === "anthropic") {
      try {
        await verifyAnthropicApiKey(parsed.data.apiKey.trim());
      } catch {
        return c.json(
          {
            error: {
              code: "INVALID_LLM_SETTINGS",
              message: "Invalid LLM credentials. Check your API key and try again.",
            },
          },
          400,
        );
      }
    }

    return c.json({ success: true });
  });

  routes.post("/llm", async (c) => {
    const existing = await settings.get();
    const hasAdmin = deps.userRepo
      ? Boolean(await deps.userRepo.findFirstLocalAdmin())
      : Boolean(existing?.admin_email);
    if (!hasAdmin) {
      return c.json(
        { error: { code: "SETUP_INCOMPLETE", message: "Admin account must be created before configuring LLM" } },
        409,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = llmSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join(", ");
      return c.json({ error: { code: "BAD_REQUEST", message } }, 400);
    }

    if (parsed.data.provider === "anthropic") {
      await settings.update({
        llmProvider: "anthropic",
        anthropicApiKey: parsed.data.apiKey.trim(),
        awsAccessKeyId: null,
        awsSecretAccessKey: null,
        awsRegion: null,
      });
    } else {
      await settings.update({
        llmProvider: "bedrock",
        anthropicApiKey: null,
        awsAccessKeyId: parsed.data.awsAccessKeyId.trim(),
        awsSecretAccessKey: parsed.data.awsSecretAccessKey.trim(),
        awsRegion: parsed.data.awsRegion.trim(),
      });
    }

    if (deps.onLlmSettingsUpdated) {
      await deps.onLlmSettingsUpdated();
    }

    return c.json({ success: true });
  });

  routes.post("/complete", async (c) => {
    const existing = await settings.get();
    const hasAdmin = deps.userRepo
      ? Boolean(await deps.userRepo.findFirstLocalAdmin())
      : Boolean(existing?.admin_email);
    if (!hasAdmin) {
      return c.json(
        { error: { code: "SETUP_INCOMPLETE", message: "Admin account must be created before completing setup" } },
        409,
      );
    }

    await settings.update({
      onboardingCompletedAt: new Date().toISOString(),
    });

    return c.json({ success: true });
  });

  return routes;
}

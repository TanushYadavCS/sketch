import { Hono } from "hono";
import { z } from "zod";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { createWhatsAppTemplateMappingRepository } from "../db/repositories/whatsapp-template-mappings";
import { createEmailTransport, verifyEmailTransport } from "../email";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";
import type { WatiWhatsAppProvider } from "../whatsapp/providers/wati";
import { denyIfNotAdmin } from "./auth-helpers";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type WhatsAppGroupsRepo = ReturnType<typeof createWhatsAppGroupRepository>;
type WhatsAppTemplateMappingsRepo = ReturnType<typeof createWhatsAppTemplateMappingRepository>;

interface ChannelDeps {
  whatsapp?: WhatsAppBot;
  watiProvider?: Pick<WatiWhatsAppProvider, "listTemplates">;
  whatsappTemplateMappings?: WhatsAppTemplateMappingsRepo;
  getSlack?: () => SlackBot | null;
  whatsappGroups?: WhatsAppGroupsRepo;
  onSlackDisconnect?: () => Promise<void>;
  settings: SettingsRepo;
  onSmtpUpdated?: () => Promise<void>;
}

const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.string().email(),
});

const templateMappingSchema = z.object({
  provider: z.string().trim().min(1).default("wati"),
  logicalKey: z.string().trim().min(1),
  providerTemplateName: z.string().trim().min(1),
  language: z.string().trim().min(1).default("en_US"),
  status: z.string().trim().min(1).default("approved"),
  category: z.string().trim().min(1).nullable().optional(),
  parameterMap: z.record(z.string(), z.string()).nullable().optional(),
});

export function channelRoutes(deps: ChannelDeps) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const slackBot = deps.getSlack?.() ?? null;
    const slackConfigured = !!slackBot;

    const settingsRow = await deps.settings.get();
    const emailConfigured = !!(settingsRow?.smtp_host && settingsRow?.smtp_from);

    const channels = [
      {
        platform: "slack" as const,
        configured: slackConfigured,
        connected: slackConfigured ? true : null,
        phoneNumber: null,
        fromAddress: null,
      },
      {
        platform: "whatsapp" as const,
        configured: deps.whatsapp?.isConnected ?? false,
        connected: deps.whatsapp?.isConnected ? true : null,
        phoneNumber: deps.whatsapp?.phoneNumber ?? null,
        fromAddress: null,
      },
      {
        platform: "email" as const,
        configured: emailConfigured,
        connected: emailConfigured ? true : null,
        phoneNumber: null,
        fromAddress: emailConfigured ? (settingsRow?.smtp_from ?? null) : null,
        outboundOnly: true,
      },
    ];

    return c.json({ channels });
  });

  routes.get("/slack", async (c) => {
    const slackBot = deps.getSlack?.() ?? null;
    if (!slackBot) {
      return c.json({ error: { code: "NOT_CONNECTED", message: "Slack is not connected" } }, 400);
    }

    return c.json({ channels: await slackBot.listChannels() });
  });

  routes.get("/whatsapp/groups", async (c) => {
    if (!deps.whatsappGroups) {
      return c.json({ groups: [] });
    }

    return c.json({ groups: await deps.whatsappGroups.list() });
  });

  routes.get("/whatsapp/templates/provider", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!deps.watiProvider) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Wati is not configured" } }, 404);
    }

    return c.json({ provider: "wati", templates: await deps.watiProvider.listTemplates() });
  });

  routes.get("/whatsapp/templates/mappings", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const provider = c.req.query("provider")?.trim() || undefined;
    return c.json({ mappings: (await deps.whatsappTemplateMappings?.listMappings(provider)) ?? [] });
  });

  routes.put("/whatsapp/templates/mappings", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!deps.whatsappTemplateMappings) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Template mappings are not configured" } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = templateMappingSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid template mapping";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const mapping = await deps.whatsappTemplateMappings.upsertMapping(parsed.data);
    return c.json({ mapping });
  });

  routes.post("/whatsapp/templates/sync", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!deps.watiProvider || !deps.whatsappTemplateMappings) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Wati templates are not configured" } }, 404);
    }

    const templates = await deps.watiProvider.listTemplates();
    const updatedMappings = await deps.whatsappTemplateMappings.syncProviderTemplates("wati", templates);
    return c.json({ provider: "wati", templates, updatedMappings });
  });

  routes.delete("/slack", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const slackBot = deps.getSlack?.() ?? null;
    if (!slackBot) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "Slack is not configured" } }, 400);
    }
    await deps.onSlackDisconnect?.();
    return c.json({ success: true });
  });

  // --- Email SMTP endpoints ---

  routes.post("/email/test", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = await c.req.json();
    const parsed = smtpConfigSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid SMTP config";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const transport = createEmailTransport(parsed.data);
    const ok = await verifyEmailTransport(transport);
    if (!ok) {
      return c.json({ error: { code: "CONNECTION_FAILED", message: "Could not connect to SMTP server" } }, 400);
    }

    return c.json({ success: true });
  });

  routes.put("/email", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const body = await c.req.json();
    const parsed = smtpConfigSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid SMTP config";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    await deps.settings.update({
      smtpHost: parsed.data.host,
      smtpPort: parsed.data.port,
      smtpUser: parsed.data.user,
      smtpPassword: parsed.data.password,
      smtpFrom: parsed.data.from,
    });

    await deps.onSmtpUpdated?.();

    return c.json({ success: true });
  });

  routes.delete("/email", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    await deps.settings.update({
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPassword: null,
      smtpFrom: null,
    });

    await deps.onSmtpUpdated?.();

    return c.json({ success: true });
  });

  return routes;
}

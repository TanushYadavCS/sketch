import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { normalizeContactPointValue } from "../db/repositories/entities";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { createWhatsAppTemplateMappingRepository } from "../db/repositories/whatsapp-template-mappings";
import { createEmailTransport, verifyEmailTransport } from "../email";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";

/** What the channels card shows. `reconnecting` and `paused` both mean paired but not live. */
export type WhatsAppChannelState = "needs-pairing" | "connected" | "reconnecting" | "paused";
import type { WatiWhatsAppProvider } from "../whatsapp/providers/wati";
import { denyIfNotAdmin } from "./auth-helpers";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type WhatsAppGroupsRepo = ReturnType<typeof createWhatsAppGroupRepository>;
type WhatsAppTemplateMappingsRepo = ReturnType<typeof createWhatsAppTemplateMappingRepository>;

interface ChannelDeps {
  whatsapp?: WhatsAppSocketFacade;
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

const memberLabelsSchema = z.object({
  labels: z.array(
    z
      .object({
        id: z.string().trim().min(1).optional(),
        phoneE164: z.string().trim().min(1).optional(),
        displayName: z.string().trim().min(1).max(120),
        companyName: z.string().trim().max(120).nullable().optional(),
      })
      .refine((label) => label.id || label.phoneE164, "Member label id or phoneE164 is required"),
  ),
});

function maskPhoneLastTwo(phoneE164: string): string {
  const lastTwo = phoneE164.replace(/\D/gu, "").slice(-2);
  return lastTwo ? `**${lastTwo}` : "**";
}

function memberLabelId(label: { group_jid: string; phone_e164: string }): string {
  return createHash("sha256").update(`${label.group_jid}\0${label.phone_e164}`).digest("base64url");
}

function memberLabelResponse(label: {
  group_jid: string;
  phone_e164: string;
  display_name: string;
  company_name: string | null;
}) {
  return {
    id: memberLabelId(label),
    maskedPhone: maskPhoneLastTwo(label.phone_e164),
    displayName: label.display_name,
    companyName: label.company_name,
  };
}

export function channelRoutes(deps: ChannelDeps) {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    const slackBot = deps.getSlack?.() ?? null;
    const slackConfigured = !!slackBot;
    const whatsappStatus = await deps.whatsapp?.pairing.status();
    /** `paired` is absent on a gateway predating the field, where `connected` was the best answer available. */
    const whatsappPaired = whatsappStatus ? (whatsappStatus.paired ?? whatsappStatus.connected) : false;
    const whatsappPausedUntil = whatsappStatus?.pausedUntil ?? null;
    /**
     * Paired-but-not-live is reconnecting, not broken — Sketch recovers on its own. Only a live
     * pause is worth telling the admin about, and even that self-resumes.
     */
    const whatsappState: WhatsAppChannelState = !whatsappPaired
      ? "needs-pairing"
      : whatsappStatus?.connected
        ? "connected"
        : whatsappPausedUntil && Date.parse(whatsappPausedUntil) > Date.now()
          ? "paused"
          : "reconnecting";

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
        /**
         * Pairedness, not liveness. Keying this to `connected` offered "Pair a number" to an
         * already-paired tenant in the middle of an outage — and hid Disconnect exactly when an
         * admin needs it.
         */
        configured: whatsappPaired,
        connected: whatsappStatus?.connected ? true : null,
        state: whatsappState,
        phoneNumber: whatsappStatus?.phoneNumber ?? null,
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

  routes.post("/whatsapp/groups/sync", async (c) => {
    await deps.whatsapp?.syncAllGroups({ force: true });

    if (!deps.whatsappGroups) {
      return c.json({ groups: [] });
    }

    return c.json({ groups: await deps.whatsappGroups.list() });
  });

  routes.get("/whatsapp/groups/:jid/member-labels", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!deps.whatsappGroups) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp groups are not configured" } }, 404);
    }

    const group = await deps.whatsappGroups.getByJid(c.req.param("jid"));
    if (!group) {
      return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp group not found" } }, 404);
    }
    if (group.index_enabled !== 1) {
      return c.json(
        { error: { code: "GROUP_NOT_INDEX_ENABLED", message: "Enable indexing for this group before editing labels" } },
        409,
      );
    }

    const labels = await deps.whatsappGroups.listMemberLabels(group.jid);
    return c.json({ labels: labels.map(memberLabelResponse) });
  });

  routes.put("/whatsapp/groups/:jid/member-labels", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    if (!deps.whatsappGroups) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp groups are not configured" } }, 404);
    }

    const group = await deps.whatsappGroups.getByJid(c.req.param("jid"));
    if (!group) {
      return c.json({ error: { code: "NOT_FOUND", message: "WhatsApp group not found" } }, 404);
    }
    if (group.index_enabled !== 1) {
      return c.json(
        { error: { code: "GROUP_NOT_INDEX_ENABLED", message: "Enable indexing for this group before editing labels" } },
        409,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = memberLabelsSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid member labels";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const createdBy = c.get("sub");
    if (!createdBy || typeof createdBy !== "string") {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Sign-in required" } }, 401);
    }

    try {
      const existingLabels = await deps.whatsappGroups.listMemberLabels(group.jid);
      const existingPhoneById = new Map(existingLabels.map((label) => [memberLabelId(label), label.phone_e164]));
      const seenPhones = new Set<string>();
      const nextLabels = parsed.data.labels.map((label) => {
        const rawPhone = label.phoneE164 ?? (label.id ? existingPhoneById.get(label.id) : undefined);
        if (!rawPhone) {
          throw new Error("Unknown member label id");
        }
        const phoneE164 = normalizeContactPointValue("whatsapp", rawPhone);
        if (seenPhones.has(phoneE164)) {
          throw new Error("Duplicate phone numbers are not allowed");
        }
        seenPhones.add(phoneE164);
        return {
          phoneE164,
          displayName: label.displayName.trim(),
          companyName: label.companyName?.trim() || null,
          createdBy,
        };
      });
      const labels = await deps.whatsappGroups.replaceMemberLabels(group.jid, nextLabels);
      return c.json({ labels: labels.map(memberLabelResponse) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid member labels";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }
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

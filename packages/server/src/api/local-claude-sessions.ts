import { Hono } from "hono";
import type { LocalClaudeSessionRow } from "../db/repositories/local-claude-sessions";
import type { LocalClaudeSessionService } from "../local-devices/claude-sessions";
import type { Logger } from "../logger";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";

interface LocalClaudeSessionEventDeps {
  service: LocalClaudeSessionService;
  logger: Logger;
  getSlack?: () => SlackBot | null;
  whatsapp?: WhatsAppBot;
}

function readBearer(value: string | undefined): string | null {
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
}

function formatNotification(message: string, sessionId: string): string {
  return `${message}\n\nSession: ${sessionId}`;
}

async function notifyOrigin(
  deps: LocalClaudeSessionEventDeps,
  params: { message: string; session: LocalClaudeSessionRow },
) {
  const text = formatNotification(params.message, params.session.id);
  const platform = params.session.origin_platform;
  const target = params.session.origin_delivery_target;
  if (!platform || !target) return;

  if (platform === "slack") {
    const slack = deps.getSlack?.();
    if (!slack) return;
    if (params.session.origin_thread_ts) {
      await slack.postThreadReply(target, params.session.origin_thread_ts, text);
    } else {
      await slack.postMessage(target, text);
    }
    return;
  }

  if (platform === "whatsapp" && deps.whatsapp) {
    await deps.whatsapp.sendText(target, text);
  }
}

export function localClaudeSessionEventRoutes(deps: LocalClaudeSessionEventDeps) {
  const routes = new Hono();

  routes.post("/:id/events", async (c) => {
    const token = readBearer(c.req.header("authorization"));
    if (!token) return c.json({ error: { code: "UNAUTHORIZED", message: "Missing event token" } }, 401);

    const eventType = c.req.query("type")?.trim() || "unknown";
    const payload = await c.req.json().catch(() => ({}));

    try {
      const delivery = await deps.service.recordEvent({
        token,
        expectedSessionId: c.req.param("id"),
        eventType,
        payload,
      });
      await notifyOrigin(deps, { message: delivery.message, session: delivery.session }).catch((err) => {
        deps.logger.warn({ err, sessionId: delivery.session.id }, "Failed to notify local Claude session origin");
      });
      return c.json({ ok: true });
    } catch (err) {
      deps.logger.warn({ err }, "Failed to record local Claude session event");
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid event token" } }, 401);
    }
  });

  return routes;
}

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { WatiWhatsAppProvider } from "../whatsapp/providers/wati";

export const WATI_WEBHOOK_QUEUE_KEY = "whatsapp:wati:webhooks";

/**
 * Derives a per-conversation queue key from a raw Wati webhook payload so one
 * busy chat cannot head-of-line-block every tenant's traffic through a single
 * global key. Falls back to the global key when no conversation identifier is
 * present (e.g. malformed or owner delivery-status events).
 */
export function watiWebhookQueueKey(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const conversationId = firstNonEmptyString(record.conversationId, record.ticketId, record.waId);
    if (conversationId) return `${WATI_WEBHOOK_QUEUE_KEY}:${conversationId}`;
  }
  return WATI_WEBHOOK_QUEUE_KEY;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function watiWebhookRoutes(
  provider: Pick<WatiWhatsAppProvider, "handleWebhook" | "webhookToken">,
  queueManager: QueueManager,
  logger: Logger,
) {
  const routes = new Hono();

  routes.post("/events", async (c) => {
    if (!isValidWebhookToken(extractWebhookToken(c.req.raw), provider.webhookToken)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid webhook token" } }, 401);
    }

    const payload = await c.req.json().catch((err) => {
      logger.warn({ err }, "Invalid Wati webhook JSON");
      return undefined;
    });

    if (payload === undefined) {
      return c.json({ error: { code: "INVALID_JSON", message: "Invalid JSON body" } }, 400);
    }

    queueManager.getQueue(watiWebhookQueueKey(payload)).enqueue(async () => {
      try {
        const results = await provider.handleWebhook(payload);
        logger.debug(
          {
            messages: results.filter((result) => result.kind === "message").length,
            deliveryStatuses: results.filter((result) => result.kind === "delivery_status").length,
            ignored: results.filter((result) => result.kind === "ignored").length,
            unrecognized: results.filter((result) => result.kind === "unrecognized").length,
          },
          "Wati webhook processed",
        );
      } catch (err) {
        logger.error({ err }, "Wati webhook processing failed");
      }
    });

    return c.json({ ok: true }, 200);
  });

  return routes;
}

export function extractWebhookToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) return token;
  }

  for (const header of ["x-wati-webhook-token", "x-sketch-wati-webhook-token", "x-webhook-token"]) {
    const token = request.headers.get(header)?.trim();
    if (token) return token;
  }

  const url = new URL(request.url);
  return url.searchParams.get("token")?.trim() || null;
}

export function isValidWebhookToken(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

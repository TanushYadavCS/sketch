import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Logger } from "../logger";
import type { WatiWhatsAppProvider } from "../whatsapp/providers/wati";

export function watiWebhookRoutes(
  provider: Pick<WatiWhatsAppProvider, "handleWebhook" | "webhookToken">,
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

    const results = await provider.handleWebhook(payload);
    const acceptedMessages = results.filter((result) => result.kind === "message").length;
    return c.json({ ok: true, acceptedMessages }, 202);
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

import { Hono } from "hono";
import type { LocalClaudeEventDelivery } from "../local-devices/claude-sessions";
import type { LocalClaudeSessionService } from "../local-devices/claude-sessions";
import type { Logger } from "../logger";

interface LocalClaudeSessionEventDeps {
  service: LocalClaudeSessionService;
  logger: Logger;
  dispatchEvent?: (delivery: LocalClaudeEventDelivery) => void;
}

function readBearer(value: string | undefined): string | null {
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
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
      deps.dispatchEvent?.(delivery);
      return c.json({ ok: true });
    } catch (err) {
      deps.logger.warn({ err }, "Failed to record local Claude session event");
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid event token" } }, 401);
    }
  });

  return routes;
}

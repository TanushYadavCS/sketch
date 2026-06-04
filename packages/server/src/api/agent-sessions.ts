import { Hono } from "hono";

function badRequest(code: string, message: string) {
  return { error: { code, message } };
}

export function agentSessionRoutes() {
  const routes = new Hono();

  routes.get("/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json(badRequest("VALIDATION_ERROR", "Session ID is required"), 400);
    }

    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    const messages = await getSessionMessages(sessionId);
    return c.json({ ok: true, sessionId, messages });
  });

  return routes;
}

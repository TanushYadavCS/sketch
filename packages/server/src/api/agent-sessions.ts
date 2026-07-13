import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import type { DB } from "../db/schema";

function badRequest(code: string, message: string) {
  return { error: { code, message } };
}

function notFound(code: string, message: string) {
  return { error: { code, message } };
}

async function loadSdkSessionMessages(sessionId: string): Promise<unknown[]> {
  const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
  const messages = await getSessionMessages(sessionId);
  return Array.isArray(messages) ? (messages as unknown[]) : [];
}

export function agentSessionRoutes(db: Kysely<DB>, deps: { logger?: Pick<Logger, "warn"> } = {}) {
  const routes = new Hono();

  /**
   * API-key-only admin transcript read. This intentionally resolves by externally visible session id across
   * workspaces; the AI SDK run path rejects cross-workspace reuse before agent_messages can mix active transcripts.
   */
  routes.get("/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json(badRequest("VALIDATION_ERROR", "Session ID is required"), 400);
    }

    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["runtime", "session_id"])
      .where("session_id", "=", sessionId)
      .execute();
    const session = sessions.find((row) => row.runtime === "aisdk") ?? sessions[0];

    if (session?.runtime === "aisdk") {
      const messages = await createAgentMessagesRepository(db).loadBySession(sessionId);
      return c.json({
        ok: true,
        version: 1,
        runtime: "aisdk",
        sessionId,
        messages: messages.map((message) => ({
          seq: message.seq,
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
        })),
      });
    }

    let messages: unknown[];
    try {
      messages = await loadSdkSessionMessages(sessionId);
    } catch (err) {
      deps.logger?.warn({ err, sessionId, runtime: "sdk" }, "Failed to read Claude SDK session transcript");
      return c.json({ error: { code: "SESSION_READ_FAILED", message: "Failed to read session messages" } }, 500);
    }

    if (!session && messages.length === 0) {
      return c.json(notFound("SESSION_NOT_FOUND", "Session not found"), 404);
    }

    return c.json({ ok: true, version: 1, runtime: "sdk", sessionId, messages });
  });

  return routes;
}

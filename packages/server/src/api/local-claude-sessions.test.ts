import { describe, expect, it, vi } from "vitest";
import { localClaudeSessionEventRoutes } from "./local-claude-sessions";

describe("localClaudeSessionEventRoutes", () => {
  it("records and dispatches Claude hook events without direct chat notification", async () => {
    const delivery = {
      session: { id: "session-1" },
      event: { id: "event-1" },
      status: "completed_turn",
      message: "Claude Code completed a turn.",
    };
    const service = {
      recordEvent: vi.fn().mockResolvedValue(delivery),
    };
    const dispatchEvent = vi.fn();
    const logger = { warn: vi.fn() };
    const routes = localClaudeSessionEventRoutes({
      service: service as never,
      dispatchEvent,
      logger: logger as never,
    });

    const res = await routes.request("/session-1/events?type=Stop", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ last_assistant_message: "Done" }),
    });

    expect(res.status).toBe(200);
    expect(service.recordEvent).toHaveBeenCalledWith({
      token: "token",
      expectedSessionId: "session-1",
      eventType: "Stop",
      payload: { last_assistant_message: "Done" },
    });
    expect(dispatchEvent).toHaveBeenCalledWith(delivery);
  });
});

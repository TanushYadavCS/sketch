import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "./routes";
import { AgentDeliveryTargetError, type AgentRunService } from "./service";

function createRoutesTestApp(service: AgentRunService) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sub", "auth-user");
    c.set("email", "user@example.com");
    await next();
  });
  app.route("/api/agents", agentRoutes(service));
  return app;
}

function createService(overrides: Record<string, unknown> = {}) {
  return {
    resolveUserId: vi.fn(async () => "user-1"),
    resolveDeliveryConfigForUser: vi.fn(async (_userId, delivery) => delivery),
    updateConfigForUser: vi.fn(async () => ({ agentKey: "daily-brief", delivery: null })),
    ...overrides,
  } as unknown as AgentRunService & {
    resolveDeliveryConfigForUser: ReturnType<typeof vi.fn>;
    updateConfigForUser: ReturnType<typeof vi.fn>;
  };
}

describe("agentRoutes", () => {
  it("resolves delivery config before saving it", async () => {
    const resolved = {
      enabled: true as const,
      platform: "slack" as const,
      targetType: "dm" as const,
      targetId: "U_SELF",
      label: "Agent User <user@example.com>",
    };
    const service = createService({
      resolveDeliveryConfigForUser: vi.fn(async () => resolved),
      updateConfigForUser: vi.fn(async () => ({ agentKey: "daily-brief", delivery: resolved })),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request("/api/agents/daily-brief/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "dm",
          targetId: "U_SELF",
          label: "Spoofed",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(service.updateConfigForUser).toHaveBeenCalledWith(
      "daily-brief",
      "user-1",
      expect.objectContaining({ delivery: resolved }),
    );
  });

  it("rejects unauthorized delivery config before saving it", async () => {
    const service = createService({
      resolveDeliveryConfigForUser: vi.fn(async () => {
        throw new AgentDeliveryTargetError("Slack DM delivery must target the current user");
      }),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request("/api/agents/daily-brief/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "dm",
          targetId: "U_OTHER",
          label: "Other User",
        },
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Slack DM delivery must target the current user" },
    });
    expect(res.status).toBe(400);
    expect(service.updateConfigForUser).not.toHaveBeenCalled();
  });
});

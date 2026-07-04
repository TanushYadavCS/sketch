import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "./definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY } from "./definitions/daily-brief";
import { agentRoutes } from "./routes";
import { AgentDeliveryTargetError, AgentRunService, type AgentRunServiceDeps, AgentSourceTargetError } from "./service";

function createRoutesTestApp(service: AgentRunService, sub = "auth-user", email = "user@example.com") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sub", sub);
    c.set("email", email);
    await next();
  });
  app.route("/api/agents", agentRoutes(service));
  return app;
}

function createService(overrides: Record<string, unknown> = {}) {
  return {
    resolveUserId: vi.fn(async () => "user-1"),
    resolveDeliveryConfigForUser: vi.fn(async (_userId, delivery) => delivery),
    listDefinitions: vi.fn(() => [{ key: "daily-brief" }]),
    listOutputsForUser: vi.fn(async () => ({ outputs: [], nextCursor: null })),
    listEligibleRouteMembers: vi.fn(async () => []),
    requestGenerationForUser: vi.fn(async () => []),
    updateConfigForUser: vi.fn(async () => ({ agentKey: "daily-brief", delivery: null })),
    ...overrides,
  } as unknown as AgentRunService & {
    resolveDeliveryConfigForUser: ReturnType<typeof vi.fn>;
    listOutputsForUser: ReturnType<typeof vi.fn>;
    listEligibleRouteMembers: ReturnType<typeof vi.fn>;
    requestGenerationForUser: ReturnType<typeof vi.fn>;
    updateConfigForUser: ReturnType<typeof vi.fn>;
  };
}

describe("agentRoutes", () => {
  it("passes parsed delivery config to the service for saving", async () => {
    const service = createService({
      updateConfigForUser: vi.fn(async () => ({ agentKey: "daily-brief", delivery: null })),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${DAILY_BRIEF_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "dm",
          targetId: "U_SELF",
          label: "Spoofed",
          mentions: [{ platform: "slack", targetId: "U_OWNER", label: "Spoofed Owner" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(service.updateConfigForUser).toHaveBeenCalledWith(
      DAILY_BRIEF_AGENT_KEY,
      "user-1",
      expect.objectContaining({
        delivery: expect.objectContaining({
          targetId: "U_SELF",
          mentions: [{ platform: "slack", targetId: "U_OWNER", label: "Spoofed Owner" }],
        }),
      }),
    );
    expect(service.resolveDeliveryConfigForUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        platform: "slack",
        targetType: "dm",
        targetId: "U_SELF",
      }),
    );
  });

  it("rejects delivery mentions for the wrong platform", async () => {
    const service = createService();
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${DAILY_BRIEF_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        delivery: {
          enabled: true,
          platform: "slack",
          targetType: "channel",
          targetId: "C_DAILY",
          label: "#daily",
          mentions: [{ platform: "whatsapp", targetId: "+15551234567", label: "Ada" }],
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "delivery mention platform must match delivery.platform" },
    });
    expect(service.updateConfigForUser).not.toHaveBeenCalled();
  });

  it("returns service validation errors for unauthorized delivery config", async () => {
    const service = createService({
      resolveDeliveryConfigForUser: vi.fn(async () => {
        throw new AgentDeliveryTargetError("Slack DM delivery must target the current user");
      }),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${DAILY_BRIEF_AGENT_KEY}/config`, {
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

  it("validates combined delivery model targets before saving config", async () => {
    const service = createService({
      resolveDeliveryConfigForUser: vi.fn(async () => {
        throw new AgentDeliveryTargetError("Slack channel is not available for delivery");
      }),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deliveryModel: {
          mode: "combined",
          combined: {
            enabled: true,
            platform: "slack",
            targetType: "channel",
            targetId: "C_PRIVATE",
            label: "#private",
            ackNonDm: true,
          },
        },
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Slack channel is not available for delivery" },
    });
    expect(res.status).toBe(400);
    expect(service.updateConfigForUser).not.toHaveBeenCalled();
  });

  it("returns service validation errors for unauthorized source config", async () => {
    const service = createService({
      updateConfigForUser: vi.fn(async () => {
        throw new AgentSourceTargetError("Slack channel is not available for this user");
      }),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${DAILY_BRIEF_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          {
            platform: "slack",
            targetType: "channel",
            targetId: "C_PRIVATE",
            label: "#private",
          },
        ],
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Slack channel is not available for this user" },
    });
    expect(res.status).toBe(400);
  });

  it("passes parsed routes to the service for saving", async () => {
    const service = createService({
      updateConfigForUser: vi.fn(async () => ({ agentKey: CONVERSATION_SUMMARY_AGENT_KEY, routes: [] })),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ platform: "slack", targetType: "channel", targetId: "C_ALPHA", label: "#alpha" }],
        routes: [
          {
            id: "alpha-route",
            sources: ["slack:channel:C_ALPHA"],
            focus: "  launch blockers  ",
            sections: { highlights: true, decisions: false },
            maxItemsPerSection: 2,
            schedule: { hour: 9, minute: 15 },
            destination: { kind: "self" },
            enabled: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(service.updateConfigForUser).toHaveBeenCalledWith(
      CONVERSATION_SUMMARY_AGENT_KEY,
      "user-1",
      expect.objectContaining({
        routes: [
          {
            id: "alpha-route",
            sources: ["slack:channel:C_ALPHA"],
            focus: "launch blockers",
            sections: { highlights: true, decisions: false },
            maxItemsPerSection: 2,
            schedule: { hour: 9, minute: 15 },
            destination: { kind: "self" },
            enabled: true,
          },
        ],
      }),
    );
  });

  it("passes multi-source routes and Slack member destinations to the service for saving", async () => {
    const service = createService({
      updateConfigForUser: vi.fn(async () => ({ agentKey: CONVERSATION_SUMMARY_AGENT_KEY, routes: [] })),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { platform: "slack", targetType: "channel", targetId: "C_ALPHA", label: "#alpha" },
          { platform: "slack", targetType: "channel", targetId: "C_BETA", label: "#beta" },
        ],
        routes: [
          {
            id: "combined-route",
            sources: ["slack:channel:C_ALPHA", "slack:channel:C_ALPHA", "slack:channel:C_BETA"],
            focus: null,
            sections: null,
            maxItemsPerSection: null,
            schedule: null,
            destination: { kind: "member", platform: "slack", memberUserId: "  member-1  " },
            enabled: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(service.updateConfigForUser).toHaveBeenCalledWith(
      CONVERSATION_SUMMARY_AGENT_KEY,
      "user-1",
      expect.objectContaining({
        routes: [
          expect.objectContaining({
            id: "combined-route",
            sources: ["slack:channel:C_ALPHA", "slack:channel:C_BETA"],
            destination: { kind: "member", platform: "slack", memberUserId: "member-1" },
          }),
        ],
      }),
    );
  });

  it("rejects combined routes with self delivery", async () => {
    const service = createService();
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { platform: "slack", targetType: "channel", targetId: "C_ALPHA", label: "#alpha" },
          { platform: "slack", targetType: "channel", targetId: "C_BETA", label: "#beta" },
        ],
        routes: [
          {
            id: "combined-self-route",
            sources: ["slack:channel:C_ALPHA", "slack:channel:C_BETA"],
            focus: null,
            sections: null,
            maxItemsPerSection: null,
            schedule: null,
            destination: { kind: "self" },
            enabled: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Combined routes cannot use self destination" },
    });
    expect(service.updateConfigForUser).not.toHaveBeenCalled();
  });

  it("rejects member route destinations with WhatsApp sources", async () => {
    const service = createService();
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ platform: "whatsapp", targetType: "group", targetId: "120363000000001@g.us", label: "Leads" }],
        routes: [
          {
            id: "whatsapp-member-route",
            sources: ["whatsapp:group:120363000000001@g.us"],
            focus: null,
            sections: null,
            maxItemsPerSection: null,
            schedule: null,
            destination: { kind: "member", platform: "slack", memberUserId: "member-1" },
            enabled: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Member route destinations support Slack sources only" },
    });
    expect(service.updateConfigForUser).not.toHaveBeenCalled();
  });

  it("lists route members through the agent route-members endpoint", async () => {
    const service = createService({
      listEligibleRouteMembers: vi.fn(async () => [
        { userId: "member-1", name: "Member One", slackUserId: "U_MEMBER_1" },
      ]),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/route-members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["slack:channel:C_ALPHA", "slack:channel:C_ALPHA", "slack:channel:C_BETA"],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      members: [{ userId: "member-1", name: "Member One", slackUserId: "U_MEMBER_1" }],
    });
    expect(service.listEligibleRouteMembers).toHaveBeenCalledWith("user-1", [
      "slack:channel:C_ALPHA",
      "slack:channel:C_BETA",
    ]);
  });

  it("lists completed outputs for an agent", async () => {
    const service = createService({
      listDefinitions: vi.fn(() => [{ key: "daily-brief" }]),
      listOutputsForUser: vi.fn(async () => ({ outputs: [{ id: "out-1" }], nextCursor: "out-1" })),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request("/api/agents/daily-brief/outputs?limit=10&cursor=old");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outputs: [{ id: "out-1" }], nextCursor: "out-1" });
    expect(service.listOutputsForUser).toHaveBeenCalledWith("daily-brief", "user-1", { limit: 10, cursor: "old" });
  });

  it("returns fan-out generations while keeping legacy generation", async () => {
    const service = createService({
      listDefinitions: vi.fn(() => [{ key: "conversation_summary" }]),
      requestGenerationForUser: vi.fn(async () => [
        {
          id: "out-a",
          status: "running",
          output_date: "2026-07-04",
          source_key: "slack:channel:C_A",
        },
        {
          id: "out-b",
          status: "running",
          output_date: "2026-07-04",
          source_key: "slack:channel:C_B",
        },
      ]),
    });
    const app = createRoutesTestApp(service);

    const res = await app.request("/api/agents/conversation_summary/runs", { method: "POST" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      generation: { id: "out-a", sourceKey: "slack:channel:C_A", status: "running", outputDate: "2026-07-04" },
      generations: [
        { id: "out-a", sourceKey: "slack:channel:C_A", status: "running", outputDate: "2026-07-04" },
        { id: "out-b", sourceKey: "slack:channel:C_B", status: "running", outputDate: "2026-07-04" },
      ],
    });
  });

  it("rejects combined delivery to a selected source through the public config route", async () => {
    const db = await createTestDb();
    try {
      const users = createUserRepository(db);
      const user = await users.create({ name: "Agent User", email: "user@example.com", slackUserId: "U_AGENT" });
      const service = new AgentRunService({
        db,
        config: createTestConfig(),
        logger: createTestLogger(),
        users,
        settings: createSettingsRepository(db),
        runAgent: vi.fn(async () => {
          throw new Error("runAgent should not be called");
        }) as unknown as AgentRunServiceDeps["runAgent"],
        getSlack: () => ({
          listChannels: vi.fn(async () => [{ id: "C_SOURCE", name: "source", type: "public_channel", isMember: true }]),
          isUserInChannel: vi.fn(async () => true),
        }),
      });
      const app = createRoutesTestApp(service, user.id, user.email ?? undefined);

      const res = await app.request(`/api/agents/${CONVERSATION_SUMMARY_AGENT_KEY}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: [{ platform: "slack", targetType: "channel", targetId: "C_SOURCE", label: "#source" }],
          deliveryModel: {
            mode: "combined",
            combined: {
              enabled: true,
              platform: "slack",
              targetType: "channel",
              targetId: "C_SOURCE",
              label: "#source",
              ackNonDm: true,
            },
          },
        }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          message: "Combined delivery cannot target one of the selected sources",
        },
      });
    } finally {
      await db.destroy();
    }
  });
});

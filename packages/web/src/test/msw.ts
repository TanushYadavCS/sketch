import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/**
 * Default MSW handlers — happy-path responses for all API endpoints.
 * Override per-test with server.use(...) for error/edge cases.
 */
export const handlers = [
  http.get("/api/setup/status", () => {
    return HttpResponse.json({
      completed: false,
      currentStep: 0,
      adminEmail: null,
      orgName: null,
      botName: "Sketch",
      slackConnected: false,
      llmConnected: false,
      llmProvider: null,
    });
  }),

  http.post("/api/setup/account", async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "Email and password required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/setup/slack", async ({ request }) => {
    const body = (await request.json()) as { botToken?: string; appToken?: string };
    if (!body.botToken || !body.appToken) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "Bot token and app token required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/setup/identity", async ({ request }) => {
    const body = (await request.json()) as { orgName?: string; botName?: string };
    if (!body.orgName || !body.botName) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "Organization and bot name required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/setup/llm", async ({ request }) => {
    const body = (await request.json()) as
      | { provider: "anthropic"; apiKey?: string }
      | { provider: "bedrock"; awsAccessKeyId?: string; awsSecretAccessKey?: string; awsRegion?: string };

    if (body.provider === "anthropic") {
      if (!body.apiKey) {
        return HttpResponse.json({ error: { code: "BAD_REQUEST", message: "API key required" } }, { status: 400 });
      }
      return HttpResponse.json({ success: true });
    }

    if (!body.awsAccessKeyId || !body.awsSecretAccessKey || !body.awsRegion) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "AWS credentials required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/setup/slack/verify", async ({ request }) => {
    const body = (await request.json()) as { botToken?: string; appToken?: string };
    if (!body.botToken || !body.appToken) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "Bot token and app token required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ success: true, workspaceName: "Test Workspace" });
  }),

  http.post("/api/setup/complete", async () => {
    return HttpResponse.json({ success: true });
  }),

  http.delete("/api/channels/slack", () => {
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/channels/slack", () => {
    return HttpResponse.json({ channels: [] });
  }),

  http.get("/api/channels/whatsapp/groups", () => {
    return HttpResponse.json({ groups: [] });
  }),

  http.delete("/api/channels/whatsapp/pair", () => {
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/channels/status", () => {
    return HttpResponse.json({
      channels: [
        { platform: "slack", configured: false, connected: null, phoneNumber: null, fromAddress: null },
        { platform: "whatsapp", configured: false, connected: null, phoneNumber: null, fromAddress: null },
        { platform: "email", configured: false, connected: null, phoneNumber: null, fromAddress: null },
      ],
    });
  }),

  http.get("/api/users", () => {
    return HttpResponse.json({
      users: [
        {
          id: "u1",
          name: "Alice Smith",
          email: null,
          email_verified_at: null,
          auth_role: "member",
          slack_user_id: "U001",
          whatsapp_number: null,
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "u2",
          name: "Bob Jones",
          email: null,
          email_verified_at: null,
          auth_role: "admin",
          slack_user_id: null,
          whatsapp_number: "+919876543210",
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
  }),

  http.post("/api/users", async ({ request }) => {
    const body = (await request.json()) as { name?: string; email?: string; whatsappNumber?: string };
    if (!body.name || (!body.email && !body.whatsappNumber)) {
      return HttpResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Name and either email or WhatsApp number required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json(
      {
        user: {
          id: "u-new",
          name: body.name,
          email: body.email ?? null,
          email_verified_at: null,
          auth_role: "member",
          slack_user_id: null,
          whatsapp_number: body.whatsappNumber ?? null,
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  http.patch("/api/users/:id", async ({ request }) => {
    const body = (await request.json()) as { name?: string; email?: string | null; whatsappNumber?: string | null };
    return HttpResponse.json({
      user: {
        id: "u1",
        name: body.name ?? "Alice Smith",
        email: body.email ?? null,
        email_verified_at: null,
        auth_role: "member",
        slack_user_id: "U001",
        whatsapp_number: body.whatsappNumber ?? null,
        description: null,
        type: "human",
        role: null,
        reports_to: null,
        allowed_tools: null,
        slack_channel_ids: [],
        whatsapp_group_jids: [],
        is_whatsapp_fallback: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    });
  }),

  http.delete("/api/users/:id", () => {
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/entities/resets/jobs", () => {
    return HttpResponse.json({ active: false, currentJob: null, latestJob: null, blockedBy: null });
  }),

  http.get("/api/entities/reenrichments/jobs", () => {
    return HttpResponse.json({ active: false, currentJob: null, latestJob: null, blockedBy: null });
  }),

  http.get("/api/entities/rebuilds/jobs", () => {
    return HttpResponse.json({ active: false, currentJob: null, latestJob: null, blockedBy: null });
  }),

  http.get("/api/entities/:id/bindings", () => {
    return HttpResponse.json({ bindings: [] });
  }),

  http.post("/api/entities/:id/bindings", () => {
    return HttpResponse.json({ binding: null });
  }),

  http.delete("/api/entities/:id/bindings/:bindingId", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.post("/api/entities/:id/group", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.delete("/api/entities/:id/group/:childId", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.get("/api/entities/:id/members", () => {
    return HttpResponse.json({ members: [], truncated: false });
  }),

  http.put("/api/entities/:id/members/:fileId", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.delete("/api/entities/:id/members/:fileId", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.get("/api/entities/merges", () => {
    return HttpResponse.json({ merges: [] });
  }),

  http.post("/api/entities/merges", () => {
    return HttpResponse.json({ mergeId: "merge-1" });
  }),

  http.delete("/api/entities/merges/:mergeId", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.delete("/api/entities/:id", () => {
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/entities/:id/merge-preview", () => {
    return HttpResponse.json({
      survivorId: "s",
      loserId: "l",
      counts: {
        sourceRefs: 0,
        mentions: 0,
        relationships: 0,
        contactPoints: 0,
        shareEmails: 0,
        aliasRejections: 0,
        domains: 0,
        candidates: 0,
        reviewQueue: 0,
      },
      collisions: { mentions: 0, contactPoints: 0, shareEmails: 0, aliasRejections: 0, domains: 0, relationships: 0 },
      selfLoopsDropped: 0,
    });
  }),

  http.get("/api/projects", () => {
    return HttpResponse.json({ projects: [] });
  }),

  http.get("/api/projects/bindable-containers", () => {
    return HttpResponse.json({ containers: [] });
  }),

  http.get("/api/settings/identity", () => {
    return HttpResponse.json({ orgName: null, botName: "Sketch", orgContext: null });
  }),

  http.get("/api/entity-review", () => {
    return HttpResponse.json({ rows: [], total: 0 });
  }),

  http.get("/api/auth/session", () => {
    return HttpResponse.json({ authenticated: false });
  }),

  http.post("/api/auth/login", async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "Email and password required" } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ authenticated: true, email: body.email });
  }),
];

export const server = setupServer(...handlers);

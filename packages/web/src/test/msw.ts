import type { AutomationEditLockView } from "@/lib/api";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/**
 * Whole-automation edit lock fixtures for the lock routes (the backend lane
 * implements them later). State is per task id and simulates one "current
 * viewer", so `isHeldByMe` is derived consistently. Tests that rely on these
 * fixtures must call `resetAutomationLockFixtures()` (typically in
 * `beforeEach`) because the state is module-level and survives
 * `server.resetHandlers()`.
 */
interface MockAutomationLockState {
  heldByUserId: string | null;
  heldByName: string | null;
  heldByPlatform: "slack" | "web" | "whatsapp" | null;
  heldBySurface: "builder" | "admin" | null;
  expiresAt: string | null;
  stealPending: { requesterName: string; expiresAt: string } | null;
}

const AUTOMATION_LOCK_FIXTURE_VIEWER_ID = "u-current";
const AUTOMATION_LOCK_FIXTURE_VIEWER_NAME = "Test Viewer";
const AUTOMATION_LOCK_FIXTURE_TTL_MS = 15 * 60 * 1000;
const AUTOMATION_LOCK_FIXTURE_STEAL_TTL_MS = 5 * 60 * 1000;

const automationLockFixtureState = new Map<string, MockAutomationLockState>();

function emptyAutomationLockFixture(): MockAutomationLockState {
  return {
    heldByUserId: null,
    heldByName: null,
    heldByPlatform: null,
    heldBySurface: null,
    expiresAt: null,
    stealPending: null,
  };
}

function automationLockFixtureView(taskId: string): AutomationEditLockView {
  const state = automationLockFixtureState.get(taskId) ?? emptyAutomationLockFixture();
  return { ...state, isHeldByMe: state.heldByUserId === AUTOMATION_LOCK_FIXTURE_VIEWER_ID };
}

function automationLockFixtureError(code: string, taskId: string, message: string) {
  return HttpResponse.json({ error: { code, message, lock: automationLockFixtureView(taskId) } }, { status: 409 });
}

export function resetAutomationLockFixtures() {
  automationLockFixtureState.clear();
}

export function seedAutomationLockFixture(taskId: string, state: Partial<MockAutomationLockState>) {
  automationLockFixtureState.set(taskId, { ...emptyAutomationLockFixture(), ...state });
}

/**
 * Admin-tab list fixture: installs a handler for GET /api/scheduled-tasks
 * returning the given task payloads (e.g. foreign-owned tasks an admin sees
 * through the backend list-all path). Overrides the default handler for the
 * duration of the test.
 */
export function seedAdminScheduledTaskListFixture(tasks: unknown[]) {
  server.use(http.get("/api/scheduled-tasks", () => HttpResponse.json({ tasks })));
}

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
      whatsappConnected: false,
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

  http.get("/api/channels/whatsapp/groups/:jid/member-labels", () => {
    return HttpResponse.json({ labels: [] });
  }),

  http.put("/api/channels/whatsapp/groups/:jid/member-labels", async ({ request }) => {
    const body = (await request.json()) as {
      labels?: Array<{ id?: string; phoneE164?: string; displayName: string; companyName?: string | null }>;
    };
    return HttpResponse.json({
      labels: (body.labels ?? []).map((label, index) => ({
        id: label.id ?? `label-${index}`,
        maskedPhone: label.phoneE164 ? `**${label.phoneE164.replace(/\D/gu, "").slice(-2)}` : "**67",
        displayName: label.displayName,
        companyName: label.companyName ?? null,
      })),
    });
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

  http.get("/api/connectors/credential-source", () => {
    return HttpResponse.json({
      mode: "local",
      canvasConfigured: false,
      canvasCredentialImportConfigured: false,
      publicKeyId: null,
    });
  }),

  http.get("/api/connectors/canvas/suggestions", () => {
    return HttpResponse.json({ suggestion: null });
  }),

  http.get("/api/mcp-servers", () => {
    return HttpResponse.json({ servers: [] });
  }),

  http.get("/api/mcp-servers/:providerId/connections", () => {
    return HttpResponse.json({ connections: [] });
  }),

  http.get("/api/users", () => {
    return HttpResponse.json({
      users: [
        {
          id: "u1",
          name: "Alice Smith",
          email: "alice@example.com",
          email_verified_at: "2026-01-01T00:00:00Z",
          auth_role: "member",
          slack_user_id: "U001",
          whatsapp_number: "+14155550101",
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
          email: "bob@example.com",
          email_verified_at: "2026-01-02T00:00:00Z",
          auth_role: "admin",
          slack_user_id: null,
          whatsapp_number: "+14155550102",
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
        {
          id: "u3",
          name: "Carol Davis",
          email: "carol@example.com",
          email_verified_at: "2026-01-03T00:00:00Z",
          auth_role: "member",
          slack_user_id: null,
          whatsapp_number: "+14155550103",
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: "2026-01-03T00:00:00Z",
        },
        {
          id: "u4",
          name: "Dave Evans",
          email: "dave@example.com",
          email_verified_at: "2026-01-04T00:00:00Z",
          auth_role: "member",
          slack_user_id: null,
          whatsapp_number: "+14155550104",
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: "2026-01-04T00:00:00Z",
        },
      ],
    });
  }),

  http.post("/api/users", async ({ request }) => {
    const body = (await request.json()) as { name?: string; email?: string; whatsappNumber?: string };
    if (!body.name || !body.email || !body.whatsappNumber) {
      return HttpResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Name, email, and WhatsApp number required" } },
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

  http.get("/api/entities/:id/tasks", () => {
    return HttpResponse.json({ tasks: [] });
  }),

  http.patch("/api/entities/:id/tasks/:taskId", async ({ params, request }) => {
    const body = (await request.json()) as { status?: string };
    return HttpResponse.json({
      task: {
        id: params.taskId,
        parentEntityId: params.id,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: "Updated task",
        status: body.status ?? "open",
        statusRaw: body.status ?? "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        proposedAssigneeName: null,
        priority: null,
        dueAt: null,
        provenance: "summary",
        sourceTaskId: String(params.taskId),
        createdByUserId: "u1",
        createdByUserName: "Alice Smith",
        createdByUserEmail: "alice@example.com",
        isOwnedByViewer: true,
        readonlyReason: null,
        completedAt: body.status === "done" ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
        canEditStatus: true,
      },
    });
  }),

  http.get("/api/tasks/:taskId", ({ params }) => {
    const taskId = String(params.taskId);
    return HttpResponse.json({
      task: {
        id: taskId,
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: "Linked Brief task",
        status: "open",
        statusRaw: "open",
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        proposedAssigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: taskId,
        createdByUserId: "user-1",
        createdByUserName: "Test User",
        createdByUserEmail: "user@example.com",
        isOwnedByViewer: true,
        readonlyReason: null,
        completedAt: null,
        updatedAt: "2026-07-17T10:00:00.000Z",
        canEditStatus: true,
      },
    });
  }),

  http.patch("/api/tasks/:taskId", async ({ params, request }) => {
    const taskId = String(params.taskId);
    const body = (await request.json()) as { status: string };
    return HttpResponse.json({
      task: {
        id: taskId,
        parentEntityId: null,
        parentSourceRef: null,
        parentName: null,
        source: "summary",
        externalRef: null,
        title: "Linked Brief task",
        status: body.status,
        statusRaw: body.status,
        statusAuthority: "local",
        assigneeEntityId: null,
        assigneeName: null,
        proposedAssigneeName: null,
        priority: "medium",
        dueAt: null,
        provenance: "summary",
        sourceTaskId: taskId,
        createdByUserId: "user-1",
        createdByUserName: "Test User",
        createdByUserEmail: "user@example.com",
        isOwnedByViewer: true,
        readonlyReason: null,
        completedAt: body.status === "done" ? "2026-07-17T10:00:00.000Z" : null,
        updatedAt: "2026-07-17T10:00:00.000Z",
        canEditStatus: true,
      },
    });
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

  http.get("/api/web-chat/conversations", () => {
    return HttpResponse.json({ conversations: [] });
  }),

  http.get("/api/scheduled-tasks/:id/shares", () => {
    return HttpResponse.json({ shares: [] });
  }),

  http.put("/api/scheduled-tasks/:id/shares/:userId", () => {
    return HttpResponse.json({ success: true });
  }),

  http.delete("/api/scheduled-tasks/:id/shares/:userId", () => {
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/scheduled-tasks/:id", ({ params }) => {
    const taskId = String(params.id);
    return HttpResponse.json({
      automation: {
        id: taskId,
        platform: "slack",
        contextType: "channel",
        deliveryTarget: "C123",
        threadTs: null,
        prompt: "Post the Monday revenue summary",
        executionMode: "hybrid",
        executionModeRecommendation: {
          mode: "deterministic",
          reason: "Best when the workflow is fixed and should run the same way every time.",
        },
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "Asia/Kolkata",
        sessionMode: "fresh",
        nextRunAt: "2026-03-20T03:30:00.000Z",
        lastRunAt: "2026-03-13T03:30:00.000Z",
        status: "active",
        isPlaceholderDraft: false,
        createdBy: "u1",
        createdByName: "Alice Smith",
        createdAt: "2026-03-10T09:15:00.000Z",
        updatedAt: "2026-03-13T03:30:00.000Z",
        revision: 1,
        lastEditedBy: "u1",
        lastEditedByName: "Alice Smith",
        title: "Monday revenue summary",
        description: null,
        originChat: null,
        delivery: {
          platform: "slack",
          targetType: "channel",
          targetId: "C123",
          threadTs: null,
          mode: "deliver",
          label: "#ops",
        },
        steps: [],
        edges: [],
        stepContent: {},
        latestRun: null,
        recentRuns: [],
        shares: [],
        canShare: true,
        canEdit: true,
        isOwner: true,
        lock: automationLockFixtureView(taskId),
      },
    });
  }),

  http.get("/api/scheduled-tasks/:taskId/conversations/:conversationId/messages", () => {
    return HttpResponse.json({
      messages: [
        {
          id: "fixture-message-1",
          role: "user",
          parts: [{ type: "text", text: "Build the weekly digest" }],
          createdAt: "2026-06-02T09:00:00.000Z",
        },
        {
          id: "fixture-message-2",
          role: "assistant",
          parts: [{ type: "text", text: "Done — it runs Mondays at 9." }],
          createdAt: "2026-06-02T09:00:05.000Z",
        },
      ],
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
  }),

  http.post("/api/scheduled-tasks/:id/lock", ({ params }) => {
    const taskId = String(params.id);
    const current = automationLockFixtureState.get(taskId) ?? emptyAutomationLockFixture();
    if (current.heldByUserId && current.heldByUserId !== AUTOMATION_LOCK_FIXTURE_VIEWER_ID) {
      return automationLockFixtureError("LOCKED", taskId, "This automation is being edited by another user.");
    }
    const lock: MockAutomationLockState = {
      heldByUserId: AUTOMATION_LOCK_FIXTURE_VIEWER_ID,
      heldByName: AUTOMATION_LOCK_FIXTURE_VIEWER_NAME,
      heldByPlatform: "web",
      heldBySurface: "builder",
      expiresAt: new Date(Date.now() + AUTOMATION_LOCK_FIXTURE_TTL_MS).toISOString(),
      stealPending: current.stealPending,
    };
    automationLockFixtureState.set(taskId, lock);
    return HttpResponse.json({ lock: { ...lock, isHeldByMe: true } });
  }),

  http.delete("/api/scheduled-tasks/:id/lock", ({ params }) => {
    const taskId = String(params.id);
    const current = automationLockFixtureState.get(taskId) ?? emptyAutomationLockFixture();
    if (current.heldByUserId === AUTOMATION_LOCK_FIXTURE_VIEWER_ID) {
      automationLockFixtureState.set(taskId, emptyAutomationLockFixture());
    }
    return HttpResponse.json({ success: true });
  }),

  http.post("/api/scheduled-tasks/:id/lock/steal", ({ params }) => {
    const taskId = String(params.id);
    const current = automationLockFixtureState.get(taskId) ?? emptyAutomationLockFixture();
    if (!current.heldByUserId) {
      return automationLockFixtureError("NOT_LOCKED", taskId, "No one is currently editing this automation.");
    }
    if (current.heldByUserId === AUTOMATION_LOCK_FIXTURE_VIEWER_ID) {
      return automationLockFixtureError("LOCKED", taskId, "You already hold the editing lock.");
    }
    const stealPending = {
      requesterName: AUTOMATION_LOCK_FIXTURE_VIEWER_NAME,
      expiresAt: new Date(Date.now() + AUTOMATION_LOCK_FIXTURE_STEAL_TTL_MS).toISOString(),
    };
    automationLockFixtureState.set(taskId, { ...current, stealPending });
    return HttpResponse.json({ status: "pending" });
  }),

  http.post("/api/scheduled-tasks/:id/lock/steal/response", async ({ params, request }) => {
    const taskId = String(params.id);
    const body = (await request.json()) as { approve?: boolean };
    const current = automationLockFixtureState.get(taskId) ?? emptyAutomationLockFixture();
    if (current.heldByUserId !== AUTOMATION_LOCK_FIXTURE_VIEWER_ID) {
      return HttpResponse.json(
        { error: { code: "FORBIDDEN", message: "Only the current editor can respond to a takeover request." } },
        { status: 403 },
      );
    }
    if (!current.stealPending) {
      return automationLockFixtureError("NOT_PENDING", taskId, "No takeover request is pending.");
    }
    if (body.approve) {
      automationLockFixtureState.set(taskId, {
        heldByUserId: "u-requester",
        heldByName: current.stealPending.requesterName,
        heldByPlatform: "web",
        heldBySurface: "builder",
        expiresAt: new Date(Date.now() + AUTOMATION_LOCK_FIXTURE_TTL_MS).toISOString(),
        stealPending: null,
      });
    } else {
      automationLockFixtureState.set(taskId, { ...current, stealPending: null });
    }
    return HttpResponse.json({ success: true });
  }),

  http.get("/api/scheduled-tasks", () => {
    return HttpResponse.json({
      tasks: [
        {
          id: "task-1",
          platform: "slack",
          contextType: "channel",
          deliveryTarget: "C123",
          threadTs: null,
          prompt: "Post the Monday revenue summary",
          scheduleType: "cron",
          scheduleValue: "0 9 * * 1",
          timezone: "Asia/Kolkata",
          sessionMode: "fresh",
          nextRunAt: "2026-03-20T03:30:00.000Z",
          lastRunAt: "2026-03-13T03:30:00.000Z",
          status: "active",
          createdBy: "u1",
          createdAt: "2026-03-10T09:15:00.000Z",
          targetLabel: "#ops",
          targetKindLabel: "Slack channel",
          creatorName: "Alice Smith",
          scheduleLabel: "Cron: 0 9 * * 1 (Asia/Kolkata)",
          canPause: true,
          canResume: false,
          canDelete: true,
          title: null,
          description: null,
          originChat: null,
          steps: null,
          stepCount: 0,
          triggerConfig: null,
          outputTarget: null,
          outputPlatform: null,
          outputThreadTs: null,
          outputMode: "deliver",
          delivery: {
            platform: "slack",
            targetType: "channel",
            targetId: "C123",
            threadTs: null,
            mode: "deliver",
            label: "#ops",
          },
          lastRunStatus: null,
          runCount: 0,
          shareCount: 0,
          sharedWithMe: false,
          canShare: true,
          canEdit: true,
          isOwner: true,
        },
      ],
    });
  }),

  http.post("/api/scheduled-tasks/:taskId/runs", ({ params }) => {
    return HttpResponse.json({ status: "triggered", runId: `run-${String(params.taskId)}` }, { status: 202 });
  }),

  http.get("/api/scheduled-tasks/:taskId/runs/:runId", ({ params }) => {
    const taskId = String(params.taskId);
    const runId = String(params.runId);
    return HttpResponse.json({
      run: {
        id: runId,
        task_id: taskId,
        trigger_data: JSON.stringify({ type: "manual" }),
        status: "completed",
        step_outputs: JSON.stringify({}),
        error_message: null,
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:00:01.000Z",
      },
    });
  }),

  http.get("/api/scheduled-tasks/:taskId/runs", () => {
    return HttpResponse.json({ runs: [] });
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

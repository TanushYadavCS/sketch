import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import * as automationRunsModule from "../db/repositories/automation-runs";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";
import { scheduledTaskRoutes } from "./scheduled-tasks";

const config = createTestConfig();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();
  await settings.create();
  const admin = await users.create({
    name: normalizedEmail.split("@")[0],
    email: normalizedEmail,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin;
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function getMemberCookie(db: Kysely<DB>, userId: string): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  const token = await signJwt(userId, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

function makeBuilderSaveRequest(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  const request: AutomationBuilderSaveRequest = {
    expectedRevision: 0,
    title: "Daily account brief",
    description: "Summarize account activity every two minutes.",
    prompt: "Summarize account activity.",
    scheduleType: "interval",
    scheduleValue: "120",
    timezone: "UTC",
    status: "active",
    delivery: {
      platform: "slack",
      targetType: "dm",
      targetId: "D123",
      threadTs: null,
      mode: "deliver",
    },
    steps: [
      {
        id: "trigger-1",
        type: "trigger",
        label: "Every two minutes",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: {
          type: "schedule",
          scheduleType: "interval",
          scheduleValue: "120",
          timezone: "UTC",
        },
      },
      {
        id: "agent-1",
        type: "agent",
        label: "Summarize",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
        agentMode: "sketch",
      },
    ],
    edges: [{ id: "trigger-1-agent-1", from: "trigger-1", to: "agent-1" }],
    stepContent: {
      "agent-1": {
        taskId: "task-builder",
        stepId: "agent-1",
        contentType: "prompt",
        content: "Check account activity and summarize changes.",
        apps: ["clickup"],
      },
    },
  };

  return { ...request, ...overrides };
}

describe("Scheduled Tasks API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("returns all tasks for admins with resolved labels", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const groups = createWhatsAppGroupRepository(db);

    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });
    const recipient = await users.create({
      name: "Recipient Person",
      email: "recipient@test.com",
      slackUserId: "URECIPIENT",
    });

    await db
      .insertInto("channels")
      .values({
        id: "channel-1",
        slack_channel_id: "C123",
        name: "ops",
        type: "public_channel",
      })
      .execute();

    await groups.upsert({
      jid: "999@g.us",
      name: "Leads Group",
      description: "Daily leads",
      updated_at: "2026-03-13T12:00:00.000Z",
    });

    await tasks.add({
      id: "task-channel",
      platform: "slack",
      context_type: "channel",
      delivery_target: "C123",
      thread_ts: null,
      prompt: "Post the ops summary",
      schedule_type: "cron",
      schedule_value: "0 9 * * 1",
      timezone: "Asia/Kolkata",
      session_mode: "fresh",
      created_by: member.id,
      status: "active",
      next_run_at: null,
      output_target: recipient.slack_user_id,
      origin_platform: "web",
      origin_conversation_id: "chat-alpha",
      origin_provider_thread_id: null,
    });
    await tasks.add({
      id: "task-group",
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "999@g.us",
      thread_ts: null,
      prompt: "Share a WhatsApp update",
      schedule_type: "interval",
      schedule_value: "7200",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "paused",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    const labels = body.tasks.map((task: { targetLabel: string }) => task.targetLabel);
    expect(labels).toContain("#ops");
    expect(labels).toContain("Leads Group");

    const slackTask = body.tasks.find((task: { id: string }) => task.id === "task-channel");
    const whatsappTask = body.tasks.find((task: { id: string }) => task.id === "task-group");
    expect(slackTask.creatorName).toBe("Alice Member");
    expect(slackTask.targetKindLabel).toBe("Slack channel");
    expect(slackTask.delivery.label).toBe("Recipient Person");
    expect(slackTask.originChat).toEqual({
      platform: "web",
      conversationId: "chat-alpha",
      providerThreadId: null,
      currentMessageId: null,
    });
    expect(whatsappTask.targetKindLabel).toBe("WhatsApp group");
    expect(whatsappTask.canResume).toBe(true);
    expect(whatsappTask.originChat).toBeNull();

    const detail = await app.request("/api/scheduled-tasks/task-channel", { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      automation: {
        id: "task-channel",
        originChat: {
          platform: "web",
          conversationId: "chat-alpha",
          providerThreadId: null,
          currentMessageId: null,
        },
      },
    });
  });

  it("returns the persisted Slack origin chat transcript for accessible automations", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const conversations = createConversationRepository(db);
    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });
    const conversation = await conversations.getOrCreate(
      { platform: "slack", kind: "channel", providerConversationId: "C123" },
      "design-wins",
    );
    const originMessage = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "1700.1",
      senderName: "Alice",
      text: "Create a Trustpilot wins automation",
      providerThreadId: "1700.1",
      receivedAt: "2026-06-01T00:00:00.000Z",
    });
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "1700.2",
      senderName: "Sketch",
      isBot: true,
      text: "All set - here's the draft.",
      providerThreadId: "1700.1",
      receivedAt: "2026-06-01T00:00:02.000Z",
    });
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "1700.3",
      senderName: "Bob",
      text: "Unrelated top-level note",
      providerThreadId: "1700.3",
    });
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "1700.4",
      senderName: "Alice",
      text: "Later note after creation",
      providerThreadId: "1700.1",
    });

    await tasks.add({
      id: "task-origin",
      platform: "slack",
      context_type: "channel",
      delivery_target: "C123",
      thread_ts: "1700.1",
      prompt: "Post design wins",
      schedule_type: "cron",
      schedule_value: "0 9 * * 1",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "active",
      next_run_at: null,
      origin_platform: "slack",
      origin_conversation_id: String(conversation.id),
      origin_provider_thread_id: "1700.1",
      origin_message_id: originMessage.row.id,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-origin/origin-chat/messages", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      messages: [
        {
          id: "1",
          role: "user",
          senderName: "Alice",
          text: "Alice: Create a Trustpilot wins automation",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns Canvas-managed trigger metadata for external workflows", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });

    await tasks.add({
      id: "task-canvas",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Handle ClickUp issues",
      schedule_type: "external",
      schedule_value: "canvas",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "active",
      next_run_at: null,
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "ClickUp issue created",
          icon: "clickup",
          position: { x: 0, y: 0 },
          triggerConfig: {
            type: "canvas",
            app: "ClickUp",
            eventDescription: "new issue created",
            componentKey: "clickup.issue.created",
            status: "pending_canvas_setup",
          },
        },
        {
          id: "agent1",
          type: "agent",
          label: "Handle issue",
          icon: "sketch-ai",
          position: { x: 0, y: 100 },
        },
      ]),
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks[0]).toEqual(
      expect.objectContaining({
        id: "task-canvas",
        scheduleType: "external",
        scheduleValue: "canvas",
        scheduleLabel: "Canvas managed: ClickUp - new issue created",
        nextRunAt: null,
        triggerConfig: expect.objectContaining({
          type: "canvas",
          status: "pending_canvas_setup",
          componentKey: "clickup.issue.created",
        }),
      }),
    );
  });

  it("returns schedule trigger metadata from canonical schedule columns", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });

    await tasks.add({
      id: "task-stale-trigger",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Check inbox",
      schedule_type: "cron",
      schedule_value: "*/10 * * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "active",
      next_run_at: null,
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "Every 5 minutes",
          icon: "clock",
          position: { x: 0, y: 0 },
          triggerConfig: {
            type: "schedule",
            scheduleType: "cron",
            scheduleValue: "*/5 * * * *",
            timezone: "UTC",
          },
        },
        {
          id: "agent1",
          type: "agent",
          label: "Check inbox",
          icon: "sketch-ai",
          position: { x: 0, y: 100 },
        },
      ]),
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    const task = body.tasks[0];
    const steps = JSON.parse(task.steps);
    expect(task.scheduleValue).toBe("*/10 * * * *");
    expect(task.triggerConfig).toEqual(
      expect.objectContaining({
        type: "schedule",
        scheduleType: "cron",
        scheduleValue: "*/10 * * * *",
        timezone: "UTC",
      }),
    );
    expect(steps[0].label).toBe("Every 10 minutes");
    expect(steps[0].triggerConfig.scheduleValue).toBe("*/10 * * * *");
  });

  it("members see only their own tasks; admins see all", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);

    const alice = await users.create({ name: "Alice", email: "alice@test.com" });
    const bob = await users.create({ name: "Bob", email: "bob@test.com" });

    await tasks.add({
      id: "task-alice",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Alice task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });
    await tasks.add({
      id: "task-bob",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "bob@s.whatsapp.net",
      thread_ts: null,
      prompt: "Bob task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: bob.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });

    const aliceCookie = await getMemberCookie(db, alice.id);
    const aliceRes = await app.request("/api/scheduled-tasks", { headers: { Cookie: aliceCookie } });
    expect(aliceRes.status).toBe(200);
    const aliceBody = await aliceRes.json();
    expect(aliceBody.tasks.map((t: { id: string }) => t.id)).toEqual(["task-alice"]);

    const adminCookie = await loginAdmin(app);
    const adminRes = await app.request("/api/scheduled-tasks", { headers: { Cookie: adminCookie } });
    const adminBody = await adminRes.json();
    expect(adminBody.tasks.map((t: { id: string }) => t.id).sort()).toEqual(["task-alice", "task-bob"]);
  });

  it("falls back to raw delivery targets when metadata is missing", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-missing-group",
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "unknown@g.us",
      thread_ts: null,
      prompt: "Missing metadata",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks[0].targetLabel).toBe("unknown@g.us");
  });

  it("returns the updated task after pause and resume", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-1",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Check in",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "paused");
      }),
      resumeTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "active");
      }),
      removeTask: vi.fn(async () => true),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const pauseRes = await app.request("/api/scheduled-tasks/task-1/pause", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json()).task.status).toBe("paused");

    const resumeRes = await app.request("/api/scheduled-tasks/task-1/resume", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).task.status).toBe("active");
  });

  it("members cannot access other users' tasks via any route", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });
    const bob = await users.create({ name: "Bob", email: "bob@test.com" });

    await tasks.add({
      id: "task-bob",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "bob@s.whatsapp.net",
      thread_ts: null,
      prompt: "Bob's task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: bob.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await getMemberCookie(db, alice.id);

    const routes = [
      { method: "POST", path: "/api/scheduled-tasks/task-bob/pause" },
      { method: "POST", path: "/api/scheduled-tasks/task-bob/resume" },
      { method: "DELETE", path: "/api/scheduled-tasks/task-bob" },
      { method: "POST", path: "/api/scheduled-tasks/task-bob/run" },
      { method: "GET", path: "/api/scheduled-tasks/task-bob/runs" },
      { method: "GET", path: "/api/scheduled-tasks/task-bob/runs/some-run-id" },
      { method: "GET", path: "/api/scheduled-tasks/task-bob/step-content" },
    ];
    for (const { method, path } of routes) {
      const res = await app.request(path, { method, headers: { Cookie: cookie } });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // None of the scheduler mutation deps should have been invoked.
    expect(scheduler.pauseTask).not.toHaveBeenCalled();
    expect(scheduler.resumeTask).not.toHaveBeenCalled();
    expect(scheduler.removeTask).not.toHaveBeenCalled();
    expect(scheduler.executeTaskById).not.toHaveBeenCalled();
  });

  it("admins can access any task via any route", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const bob = await users.create({ name: "Bob", email: "bob@test.com" });

    await tasks.add({
      id: "task-bob",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "bob@s.whatsapp.net",
      thread_ts: null,
      prompt: "Bob's task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: bob.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "paused");
      }),
      resumeTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "active");
      }),
      removeTask: vi.fn(async () => true),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const runsRes = await app.request("/api/scheduled-tasks/task-bob/runs", { headers: { Cookie: cookie } });
    expect(runsRes.status).toBe(200);

    const stepRes = await app.request("/api/scheduled-tasks/task-bob/step-content", { headers: { Cookie: cookie } });
    expect(stepRes.status).toBe(200);

    const pauseRes = await app.request("/api/scheduled-tasks/task-bob/pause", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(pauseRes.status).toBe(200);
  });

  it("fails closed when an admin context has no user in this tenant", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const owner = await users.create({ name: "Owner", email: "owner@test.com" });

    await tasks.add({
      id: "task-owner",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "owner@s.whatsapp.net",
      thread_ts: null,
      prompt: "Owner task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: owner.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("role", "admin");
      c.set("sub", "admin-from-another-tenant");
      await next();
    });
    app.route("/api/scheduled-tasks", scheduledTaskRoutes(db, scheduler));

    const res = await app.request("/api/scheduled-tasks/task-owner");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Scheduled task not found" },
    });
  });

  it("resolves sub via email for local JWT issued with email subject", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-alice",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Alice task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    // Email-as-sub (legacy local JWT path)
    const cookie = await getMemberCookie(db, "alice@test.com");

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(["task-alice"]);
  });

  it("members get 404 when sub does not resolve to any user row", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-alice",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Alice task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });

    // UUID-shaped sub, but no such user row (simulates a deleted user holding an old JWT)
    const ghostCookie = await getMemberCookie(db, "00000000-0000-0000-0000-000000000000");
    const ghostList = await app.request("/api/scheduled-tasks", { headers: { Cookie: ghostCookie } });
    expect(ghostList.status).toBe(401);

    const ghostDetail = await app.request("/api/scheduled-tasks/task-alice/runs", { headers: { Cookie: ghostCookie } });
    expect(ghostDetail.status).toBe(401);

    // Email-shaped sub but no row
    const ghostEmailCookie = await getMemberCookie(db, "nobody@test.com");
    const ghostEmailDetail = await app.request("/api/scheduled-tasks/task-alice/runs", {
      headers: { Cookie: ghostEmailCookie },
    });
    expect(ghostEmailDetail.status).toBe(401);
  });

  it("list endpoint calls getRunSummaries exactly once regardless of row count", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    for (let i = 0; i < 5; i++) {
      await tasks.add({
        id: `task-${i}`,
        platform: "whatsapp",
        context_type: "dm",
        delivery_target: "alice@s.whatsapp.net",
        thread_ts: null,
        prompt: `Task ${i}`,
        schedule_type: "interval",
        schedule_value: "3600",
        timezone: "UTC",
        session_mode: "fresh",
        created_by: alice.id,
        status: "active",
        next_run_at: null,
      });
    }

    const originalFactory = automationRunsModule.createAutomationRunsRepository;
    const summariesSpy = vi.fn(originalFactory(db).getRunSummaries);
    const factorySpy = vi
      .spyOn(automationRunsModule, "createAutomationRunsRepository")
      .mockImplementation((arg: Kysely<DB>) => {
        const repo = originalFactory(arg);
        return { ...repo, getRunSummaries: summariesSpy };
      });

    try {
      const app = createApp(db, config, {
        scheduler: {
          pauseTask: vi.fn(),
          resumeTask: vi.fn(),
          removeTask: vi.fn(),
          executeTaskById: vi.fn(),
        },
      });
      const cookie = await loginAdmin(app);

      const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(5);
      expect(summariesSpy).toHaveBeenCalledTimes(1);
    } finally {
      factorySpy.mockRestore();
    }
  });

  it("saves builder definitions atomically and asks the scheduler to reschedule", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const stepContent = createAutomationStepContentRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice-builder@test.com" });

    await tasks.add({
      id: "task-builder",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Old prompt",
      schedule_type: "cron",
      schedule_value: "0 9 * * 1",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });
    await stepContent.upsert({
      taskId: "task-builder",
      stepId: "old-step",
      contentType: "prompt",
      content: "Stale prompt",
    });

    let refreshObserved:
      | {
          revision: number;
          title: string | null;
          content: Awaited<ReturnType<typeof stepContent.getByTask>>;
        }
      | undefined;
    const refreshTaskSchedule = vi.fn(async (taskId: string) => {
      const committedRow = await tasks.getById(taskId);
      refreshObserved = {
        revision: committedRow?.revision ?? -1,
        title: committedRow?.title ?? null,
        content: await stepContent.getByTask(taskId),
      };
      return null;
    });
    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
        refreshTaskSchedule,
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(makeBuilderSaveRequest()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.automation).toMatchObject({
      id: "task-builder",
      title: "Daily account brief",
      revision: 1,
      scheduleType: "interval",
      scheduleValue: "120",
    });
    expect(refreshTaskSchedule).toHaveBeenCalledWith("task-builder");
    expect(refreshObserved).toMatchObject({
      revision: 1,
      title: "Daily account brief",
      content: [{ step_id: "agent-1", content: "Check account activity and summarize changes." }],
    });

    const row = await tasks.getById("task-builder");
    expect(row).toMatchObject({
      prompt: "Summarize account activity.",
      schedule_type: "interval",
      schedule_value: "120",
      last_edited_by: admin.id,
      revision: 1,
    });
    expect(row?.steps).not.toContain("Check account activity");

    const contentRows = await stepContent.getByTask("task-builder");
    expect(contentRows).toHaveLength(1);
    expect(contentRows[0]).toMatchObject({
      step_id: "agent-1",
      content_type: "prompt",
      content: "Check account activity and summarize changes.",
    });
    expect(contentRows[0].apps).toBe(JSON.stringify(["clickup"]));
  });

  it("rejects stale builder saves without rescheduling", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice-conflict@test.com" });

    await tasks.add({
      id: "task-builder",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Old prompt",
      schedule_type: "interval",
      schedule_value: "120",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    await db.updateTable("scheduled_tasks").set({ revision: 3 }).where("id", "=", "task-builder").execute();

    const refreshTaskSchedule = vi.fn(async () => null);
    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
        refreshTaskSchedule,
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(makeBuilderSaveRequest({ expectedRevision: 0 })),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "REVISION_CONFLICT", currentRevision: 3 },
    });
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
    await expect(tasks.getById("task-builder")).resolves.toMatchObject({ prompt: "Old prompt", revision: 3 });
  });

  it("rejects action steps when no broker-capable integration provider is configured", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice-action@test.com" });
    const baseRequest = makeBuilderSaveRequest();

    await tasks.add({
      id: "task-builder",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Old prompt",
      schedule_type: "interval",
      schedule_value: "120",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const actionRequest = makeBuilderSaveRequest({
      steps: [
        ...baseRequest.steps,
        {
          id: "action-1",
          type: "action",
          label: "Post update",
          icon: "bolt",
          position: { x: 520, y: 0 },
        },
      ],
      edges: [
        { id: "trigger-1-agent-1", from: "trigger-1", to: "agent-1" },
        { id: "agent-1-action-1", from: "agent-1", to: "action-1" },
      ],
      stepContent: {
        ...baseRequest.stepContent,
        "action-1": {
          taskId: "task-builder",
          stepId: "action-1",
          contentType: "script",
          content: "return input;",
          apps: ["slack"],
        },
      },
    });
    const refreshTaskSchedule = vi.fn(async () => null);
    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
        refreshTaskSchedule,
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(actionRequest),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "BROKER_REQUIRED" })]));
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
  });

  it("runs single builder steps through the scheduler", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice-step@test.com" });

    await tasks.add({
      id: "task-builder",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Run step",
      schedule_type: "interval",
      schedule_value: "120",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const executeStepById = vi.fn(async () => ({
      runId: "run-step",
      status: "completed" as const,
      stepOutputs: { "agent-1": { status: "completed" as const, output: "ok", duration_ms: 12 } },
      finalOutput: "ok",
    }));
    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
        executeStepById,
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-builder/steps/agent-1/runs", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { account: "Acme" }, useLatestUpstreamOutput: true }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ run: { runId: "run-step", status: "completed" } });
    expect(executeStepById).toHaveBeenCalledWith("task-builder", "agent-1", {
      input: { account: "Acme" },
      useLatestUpstreamOutput: true,
    });
  });

  it("deletes tasks successfully", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-delete",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Delete me",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });
    await createAutomationRunsRepository(db).create({ taskId: "task-delete" });
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-delete",
      conversationId: "builder-delete",
      transcriptUserId: alice.id,
      kind: "builder",
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      removeTaskRuntime: vi.fn().mockResolvedValue(true),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-delete", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    await expect(tasks.getById("task-delete")).resolves.toBeUndefined();
    await expect(createAutomationRunsRepository(db).list("task-delete")).resolves.toEqual([]);
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskConversation("task-delete", "builder-delete"),
    ).resolves.toEqual([]);
    expect(scheduler.removeTaskRuntime).toHaveBeenCalledWith("task-delete");
  });

  it("surfaces runtime cleanup failure after committing API deletion", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });
    for (const id of ["task-delete-false", "task-delete-throw"]) {
      await tasks.add({
        id,
        platform: "whatsapp",
        context_type: "dm",
        delivery_target: "alice@s.whatsapp.net",
        thread_ts: null,
        prompt: "Delete me",
        schedule_type: "interval",
        schedule_value: "3600",
        timezone: "UTC",
        session_mode: "fresh",
        created_by: alice.id,
        status: "active",
        next_run_at: null,
      });
    }

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      removeTaskRuntime: vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("runtime unavailable")),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const falseResponse = await app.request("/api/scheduled-tasks/task-delete-false", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(falseResponse.status).toBe(503);
    await expect(falseResponse.json()).resolves.toMatchObject({
      error: { code: "SCHEDULER_INCONSISTENT" },
    });
    await expect(tasks.getById("task-delete-false")).resolves.toBeUndefined();

    const thrownResponse = await app.request("/api/scheduled-tasks/task-delete-throw", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(thrownResponse.status).toBe(503);
    await expect(thrownResponse.json()).resolves.toMatchObject({
      error: { code: "SCHEDULER_INCONSISTENT" },
    });
    await expect(tasks.getById("task-delete-throw")).resolves.toBeUndefined();
  });
});

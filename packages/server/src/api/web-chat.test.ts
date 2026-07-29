import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams } from "../agent/runner";
import { getSessionId, saveSessionId } from "../agent/sessions";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

function makeAgentResult(finalText = "Hello from Sketch", pendingUploads: string[] = []) {
  return {
    messageSent: true,
    sessionId: "sess-web-1",
    costUsd: 0.01,
    pendingUploads,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    stopReason: null,
    errorSubtype: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: null,
    isResumedSession: false,
    totalAttachments: 0,
    imageCount: 0,
    nonImageCount: 0,
    mimeTypes: [],
    fileSizes: [],
    promptMode: "text" as const,
    toolCalls: [],
    trace: { progressEvents: [], finalText, automationArtifacts: [] },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword("testpassword123");
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString(), orgName: "NullCode AI", botName: "Sketch" });
  const admin = await users.create({
    name: "Karan Hudia",
    email: "karan@example.com",
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
  return users.update(admin.id, { timezone: "Asia/Kolkata" });
}

async function login(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "karan@example.com", password: "testpassword123" }),
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

function webChatTranscriptPath(dataDir: string, userId: string, conversationId = "default") {
  return join(dataDir, "web-chat", userId, `${conversationId}.json`);
}

function webChatStreamChunks(text: string): Array<{ type?: string; data?: unknown }> {
  return text.split("\n\n").flatMap((chunk) => {
    const data = chunk.trim().replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as { type?: string; data?: unknown }];
  });
}

describe("web chat API", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-web-chat-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("runs the current user's agent from an AI SDK message payload", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } });
      return makeAgentResult("I can help with that.");
    });
    const buildMcpServers = vi.fn().mockResolvedValue({});
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "Can you summarize my workspace?" }],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const text = await res.text();
    expect(text).toContain('"messageMetadata":{"createdAt":"');
    expect(text).toContain('"type":"data-progress"');
    expect(text).toContain("Using tool");
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-progress")).toMatchObject({
      type: "data-progress",
      data: {
        lines: ["Using tool"],
        items: [
          {
            kind: "tool",
            label: "Using tool",
            icon: { type: "tool" },
          },
        ],
      },
    });
    expect(text).toContain('"type":"text-delta"');
    expect(text).toContain("I can help with that.");
    expect(buildMcpServers).toHaveBeenCalledWith("karan@example.com");

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.workspaceKey).toBe(admin.id);
    expect(call.currentUserId).toBe(admin.id);
    expect(call.sessionMode).toBe("chat");
    expect(call.persistSession).toBe(true);
    expect(call.platform).toBe("slack");
    expect(call.responseSurface).toBe("web");
    expect(call.contextType).toBe("dm");
    expect(call.userMessage).toContain("Karan Hudia");
    expect(call.userMessage).toContain("Can you summarize my workspace?");
    expect(call.taskContext).toBeUndefined();
  });

  it("streams assistant text deltas before the web chat agent run finishes", async () => {
    await seedAdmin(db);
    const deltaWritten = deferred<void>();
    const finishAgent = deferred<void>();
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onTextDelta?.("Hel");
      deltaWritten.resolve();
      await finishAgent.promise;
      return makeAgentResult("Hello");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-streaming", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Stream this response" }),
    });

    expect(res.status).toBe(200);
    await deltaWritten.promise;
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Expected streaming response body");
    const decoder = new TextDecoder();
    let partial = "";
    for (let index = 0; index < 8 && !partial.includes("Hel"); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      partial += decoder.decode(chunk.value, { stream: true });
    }

    expect(partial).toContain('"type":"text-delta"');
    expect(partial).toContain('"delta":"Hel"');
    expect(partial).not.toContain('"delta":"Hello"');

    finishAgent.resolve();
    let rest = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    rest += decoder.decode();
    const fullStream = partial + rest;
    expect(fullStream).toContain('"delta":"lo"');
    expect(fullStream).not.toContain('"delta":"Hello"');
    expect(fullStream).toContain("data: [DONE]");
  });

  it("closes an open streamed text part before emitting an agent error", async () => {
    await seedAdmin(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onTextDelta?.("Partial answer");
      throw new Error("agent exploded");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-streaming-error", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Stream then fail" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const textDeltaIndex = text.indexOf('"type":"text-delta"');
    const textEndIndex = text.indexOf('"type":"text-end"');
    const errorIndex = text.indexOf('"type":"error"');
    expect(textDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(textEndIndex).toBeGreaterThan(textDeltaIndex);
    expect(errorIndex).toBeGreaterThan(textEndIndex);
    expect(text).toContain('"errorText":"agent exploded"');
  });

  it("streams and persists integration connection cards from the web chat agent", async () => {
    const admin = await seedAdmin(db);
    const card = {
      requestId: "integration-req-1",
      appId: "github",
      appName: "GitHub",
      reason: "Connect GitHub so Sketch can inspect repository issues.",
    };
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult(
        "GitHub is not connected.\n\n" +
          "You'll need to connect it in Settings → Integrations using the GitHub OAuth flow.\n\n" +
          "Once it's connected, ask again and I'll inspect the issues.",
      ),
      pendingIntegrationConnections: [card],
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-integrations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Connect GitHub" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-integration-connection")).toMatchObject({
      type: "data-integration-connection",
      data: card,
    });
    expect(text).toContain("GitHub is not connected.");
    expect(text).not.toContain("Settings");
    expect(text).not.toContain("OAuth flow");
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-integrations"), "utf-8"),
    );
    expect(transcript.messages.at(-1).parts).toContainEqual({
      type: "text",
      text: "GitHub is not connected.",
    });
    expect(transcript.messages.at(-1).parts).toContainEqual({
      type: "data-integration-connection",
      id: "integration-connection-0",
      data: card,
    });
  });

  it("buffers integration-related streamed text until setup instructions can be sanitized", async () => {
    await seedAdmin(db);
    const card = {
      requestId: "integration-req-1",
      appId: "github",
      appName: "GitHub",
      reason: "Connect GitHub so Sketch can inspect repository issues.",
    };
    const rawText =
      "GitHub is not connected.\n\n" +
      "You'll need to connect it in Settings -> Integrations using the GitHub OAuth flow.";
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({
        kind: "tool_use",
        toolName: "mcp__canvas__direct_execute_action",
        input: { componentKey: "github-create-issue" },
      });
      await params.onTextDelta?.(rawText);
      return {
        ...makeAgentResult(rawText),
        pendingIntegrationConnections: [card],
      };
    });

    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-buffered-integrations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Create a GitHub issue" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("GitHub is not connected.");
    expect(text).not.toContain("Settings");
    expect(text).not.toContain("OAuth flow");
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-integration-connection")).toMatchObject({
      type: "data-integration-connection",
      data: card,
    });
  });

  it("streams automation cards and includes builder context when a builder reply updates an automation", async () => {
    const admin = await seedAdmin(db);
    const artifact = {
      taskId: "task-123",
      kind: "New automation",
      title: "Send weekly customer brief",
      description: "Summarizes customer updates every Monday.",
      tags: ["Scheduled", "Slack"],
      scheduleLabel: "Cron: 0 9 * * 1 (Asia/Kolkata)",
      deliveryLabel: "Slack DM",
      builderUrl: "/scheduled-tasks/task-123/edit",
      status: "active" as const,
    };
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({
        kind: "tool_use",
        toolName: "ManageScheduledTasks",
        input: { action: "add" },
      });
      await params.onTextDelta?.("Automation created. Open builder: /scheduled-tasks/task-123/edit");
      return {
        ...makeAgentResult("Automation created. Open builder: /scheduled-tasks/task-123/edit"),
        trace: {
          progressEvents: [],
          finalText: "Automation created. Open builder: /scheduled-tasks/task-123/edit",
          automationArtifacts: [artifact],
        },
      };
    });
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-123",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        prompt: "Send weekly customer brief",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "Asia/Kolkata",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: admin.id,
        createdAt: "2026-06-01T00:00:00.000Z",
        title: "Send weekly customer brief",
        description: "Summarizes customer updates every Monday.",
        originChat: null,
        steps: JSON.stringify([
          {
            id: "trigger",
            type: "trigger",
            label: "Weekly trigger",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: {
              type: "schedule",
              scheduleType: "cron",
              scheduleValue: "0 9 * * 1",
              timezone: "Asia/Kolkata",
            },
          },
          {
            id: "brief",
            type: "agent",
            label: "Create brief",
            icon: "robot",
            position: { x: 245, y: 0 },
            agentMode: "sketch",
          },
        ]),
        edges: JSON.stringify([{ id: "trigger-brief", from: "trigger", to: "brief" }]),
        outputTarget: null,
        outputPlatform: null,
        outputThreadTs: null,
        outputMode: "deliver",
        delivery: { platform: "slack", targetType: "dm", targetId: "D123", threadTs: null, mode: "deliver" },
      }),
    };
    const stepContentRepo = {
      getByTask: vi.fn().mockResolvedValue([
        {
          task_id: "task-123",
          step_id: "brief",
          content_type: "prompt",
          content: "Summarize customer updates in three bullets.",
          apps: JSON.stringify(["Slack"]),
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ]),
    };
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
      stepContentRepo: stepContentRepo as never,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-automation", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Make the summary shorter", automationTaskId: "task-123" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = webChatStreamChunks(text);
    const visibleText = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => (chunk as { delta?: string }).delta ?? "")
      .join("");
    expect(visibleText).toBe("All set - here's the automation.");
    expect(visibleText).not.toContain("/scheduled-tasks/task-123/edit");
    expect(chunks.find((chunk) => chunk.type === "data-automation")).toMatchObject({
      type: "data-automation",
      data: artifact,
    });
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.userMessage).toContain("task_id: task-123");
    expect(call.userMessage).toContain("current_automation:");
    expect(call.userMessage).toContain("title: Send weekly customer brief");
    expect(call.userMessage).toContain("steps:");
    expect(call.userMessage).toContain("- brief [agent]: Create brief");
    expect(call.userMessage).toContain("prompt: Summarize customer updates in three bullets.");
    expect(call.userMessage).toContain("edges: trigger->brief");
    expect(stepContentRepo.getByTask).toHaveBeenCalledWith("task-123");

    const transcript = JSON.parse(await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-automation"), "utf-8"));
    expect(transcript.messages.at(-1).parts).toContainEqual({
      type: "data-automation",
      id: "automation-0",
      data: artifact,
    });
  });

  it("starts builder replies without originating Slack conversation context", async () => {
    const admin = await seedAdmin(db);
    const conversations = createConversationRepository(db);
    const conversation = await conversations.getOrCreate(
      { platform: "slack", kind: "channel", providerConversationId: "C123" },
      "design-wins",
    );
    await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "1700.1",
      senderName: "Alice",
      text: "Create a Trustpilot wins automation",
      providerThreadId: "1700.1",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated."));
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-123",
        platform: "slack",
        contextType: "channel",
        deliveryTarget: "C123",
        threadTs: "1700.1",
        prompt: "Post design wins",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: admin.id,
        createdAt: "2026-06-01T00:00:00.000Z",
        title: "Post design wins",
        description: null,
        originChat: {
          platform: "slack",
          conversationId: String(conversation.id),
          providerThreadId: "1700.1",
          currentMessageId: 1,
        },
        steps: null,
        edges: null,
        outputTarget: null,
        outputPlatform: null,
        outputThreadTs: null,
        outputMode: "deliver",
        delivery: {
          platform: "slack",
          targetType: "channel",
          targetId: "C123",
          threadTs: "1700.1",
          mode: "deliver",
        },
      }),
    };
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=builder-task-123", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Tighten the filter", automationTaskId: "task-123" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.userMessage).toContain("task_id: task-123");
    expect(call.userMessage).toContain("title: Post design wins");
    expect(call.userMessage).not.toContain("Alice");
    expect(call.userMessage).not.toContain("The automation was created from a slack chat");
    expect(call.platform).toBe("slack");
    expect(call.taskContext).toMatchObject({
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C123",
      createdBy: admin.id,
      threadTs: "1700.1",
      canManageAnyTask: true,
      origin: {
        platform: "web",
        conversationId: "builder-task-123",
        providerThreadId: null,
        currentMessageId: null,
      },
    });
    expect(call.conversationRepo).toBeUndefined();
    expect(call.conversationContext).toBeUndefined();
  });

  it("does not inject builder context for inaccessible automation ids", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const owner = await users.create({ name: "Owner", email: "owner@test.com" });
    const member = await users.create({ name: "Member", email: "member@test.com", slackUserId: "U_MEMBER" });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("I can help with your automations."));
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-private",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D_OWNER",
        threadTs: null,
        prompt: "Private task",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: owner.id,
        createdAt: "2026-06-01T00:00:00.000Z",
        title: "Private task",
        description: null,
        originChat: null,
        steps: null,
        edges: null,
        outputTarget: null,
        outputPlatform: null,
        outputThreadTs: null,
        outputMode: "deliver",
        delivery: { platform: "slack", targetType: "dm", targetId: "D_OWNER", threadTs: null, mode: "deliver" },
      }),
    };
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
      getSlack: () => ({ openDmChannel: vi.fn().mockResolvedValue("D_MEMBER") }) as never,
    });
    const cookie = await getMemberCookie(db, member.id);

    const res = await app.request("/api/web-chat?conversationId=chat-private", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Update it", automationTaskId: "task-private" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.userMessage).not.toContain("<automation_builder>");
    expect(call.userMessage).not.toContain("task_id: task-private");
    expect(call.taskContext).toMatchObject({ createdBy: member.id, deliveryTarget: "D_MEMBER" });
  });

  it("streams connected account cards from provider state for account enquiries", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("You have GitHub connected."));
    const loadIntegrationProvider = vi.fn().mockResolvedValue({
      listConnections: vi.fn().mockResolvedValue([
        {
          id: "conn-1",
          providerId: "provider-1",
          appId: "github",
          appName: "GitHub",
          icon: "https://cdn.example/github.png",
          accountName: "Karan GitHub",
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]),
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      loadIntegrationProvider,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-connected-accounts", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What accounts are connected?" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-integration-connection")).toMatchObject({
      type: "data-integration-connection",
      data: {
        appId: "github",
        appName: "GitHub",
        state: "connected",
        accountName: "Karan GitHub",
        connectionId: "conn-1",
      },
    });
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-connected-accounts"), "utf-8"),
    );
    expect(transcript.messages.at(-1).parts).toContainEqual(
      expect.objectContaining({
        type: "data-integration-connection",
        data: expect.objectContaining({
          appId: "github",
          state: "connected",
          accountName: "Karan GitHub",
        }),
      }),
    );
  });

  it("does not append connected account cards for app-specific connection checks", async () => {
    await seedAdmin(db);
    const aimfoxCard = {
      requestId: "integration-aimfox-1",
      appId: "aimfox",
      appName: "Aimfox",
      state: "connect" as const,
      reason: "Connect Aimfox so Sketch can work with it.",
    };
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult("Your Aimfox account is not connected yet."),
      pendingIntegrationConnections: [aimfoxCard],
    });
    const loadIntegrationProvider = vi.fn().mockResolvedValue({
      listConnections: vi.fn().mockResolvedValue([
        {
          id: "conn-1",
          providerId: "provider-1",
          appId: "github",
          appName: "GitHub",
          healthy: true,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]),
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      loadIntegrationProvider,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-specific-connected-check", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Is my Aimfox account connected?" }),
    });

    expect(res.status).toBe(200);
    const cards = webChatStreamChunks(await res.text()).filter((chunk) => chunk.type === "data-integration-connection");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ data: aimfoxCard });
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
  });

  it("honors the current user's technical tool-progress setting", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    await users.update(admin.id, { toolProgress: "technical" });
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } });
      return makeAgentResult("Done.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Check notes" }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('📖 Read: \\"notes.md\\"');
  });

  it("collapses disabled web chat tool progress to generic thinking", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    await users.update(admin.id, { toolProgress: "off" });
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } });
      return makeAgentResult("Done.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Check notes" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Thinking");
    expect(text).not.toContain("Read");
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-progress")).toMatchObject({
      type: "data-progress",
      data: {
        lines: ["Thinking…"],
        items: [{ kind: "reasoning", label: "Thinking…", icon: { type: "generic", name: "reasoning" } }],
      },
    });
  });

  it("gets and updates the current user's web chat progress setting", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    await users.update(admin.id, { toolProgress: "technical" });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const current = await app.request("/api/web-chat/progress-settings", {
      headers: { Cookie: cookie },
    });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toEqual({ toolProgress: "technical" });

    const updated = await app.request("/api/web-chat/progress-settings", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toolProgress: "off" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ toolProgress: "off" });
    await expect(users.findById(admin.id)).resolves.toMatchObject({ tool_progress: "off" });
  });

  it("passes the live Slack resolver into web chat agent runs", async () => {
    await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const getSlack = vi.fn(() => null);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      getSlack,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Find my Slack channels" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ getSlack }));
  });

  it("rejects invalid web chat progress settings", async () => {
    await seedAdmin(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/progress-settings", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ toolProgress: "verbose" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Tool progress must be off, friendly, or technical" },
    });
  });

  it("scopes the agent session to the web chat conversation id", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const resAlpha = await app.request("/api/web-chat?conversationId=chat-alpha", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Alpha" }),
    });
    await resAlpha.text();
    const resBeta = await app.request("/api/web-chat?conversationId=chat-beta", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Beta" }),
    });
    await resBeta.text();

    expect(runAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceKey: admin.id, threadTs: "chat-alpha" }),
    );
    expect(runAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceKey: admin.id, threadTs: "chat-beta" }),
    );
  });

  it("streams generated files back to the web chat as downloadable file parts", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await mkdir(params.workspaceDir, { recursive: true });
      const filePath = join(params.workspaceDir, "skills-overview.pdf");
      await writeFile(filePath, "pdf bytes");
      return makeAgentResult("Created the PDF.", [filePath]);
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Create a PDF" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"data-file"');
    expect(text).toContain('"name":"skills-overview.pdf"');
    expect(text).toContain('"mediaType":"application/pdf"');
    expect(text).toContain(`/api/web-chat/files?path=${encodeURIComponent("skills-overview.pdf")}`);
    expect(text).toContain("skills-overview.pdf");
  });

  it("uploads web chat attachments and passes workspace-local files to the agent", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("I can see the attachment."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);
    const form = new FormData();
    form.append("file", new File(["hello notes"], "notes.txt", { type: "text/plain" }));

    const uploadRes = await app.request("/api/web-chat/attachments", {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });

    expect(uploadRes.status).toBe(200);
    const upload = (await uploadRes.json()) as {
      name: string;
      path: string;
      relativePath: string;
      url: string;
      mediaType: string;
      sizeBytes: number;
    };
    expect(upload).toMatchObject({
      name: "notes.txt",
      path: expect.stringMatching(/^attachments\//),
      relativePath: expect.stringMatching(/^attachments\//),
      url: expect.stringContaining("/api/web-chat/files?path=attachments"),
      mediaType: "text/plain",
      sizeBytes: 11,
    });
    expect(upload.path).not.toContain(dataDir);

    const chatRes = await app.request("/api/web-chat?conversationId=chat-attachments", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-attachment",
          role: "user",
          parts: [{ type: "text", text: "Please inspect this file" }],
        },
        attachments: [upload],
      }),
    });

    expect(chatRes.status).toBe(200);
    await chatRes.text();
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.attachments).toEqual([
      expect.objectContaining({
        originalName: "notes.txt",
        mimeType: "text/plain",
        localPath: join(dataDir, "workspaces", admin.id, upload.relativePath),
        sizeBytes: 11,
      }),
    ]);

    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-attachments"), "utf-8"),
    ) as { messages: unknown[] };
    expect(transcript.messages[0]).toEqual({
      id: "user-msg-attachment",
      role: "user",
      createdAt: expect.any(String),
      parts: [
        { type: "text", text: "Please inspect this file" },
        {
          type: "data-file",
          id: "attachment-0",
          data: {
            name: "notes.txt",
            url: upload.url,
            mediaType: "text/plain",
            sizeBytes: 11,
          },
        },
      ],
    });
  });

  it("rejects oversized attachment uploads with a 413 envelope before buffering", async () => {
    await seedAdmin(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    // 70MB exceeds the streaming body-limit ceiling, so it is rejected while
    // streaming, before the handler buffers it into memory.
    const oversized = new Uint8Array(70 * 1024 * 1024);
    const form = new FormData();
    form.append("file", new File([oversized], "big.bin", { type: "application/octet-stream" }));

    const res = await app.request("/api/web-chat/attachments", {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects web chat attachments outside the user's workspace", async () => {
    await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Read this",
        attachments: [{ name: "secret.txt", relativePath: "../secret.txt", mediaType: "text/plain" }],
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Attachment is outside workspace" },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("transcribes uploaded voice recordings with the configured OpenRouter key and audio MIME type", async () => {
    await seedAdmin(db);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello from voice" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, OPENROUTER_API_KEY: "sk-or-test" }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);
    const form = new FormData();
    form.append("file", new File(["audio bytes"], "recording.m4a", { type: "audio/mp4" }));

    const res = await app.request("/api/web-chat/transcribe", {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: "hello from voice" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    const requestBody = JSON.parse(String(init.body));
    expect(requestBody.model).toBe("openai/whisper-large-v3-turbo");
    expect(requestBody.input_audio.format).toBe("m4a");
  });

  it("returns the current user's persisted web chat transcript", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "default.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "u-history", role: "user", parts: [{ type: "text", text: "What did we discuss?" }] },
          { id: "a-history", role: "assistant", parts: [{ type: "text", text: "We discussed skills." }] },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/messages", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: unknown[]; updatedAt: unknown };
    expect(json).toEqual({
      messages: [
        { id: "u-history", role: "user", parts: [{ type: "text", text: "What did we discuss?" }] },
        { id: "a-history", role: "assistant", parts: [{ type: "text", text: "We discussed skills." }] },
      ],
      updatedAt: expect.any(String),
    });
  });

  it("sanitizes legacy manual setup text when returning persisted integration cards", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "chat-setup-text.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "u-history", role: "user", parts: [{ type: "text", text: "Check Gmail" }] },
          {
            id: "a-history",
            role: "assistant",
            parts: [
              {
                type: "text",
                text:
                  "Gmail is not connected.\n\n" +
                  "You'll need to connect Gmail in Settings → Integrations with a Gmail API key.\n\n" +
                  "Once it's connected, ask again.",
              },
              {
                type: "data-integration-connection",
                id: "integration-connection-0",
                data: {
                  requestId: "req-gmail",
                  appId: "google-gmail-oauth",
                  appName: "Gmail",
                  state: "connect",
                },
              },
            ],
          },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/messages?conversationId=chat-setup-text", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: Array<{ parts: unknown[] }> };
    expect(JSON.stringify(json)).not.toContain("Settings");
    expect(JSON.stringify(json)).not.toContain("API key");
    expect(json.messages.at(-1)?.parts).toContainEqual({ type: "text", text: "Gmail is not connected." });
  });

  it("accepts legacy line-only web chat progress transcripts", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "chat-legacy-progress.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "u-history", role: "user", parts: [{ type: "text", text: "Check progress" }] },
          {
            id: "a-progress",
            role: "assistant",
            parts: [{ type: "data-progress", id: "progress", data: { lines: ['📖 Reading "notes.md"'] } }],
          },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/messages?conversationId=chat-legacy-progress", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      messages: [
        { id: "u-history", role: "user", parts: [{ type: "text", text: "Check progress" }] },
        {
          id: "a-progress",
          role: "assistant",
          parts: [{ type: "data-progress", id: "progress", data: { lines: ['📖 Reading "notes.md"'] } }],
        },
      ],
    });
  });

  it("migrates legacy web chat transcripts out of the agent-visible workspace", async () => {
    const admin = await seedAdmin(db);
    const legacyTranscriptDir = join(dataDir, "workspaces", admin.id, "web-chat");
    const legacyTranscriptPath = join(legacyTranscriptDir, "chat-legacy.json");
    await mkdir(legacyTranscriptDir, { recursive: true });
    await writeFile(
      legacyTranscriptPath,
      JSON.stringify({
        version: 1,
        messages: [{ id: "u-legacy", role: "user", parts: [{ type: "text", text: "Legacy title" }] }],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/messages?conversationId=chat-legacy", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      messages: [{ id: "u-legacy", role: "user", parts: [{ type: "text", text: "Legacy title" }] }],
      updatedAt: expect.any(String),
    });
    await expect(readFile(legacyTranscriptPath, "utf-8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(webChatTranscriptPath(dataDir, admin.id, "chat-legacy"), "utf-8")).resolves.toContain(
      "Legacy title",
    );
  });

  it("migrates unrelated legacy web chat transcripts before starting a new web chat run", async () => {
    const admin = await seedAdmin(db);
    const legacyTranscriptDir = join(dataDir, "workspaces", admin.id, "web-chat");
    const legacyTranscriptPath = join(legacyTranscriptDir, "chat-old.json");
    await mkdir(legacyTranscriptDir, { recursive: true });
    await writeFile(
      legacyTranscriptPath,
      JSON.stringify({
        version: 1,
        messages: [{ id: "u-old", role: "user", parts: [{ type: "text", text: "Old web context" }] }],
      }),
    );
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Fresh reply."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-new", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Start fresh" }),
    });

    expect(res.status).toBe(200);
    await res.text();
    await expect(readFile(legacyTranscriptPath, "utf-8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(webChatTranscriptPath(dataDir, admin.id, "chat-old"), "utf-8")).resolves.toContain(
      "Old web context",
    );
  });

  it("persists successful web chat turns with generated file parts in the server transcript", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await mkdir(params.workspaceDir, { recursive: true });
      const filePath = join(params.workspaceDir, "skills-overview.pdf");
      await writeFile(filePath, "pdf bytes");
      return makeAgentResult("Created the PDF.", [filePath]);
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-1",
          role: "user",
          parts: [{ type: "text", text: "Create a PDF" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const transcript = JSON.parse(await readFile(webChatTranscriptPath(dataDir, admin.id), "utf-8")) as {
      messages: unknown[];
    };

    expect(transcript.messages).toEqual([
      {
        id: "user-msg-1",
        role: "user",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Create a PDF" }],
      },
      {
        id: expect.any(String),
        role: "assistant",
        createdAt: expect.any(String),
        parts: [
          { type: "text", text: "Created the PDF." },
          {
            type: "data-file",
            id: "file-0",
            data: {
              name: "skills-overview.pdf",
              url: `/api/web-chat/files?path=${encodeURIComponent("skills-overview.pdf")}`,
              mediaType: "application/pdf",
              sizeBytes: 9,
            },
          },
        ],
      },
    ]);
  });

  it("isolates persisted web chat turns by conversation id", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Conversation-specific reply."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-alpha", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-alpha",
          role: "user",
          parts: [{ type: "text", text: "Start alpha chat" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const transcript = JSON.parse(await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-alpha"), "utf-8")) as {
      messages: unknown[];
    };
    expect(transcript.messages).toEqual([
      {
        id: "user-msg-alpha",
        role: "user",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Start alpha chat" }],
      },
      {
        id: expect.any(String),
        role: "assistant",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Conversation-specific reply." }],
      },
    ]);

    await expect(readFile(webChatTranscriptPath(dataDir, admin.id), "utf-8")).rejects.toThrow(/ENOENT/);
  });

  it("keeps persisted web chat transcripts outside the agent-visible workspace", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Private web reply."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-private", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-private",
          role: "user",
          parts: [{ type: "text", text: "Keep this out of the workspace" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    await expect(
      readFile(join(dataDir, "workspaces", admin.id, "web-chat", "chat-private.json"), "utf-8"),
    ).rejects.toThrow(/ENOENT/);

    const history = await app.request("/api/web-chat/messages?conversationId=chat-private", {
      headers: { Cookie: cookie },
    });
    await expect(history.json()).resolves.toMatchObject({
      messages: [
        {
          id: "user-msg-private",
          role: "user",
          createdAt: expect.any(String),
          parts: [{ type: "text", text: "Keep this out of the workspace" }],
        },
        {
          id: expect.any(String),
          role: "assistant",
          createdAt: expect.any(String),
          parts: [{ type: "text", text: "Private web reply." }],
        },
      ],
    });
  });

  it("persists the user message before the web chat agent finishes", async () => {
    const admin = await seedAdmin(db);
    const agentStarted = deferred<void>();
    const finishAgent = deferred<void>();
    const runAgent = vi.fn().mockImplementation(async () => {
      agentStarted.resolve();
      await finishAgent.promise;
      return makeAgentResult("Finished in the background.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-pending", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-pending",
          role: "user",
          parts: [{ type: "text", text: "Do this in the background" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    await agentStarted.promise;
    const pendingTranscript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-pending"), "utf-8"),
    ) as { messages: unknown[] };
    expect(pendingTranscript.messages).toEqual([
      {
        id: "user-msg-pending",
        role: "user",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Do this in the background" }],
      },
      {
        id: "assistant-progress-user-msg-pending",
        role: "assistant",
        createdAt: expect.any(String),
        parts: [{ type: "data-progress", id: "progress", data: { lines: ["Thinking…"] } }],
      },
    ]);

    finishAgent.resolve();
    await res.text();
    const completedTranscript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-pending"), "utf-8"),
    ) as { messages: unknown[] };
    expect(completedTranscript.messages).toEqual([
      {
        id: "user-msg-pending",
        role: "user",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Do this in the background" }],
      },
      {
        id: expect.any(String),
        role: "assistant",
        createdAt: expect.any(String),
        parts: [{ type: "text", text: "Finished in the background." }],
      },
    ]);
  });

  it("preserves overlapping turns in the same conversation", async () => {
    const admin = await seedAdmin(db);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let secondRunStarted = false;
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      if (params.userMessage.includes("first")) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return makeAgentResult("Reply to first");
      }
      secondRunStarted = true;
      secondStarted.resolve();
      await releaseSecond.promise;
      return makeAgentResult("Reply to second");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const first = app.request("/api/web-chat?conversationId=chat-overlap", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-first",
          role: "user",
          parts: [{ type: "text", text: "first request" }],
        },
      }),
    });
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await firstStarted.promise;

    const second = app.request("/api/web-chat?conversationId=chat-overlap", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-second",
          role: "user",
          parts: [{ type: "text", text: "second request" }],
        },
      }),
    });

    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondRunStarted).toBe(false);

    releaseFirst.resolve();
    await firstResponse.text();
    await secondStarted.promise;
    releaseSecond.resolve();
    await secondResponse.text();

    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-overlap"), "utf-8"),
    ) as {
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    expect(transcript.messages.map((message) => ({ role: message.role, part: message.parts[0] }))).toEqual([
      { role: "user", part: { type: "text", text: "first request" } },
      { role: "assistant", part: { type: "text", text: "Reply to first" } },
      { role: "user", part: { type: "text", text: "second request" } },
      { role: "assistant", part: { type: "text", text: "Reply to second" } },
    ]);
    expect(transcript.messages.some((message) => message.parts.some((part) => part.type === "data-progress"))).toBe(
      false,
    );
  });

  it("returns and updates in-progress web chat state while an agent run is pending", async () => {
    const admin = await seedAdmin(db);
    const paramsSeen = deferred<RunAgentParams>();
    const allowProgress = deferred<void>();
    const progressWritten = deferred<void>();
    const finishAgent = deferred<void>();
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      paramsSeen.resolve(params);
      await allowProgress.promise;
      await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "notes.md" } });
      progressWritten.resolve();
      await finishAgent.promise;
      return makeAgentResult("Finished in the background.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-progress", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-progress",
          role: "user",
          parts: [{ type: "text", text: "Keep me updated" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    await paramsSeen.promise;
    const pending = await app.request("/api/web-chat/messages?conversationId=chat-progress", {
      headers: { Cookie: cookie },
    });
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      messages: [
        { id: "user-msg-progress", role: "user", parts: [{ type: "text", text: "Keep me updated" }] },
        {
          id: "assistant-progress-user-msg-progress",
          role: "assistant",
          parts: [{ type: "data-progress", id: "progress", data: { lines: ["Thinking…"] } }],
        },
      ],
    });

    allowProgress.resolve();
    await progressWritten.promise;
    const withProgress = await app.request("/api/web-chat/messages?conversationId=chat-progress", {
      headers: { Cookie: cookie },
    });
    await expect(withProgress.json()).resolves.toMatchObject({
      messages: [
        { id: "user-msg-progress", role: "user" },
        {
          id: "assistant-progress-user-msg-progress",
          role: "assistant",
          parts: [
            {
              type: "data-progress",
              id: "progress",
              data: {
                lines: ["Using tool"],
                items: [
                  {
                    kind: "tool",
                    label: "Using tool",
                    icon: { type: "tool" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    finishAgent.resolve();
    await res.text();
    const completed = await app.request("/api/web-chat/messages?conversationId=chat-progress", {
      headers: { Cookie: cookie },
    });
    await expect(completed.json()).resolves.toMatchObject({
      messages: [
        { id: "user-msg-progress", role: "user", parts: [{ type: "text", text: "Keep me updated" }] },
        { id: expect.any(String), role: "assistant", parts: [{ type: "text", text: "Finished in the background." }] },
      ],
    });
  });

  it("keeps the web chat agent run alive when the client request is aborted", async () => {
    await seedAdmin(db);
    const paramsSeen = deferred<RunAgentParams>();
    const finishAgent = deferred<void>();
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      paramsSeen.resolve(params);
      await finishAgent.promise;
      return makeAgentResult("Still finished.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);
    const abortController = new AbortController();

    const res = await app.request(
      new Request("http://localhost/api/web-chat?conversationId=chat-background", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Keep working if I leave" }),
        signal: abortController.signal,
      }),
    );

    expect(res.status).toBe(200);
    const params = await paramsSeen.promise;
    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!params.abortController) throw new Error("Expected web chat to pass an agent abort controller");
    expect(params.abortController.signal.aborted).toBe(false);

    finishAgent.resolve();
    await res.text();
  });

  it("interrupts the active web chat agent run for a conversation", async () => {
    const admin = await seedAdmin(db);
    const paramsSeen = deferred<RunAgentParams>();
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      paramsSeen.resolve(params);
      await new Promise((_resolve, reject) => {
        params.abortController?.signal.addEventListener("abort", () => reject(new Error("Aborted by user")), {
          once: true,
        });
      });
      return makeAgentResult("Should not finish");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const runResponse = await app.request("/api/web-chat?conversationId=chat-stop", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "user-msg-stop",
          role: "user",
          parts: [{ type: "text", text: "Keep working until I stop you" }],
        },
      }),
    });
    expect(runResponse.status).toBe(200);
    const params = await paramsSeen.promise;

    const stopResponse = await app.request("/api/web-chat/conversations/chat-stop/interruptions", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toEqual({ success: true, interrupted: true });
    expect(params.abortController?.signal.aborted).toBe(true);
    const streamText = await runResponse.text();
    expect(streamText).not.toContain("Stopped.");
    expect(webChatStreamChunks(streamText).find((chunk) => chunk.type === "data-interruption")).toMatchObject({
      type: "data-interruption",
      data: {
        detail: "Sketch paused.",
        label: "Tell Sketch what to do differently.",
      },
    });

    const transcript = JSON.parse(await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-stop"), "utf-8")) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string; data?: unknown }> }>;
    };
    expect(transcript.messages.map((message) => ({ role: message.role, part: message.parts[0] }))).toEqual([
      { role: "user", part: { type: "text", text: "Keep working until I stop you" } },
      {
        role: "assistant",
        part: {
          type: "data-interruption",
          id: "interruption",
          data: {
            detail: "Sketch paused.",
            label: "Tell Sketch what to do differently.",
          },
        },
      },
    ]);
  });

  it("interrupts a stale pending web chat progress message when no run is active", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "chat-stale-progress.json"),
      JSON.stringify({
        version: 1,
        messages: [
          {
            id: "user-msg-stale",
            role: "user",
            createdAt: "2026-06-01T00:00:00.000Z",
            parts: [{ type: "text", text: "Run the automation" }],
          },
          {
            id: "assistant-progress-user-msg-stale",
            role: "assistant",
            createdAt: "2026-06-01T00:00:01.000Z",
            parts: [{ type: "data-progress", id: "progress", data: { lines: ['ManageScheduledTasks: "run"'] } }],
          },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const stopResponse = await app.request("/api/web-chat/conversations/chat-stale-progress/interruptions", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toEqual({ success: true, interrupted: true });
    const transcript = JSON.parse(await readFile(join(transcriptDir, "chat-stale-progress.json"), "utf-8")) as {
      messages: Array<{ role: string; parts: Array<{ type: string; id?: string; data?: unknown }> }>;
    };
    expect(transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "data-interruption",
          id: "interruption",
          data: {
            detail: "Sketch paused.",
            label: "Tell Sketch what to do differently.",
          },
        },
      ],
    });
  });

  it("reports no interruption when a web chat conversation is not running", async () => {
    await seedAdmin(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const stopResponse = await app.request("/api/web-chat/conversations/chat-idle/interruptions", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toEqual({ success: true, interrupted: false });
  });

  it("lists persisted web chat conversations for Home Recents", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "chat-alpha.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "u-alpha", role: "user", parts: [{ type: "text", text: "Alpha title" }] },
          { id: "a-alpha", role: "assistant", parts: [{ type: "text", text: "Alpha reply" }] },
        ],
      }),
    );
    await writeFile(
      join(transcriptDir, "chat-beta.json"),
      JSON.stringify({
        version: 1,
        messages: [
          { id: "u-beta", role: "user", parts: [{ type: "text", text: "Beta title" }] },
          { id: "a-beta", role: "assistant", parts: [{ type: "text", text: "Beta reply" }] },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/conversations", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      conversations: expect.arrayContaining([
        { id: "chat-alpha", title: "Alpha title", channel: "web", updatedAt: expect.any(String) },
        { id: "chat-beta", title: "Beta title", channel: "web", updatedAt: expect.any(String) },
      ]),
    });
  });

  it("deletes a persisted web chat conversation and archives its agent session", async () => {
    const admin = await seedAdmin(db);
    const transcriptDir = join(dataDir, "web-chat", admin.id);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, "chat-alpha.json"),
      JSON.stringify({
        version: 1,
        messages: [{ id: "u-alpha", role: "user", parts: [{ type: "text", text: "Alpha title" }] }],
      }),
    );
    await saveSessionId(db, admin.id, "sess-alpha", "chat-alpha");
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat/conversations/chat-alpha", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const conversations = await app.request("/api/web-chat/conversations", {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    await expect(readFile(join(transcriptDir, "chat-alpha.json"), "utf-8")).rejects.toThrow();
    await expect(getSessionId(db, admin.id, "chat-alpha")).resolves.toBeUndefined();
    const session = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", admin.id)
      .where("thread_key", "=", "chat-alpha")
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ session_id: "sess-alpha", archived_at: expect.any(String) });
    await expect(conversations.json()).resolves.toEqual({ conversations: [] });
  });

  it("serves generated web chat files only from the current user's workspace", async () => {
    const admin = await seedAdmin(db);
    const workspaceDir = join(dataDir, "workspaces", admin.id);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "skills-overview.pdf"), "pdf bytes");
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const ok = await app.request(`/api/web-chat/files?path=${encodeURIComponent("skills-overview.pdf")}`, {
      headers: { Cookie: cookie },
    });
    const traversal = await app.request(`/api/web-chat/files?path=${encodeURIComponent("../settings.json")}`, {
      headers: { Cookie: cookie },
    });

    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/pdf");
    expect(ok.headers.get("content-disposition")).toContain("skills-overview.pdf");
    expect(ok.headers.has("content-length")).toBe(false);
    await expect(ok.text()).resolves.toBe("pdf bytes");
    expect(traversal.status).toBe(403);
  });

  it("uses the current user's Slack DM channel for web chat task context when available", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    await users.update(admin.id, { slackUserId: "U_SLACK" });
    const openDmChannel = vi.fn().mockResolvedValue("D_WEB_DM");
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      getSlack: () => ({ openDmChannel }) as never,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Schedule a reminder" }),
    });
    await res.text();

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(openDmChannel).toHaveBeenCalledWith("U_SLACK", undefined);
    expect(call.platform).toBe("slack");
    expect(call.contextType).toBe("dm");
    expect(call.taskContext).toMatchObject({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "D_WEB_DM",
      createdBy: admin.id,
    });
  });

  it("uses the current user's WhatsApp DM JID for web chat task context when Slack DM is unavailable", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    await users.update(admin.id, { whatsappNumber: "+919999999999" });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Schedule a reminder" }),
    });
    await res.text();

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.platform).toBe("whatsapp");
    expect(call.contextType).toBe("dm");
    expect(call.taskContext).toMatchObject({
      platform: "whatsapp",
      contextType: "dm",
      deliveryTarget: "919999999999@s.whatsapp.net",
      createdBy: admin.id,
    });
  });

  it("rejects empty AI SDK chat requests before running the agent", async () => {
    await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "VALIDATION_ERROR", message: "Message is required" },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });
});

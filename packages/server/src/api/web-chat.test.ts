import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIntegrationConnection, WebChatQuestion, WebChatQuestionBatch } from "@sketch/shared";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams } from "../agent/runner";
import { getSessionId, saveSessionId } from "../agent/sessions";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import { createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { createCliIntegrationService } from "../integrations/cli/service";
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

function makeBuilderScheduler(
  taskId: string,
  createdBy: string,
  title = "Builder brief",
  listedTaskTitles: string[] = [],
) {
  const task = {
    id: taskId,
    platform: "slack",
    contextType: "dm",
    deliveryTarget: "D_BUILDER",
    threadTs: null,
    prompt: "Send a builder brief",
    scheduleType: "cron",
    scheduleValue: "0 9 * * 1",
    timezone: "UTC",
    sessionMode: "fresh",
    nextRunAt: null,
    lastRunAt: null,
    status: "active",
    createdBy,
    createdAt: "2026-06-01T00:00:00.000Z",
    revision: 0,
    title,
    description: null,
    originChat: null,
    steps: null,
    edges: null,
    outputTarget: null,
    outputPlatform: null,
    outputThreadTs: null,
    outputMode: "deliver",
    delivery: { platform: "slack", targetType: "dm", targetId: "D_BUILDER", threadTs: null, mode: "deliver" },
  };
  const listedTasks = [
    task,
    ...listedTaskTitles.map((listedTitle, index) => ({ ...task, id: `listed-task-${index}`, title: listedTitle })),
  ];
  return {
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    removeTask: vi.fn(),
    executeTaskById: vi.fn(),
    getTaskById: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue(listedTasks),
  } as never;
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
    expect(text).toContain("Reading");
    expect(webChatStreamChunks(text).find((chunk) => chunk.type === "data-progress")).toMatchObject({
      type: "data-progress",
      data: {
        lines: ["Reading"],
        items: [
          {
            kind: "file",
            label: "Reading",
            icon: { type: "tool", name: "Read" },
            toolName: "Read",
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

  it("persists a recovery message when the agent returns no assistant content", async () => {
    const admin = await seedAdmin(db);
    const recoveryText = "I wasn't able to complete that request. Please try again.";
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult(""),
      messageSent: false,
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-empty-response", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Summarize my open tasks" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(stream).toContain(recoveryText);

    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-empty-response"), "utf-8"),
    ) as { messages: Array<{ role: string; parts: unknown[] }> };
    expect(transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: recoveryText }],
    });
  });

  it("hands a create-automation skill invocation to the builder", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult("I will create the automation here."),
      rawUsage: {
        toolCalls: [
          {
            toolName: "Skill",
            skillName: "create-automation",
            startedAt: 0,
            endedAt: 1,
            success: true,
          },
        ],
      },
      trace: {
        progressEvents: [{ kind: "tool_use", toolName: "Skill", input: { skill: "create-automation" } }],
        finalText: "I will create the automation here.",
        automationArtifacts: [],
      },
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-skill-handoff", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please configure this draft for my daily brief" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    const handoff = webChatStreamChunks(stream).find((chunk) => chunk.type === "data-automation-handoff")?.data as {
      kind: string;
      taskId: string;
      sourceConversationId: string;
      builderConversationId: string;
      builderUrl: string;
      status: string;
    };
    expect(handoff).toMatchObject({
      kind: "automation-draft",
      sourceConversationId: "chat-skill-handoff",
      status: "paused",
    });
    expect(handoff.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(handoff.builderConversationId).toMatch(/^builder-[0-9a-f-]{36}$/);
    expect(handoff.builderUrl).toContain(
      `/scheduled-tasks/${handoff.taskId}/edit?conversationId=${handoff.builderConversationId}`,
    );

    const task = await createScheduledTaskRepository(db).getById(handoff.taskId);
    expect(task).toMatchObject({
      status: "paused",
      title: "New automation",
      prompt: "Describe the automation.",
      origin_platform: "web",
      origin_conversation_id: "chat-skill-handoff",
      created_by: admin.id,
      thread_ts: null,
      output_thread_ts: null,
    });
    const associations = await createScheduledTaskConversationRepository(db).listByTaskAndTranscriptUser(
      handoff.taskId,
      admin.id,
    );
    expect(associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversation_id: "chat-skill-handoff", kind: "web_chat" }),
        expect.objectContaining({ conversation_id: handoff.builderConversationId, kind: "builder" }),
      ]),
    );
    expect(stream).not.toContain('"type":"data-automation"');
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-skill-handoff"), "utf-8"),
    );
    expect(transcript.messages.at(-1).parts).toContainEqual({
      type: "data-automation-handoff",
      id: "automation-handoff-0",
      data: handoff,
    });
  });

  it("creates a setup draft from the user's create intent even without a skill invocation", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult("I can help with that."),
      rawUsage: { toolCalls: [] },
      trace: {
        progressEvents: [],
        finalText: "I can help with that.",
        automationArtifacts: [],
      },
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-intent-handoff", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I want to create an automation that sends a daily brief" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    const handoff = webChatStreamChunks(stream).find((chunk) => chunk.type === "data-automation-handoff")?.data as {
      kind: string;
      taskId: string;
      sourceConversationId: string;
      builderConversationId: string;
      status: string;
    };
    expect(handoff).toMatchObject({
      kind: "automation-draft",
      sourceConversationId: "chat-intent-handoff",
      status: "paused",
    });
    expect(handoff.builderConversationId).toMatch(/^builder-[0-9a-f-]{36}$/);
    expect(stream).not.toContain('"type":"data-automation"');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not create a setup draft when the message expresses update intent", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult("I can update that for you."),
      rawUsage: {
        toolCalls: [
          {
            toolName: "Skill",
            skillName: "create-automation",
            startedAt: 0,
            endedAt: 1,
            success: true,
          },
        ],
      },
      trace: {
        progressEvents: [{ kind: "tool_use", toolName: "Skill", input: { skill: "create-automation" } }],
        finalText: "I can update that for you.",
        automationArtifacts: [],
      },
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-update-intent", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Update my daily brief automation to run twice a day" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(stream).not.toContain('"type":"data-automation-handoff"');
    expect(stream).toContain("I can update that for you.");
  });

  it("offers existing automations for generic update intent and opens the selected one", async () => {
    const admin = await seedAdmin(db);
    const scheduler = makeBuilderScheduler("task-daily-brief", admin.id, "Daily brief");
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("I will create a new automation."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-generic-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I want to update an automation" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(runAgent).not.toHaveBeenCalled();
    expect(stream).toContain("Which automation should I open in the builder?");
    expect(stream).toContain("No changes were made");
    expect(stream).not.toContain('"type":"data-automation-handoff"');
    expect(await createScheduledTaskRepository(db).listByCreatedBy(admin.id)).toHaveLength(0);

    const question = webChatStreamChunks(stream).find((chunk) => chunk.type === "data-question")?.data as {
      id: string;
      options: Array<{ id: string; label: string }>;
    };
    const dailyBrief = question.options.find((option) => option.label === "Daily brief");
    if (!dailyBrief) throw new Error("Expected Daily brief option");

    const selection = await app.request("/api/web-chat?conversationId=chat-generic-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "msg-select-daily-brief",
          role: "user",
          parts: [
            { type: "text", text: dailyBrief.label },
            {
              type: "data-question-answer",
              id: `question-answer-${question.id}`,
              data: { questionId: question.id, optionId: dailyBrief.id },
            },
          ],
        },
      }),
    });

    const selectionStream = await selection.text();
    expect(selection.status, selectionStream).toBe(200);
    expect(runAgent).not.toHaveBeenCalled();
    expect(webChatStreamChunks(selectionStream).find((chunk) => chunk.type === "data-automation")?.data).toMatchObject({
      taskId: "task-daily-brief",
      kind: "Updated automation",
    });
    expect(selectionStream).not.toContain('"type":"data-automation-handoff"');
  });

  it("routes an explicitly named existing automation to its builder before running the agent", async () => {
    const admin = await seedAdmin(db);
    const taskId = "task-weekday-calendar-summary";
    const scheduler = makeBuilderScheduler(taskId, admin.id, "Weekday Morning Calendar Summary");
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("The update is ready."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-explicit-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Update my Weekday Morning Calendar Summary automation to call out meetings with external attendees.",
      }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    const artifact = webChatStreamChunks(stream).find((chunk) => chunk.type === "data-automation")?.data;
    expect(runAgent).not.toHaveBeenCalled();
    expect(artifact).toMatchObject({
      taskId,
      kind: "Updated automation",
      builderUrl: `http://localhost:3000/scheduled-tasks/${taskId}/edit`,
    });
    expect(stream).not.toContain('"type":"data-automation-handoff"');
  });

  it("asks the user to choose when an update request matches multiple automations", async () => {
    const admin = await seedAdmin(db);
    const scheduler = makeBuilderScheduler("task-gmail-triage", admin.id, "Triage Gmail inbox", [
      "Hourly Gmail inbox triage",
      "Weekday Gmail inbox triage",
      "Weekday Gmail inbox triage",
    ]);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("The update is ready."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-ambiguous-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I want to update my gmail automation" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(runAgent).not.toHaveBeenCalled();
    expect(stream).toContain("I found multiple automations matching “gmail”");
    expect(stream).toContain("Triage Gmail inbox");
    expect(stream).toContain("Hourly Gmail inbox triage");
    expect(stream).toContain("Weekday Gmail inbox triage");
    expect(webChatStreamChunks(stream).find((chunk) => chunk.type === "data-question")?.data).toMatchObject({
      prompt: "Which automation should I open in the builder?",
    });
    expect(stream).not.toContain('"type":"data-automation"');
    expect(stream).not.toContain('"type":"data-automation-handoff"');
  });

  it("opens the selected automation builder after an ambiguous update question", async () => {
    const admin = await seedAdmin(db);
    const scheduler = makeBuilderScheduler("task-gmail-triage", admin.id, "Triage Gmail inbox", [
      "Hourly Gmail inbox triage",
      "Weekday Gmail inbox triage",
      "Weekday Gmail inbox triage",
    ]);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("The update is ready."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const questionResponse = await app.request("/api/web-chat?conversationId=chat-selected-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I want to update my gmail automation" }),
    });
    const questionStream = await questionResponse.text();
    const question = webChatStreamChunks(questionStream).find((chunk) => chunk.type === "data-question")?.data as {
      id: string;
      options: Array<{ id: string; label: string }>;
    };
    const selectedOption = question.options.find((option) => option.label === "Triage Gmail inbox");
    if (!selectedOption) throw new Error("Expected Triage Gmail inbox option");

    const builderResponse = await app.request("/api/web-chat?conversationId=chat-selected-update", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "msg-select-gmail",
          role: "user",
          parts: [
            { type: "text", text: selectedOption.label },
            {
              type: "data-question-answer",
              id: `question-answer-${question.id}`,
              data: { questionId: question.id, optionId: selectedOption.id },
            },
          ],
        },
      }),
    });

    expect(builderResponse.status).toBe(200);
    const builderStream = await builderResponse.text();
    expect(runAgent).not.toHaveBeenCalled();
    expect(webChatStreamChunks(builderStream).find((chunk) => chunk.type === "data-automation")?.data).toMatchObject({
      taskId: "task-gmail-triage",
      kind: "Updated automation",
    });
    expect(builderStream).toContain("I’ll open the existing automation in the builder");
  });

  it("emits the automation artifact after the agent creates a natural-language automation", async () => {
    const admin = await seedAdmin(db);
    const artifact = {
      taskId: "task-natural-language",
      requiresBuilder: true,
      kind: "New automation",
      title: "Weekday Morning Calendar Summary",
      description: "Sends a quick summary of the day's calendar every weekday morning.",
      tags: ["Scheduled", "Slack"],
      scheduleLabel: "Cron: 0 9 * * 1-5 (Asia/Kolkata)",
      deliveryLabel: "Slack DM",
      builderUrl: "/scheduled-tasks/task-natural-language/edit?conversationId=chat-natural-language",
      status: "active" as const,
    };
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({
        kind: "tool_use",
        toolName: "ManageScheduledTasks",
        input: {
          action: "add",
          request: "Remind me every weekday morning with a quick summary of my calendar for the day.",
        },
      });
      return {
        ...makeAgentResult("Automation created."),
        trace: {
          progressEvents: [],
          finalText: "Automation created.",
          automationArtifacts: [artifact],
        },
      };
    });
    const buildMcpServers = vi.fn().mockResolvedValue({});
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-natural-language", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Remind me every weekday morning with a quick summary of my calendar for the day.",
      }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    const chunks = webChatStreamChunks(stream);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(buildMcpServers).toHaveBeenCalledWith("karan@example.com");
    expect(chunks.find((chunk) => chunk.type === "data-automation-handoff")).toBeUndefined();
    expect(chunks.find((chunk) => chunk.type === "data-automation")).toMatchObject({
      type: "data-automation",
      data: artifact,
    });
    expect(stream).toContain("All set - here's the automation.");

    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "chat-natural-language"), "utf-8"),
    );
    expect(transcript.messages.at(-1).parts).toContainEqual({
      type: "data-automation",
      id: "automation-0",
      data: artifact,
    });
  });

  it("streams an existing automation builder artifact after the agent opens it", async () => {
    await seedAdmin(db);
    const artifact = {
      taskId: "task-existing-automation",
      requiresBuilder: true,
      kind: "Updated automation",
      title: "Weekday Morning Calendar Summary",
      description: "Sends a quick summary of the day's calendar every weekday morning.",
      tags: ["Scheduled", "Slack"],
      scheduleLabel: "Cron: 0 9 * * 1-5 (Asia/Kolkata)",
      deliveryLabel: "Slack DM",
      builderUrl: "/scheduled-tasks/task-existing-automation/edit?conversationId=builder-existing",
      status: "active" as const,
    };
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onProgressEvent({
        kind: "tool_use",
        toolName: "ManageScheduledTasks",
        input: { action: "open", task_id: "task-existing-automation" },
      });
      return {
        ...makeAgentResult("Opening the automation builder."),
        trace: {
          progressEvents: [],
          finalText: "Opening the automation builder.",
          automationArtifacts: [artifact],
        },
      };
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=chat-existing-automation", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Update my daily brief automation" }),
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(webChatStreamChunks(stream).find((chunk) => chunk.type === "data-automation")).toMatchObject({
      type: "data-automation",
      data: { taskId: artifact.taskId, kind: "Updated automation", builderUrl: artifact.builderUrl },
    });
    expect(stream).not.toContain('"type":"data-automation-handoff"');
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

  it("streams a pending choice question and validates a stable option selection", async () => {
    const admin = await seedAdmin(db);
    const question: WebChatQuestion = {
      id: "schedule-frequency",
      prompt: "How often should Sketch run this automation?",
      options: [
        { id: "daily", label: "Daily" },
        { id: "weekly", label: "Weekly", description: "Run once each week." },
      ],
    };
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ...makeAgentResult(""),
        pendingQuestion: question,
        trace: { progressEvents: [], finalText: null, automationArtifacts: [] },
      })
      .mockResolvedValueOnce(makeAgentResult("Got it — weekly."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const firstResponse = await app.request("/api/web-chat?conversationId=choice-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Which cadence should I use?" }),
    });
    const firstChunks = webChatStreamChunks(await firstResponse.text());
    expect(firstResponse.status).toBe(200);
    expect(firstChunks).toContainEqual({ type: "data-question", id: "question-schedule-frequency", data: question });

    const secondResponse = await app.request("/api/web-chat?conversationId=choice-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "choice-answer-1",
          role: "user",
          parts: [
            { type: "text", text: "Weekly" },
            {
              type: "data-question-answer",
              id: "question-answer-schedule-frequency",
              data: { questionId: "schedule-frequency", optionId: "weekly" },
            },
          ],
        },
      }),
    });
    expect(secondResponse.status).toBe(200);
    await secondResponse.text();

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]?.[0].userMessage).toContain("Weekly");
    const transcript = JSON.parse(await readFile(webChatTranscriptPath(dataDir, admin.id, "choice-chat"), "utf-8")) as {
      messages: Array<{ role: string; parts: unknown[] }>;
    };
    expect(transcript.messages[2]?.parts).toContainEqual({
      type: "data-question-answer",
      id: "question-answer-schedule-frequency",
      data: { questionId: "schedule-frequency", optionId: "weekly" },
    });
  });

  it("consumes a question answer only once when duplicate requests arrive concurrently", async () => {
    const admin = await seedAdmin(db);
    const question: WebChatQuestion = {
      id: "schedule-frequency",
      prompt: "How often should Sketch run this automation?",
      options: [
        { id: "daily", label: "Daily" },
        { id: "weekly", label: "Weekly" },
      ],
    };
    const buildMcpServersReleased = deferred<void>();
    const duplicateBuildsReached = deferred<void>();
    let buildMcpServersCalls = 0;
    const buildMcpServers = vi.fn().mockImplementation(async () => {
      buildMcpServersCalls += 1;
      if (buildMcpServersCalls > 1) {
        if (buildMcpServersCalls === 3) duplicateBuildsReached.resolve();
        await buildMcpServersReleased.promise;
      }
      return {};
    });
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ...makeAgentResult(""),
        pendingQuestion: question,
        trace: { progressEvents: [], finalText: null, automationArtifacts: [] },
      })
      .mockResolvedValue(makeAgentResult("Got it — daily."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers,
    });
    const cookie = await login(app);

    const firstResponse = await app.request("/api/web-chat?conversationId=concurrent-choice", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Which cadence should I use?" }),
    });
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();

    const answerBody = JSON.stringify({
      message: {
        id: "concurrent-choice-answer",
        role: "user",
        parts: [
          { type: "text", text: "Daily" },
          {
            type: "data-question-answer",
            id: "question-answer-schedule-frequency",
            data: { questionId: "schedule-frequency", optionId: "daily" },
          },
        ],
      },
    });
    const request = () =>
      app.request("/api/web-chat?conversationId=concurrent-choice", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: answerBody,
      });
    const responsesPromise = Promise.all([request(), request()]);
    await duplicateBuildsReached.promise;
    buildMcpServersReleased.resolve();
    const responses = await responsesPromise;

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await Promise.all(responses.map((response) => response.text()));

    expect(runAgent).toHaveBeenCalledTimes(2);
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "concurrent-choice"), "utf-8"),
    ) as { messages: Array<{ role: string; parts: unknown[] }> };
    const answerParts = transcript.messages.flatMap((message) =>
      message.parts.filter(
        (part): part is { type: "data-question-answer"; data: { questionId: string } } =>
          typeof part === "object" && part !== null && "type" in part && part.type === "data-question-answer",
      ),
    );
    expect(answerParts).toHaveLength(1);
    expect(answerParts[0]?.data.questionId).toBe("schedule-frequency");
    expect(transcript.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("streams and validates a bounded batch of pending choices", async () => {
    const admin = await seedAdmin(db);
    const batch: WebChatQuestionBatch = {
      batchId: "automation-setup",
      questions: [
        {
          id: "source",
          prompt: "Where should this read from?",
          options: [
            { id: "gmail", label: "Gmail" },
            { id: "drive", label: "Google Drive" },
          ],
        },
        {
          id: "cadence",
          prompt: "How often should it run?",
          options: [
            { id: "daily", label: "Daily" },
            { id: "weekly", label: "Weekly" },
          ],
        },
      ],
    };
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ...makeAgentResult(""),
        pendingInteraction: batch,
        trace: { progressEvents: [], finalText: null, automationArtifacts: [] },
      })
      .mockResolvedValueOnce(makeAgentResult("Configured."));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const firstResponse = await app.request("/api/web-chat?conversationId=batch-choice-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Set up the automation" }),
    });
    expect(firstResponse.status).toBe(200);
    expect(webChatStreamChunks(await firstResponse.text())).toContainEqual({
      type: "data-question-batch",
      id: "question-automation-setup",
      data: batch,
    });

    const secondResponse = await app.request("/api/web-chat?conversationId=batch-choice-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "batch-answer-1",
          role: "user",
          parts: [
            { type: "text", text: "Gmail, Daily" },
            {
              type: "data-question-batch-answer",
              id: "question-batch-answer-automation-setup",
              data: {
                batchId: "automation-setup",
                answers: [
                  { questionId: "source", optionId: "gmail" },
                  { questionId: "cadence", optionId: "daily" },
                ],
              },
            },
          ],
        },
      }),
    });
    expect(secondResponse.status).toBe(200);
    await secondResponse.text();

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1]?.[0].userMessage).toContain("Gmail, Daily");
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "batch-choice-chat"), "utf-8"),
    ) as { messages: Array<{ role: string; parts: unknown[] }> };
    expect(transcript.messages[2]?.parts).toContainEqual({
      type: "data-question-batch-answer",
      id: "question-batch-answer-automation-setup",
      data: {
        batchId: "automation-setup",
        answers: [
          { questionId: "source", optionId: "gmail" },
          { questionId: "cadence", optionId: "daily" },
        ],
      },
    });
  });

  it("rejects a choice that is not part of the pending question", async () => {
    const admin = await seedAdmin(db);
    const question: WebChatQuestion = {
      id: "delivery-mode",
      prompt: "Where should this go?",
      options: [
        { id: "slack", label: "Slack" },
        { id: "email", label: "Email" },
      ],
    };
    const runAgent = vi.fn().mockResolvedValue({
      ...makeAgentResult(""),
      pendingQuestion: question,
      trace: { progressEvents: [], finalText: null, automationArtifacts: [] },
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });
    const cookie = await login(app);

    const firstResponse = await app.request("/api/web-chat?conversationId=invalid-choice", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Ask me" }),
    });
    await firstResponse.text();

    const invalidResponse = await app.request("/api/web-chat?conversationId=invalid-choice", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          id: "invalid-choice-answer",
          role: "user",
          parts: [
            { type: "text", text: "SMS" },
            {
              type: "data-question-answer",
              id: "question-answer-delivery-mode",
              data: { questionId: "delivery-mode", optionId: "sms" },
            },
          ],
        },
      }),
    });

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({
      error: { code: "QUESTION_OPTION_INVALID", message: "That option is not available for the pending question" },
    });
    expect(runAgent).toHaveBeenCalledOnce();
    const transcript = JSON.parse(
      await readFile(webChatTranscriptPath(dataDir, admin.id, "invalid-choice"), "utf-8"),
    ) as { messages: Array<{ role: string }> };
    expect(transcript.messages).toHaveLength(2);
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
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-123",
      conversationId: "chat-automation",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    const artifact = {
      taskId: "task-123",
      requiresBuilder: true,
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
        revision: 0,
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
      body: JSON.stringify({
        message: "<automation_builder>\ntask_id: stale-task\n</automation_builder>\nMake the summary shorter",
        automationTaskId: "task-123",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
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
    expect(call.currentAutomation).toMatchObject({
      taskId: "task-123",
      revision: 0,
      builderConversationId: "chat-automation",
      builderState: {
        title: "Send weekly customer brief",
        prompt: "Send weekly customer brief",
        steps: expect.arrayContaining([expect.objectContaining({ id: "brief" })]),
      },
    });
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

  it("rejects a guessed builder conversation before agent or transcript execution", async () => {
    const admin = await seedAdmin(db);
    const legacyTranscriptPath = join(dataDir, "workspaces", admin.id, "web-chat", "guessed-builder.json");
    await mkdir(join(dataDir, "workspaces", admin.id, "web-chat"), { recursive: true });
    await writeFile(
      legacyTranscriptPath,
      JSON.stringify({ messages: [{ id: "legacy", role: "user", parts: [{ type: "text", text: "Keep me" }] }] }),
    );
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Should not run."));
    const scheduler = makeBuilderScheduler("task-guessed", admin.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=guessed-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Run this guessed conversation",
        automationTaskId: "task-guessed",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "CONVERSATION_NOT_FOUND" } });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(readFile(webChatTranscriptPath(dataDir, admin.id, "guessed-builder"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(legacyTranscriptPath, "utf-8")).resolves.toContain("Keep me");
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskConversationForTranscriptUser(
        "task-guessed",
        "guessed-builder",
        admin.id,
        { includeArchived: true },
      ),
    ).resolves.toHaveLength(0);
  });

  it("requires an exact authoring lease for AI SDK builder messages", async () => {
    const admin = await seedAdmin(db);
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-builder-lease",
      conversationId: "builder-lease",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Builder reply"));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler: makeBuilderScheduler("task-builder-lease", admin.id),
    });
    const cookie = await login(app);
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const message = {
      messages: [{ id: "builder-user-message", role: "user", parts: [{ type: "text", text: "Continue setup" }] }],
      automationTaskId: "task-builder-lease",
    };

    const missingLease = await app.request("/api/web-chat?conversationId=builder-lease", {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    expect(missingLease.status).toBe(400);
    expect(await missingLease.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(runAgent).not.toHaveBeenCalled();

    const withLease = await app.request("/api/web-chat?conversationId=builder-lease", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...message,
        clientSessionId: "builder-session-a",
        generation: 1,
      }),
    });
    expect(withLease.status).toBe(200);
    await withLease.text();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].taskContext?.authoringLease).toEqual({
      sessionId: "builder-session-a",
      generation: 1,
    });

    const otherSession = await app.request("/api/web-chat?conversationId=builder-lease", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...message, clientSessionId: "builder-session-b", generation: 1 }),
    });
    expect(otherSession.status).toBe(409);
    expect(await otherSession.json()).toMatchObject({ error: { code: "BUILDER_CHAT_LOCKED" } });
    expect(runAgent).toHaveBeenCalledOnce();

    await db
      .updateTable("automation_task_locks")
      .set({ generation: 2 })
      .where("task_id", "=", "task-builder-lease")
      .execute();
    const staleGeneration = await app.request("/api/web-chat?conversationId=builder-lease", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...message, clientSessionId: "builder-session-a", generation: 1 }),
    });
    expect(staleGeneration.status).toBe(409);
    expect(await staleGeneration.json()).toMatchObject({ error: { code: "LEASE_STALE" } });
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("rejects an archived builder conversation without reviving it", async () => {
    const admin = await seedAdmin(db);
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-archived",
      conversationId: "archived-builder",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    await conversations.setArchivedForTaskConversation("task-archived", "archived-builder", admin.id, true);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Should not run."));
    const scheduler = makeBuilderScheduler("task-archived", admin.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=archived-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Run this archived conversation",
        automationTaskId: "task-archived",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "CONVERSATION_ARCHIVED" } });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(readFile(webChatTranscriptPath(dataDir, admin.id, "archived-builder"), "utf-8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      conversations.listByTaskConversationForTranscriptUser("task-archived", "archived-builder", admin.id, {
        includeArchived: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ kind: "builder", archived_at: expect.any(String) })]);
  });

  it("allows an active source-chat association without manufacturing a builder association", async () => {
    const admin = await seedAdmin(db);
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-source",
      conversationId: "source-chat",
      transcriptUserId: admin.id,
      kind: "web_chat",
    });
    await db
      .updateTable("scheduled_task_conversations")
      .set({ updated_at: "2000-01-01 00:00:00", last_active_at: "2000-01-01 00:00:00" })
      .where("task_id", "=", "task-source")
      .where("conversation_id", "=", "source-chat")
      .where("transcript_user_id", "=", admin.id)
      .where("kind", "=", "web_chat")
      .execute();
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated from the source chat."));
    const scheduler = makeBuilderScheduler("task-source", admin.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=source-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Continue from the source chat",
        automationTaskId: "task-source",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(runAgent).toHaveBeenCalledOnce();
    const sourceAssociation = await conversations.listByTaskConversationForTranscriptUser(
      "task-source",
      "source-chat",
      admin.id,
      { includeArchived: true },
    );
    expect(sourceAssociation).toEqual([expect.objectContaining({ kind: "web_chat", archived_at: null })]);
    expect(sourceAssociation[0]?.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(sourceAssociation[0]?.last_active_at).not.toBe("2000-01-01 00:00:00");
  });

  it("does not revive an archived builder kind when an active source-chat association opens the task", async () => {
    const admin = await seedAdmin(db);
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-archived-builder",
      conversationId: "source-with-archived-builder",
      transcriptUserId: admin.id,
      kind: "web_chat",
    });
    await conversations.upsert({
      taskId: "task-archived-builder",
      conversationId: "source-with-archived-builder",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    await conversations.setArchivedForTaskConversation(
      "task-archived-builder",
      "source-with-archived-builder",
      admin.id,
      true,
    );
    await conversations.upsert({
      taskId: "task-archived-builder",
      conversationId: "source-with-archived-builder",
      transcriptUserId: admin.id,
      kind: "web_chat",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated from the source chat."));
    const scheduler = makeBuilderScheduler("task-archived-builder", admin.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=source-with-archived-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Continue from the source chat",
        automationTaskId: "task-archived-builder",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(runAgent).toHaveBeenCalledOnce();
    await expect(
      conversations.listByTaskConversationForTranscriptUser(
        "task-archived-builder",
        "source-with-archived-builder",
        admin.id,
        { includeArchived: true },
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "builder", archived_at: expect.any(String) }),
        expect.objectContaining({ kind: "web_chat", archived_at: null }),
      ]),
    );
  });

  it("does not run or append a transcript when an existing builder touch fails", async () => {
    const admin = await seedAdmin(db);
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-builder-association-failure",
      conversationId: "source-chat-association-failure",
      transcriptUserId: admin.id,
      kind: "web_chat",
    });
    await conversations.upsert({
      taskId: "task-builder-association-failure",
      conversationId: "source-chat-association-failure",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    await sql`
      CREATE TRIGGER reject_builder_touch
      BEFORE UPDATE OF last_active_at ON scheduled_task_conversations
      WHEN OLD.kind = 'builder'
      BEGIN
        SELECT RAISE(FAIL, 'builder touch rejected');
      END
    `.execute(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Should not run."));
    const scheduler = makeBuilderScheduler("task-builder-association-failure", admin.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=source-chat-association-failure", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Continue from the source chat",
        automationTaskId: "task-builder-association-failure",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "CONVERSATION_UNAVAILABLE" } });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(
      readFile(webChatTranscriptPath(dataDir, admin.id, "source-chat-association-failure"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      conversations.listByTaskConversationForTranscriptUser(
        "task-builder-association-failure",
        "source-chat-association-failure",
        admin.id,
        { includeArchived: true },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ kind: "builder", archived_at: null }),
      expect.objectContaining({ kind: "web_chat", archived_at: null }),
    ]);
  });

  it("passes builder channel context to CLI environment resolution", async () => {
    const admin = await seedAdmin(db);
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-cli-context",
      conversationId: "builder-cli-context",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated."));
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({ GH_TOKEN: "ghp_shared" });
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-cli-context",
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
        revision: 0,
        title: "Post design wins",
        description: null,
        originChat: null,
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
      listAgentEnvForRuntime,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=builder-cli-context", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Use GitHub",
        automationTaskId: "task-cli-context",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });
    await res.text();

    expect(listAgentEnvForRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUserId: admin.id,
        contextType: "channel_mention",
        taskContext: expect.objectContaining({
          platform: "slack",
          contextType: "channel",
          deliveryTarget: "C123",
        }),
      }),
    );
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agentEnv: { GH_TOKEN: "ghp_shared" } }));
  });

  it("starts builder replies without originating Slack conversation context", async () => {
    const admin = await seedAdmin(db);
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-123",
      conversationId: "builder-task-123",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    await db
      .updateTable("scheduled_task_conversations")
      .set({ updated_at: "2000-01-01 00:00:00", last_active_at: "2000-01-01 00:00:00" })
      .where("task_id", "=", "task-123")
      .where("conversation_id", "=", "builder-task-123")
      .where("transcript_user_id", "=", admin.id)
      .where("kind", "=", "builder")
      .execute();
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
        revision: 0,
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
      body: JSON.stringify({
        message: "Tighten the filter",
        automationTaskId: "task-123",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
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
    expect(call.taskContext?.currentAutomation).toMatchObject({
      taskId: "task-123",
      revision: 0,
      builderConversationId: "builder-task-123",
    });
    expect(call.conversationRepo).toBeUndefined();
    expect(call.conversationContext).toBeUndefined();
    const builderAssociation = await createScheduledTaskConversationRepository(
      db,
    ).listByTaskConversationForTranscriptUser("task-123", "builder-task-123", admin.id);
    expect(builderAssociation).toEqual([expect.objectContaining({ kind: "builder", archived_at: null })]);
    expect(builderAssociation[0]?.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(builderAssociation[0]?.last_active_at).not.toBe("2000-01-01 00:00:00");
  });

  it("preserves the original web-chat requirements when trimming builder history", async () => {
    const admin = await seedAdmin(db);
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-web-origin",
      conversationId: "builder-web-origin",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    await mkdir(join(dataDir, "web-chat", admin.id), { recursive: true });
    await writeFile(
      webChatTranscriptPath(dataDir, admin.id, "source-web-origin"),
      JSON.stringify({
        messages: [
          {
            id: "source-requirements",
            role: "user",
            parts: [
              {
                type: "text",
                text: "Create a daily GitHub PR digest for my open pull requests and send it to Slack.",
              },
            ],
          },
          ...Array.from({ length: 14 }, (_, index) => ({
            id: `source-follow-up-${index}`,
            role: index % 2 === 0 ? "assistant" : "user",
            parts: [{ type: "text", text: `Source chat follow-up ${index}` }],
          })),
        ],
      }),
    );
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("I found the source requirements."));
    const scheduler = makeBuilderScheduler("task-web-origin", admin.id);
    const getTaskById = (scheduler as unknown as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById;
    getTaskById.mockResolvedValue({
      id: "task-web-origin",
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "D_BUILDER",
      threadTs: null,
      prompt: "Automation setup",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      timezone: "UTC",
      sessionMode: "fresh",
      nextRunAt: null,
      lastRunAt: null,
      status: "active",
      createdBy: admin.id,
      createdAt: "2026-06-01T00:00:00.000Z",
      revision: 0,
      title: "GitHub PR digest",
      description: null,
      originChat: {
        platform: "web",
        conversationId: "source-web-origin",
        providerThreadId: null,
        currentMessageId: null,
      },
      steps: null,
      edges: null,
      outputTarget: null,
      outputPlatform: null,
      outputThreadTs: null,
      outputMode: "deliver",
      delivery: { platform: "slack", targetType: "dm", targetId: "D_BUILDER", threadTs: null, mode: "deliver" },
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=builder-web-origin", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: '[automation-setup-mode-selection] I chose the "deterministic" execution mode (Deterministic).',
        automationTaskId: "task-web-origin",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].userMessage).toContain(
      "Create a daily GitHub PR digest for my open pull requests and send it to Slack.",
    );
  });

  it("re-grants an admin task access but keeps the owner transcript viewer-scoped", async () => {
    const admin = await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-builder@test.com" });
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-foreign",
      conversationId: "owner-builder",
      transcriptUserId: owner.id,
      kind: "builder",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated."));
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-foreign",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D_OWNER",
        threadTs: null,
        prompt: "Send the owner a brief",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: owner.id,
        createdAt: "2026-06-01T00:00:00.000Z",
        revision: 3,
        title: "Owner brief",
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
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=owner-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Make this stricter",
        automationTaskId: "task-foreign",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    // The admin passes the task access gate (re-granted) but the owner's
    // transcript conversation stays out of the admin's view.
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "CONVERSATION_NOT_FOUND" } });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(readFile(webChatTranscriptPath(dataDir, admin.id, "owner-builder"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      conversations.listByTaskConversationForTranscriptUser("task-foreign", "owner-builder", owner.id),
    ).resolves.toHaveLength(1);
    await expect(
      conversations.listByTaskConversationForTranscriptUser("task-foreign", "owner-builder", admin.id),
    ).resolves.toHaveLength(0);
    expect(scheduler.getTaskById).toHaveBeenCalledWith("task-foreign");
  });

  it("opens the builder context to an admin on a foreign-owned task", async () => {
    const admin = await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-admin-wc@test.com" });
    const conversations = createScheduledTaskConversationRepository(db);
    await conversations.upsert({
      taskId: "task-foreign-admin",
      conversationId: "admin-builder",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated."));
    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "task-foreign-admin",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D_OWNER",
        threadTs: null,
        prompt: "Send the owner a brief",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: owner.id,
        createdAt: "2026-06-01T00:00:00.000Z",
        revision: 2,
        title: "Owner brief",
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
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat?conversationId=admin-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Make this stricter",
        automationTaskId: "task-foreign-admin",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.userMessage).toContain("task_id: task-foreign-admin");
    expect(call.taskContext).toMatchObject({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "D_OWNER",
      createdBy: admin.id,
      canManageAnyTask: true,
      origin: {
        platform: "web",
        conversationId: "admin-builder",
        providerThreadId: null,
        currentMessageId: null,
      },
    });
  });

  it("rejects inaccessible automation ids before running or mutating the transcript", async () => {
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
        revision: 0,
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
      body: JSON.stringify({
        message: "Update it",
        automationTaskId: "task-private",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "AUTOMATION_NOT_FOUND" } });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(readFile(webChatTranscriptPath(dataDir, member.id, "chat-private"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("opens the builder context to an explicit grantee of a shared automation", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const owner = await users.create({ name: "Owner", email: "owner-grantee-wc@test.com" });
    const member = await users.create({ name: "Member", email: "member-grantee-wc@test.com" });
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult("Updated."));
    const scheduler = makeBuilderScheduler("task-granted-builder", owner.id);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler,
    });
    const cookie = await getMemberCookie(db, member.id);

    const denied = await app.request("/api/web-chat?conversationId=granted-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Tighten it",
        automationTaskId: "task-granted-builder",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: "AUTOMATION_NOT_FOUND" } });

    await createAutomationSharesRepository(db).grant({
      taskId: "task-granted-builder",
      userId: member.id,
      grantedByUserId: owner.id,
    });

    const allowed = await app.request("/api/web-chat?conversationId=granted-builder", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Tighten it",
        automationTaskId: "task-granted-builder",
        clientSessionId: "test-builder-session",
        generation: 1,
      }),
    });
    expect(allowed.status).toBe(404);
    expect(await allowed.json()).toMatchObject({ error: { code: "CONVERSATION_NOT_FOUND" } });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("streams connected CLI account cards before filtering Canvas GitHub connections", async () => {
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
    const cliConnection: CliIntegrationConnection = {
      id: "cli-1",
      appId: "github",
      appName: "GitHub",
      executionMode: "cli",
      ownerUserId: admin.id,
      accountExternalId: "123",
      accountLogin: "karan",
      accountAvatarUrl: null,
      accountType: "User",
      status: "active",
      verifiedAt: "2026-01-01T00:00:00Z",
      lastVerificationError: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      isOwnedByViewer: true,
      canUse: true,
      canManage: true,
      shares: [],
    };
    const cliIntegrations = {
      listCatalog: () => [],
      listConnections: vi.fn().mockResolvedValue([cliConnection]),
    } as unknown as ReturnType<typeof createCliIntegrationService>;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      loadIntegrationProvider,
      cliIntegrations,
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
        accountName: "@karan",
        connectionId: "cli-1",
        executionMode: "cli",
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
          accountName: "@karan",
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
                lines: ["Reading"],
                items: [
                  {
                    kind: "file",
                    label: "Reading",
                    icon: { type: "tool", name: "Read" },
                    toolName: "Read",
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
        label: "What should Sketch do differently?",
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
            label: "What should Sketch do differently?",
          },
        },
      },
    ]);
  });

  it("requires the exact authoring lease when interrupting builder chat", async () => {
    const admin = await seedAdmin(db);
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "task-builder-stop",
      conversationId: "builder-stop",
      transcriptUserId: admin.id,
      kind: "builder",
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: vi.fn().mockResolvedValue(makeAgentResult()),
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler: makeBuilderScheduler("task-builder-stop", admin.id),
    });
    const cookie = await login(app);
    const url = "/api/web-chat/conversations/builder-stop/interruptions?automationTaskId=task-builder-stop";

    const missingLease = await app.request(url, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(missingLease.status).toBe(400);
    expect(await missingLease.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const withLease = await app.request(url, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientSessionId: "builder-stop-session", generation: 1 }),
    });
    expect(withLease.status).toBe(200);
    await expect(withLease.json()).resolves.toEqual({ success: true, interrupted: false });
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
            label: "What should Sketch do differently?",
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

  it("uses the current user's id as a task-context delivery fallback when no outbound DM is available", async () => {
    const admin = await seedAdmin(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      scheduler: makeBuilderScheduler("unused-task", admin.id),
    });
    const cookie = await login(app);

    const res = await app.request("/api/web-chat", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Give me a summary of my workspace" }),
    });
    await res.text();

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.platform).toBe("slack");
    expect(call.contextType).toBe("dm");
    expect(call.taskContext).toMatchObject({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: admin.id,
      createdBy: admin.id,
      conversationKind: "web_chat",
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

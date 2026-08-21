import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersTable } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  AutomationArtifactCollector,
  QuestionCollector,
  UploadCollector,
  createSketchMcpServer,
  handleGetTeamDirectory,
  handleResolveInboxWorkflow,
  handleSearchUsers,
  handleSendMessage,
  handleSendMessageToTarget,
  handleSendMessageToUsers,
  handleSetUserTimezone,
  handleUpdateInboxWorkflow,
} from "./sketch-tools";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeUser(overrides: Partial<Selectable<UsersTable>> = {}): Selectable<UsersTable> {
  return {
    id: "user-1",
    name: "Alice",
    email: null,
    email_verified_at: null,
    password_hash: null,
    auth_role: "member",
    slack_user_id: "S001",
    whatsapp_number: null,
    whatsapp_lid: null,
    whatsapp_lid_attempted_at: null,
    whatsapp_lid_checked_at: null,
    description: "Product manager",
    type: "human",
    role: null,
    reports_to: null,
    tool_progress: null,
    reasoning_text: null,
    allowed_tools: null,
    timezone: null,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeInboxMessagesRepoMock() {
  return {
    create: vi.fn(),
    listPendingForRecipient: vi.fn(),
    hasPendingForRecipientByKind: vi.fn().mockResolvedValue(false),
    listPendingForRecipientByKind: vi.fn().mockResolvedValue([{ id: "inbox-1" }]),
    markConsumed: vi.fn(),
    findById: vi.fn(),
    findUnresolvedByRecipientAndKind: vi.fn(),
    updateWorkflow: vi.fn(),
    resolve: vi.fn(),
  };
}

function makeUserRepoMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    list: async () => [],
    findById: async () => undefined,
    getAllEmailsForUser: async () => [],
    findByEmail: async () => undefined,
    findBySlackId: async () => undefined,
    findByExactName: async () => undefined,
    searchByNamePrefix: async () => [],
    searchByNameSubstring: async () => [],
    ...overrides,
  };
}

describe("UploadCollector", () => {
  it("stores file paths via collect()", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file1.pdf");
    collector.collect("/workspace/file2.csv");
    expect(collector.drain()).toEqual(["/workspace/file1.pdf", "/workspace/file2.csv"]);
  });

  it("drain() clears the queue", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file.txt");
    collector.drain();
    expect(collector.drain()).toEqual([]);
  });
});

describe("createSketchMcpServer", () => {
  let tmpDir: string;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-upload-test-"));
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a valid MCP server config", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("sketch");
    expect(server.instance).toBeDefined();
  });

  it("keeps questions available in web chat and exposes them to capable channels only when enabled", () => {
    const questionCollector = new QuestionCollector();
    const capabilities = {
      available: true,
      interactiveSingleSelect: false,
      interactiveBatch: false,
      nativeCustomResponse: false,
      textFallback: true,
      cancelControl: false,
    };
    const registeredTools = (deps: Parameters<typeof createSketchMcpServer>[0]) =>
      (createSketchMcpServer(deps).instance as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools;

    const webTools = registeredTools({
      uploadCollector: new UploadCollector(),
      questionCollector,
      responseSurface: "web",
      workspaceDir: tmpDir,
    });
    const slackTools = registeredTools({
      uploadCollector: new UploadCollector(),
      questionCollector: new QuestionCollector(),
      responseSurface: "slack",
      questionInteractionCapabilities: capabilities,
      workspaceDir: tmpDir,
    });
    const unavailableWhatsAppTools = registeredTools({
      uploadCollector: new UploadCollector(),
      questionCollector: new QuestionCollector(),
      responseSurface: "whatsapp",
      questionInteractionCapabilities: { ...capabilities, available: false },
      workspaceDir: tmpDir,
    });

    expect(webTools.AskUserQuestion).toBeDefined();
    expect(webTools.AskUserQuestions).toBeDefined();
    expect(slackTools.AskUserQuestion).toBeDefined();
    expect(slackTools.AskUserQuestions).toBeDefined();
    expect(unavailableWhatsAppTools.AskUserQuestion).toBeUndefined();
    expect(unavailableWhatsAppTools.AskUserQuestions).toBeUndefined();
  });

  it("exposes the unified chat history tool", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools.ReadChatHistory).toBeDefined();
    expect(Object.keys(tools)).not.toContain(["Search", "Chat", "History"].join(""));
    expect(tools.WhatsAppGroupHistory).toBeUndefined();
    expect(tools.SlackChannelHistory).toBeUndefined();
  });

  it("does not expose integration card rendering tools", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

    expect(tools.RequestIntegrationConnection).toBeUndefined();
    expect(tools.SearchIntegrationApps).toBeUndefined();
  });

  it("forwards automation artifacts from the scheduled task tool", async () => {
    const uploadCollector = new UploadCollector();
    const automationArtifactCollector = new AutomationArtifactCollector();
    const scheduler = {
      refreshTaskSchedule: vi.fn().mockImplementation(async (id: string) => ({
        id,
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        prompt: "Daily account brief",
        scheduleType: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: "user-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        title: null,
        description: null,
        originChat: null,
        steps: null,
        edges: null,
        outputTarget: "D123",
        outputPlatform: "slack",
        outputThreadTs: null,
        outputMode: "deliver",
        delivery: {
          platform: "slack",
          targetType: "dm",
          targetId: "D123",
          threadTs: null,
          mode: "deliver",
        },
      })),
    };
    const server = createSketchMcpServer({
      uploadCollector,
      automationArtifactCollector,
      workspaceDir: tmpDir,
      db,
      scheduler: scheduler as never,
      taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D123", createdBy: "user-1" },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown> }>;
      }
    )._registeredTools;

    await tools.ManageScheduledTasks.handler({
      action: "add",
      prompt: "Daily account brief",
      schedule_type: "cron",
      schedule_value: "0 9 * * 1",
    });

    const artifacts = automationArtifactCollector.drain();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual(
      expect.objectContaining({
        taskId: expect.any(String),
        builderUrl: expect.stringMatching(/^http:\/\/localhost:3000\/scheduled-tasks\/[^/]+\/edit$/),
      }),
    );
  });

  it("passes the settings encryption key to native webhook automation persistence", async () => {
    const uploadCollector = new UploadCollector();
    const scheduler = {
      refreshTaskSchedule: vi.fn().mockImplementation(async (id: string) => ({
        id,
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        prompt: "Process inbound events.",
        scheduleType: "external",
        scheduleValue: "webhook",
        timezone: "UTC",
        sessionMode: "fresh",
        nextRunAt: null,
        lastRunAt: null,
        status: "active",
        createdBy: "user-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        title: "Inbound webhook",
        description: null,
        originChat: null,
        steps: null,
        edges: null,
        outputTarget: "D123",
        outputPlatform: "slack",
        outputThreadTs: null,
        outputMode: "deliver",
        delivery: {
          platform: "slack",
          targetType: "dm",
          targetId: "D123",
          threadTs: null,
          mode: "deliver",
        },
      })),
      executeTaskById: vi.fn().mockResolvedValue({ status: "completed", aborted: false }),
    };
    const server = createSketchMcpServer({
      uploadCollector,
      workspaceDir: tmpDir,
      db,
      settingsEncryptionKey: ENCRYPTION_KEY,
      scheduler: scheduler as never,
      taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D123", createdBy: "user-1" },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }
        >;
      }
    )._registeredTools;

    const result = await tools.ManageScheduledTasks.handler({
      action: "add",
      title: "Inbound webhook",
      prompt: "Process inbound events.",
      schedule_type: "external",
      schedule_value: "webhook",
    });

    expect(result.content[0].text).toContain("Automation created:");
    await expect(db.selectFrom("webhook_endpoints").select("status").executeTakeFirst()).resolves.toMatchObject({
      status: "active",
    });
  });

  it("ReadChatHistory caps reads at the current conversation message cursor", async () => {
    const collector = new UploadCollector();
    const listMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 7,
          conversationId: 1,
          providerMessageId: "m1",
          senderJid: "U1",
          senderName: "Alice",
          senderUserId: "user-1",
          isBot: false,
          addressedToSketch: false,
          text: "launch budget approved",
          attachments: [],
          providerThreadId: "thread-1",
          providerParentMessageId: null,
          isThreadReply: false,
          providerTimestamp: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      hasMore: false,
    });
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      conversationRepo: { listMessages } as never,
      conversationContext: { conversationId: 1, currentMessageId: 12, providerThreadId: "thread-1" },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (input: { scope?: "conversation" | "current_thread" }) => Promise<{ content: { text: string }[] }>;
          }
        >;
      }
    )._registeredTools;

    const result = await tools.ReadChatHistory.handler({ scope: "current_thread" });

    expect(listMessages).toHaveBeenCalledWith(1, {
      afterMessageId: undefined,
      beforeMessageId: 12,
      limit: undefined,
      order: undefined,
      includeBotMessages: undefined,
      providerThreadId: "thread-1",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      messages: [{ id: 7, text: "launch budget approved", providerThreadId: "thread-1" }],
      hasMore: false,
    });
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("olderPageToken");
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("newerPageToken");
  });

  it("ReadChatHistory treats blank optional strings as omitted", async () => {
    const collector = new UploadCollector();
    const listMessages = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      conversationRepo: { listMessages } as never,
      conversationContext: { conversationId: 1, currentMessageId: 12 },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }
        >;
      }
    )._registeredTools;

    const result = await tools.ReadChatHistory.handler({
      conversationRef: "",
      anchorMessageId: 1,
      pageToken: "",
      scope: "all_chats",
      afterTime: "",
      beforeTime: "",
      platform: "slack",
      limit: 20,
      order: "asc",
      includeBotMessages: false,
    });

    expect(result.content[0].text).not.toContain("ISO-8601");
    expect(result.content[0].text).not.toContain("cannot be combined");
    expect(result.content[0].text).not.toContain("pageToken can only be combined");
  });

  it("ReadChatHistory keeps top-level Slack history separate from thread replies", async () => {
    const collector = new UploadCollector();
    const listMessages = vi.fn().mockResolvedValue({ messages: [], hasMore: false });
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      conversationRepo: { listMessages } as never,
      conversationContext: { conversationId: 1, currentMessageId: 12, isThreadReply: false },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (input: { scope?: "conversation" | "current_thread" }) => Promise<{ content: { text: string }[] }>;
          }
        >;
      }
    )._registeredTools;

    await tools.ReadChatHistory.handler({});

    expect(listMessages).toHaveBeenCalledWith(1, {
      afterMessageId: undefined,
      beforeMessageId: 12,
      limit: undefined,
      order: undefined,
      includeBotMessages: undefined,
      providerThreadId: undefined,
      isThreadReply: false,
    });
  });

  it("does not expose TranscribeAudio when transcription is disabled", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools.TranscribeAudio).toBeUndefined();
  });

  it("exposes TranscribeAudio when transcription is enabled", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      transcriptionEnabled: true,
    });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools.TranscribeAudio).toBeDefined();
  });

  it("TranscribeAudio validates workspace paths", async () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      transcriptionEnabled: true,
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: { file_path: string }) => Promise<{ content: { text: string }[] }> }
        >;
      }
    )._registeredTools;

    const result = await tools.TranscribeAudio.handler({ file_path: "/tmp/outside.ogg" });
    expect(result.content[0].text).toContain("must be within");
  });

  it("does not expose VisualAnalysis when vision analysis is disabled", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools.VisualAnalysis).toBeUndefined();
  });

  it("exposes VisualAnalysis when vision analysis is enabled", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      visionAnalysisEnabled: true,
      visionConfig: {
        apiKey: "sk-or-vision",
        model: "xiaomi/mimo-v2.5",
        source: "env",
        providerMode: "env",
      },
    });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools.VisualAnalysis).toBeDefined();
  });

  it("VisualAnalysis validates workspace paths", async () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({
      uploadCollector: collector,
      workspaceDir: tmpDir,
      visionAnalysisEnabled: true,
      visionConfig: {
        apiKey: "sk-or-vision",
        model: "xiaomi/mimo-v2.5",
        source: "env",
        providerMode: "env",
      },
    });
    const tools = (
      server.instance as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: { file_path: string; question: string }) => Promise<{ content: { text: string }[] }> }
        >;
      }
    )._registeredTools;

    const result = await tools.VisualAnalysis.handler({
      file_path: "/tmp/outside.png",
      question: "What is in this image?",
    });
    expect(result.content[0].text).toContain("must be within");
  });

  it("VisualAnalysis accepts image files without image extensions", async () => {
    const imagePath = join(tmpDir, "image.bin");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The file is a PNG image." } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const collector = new UploadCollector();
      const server = createSketchMcpServer({
        uploadCollector: collector,
        workspaceDir: tmpDir,
        visionAnalysisEnabled: true,
        visionConfig: {
          apiKey: "sk-or-vision",
          model: "xiaomi/mimo-v2.5",
          source: "env",
          providerMode: "env",
        },
      });
      const tools = (
        server.instance as unknown as {
          _registeredTools: Record<
            string,
            { handler: (input: { file_path: string; question: string }) => Promise<{ content: { text: string }[] }> }
          >;
        }
      )._registeredTools;

      const result = await tools.VisualAnalysis.handler({
        file_path: imagePath,
        question: "What is this?",
      });

      expect(result.content[0].text).toBe("The file is a PNG image.");
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("handleGetTeamDirectory", () => {
  it("includes the current user and distinguishes workspace access from org role", async () => {
    const alice = makeUser({ id: "user-alice", name: "Alice", auth_role: "admin", role: "Engineering Lead" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });
    const result = await handleGetTeamDirectory({
      userRepo: makeUserRepoMock({
        list: async () => [alice, bob],
        findById: async () => undefined,
      }),
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user-alice",
          name: "Alice",
          role: "Engineering Lead",
          workspaceRole: "admin",
          isCurrentUser: true,
        }),
        expect.objectContaining({
          id: "user-bob",
          name: "Bob",
          workspaceRole: "member",
          isCurrentUser: false,
        }),
      ]),
    );
  });

  it("returns channels from the recipient's connected accounts", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: "S999", whatsapp_number: "+1234567890" });
    const result = await handleGetTeamDirectory({
      userRepo: makeUserRepoMock({
        list: async () => [user],
        findById: async () => undefined,
      }),
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].channels).toEqual(["slack", "whatsapp"]);
  });

  it("returns an error when userRepo is unavailable", async () => {
    const result = await handleGetTeamDirectory({ userRepo: undefined, currentUserId: "user-alice" });
    expect(result.content[0].text).toBe("Team directory not available.");
  });
});

describe("handleSetUserTimezone", () => {
  it("persists a valid IANA timezone for the current user", async () => {
    const update = vi.fn().mockResolvedValue(makeUser({ id: "user-alice", timezone: "Asia/Kolkata" }));
    const result = await handleSetUserTimezone(
      { timezone: "Asia/Kolkata" },
      { userRepo: makeUserRepoMock({ update }), currentUserId: "user-alice" },
    );

    expect(update).toHaveBeenCalledWith("user-alice", { timezone: "Asia/Kolkata" });
    expect(result.content[0].text).toBe("Timezone set to Asia/Kolkata.");
  });

  it("trims whitespace before validating", async () => {
    const update = vi.fn().mockResolvedValue(makeUser({ id: "user-alice", timezone: "Europe/London" }));
    const result = await handleSetUserTimezone(
      { timezone: "  Europe/London  " },
      { userRepo: makeUserRepoMock({ update }), currentUserId: "user-alice" },
    );

    expect(update).toHaveBeenCalledWith("user-alice", { timezone: "Europe/London" });
    expect(result.content[0].text).toBe("Timezone set to Europe/London.");
  });

  it("rejects an invalid timezone without persisting", async () => {
    const update = vi.fn();
    const result = await handleSetUserTimezone(
      { timezone: "Not/Real" },
      { userRepo: makeUserRepoMock({ update }), currentUserId: "user-alice" },
    );

    expect(update).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("not a valid IANA timezone");
  });

  it("rejects an empty timezone string", async () => {
    const update = vi.fn();
    const result = await handleSetUserTimezone(
      { timezone: "   " },
      { userRepo: makeUserRepoMock({ update }), currentUserId: "user-alice" },
    );

    expect(update).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Error: timezone is required.");
  });

  it("returns an error when userRepo or currentUserId is missing", async () => {
    const result = await handleSetUserTimezone(
      { timezone: "Asia/Kolkata" },
      { userRepo: undefined, currentUserId: "user-alice" },
    );
    expect(result.content[0].text).toBe("Timezone update is not available in this context.");
  });
});

describe("handleSendMessage", () => {
  it("sends a visible DM and stores the same message in inbox", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "S999" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    const createInboxMessage = vi.fn().mockResolvedValue({ id: "inbox-1" });

    const result = await handleSendMessage(
      { recipientUserId: "user-bob", message: "Need your latest update." },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-bob" ? bob : undefined) }),
        sendDm,
        currentUserId: "user-alice",
      },
    );

    expect(sendDm).toHaveBeenCalledWith({
      userId: "user-bob",
      platform: "slack",
      message: "Need your latest update.",
    });
    expect(createInboxMessage).toHaveBeenCalledWith({
      senderUserId: "user-alice",
      recipientUserId: "user-bob",
      message: "Need your latest update.",
      platform: "slack",
      channelId: "D123",
      messageRef: "1111.0001",
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      inboxMessageId: "inbox-1",
      recipientName: "Bob",
      status: "sent",
    });
  });

  it("routes to WhatsApp when that is the recipient's only connected channel", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: null, whatsapp_number: "+1234567890" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "1234567890@s.whatsapp.net", messageRef: "" });
    const createInboxMessage = vi.fn().mockResolvedValue({ id: "inbox-1" });

    await handleSendMessage(
      { recipientUserId: "user-bob", message: "Need your latest update." },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-bob" ? bob : undefined) }),
        sendDm,
        currentUserId: "user-alice",
      },
    );

    expect(sendDm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-bob",
        platform: "whatsapp",
        message: "Need your latest update.",
        senderUserId: "user-alice",
        storeInInbox: true,
        inboxKind: "note",
      }),
    );
    expect(createInboxMessage).toHaveBeenCalledWith({
      senderUserId: "user-alice",
      recipientUserId: "user-bob",
      message: "Need your latest update.",
      platform: "whatsapp",
      channelId: "1234567890@s.whatsapp.net",
      messageRef: "",
    });
  });

  it("rejects sending to self", async () => {
    const result = await handleSendMessage(
      { recipientUserId: "user-alice", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toBe("Error: cannot send a message to yourself.");
  });

  it("rejects unknown recipients", async () => {
    const result = await handleSendMessage(
      { recipientUserId: "user-ghost", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toBe("Error: user not found.");
  });

  it("uses the parked WhatsApp inbox row when sendDm returns one", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: null, whatsapp_number: "+1234567890" });
    const sendDm = vi.fn().mockResolvedValue({
      channelId: "dm:+1234567890",
      messageRef: "wa-nudge-1",
      inboxMessageId: "inbox-parked",
    });
    const createInboxMessage = vi.fn().mockResolvedValue({ id: "inbox-1" });

    const result = await handleSendMessage(
      { recipientUserId: "user-bob", message: "Need your latest update." },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-bob" ? bob : undefined) }),
        sendDm,
        currentUserId: "user-alice",
      },
    );

    expect(createInboxMessage).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ inboxMessageId: "inbox-parked", status: "sent" });
  });
  it("rejects recipients with no connected channel", async () => {
    const charlie = makeUser({ id: "user-charlie", name: "Charlie", slack_user_id: null, whatsapp_number: null });
    const result = await handleSendMessage(
      { recipientUserId: "user-charlie", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-charlie" ? charlie : undefined) }),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toContain("no connected channel");
  });

  it("returns an error when messaging deps are missing", async () => {
    const result = await handleSendMessage(
      { recipientUserId: "user-bob", message: "hi" },
      {
        inboxMessagesRepo: undefined,
        userRepo: undefined,
        sendDm: undefined,
        currentUserId: undefined,
      },
    );

    expect(result.content[0].text).toBe("Error: messaging is not available in this context.");
  });
});

describe("handleSendMessage to a channel or group", () => {
  const slackTarget = { platform: "slack" as const, targetType: "channel" as const, targetId: "C123" };
  const whatsappTarget = { platform: "whatsapp" as const, targetType: "group" as const, targetId: "12345@g.us" };

  function accessAllowing(...keys: string[]) {
    return { authorizedProviderTargets: async () => new Set(keys) };
  }

  function targetDeps(overrides: Partial<Parameters<typeof handleSendMessage>[1]> = {}) {
    return {
      db: {} as unknown as NonNullable<Parameters<typeof handleSendMessage>[1]["db"]>,
      currentUserId: "user-alice",
      sendTargetMessage: vi.fn().mockResolvedValue({ messageRef: "1700000000.0001" }),
      ...overrides,
    };
  }

  it("rejects setting both recipientUserId and target", async () => {
    const result = await handleSendMessage(
      { recipientUserId: "user-bob", target: slackTarget, message: "hi" },
      targetDeps(),
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toBe("Error: set only one of recipientUserId or target, not both.");
  });

  it("rejects setting neither recipientUserId nor target", async () => {
    const result = await handleSendMessage({ message: "hi" }, targetDeps(), accessAllowing());

    expect(result.content[0].text).toContain("set exactly one of recipientUserId");
  });

  it("rejects a blank message on both addressing modes", async () => {
    const deps = targetDeps();
    const dm = await handleSendMessage({ recipientUserId: "user-bob", message: "   " }, deps, accessAllowing());
    const channel = await handleSendMessage({ target: slackTarget, message: "" }, deps, accessAllowing("slack:C123"));

    expect(dm.content[0].text).toBe("Error: message must not be empty.");
    expect(channel.content[0].text).toBe("Error: message must not be empty.");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects a blank message for bulk DMs", async () => {
    const sendDm = vi.fn();
    const result = await handleSendMessageToUsers(
      { recipientUserIds: ["user-bob"], message: " " },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm,
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toBe("Error: message must not be empty.");
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("treats an empty recipientUserId alongside a target as both being set", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { recipientUserId: "", target: slackTarget, message: "hi" },
      deps,
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toBe("Error: set only one of recipientUserId or target, not both.");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty recipientUserId", async () => {
    const result = await handleSendMessage({ recipientUserId: "  ", message: "hi" }, targetDeps(), accessAllowing());

    expect(result.content[0].text).toContain("recipientUserId must not be empty");
  });

  it("rejects an empty threadTs on a Slack channel target", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: slackTarget, threadTs: "", message: "hi" },
      deps,
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toContain("threadTs must not be empty");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("does not let the current conversation context bypass a membership denial", async () => {
    const deps = targetDeps({
      conversationContext: { conversationId: 42, providerThreadId: null, isThreadReply: false },
    });
    const result = await handleSendMessage({ target: slackTarget, message: "hi" }, deps, accessAllowing());

    expect(result.content[0].text).toContain("not a known member of that channel or group");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects a Slack target that is not a channel", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: { platform: "slack", targetType: "group", targetId: "C123" }, message: "hi" },
      deps,
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toBe("Error: A Slack target must use targetType 'channel'.");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects a WhatsApp target that is not a group", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: { platform: "whatsapp", targetType: "channel", targetId: "12345@g.us" }, message: "hi" },
      deps,
      accessAllowing("whatsapp:12345@g.us"),
    );

    expect(result.content[0].text).toBe("Error: A WhatsApp target must use targetType 'group'.");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects threadTs on a WhatsApp target", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: whatsappTarget, threadTs: "1700000000.0001", message: "hi" },
      deps,
      accessAllowing("whatsapp:12345@g.us"),
    );

    expect(result.content[0].text).toBe("Error: threadTs can only be used with a Slack channel target.");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("rejects threadTs on a DM", async () => {
    const result = await handleSendMessage(
      { recipientUserId: "user-bob", threadTs: "1700000000.0001", message: "hi" },
      {
        ...targetDeps(),
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm: vi.fn(),
      },
      accessAllowing(),
    );

    expect(result.content[0].text).toBe("Error: threadTs can only be used with a Slack channel target.");
  });

  it("does not send when the requester is not a member of the target", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage({ target: slackTarget, message: "hi" }, deps, accessAllowing());

    expect(result.content[0].text).toContain("not a known member of that channel or group");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });

  it("posts to an authorized Slack channel", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: slackTarget, message: "deploy is green" },
      deps,
      accessAllowing("slack:C123"),
    );

    expect(deps.sendTargetMessage).toHaveBeenCalledWith({
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      message: "deploy is green",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "sent",
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      messageRef: "1700000000.0001",
    });
  });

  it("passes threadTs through for a Slack thread reply", async () => {
    const deps = targetDeps();
    const result = await handleSendMessage(
      { target: slackTarget, threadTs: "1699999999.0002", message: "in thread" },
      deps,
      accessAllowing("slack:C123"),
    );

    expect(deps.sendTargetMessage).toHaveBeenCalledWith({
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      message: "in thread",
      threadTs: "1699999999.0002",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ threadTs: "1699999999.0002" });
  });

  it("posts to an authorized WhatsApp group", async () => {
    const deps = targetDeps();
    await handleSendMessage(
      { target: whatsappTarget, message: "standup in 5" },
      deps,
      accessAllowing("whatsapp:12345@g.us"),
    );

    expect(deps.sendTargetMessage).toHaveBeenCalledWith({
      platform: "whatsapp",
      targetType: "group",
      targetId: "12345@g.us",
      message: "standup in 5",
    });
  });

  it("never stores an inbox item for a channel send", async () => {
    const createInboxMessage = vi.fn();
    await handleSendMessage(
      { target: slackTarget, message: "hi" },
      { ...targetDeps(), inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage } },
      accessAllowing("slack:C123"),
    );

    expect(createInboxMessage).not.toHaveBeenCalled();
  });

  it("returns a clear error when channel delivery is not wired up", async () => {
    const result = await handleSendMessage(
      { target: slackTarget, message: "hi" },
      { ...targetDeps(), sendTargetMessage: undefined },
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toBe("Error: Sending to a channel or group is not available in this context.");
  });

  it("reports a delivery failure instead of throwing", async () => {
    const result = await handleSendMessage(
      { target: slackTarget, message: "hi" },
      { ...targetDeps(), sendTargetMessage: vi.fn().mockRejectedValue(new Error("Slack bot is not connected")) },
      accessAllowing("slack:C123"),
    );

    expect(result.content[0].text).toBe("Error: Slack bot is not connected");
  });

  it("denies a target send when there is no authenticated requester", async () => {
    const deps = targetDeps({ currentUserId: undefined });
    const result = await handleSendMessage({ target: slackTarget, message: "hi" }, deps, accessAllowing("slack:C123"));

    expect(result.content[0].text).toContain("requires an authenticated requesting user");
    expect(deps.sendTargetMessage).not.toHaveBeenCalled();
  });
});

describe("registered messaging tools", () => {
  it("keeps the DM tool from posting to a shared destination at runtime", async () => {
    const { createMessagingTools } = await import("./tools/messaging");
    const tools = createMessagingTools({
      currentUserId: "user-alice",
      workspaceDir: "/tmp/workspace",
      uploadCollector: new UploadCollector(),
      sendTargetMessage: vi.fn(),
    });
    const dmTool = tools.find((entry) => entry.name === "SendMessage");

    const result = await dmTool?.handler(
      {
        message: "post this",
        target: { platform: "slack", targetType: "channel", targetId: "C123" },
      } as never,
      {} as never,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: channel and group posting requires SendMessageToTarget." }],
    });
  });

  it("keeps channel and group posting available through the separate tool", async () => {
    const slackTarget = { platform: "slack" as const, targetType: "channel" as const, targetId: "C123" };
    const deps = {
      db: {} as unknown as NonNullable<Parameters<typeof handleSendMessageToTarget>[1]["db"]>,
      currentUserId: "user-alice",
      sendTargetMessage: vi.fn().mockResolvedValue({ messageRef: "1700000000.0001" }),
    };
    const result = await handleSendMessageToTarget({ target: slackTarget, message: "post this" }, deps, {
      authorizedProviderTargets: async () => new Set(["slack:C123"]),
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "sent", targetId: "C123" });
  });
});

describe("handleSearchUsers", () => {
  it("returns ranked matches across Slack ID, email, exact name, prefix, and substring", async () => {
    const alice = makeUser({
      id: "user-alice",
      name: "Alice Johnson",
      email: "alice@acme.com",
      slack_user_id: "U12345",
    });
    const result = await handleSearchUsers(
      { queries: ["<@U12345>", "alice@acme.com", "Alice Johnson", "Alice", "john"] },
      {
        userRepo: makeUserRepoMock({
          findBySlackId: async (slackUserId: string) => (slackUserId === "U12345" ? alice : undefined),
          findByEmail: async (email: string) => (email === "alice@acme.com" ? alice : undefined),
          findByExactName: async (name: string) => (name === "Alice Johnson" ? alice : undefined),
          searchByNamePrefix: async (query: string) => (query === "Alice" ? [alice] : []),
          searchByNameSubstring: async (query: string) => (query === "john" ? [alice] : []),
        }),
        currentUserId: "user-admin",
      },
    );

    expect(JSON.parse(result.content[0].text)).toEqual({
      results: [
        { query: "<@U12345>", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "slack_user_id" })] },
        { query: "alice@acme.com", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "exact_email" })] },
        { query: "Alice Johnson", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "exact_name" })] },
        { query: "Alice", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "prefix_name" })] },
        { query: "john", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "substring_name" })] },
      ],
    });
  });
});

describe("handleSendMessageToUsers", () => {
  it("sends the same message to multiple recipients and reports per-user results", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "U111" });
    const charlie = makeUser({ id: "user-charlie", name: "Charlie", slack_user_id: null, whatsapp_number: null });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    const createInboxMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: "inbox-1" })
      .mockResolvedValueOnce({ id: "inbox-2" });

    const result = await handleSendMessageToUsers(
      { recipientUserIds: ["user-bob", "user-bob", "user-charlie"], message: "Hello team", storeInInbox: true },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({
          findById: async (id: string) => {
            if (id === "user-bob") return bob;
            if (id === "user-charlie") return charlie;
            return undefined;
          },
        }),
        sendDm,
        currentUserId: "user-admin",
      },
    );

    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({
      results: [
        {
          recipientUserId: "user-bob",
          recipientName: "Bob",
          status: "sent",
          platform: "slack",
          inboxMessageId: "inbox-1",
        },
        {
          recipientUserId: "user-bob",
          status: "skipped",
          error: "Duplicate recipient in request",
        },
        {
          recipientUserId: "user-charlie",
          recipientName: "Charlie",
          status: "failed",
          error: "Charlie has no connected channel (Slack or WhatsApp).",
        },
      ],
    });
  });
});

describe("handleUpdateInboxWorkflow", () => {
  it("updates explicit inbox workflows for the current user", async () => {
    const findById = vi.fn().mockResolvedValue({
      id: "inbox-1",
      recipient_user_id: "user-alice",
      resolution_mode: "explicit",
      resolved_at: null,
    });
    const updateWorkflow = vi.fn().mockResolvedValue({
      id: "inbox-1",
      metadata: JSON.stringify({ stage: "awaiting_confirmation" }),
    });

    const result = await handleUpdateInboxWorkflow(
      { inboxMessageId: "inbox-1", metadata: { stage: "awaiting_confirmation" } },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), findById, updateWorkflow },
        currentUserId: "user-alice",
      },
    );

    expect(updateWorkflow).toHaveBeenCalledWith("inbox-1", { stage: "awaiting_confirmation" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      inboxMessageId: "inbox-1",
      status: "updated",
      metadata: { stage: "awaiting_confirmation" },
    });
  });
});

describe("handleResolveInboxWorkflow", () => {
  it("resolves explicit inbox workflows for the current user", async () => {
    const resolve = vi.fn().mockResolvedValue({
      id: "inbox-1",
      resolved_at: "2026-04-20T10:00:00.000Z",
    });

    const result = await handleResolveInboxWorkflow(
      { inboxMessageId: "inbox-1" },
      {
        inboxMessagesRepo: {
          ...makeInboxMessagesRepoMock(),
          findById: vi.fn().mockResolvedValue({
            id: "inbox-1",
            recipient_user_id: "user-alice",
            resolution_mode: "explicit",
            resolved_at: null,
          }),
          resolve,
        },
        currentUserId: "user-alice",
      },
    );

    expect(resolve).toHaveBeenCalledWith("inbox-1");
    expect(JSON.parse(result.content[0].text)).toEqual({
      inboxMessageId: "inbox-1",
      status: "resolved",
    });
  });
});

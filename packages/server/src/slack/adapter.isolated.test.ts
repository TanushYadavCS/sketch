import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_TOO_LONG_RECOVERY_MESSAGE, PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE } from "../agent/errors";
import { NEW_SESSION_CONFIRMATIONS } from "../commands";
import { downloadSlackFile } from "../files";
import { QueueManager } from "../queue";
import { createTestConfig, flush } from "../test-utils";
import { transcribeEagerAttachments } from "../transcription/service";
import type { SlackAdapterDeps } from "./adapter";
import { createConfiguredSlackBot, validateSlackTokens } from "./adapter";

// --- Fixtures ---

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Alice",
    email: "alice@test.com",
    password_hash: null,
    auth_role: "member",
    slack_user_id: "S1",
    whatsapp_number: null,
    created_at: "2025-01-01",
    email_verified_at: null,
    description: null,
    type: "human",
    role: null,
    reports_to: null,
    tool_progress: null,
    reasoning_text: null,
    allowed_tools: null,
    timezone: null,
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch1",
    name: "general",
    slack_channel_id: "C1",
    type: "channel",
    tool_progress: null,
    reasoning_text: null,
    agent_user_id: null,
    created_at: "2025-01-01",
    ...overrides,
  };
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    platform: "slack",
    kind: "channel",
    provider_conversation_id: "C1",
    display_name: "general",
    last_seen_message_id: null,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function makeStoredMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    conversationId: 1,
    providerMessageId: "1",
    senderJid: "S1",
    senderName: "Alice",
    senderUserId: "u1",
    isBot: false,
    addressedToSketch: true,
    text: "hello",
    attachments: [],
    providerThreadId: null,
    providerParentMessageId: null,
    isThreadReply: false,
    providerTimestamp: null,
    receivedAt: "2025-01-01",
    createdAt: "2025-01-01",
    ...overrides,
  };
}

function makeConversationsRepo() {
  const conversation = makeConversation();
  return {
    getOrCreate: vi.fn().mockResolvedValue(conversation),
    find: vi.fn().mockResolvedValue(conversation),
    insertMessage: vi.fn().mockImplementation(async (data) => ({
      row: makeStoredMessage({
        id: data.providerMessageId === "reply-ts" ? 2 : 1,
        conversationId: data.conversationId,
        providerMessageId: data.providerMessageId,
        senderJid: data.senderJid,
        senderName: data.senderName,
        senderUserId: data.senderUserId ?? null,
        isBot: Boolean(data.isBot),
        addressedToSketch: Boolean(data.addressedToSketch),
        text: data.text ?? "",
        attachments: data.attachments ?? [],
        providerThreadId: data.providerThreadId ?? null,
        providerParentMessageId: data.providerParentMessageId ?? null,
        isThreadReply: Boolean(data.isThreadReply),
        providerTimestamp: data.providerTimestamp ?? null,
      }),
      inserted: true,
    })),
    listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false, nextCursor: undefined }),
    listBacklog: vi.fn().mockResolvedValue({ messages: [], hasMore: false, nextCursor: undefined }),
    getMaxMessageId: vi.fn().mockResolvedValue(null),
    updateWatermark: vi.fn().mockResolvedValue(conversation),
    advanceWatermarkToCurrentMax: vi.fn().mockResolvedValue(conversation),
    getCursor: vi.fn().mockResolvedValue(undefined),
    updateCursor: vi.fn().mockResolvedValue({
      id: 1,
      conversation_id: 1,
      scope_type: "slack_thread",
      scope_key: "1",
      last_seen_message_id: 1,
      created_at: "2025-01-01",
      updated_at: "2025-01-01",
    }),
    advanceCursorToCurrentMax: vi.fn().mockResolvedValue({
      id: 1,
      conversation_id: 1,
      scope_type: "slack_thread",
      scope_key: "1",
      last_seen_message_id: 1,
      created_at: "2025-01-01",
      updated_at: "2025-01-01",
    }),
  };
}

function makeAgentResult(overrides: Record<string, unknown> = {}) {
  return {
    messageSent: true,
    sessionId: "sess-1",
    costUsd: 0.01,
    pendingUploads: [],
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
    promptMode: "text",
    toolCalls: [],
    trace: { progressEvents: [], finalText: "hello back" },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SlackAdapterDeps> = {}): SlackAdapterDeps {
  return {
    db: {} as SlackAdapterDeps["db"],
    config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error" }),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as SlackAdapterDeps["logger"],
    repos: {
      users: {
        findBySlackId: vi.fn().mockResolvedValue(makeUser()),
        findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
        findByEmail: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockImplementation(async (data) => makeUser({ id: "new-u", ...data })),
        update: vi.fn().mockImplementation(async (id, data) => makeUser({ id, ...data })),
      } as unknown as SlackAdapterDeps["repos"]["users"],
      channels: {
        findBySlackChannelId: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockImplementation(async (data) => makeChannel({ ...data })),
        update: vi.fn().mockImplementation(async (id, data) => makeChannel({ id, ...data })),
      } as unknown as SlackAdapterDeps["repos"]["channels"],
      settings: {
        get: vi.fn().mockResolvedValue({
          slack_bot_token: "xoxb-test",
          slack_app_token: "xapp-test",
          org_name: "TestOrg",
          bot_name: "TestBot",
        }),
      } as unknown as SlackAdapterDeps["repos"]["settings"],
      conversations: makeConversationsRepo() as unknown as SlackAdapterDeps["repos"]["conversations"],
    },
    queue: new QueueManager(),
    slack: {
      userCache: {
        resolve: vi.fn().mockImplementation(async (_id, fetcher) => fetcher(_id)),
      } as unknown as SlackAdapterDeps["slack"]["userCache"],
    },
    runAgent: vi.fn().mockResolvedValue({
      ...makeAgentResult(),
    }),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    inboxMessagesRepo: {
      listPendingForRecipient: vi.fn().mockResolvedValue([]),
      markConsumed: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
    } as unknown as SlackAdapterDeps["inboxMessagesRepo"],
    sendDm: vi.fn().mockResolvedValue({ channelId: "D_outreach", messageRef: "outreach-ts" }),
    ...overrides,
  };
}

// --- SlackBot mock via vi.mock with proper class syntax ---

let mockBotInstance: Record<string, ReturnType<typeof vi.fn>> = {};

function freshMockBot() {
  return {
    onMessage: vi.fn(),
    onChannelMessage: vi.fn(),
    onThreadMessage: vi.fn(),
    onChannelMention: vi.fn(),
    onAppHomeOpened: vi.fn(),
    onHomeAction: vi.fn(),
    publishHomeView: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue("new-ts"),
    postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    getUserInfo: vi.fn().mockResolvedValue({ name: "alice", realName: "Alice", email: "alice@test.com" }),
    getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "channel" }),
    getChannelHistory: vi.fn().mockResolvedValue([]),
    getThreadReplies: vi.fn().mockResolvedValue([]),
    uploadFile: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock("./bot", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SlackBot: class MockSlackBot {
      constructor() {
        Object.assign(this, mockBotInstance);
      }
    },
  };
});

// Stub file download to avoid filesystem access
vi.mock("../files", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    downloadSlackFile: vi.fn().mockResolvedValue({
      originalName: "test.txt",
      mimeType: "text/plain",
      localPath: "/tmp/test.txt",
      sizeBytes: 100,
    }),
  };
});

vi.mock("../transcription/service", () => ({
  transcribeEagerAttachments: vi.fn(async (attachments) => attachments),
}));

// Stub workspace to avoid filesystem access
vi.mock("../agent/workspace", () => ({
  ensureWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/u1"),
  ensureChannelWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/channel-C1"),
  ensureGroupWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/wa-group-g1"),
  ensureAgentSubWorkspace: vi
    .fn()
    .mockImplementation(async (_config, agentId, subKey) => `/tmp/test-data/workspaces/agent-${agentId}/${subKey}`),
}));

// Stub session to avoid filesystem access
vi.mock("../agent/sessions", () => ({
  getSessionId: vi.fn().mockResolvedValue(undefined),
  saveSessionId: vi.fn().mockResolvedValue(undefined),
  deleteSessionId: vi.fn().mockResolvedValue(undefined),
}));

// Stub slack API for validateSlackTokens
vi.mock("./api", () => ({
  slackApiCall: vi.fn().mockResolvedValue({}),
}));

function getHandlers() {
  return {
    dm: mockBotInstance.onMessage.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
    channel: mockBotInstance.onChannelMessage.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
    thread: mockBotInstance.onThreadMessage.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
    mention: mockBotInstance.onChannelMention.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
  };
}

describe("slack/adapter", () => {
  beforeEach(() => {
    mockBotInstance = freshMockBot();
    vi.mocked(transcribeEagerAttachments).mockClear();
    vi.mocked(transcribeEagerAttachments).mockImplementation(async (attachments) => attachments);
    vi.mocked(downloadSlackFile).mockClear();
  });

  describe("createConfiguredSlackBot", () => {
    it("registers DM, passive channel, thread, and channel mention handlers", () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      expect(mockBotInstance.onMessage).toHaveBeenCalledOnce();
      expect(mockBotInstance.onChannelMessage).toHaveBeenCalledOnce();
      expect(mockBotInstance.onThreadMessage).toHaveBeenCalledOnce();
      expect(mockBotInstance.onChannelMention).toHaveBeenCalledOnce();
    });
  });

  describe("DM handler", () => {
    it("resolves user, runs agent, and posts response", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("hello");
      expect(agentCall.platform).toBe("slack");
      expect(agentCall.userName).toBe("Alice");
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "new-ts",
          senderJid: "bot",
          senderName: "TestBot",
          isBot: true,
          text: "hello back",
        }),
      );
    });

    it("replies with an identity-mapping error when Slack resolution conflicts", async () => {
      const baseDeps = makeDeps();
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(undefined),
            findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
            findByEmail: vi.fn().mockResolvedValue(makeUser({ id: "u-existing", slack_user_id: "S_EXISTING" })),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["users"],
        },
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith(
        "D1",
        expect.stringContaining("conflicts with an existing Sketch identity"),
      );
    });

    it("uploads pending files after agent run", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockResolvedValue(makeAgentResult({ pendingUploads: ["/tmp/out.pdf"] })),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "make pdf", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.uploadFile).toHaveBeenCalledWith("D1", "/tmp/out.pdf", undefined);
    });

    it("clears the shimmer and posts an error reply on agent error", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("D1", "1", "");
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_Something went wrong, try again_");
    });

    it("tells DM users to start a new session when the prompt is too long", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("Claude Code returned an error result: Prompt is too long")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("D1", "1", "");
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", PROMPT_TOO_LONG_RECOVERY_MESSAGE);
    });

    it("clears the shimmer when pre-runAgent setup throws (e.g. buildMcpServers)", async () => {
      const deps = makeDeps({
        buildMcpServers: vi.fn().mockRejectedValue(new Error("mcp config bad")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "1", "💭 Thinking…");
      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("D1", "1", "");
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_Something went wrong, try again_");
    });

    it("clears the shimmer before posting the DM error reply", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } });
          throw new Error("boom");
        }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      const errorCallIndex = mockBotInstance.postMessage.mock.calls.findIndex(
        ([channelId, text]) => channelId === "D1" && text === "_Something went wrong, try again_",
      );
      expect(errorCallIndex).toBeGreaterThanOrEqual(0);
      const errorOrder = mockBotInstance.postMessage.mock.invocationCallOrder[errorCallIndex];
      const clearCallIndex = mockBotInstance.setAssistantStatus.mock.calls.findIndex(
        ([channelId, , status]) => channelId === "D1" && status === "",
      );
      expect(clearCallIndex).toBeGreaterThanOrEqual(0);
      const clearOrder = mockBotInstance.setAssistantStatus.mock.invocationCallOrder[clearCallIndex];
      expect(clearOrder).toBeLessThan(errorOrder);
    });

    it("shows _No response_ when agent sends nothing", async () => {
      const deps = makeDeps({
        runAgent: vi
          .fn()
          .mockResolvedValue(makeAgentResult({ messageSent: false, trace: { progressEvents: [], finalText: null } })),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "quiet", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_No response_");
    });

    it("still posts the final reply when progress flush fails", async () => {
      mockBotInstance.updateMessage.mockRejectedValue(new Error("progress boom"));
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "final reply" } });
        }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "final reply");
      expect(mockBotInstance.postMessage).not.toHaveBeenCalledWith("D1", "_Something went wrong, try again_");
    });

    it("passes MCP servers to agent for DMs", async () => {
      const mcpServers = { canvas: { type: "http" as const, url: "https://mcp.test" } };
      const deps = makeDeps({
        buildMcpServers: vi.fn().mockResolvedValue(mcpServers),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.integrationMcpServers).toEqual(mcpServers);
    });

    it("eagerly transcribes audio attachments before running the agent", async () => {
      const deps = makeDeps();
      vi.mocked(downloadSlackFile).mockResolvedValueOnce({
        originalName: "voice.ogg",
        mimeType: "audio/ogg",
        localPath: "/tmp/test-data/workspaces/u1/attachments/voice.ogg",
        sizeBytes: 100,
      });
      vi.mocked(transcribeEagerAttachments).mockImplementationOnce(async (attachments) =>
        attachments.map((attachment) => ({
          ...attachment,
          transcription: { status: "completed", text: "hello from slack voice note" },
        })),
      );
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({
        text: "",
        userId: "S1",
        channelId: "D1",
        ts: "1",
        type: "dm",
        files: [{ name: "voice.ogg", urlPrivate: "https://slack.test/voice.ogg", mimetype: "audio/ogg", size: 100 }],
      });
      await flush();

      expect(transcribeEagerAttachments).toHaveBeenCalledWith(
        [expect.objectContaining({ originalName: "voice.ogg", mimeType: "audio/ogg" })],
        expect.objectContaining({ logger: deps.logger }),
      );
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0]?.[0];
      expect(agentCall?.attachments).toEqual([
        expect.objectContaining({
          originalName: "voice.ogg",
          transcription: { status: "completed", text: "hello from slack voice note" },
        }),
      ]);
    });

    it("treats leading-space /new as a reset command in Slack DMs", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();
      const sessions = await import("../agent/sessions");

      await dm({ text: " /new", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(sessions.deleteSessionId).toHaveBeenCalledWith(deps.db, "u1");
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith(
        "D1",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
    });

    it("routes the /new confirmation through the active thread when the DM has a threadTs", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "/new", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith(
        "D1",
        "t1",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
      expect(mockBotInstance.postMessage).not.toHaveBeenCalled();
    });

    it("updates the DM user's tool progress on /toolprogress", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "/toolprogress technical", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u1", { toolProgress: "technical" });
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "🛠️ Tool progress set to technical.");
    });

    it("injects inbox messages into DM context and marks them consumed after success", async () => {
      const deps = makeDeps({
        inboxMessagesRepo: {
          listPendingForRecipient: vi.fn().mockResolvedValue([
            {
              id: "inbox-1",
              sender_user_id: "sender-1",
              recipient_user_id: "u1",
              message: "Please send the latest update.",
              platform: "slack",
              channel_id: "D123",
              message_ref: "1111.0001",
              created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
              consumed_at: null,
            },
          ]),
          markConsumed: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
        } as unknown as SlackAdapterDeps["inboxMessagesRepo"],
      });
      vi.mocked(deps.repos.users.findById).mockImplementation(async (id) =>
        id === "sender-1" ? makeUser({ id, name: "Bob" }) : makeUser({ id }),
      );
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<inbox>");
      expect(agentCall.userMessage).toContain("From Bob, 5m ago:");
      expect(agentCall.userMessage).toContain("Please send the latest update.");
      expect(deps.inboxMessagesRepo?.markConsumed).toHaveBeenCalledWith(["inbox-1"]);
    });

    it("does not mark inbox messages consumed when the DM run fails", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
        inboxMessagesRepo: {
          listPendingForRecipient: vi.fn().mockResolvedValue([
            {
              id: "inbox-1",
              sender_user_id: "sender-1",
              recipient_user_id: "u1",
              message: "Please send the latest update.",
              platform: "slack",
              channel_id: "D123",
              message_ref: "1111.0001",
              created_at: new Date().toISOString(),
              consumed_at: null,
            },
          ]),
          markConsumed: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
        } as unknown as SlackAdapterDeps["inboxMessagesRepo"],
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.inboxMessagesRepo?.markConsumed).not.toHaveBeenCalled();
    });

    it("hydrates users.timezone from Slack profile on first message", async () => {
      const baseDeps = makeDeps();
      const existing = makeUser({ id: "u1", slack_user_id: "S1", timezone: null });
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(existing),
            findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
            findByEmail: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn().mockImplementation(async (_id, data) => makeUser({ ...existing, ...data })),
          } as unknown as SlackAdapterDeps["repos"]["users"],
        },
      });
      mockBotInstance.getUserInfo = vi.fn().mockResolvedValue({
        name: "alice",
        realName: "Alice",
        email: "alice@test.com",
        tz: "Asia/Kolkata",
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u1", { timezone: "Asia/Kolkata" });
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("Asia/Kolkata");
    });

    it("does not overwrite an existing users.timezone on subsequent messages", async () => {
      const baseDeps = makeDeps();
      const existing = makeUser({ id: "u1", slack_user_id: "S1", timezone: "America/New_York" });
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(existing),
            findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
            findByEmail: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["users"],
        },
      });
      mockBotInstance.getUserInfo = vi.fn().mockResolvedValue({
        name: "alice",
        realName: "Alice",
        email: "alice@test.com",
        tz: "Asia/Kolkata",
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "hello", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      const updateCalls = vi.mocked(deps.repos.users.update).mock.calls;
      expect(updateCalls.find(([, data]) => "timezone" in (data ?? {}))).toBeUndefined();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("America/New_York");
    });
  });

  describe("channel mention handler", () => {
    it("returns the current channel tool progress on /toolprogress with no args", async () => {
      const deps = makeDeps({
        repos: {
          ...makeDeps().repos,
          channels: {
            findBySlackChannelId: vi.fn().mockResolvedValue(makeChannel({ tool_progress: "technical" })),
            findById: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockImplementation(async (data) => makeChannel({ ...data })),
            update: vi.fn().mockImplementation(async (id, data) => makeChannel({ id, ...data })),
          } as unknown as SlackAdapterDeps["repos"]["channels"],
        },
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "/toolprogress", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith(
        "C1",
        "1",
        "🛠️ Tool progress: technical. 🧠 Reasoning text: off.\nUse /toolprogress off|friendly|technical",
      );
    });
  });

  describe("passive channel handler", () => {
    it("captures passive top-level channel messages without running the agent", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { channel } = getHandlers();

      await channel({ text: "ambient update", userId: "S1", channelId: "C1", ts: "2", type: "channel_message" });

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "2",
          providerThreadId: "2",
          providerParentMessageId: null,
          isThreadReply: false,
          addressedToSketch: false,
          text: "ambient update",
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });
  });

  describe("thread handler", () => {
    it("captures passive thread messages without running the agent", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { thread } = getHandlers();

      await thread({ text: "reply", userId: "S1", channelId: "C1", ts: "2", threadTs: "1", type: "thread_message" });

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "2",
          providerThreadId: "1",
          providerParentMessageId: "1",
          isThreadReply: true,
          addressedToSketch: false,
          text: "reply",
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("downloads and captures passive thread audio without eager transcription", async () => {
      const deps = makeDeps();
      vi.mocked(downloadSlackFile).mockResolvedValueOnce({
        originalName: "voice.ogg",
        mimeType: "audio/ogg",
        localPath: "/tmp/test-data/workspaces/channel-C1/attachments/voice.ogg",
        sizeBytes: 100,
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { thread } = getHandlers();

      await thread({
        text: "",
        userId: "S1",
        channelId: "C1",
        ts: "2",
        threadTs: "1",
        type: "thread_message",
        files: [{ name: "voice.ogg", urlPrivate: "https://slack.test/voice.ogg", mimetype: "audio/ogg", size: 100 }],
      });

      expect(transcribeEagerAttachments).not.toHaveBeenCalled();
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "See attached files.",
          attachments: [expect.objectContaining({ originalName: "voice.ogg", mimeType: "audio/ogg" })],
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });
  });

  describe("channel mention handler", () => {
    it("creates channel if not found and injects channel metadata into shared context", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.repos.channels.create).toHaveBeenCalled();
      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<channel>");
      expect(agentCall.userMessage).toContain("name: #general");
    });

    it("reuses existing channel", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.channels.findBySlackChannelId).mockResolvedValue(makeChannel());
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.repos.channels.create).not.toHaveBeenCalled();
    });

    it("loads channel-wide backlog on top-level mention", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.conversations.getCursor).mockResolvedValueOnce({
        id: 1,
        conversation_id: 1,
        scope_type: "slack_thread",
        scope_key: "1",
        last_seen_message_id: 10,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.repos.conversations.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 1,
          afterMessageId: 10,
          beforeMessageId: 1,
          providerThreadId: undefined,
        }),
      );
      expect(deps.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationContext: { conversationId: 1, providerThreadId: undefined },
        }),
      );
    });

    it("loads current-thread backlog on threaded mention", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.conversations.getCursor).mockResolvedValueOnce({
        id: 1,
        conversation_id: 1,
        scope_type: "slack_thread",
        scope_key: "1",
        last_seen_message_id: 10,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "2", threadTs: "1", type: "channel_mention" });
      await flush();

      expect(deps.repos.conversations.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 1,
          afterMessageId: 10,
          beforeMessageId: 1,
          providerThreadId: "1",
        }),
      );
      expect(deps.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationContext: { conversationId: 1, providerThreadId: "1" },
        }),
      );
    });

    it("eagerly transcribes audio attachments on channel mentions", async () => {
      const deps = makeDeps();
      vi.mocked(downloadSlackFile).mockResolvedValueOnce({
        originalName: "voice.ogg",
        mimeType: "audio/ogg",
        localPath: "/tmp/test-data/workspaces/channel-C1/attachments/voice.ogg",
        sizeBytes: 100,
      });
      vi.mocked(transcribeEagerAttachments).mockImplementationOnce(async (attachments) =>
        attachments.map((attachment) => ({
          ...attachment,
          transcription: { status: "completed", text: "hello from channel voice note" },
        })),
      );
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({
        text: "",
        userId: "S1",
        channelId: "C1",
        ts: "1",
        type: "channel_mention",
        files: [{ name: "voice.ogg", urlPrivate: "https://slack.test/voice.ogg", mimetype: "audio/ogg", size: 100 }],
      });
      await flush();

      expect(transcribeEagerAttachments).toHaveBeenCalledWith(
        [expect.objectContaining({ originalName: "voice.ogg", mimeType: "audio/ogg" })],
        expect.objectContaining({ logger: deps.logger }),
      );
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0]?.[0];
      expect(agentCall?.attachments).toEqual([
        expect.objectContaining({
          originalName: "voice.ogg",
          transcription: { status: "completed", text: "hello from channel voice note" },
        }),
      ]);
    });

    it("passes MCP servers to agent for channel mentions", async () => {
      const mcpServers = { canvas: { type: "http" as const, url: "https://mcp.test" } };
      const deps = makeDeps({
        buildMcpServers: vi.fn().mockResolvedValue(mcpServers),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.buildMcpServers).toHaveBeenCalledWith("alice@test.com");
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.integrationMcpServers).toEqual(mcpServers);
    });

    it("passes teammate messaging deps to agent for channel mentions", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userRepo).toBe(deps.repos.users);
      expect(agentCall.inboxMessagesRepo).toBe(deps.inboxMessagesRepo);
      expect(agentCall.currentUserId).toBe("u1");
      expect(agentCall.sendDm).toBe(deps.sendDm);
    });

    it("replies in thread when Slack identity resolution conflicts", async () => {
      const baseDeps = makeDeps();
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(undefined),
            findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
            findByEmail: vi.fn().mockResolvedValue(makeUser({ id: "u-existing", slack_user_id: "S_EXISTING" })),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["users"],
        },
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith(
        "C1",
        "1",
        expect.stringContaining("conflicts with an existing Sketch identity"),
      );
    });

    it("resets the current thread when a channel mention sends /new", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();
      const sessions = await import("../agent/sessions");

      await mention({
        text: "/new",
        userId: "S1",
        channelId: "C1",
        ts: "1",
        threadTs: "0.9",
        type: "channel_mention",
      });
      await flush();

      expect(sessions.deleteSessionId).toHaveBeenCalledWith(deps.db, "channel-C1", "0.9");
      expect(deps.repos.conversations.advanceCursorToCurrentMax).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 1,
          scopeType: "slack_thread",
          scopeKey: "0.9",
          providerThreadId: "0.9",
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith(
        "C1",
        "0.9",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
    });

    it("fetches Slack channel bootstrap history when persisted backlog is empty on first mention", async () => {
      const deps = makeDeps();
      mockBotInstance.getChannelHistory.mockResolvedValueOnce([
        { userId: "S2", text: "ambient update", ts: "0.9" },
        { userId: "S1", text: "help", ts: "1" },
      ]);
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(mockBotInstance.getChannelHistory).toHaveBeenCalledWith("C1", 5);
      expect(mockBotInstance.getThreadReplies).not.toHaveBeenCalled();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<channel_history>");
      expect(agentCall.userMessage).toContain("Alice: ambient update");
      expect(agentCall.userMessage).not.toContain("Alice: help");
    });

    it("fetches Slack thread bootstrap history when persisted backlog is empty on first threaded mention", async () => {
      const deps = makeDeps();
      mockBotInstance.getThreadReplies.mockResolvedValueOnce([
        { userId: "S2", text: "earlier reply", ts: "0.9" },
        { userId: "S1", text: "help", ts: "1" },
      ]);
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", threadTs: "0.9", type: "channel_mention" });
      await flush();

      expect(mockBotInstance.getThreadReplies).toHaveBeenCalledWith("C1", "0.9", 50);
      expect(mockBotInstance.getChannelHistory).not.toHaveBeenCalled();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<thread>");
      expect(agentCall.userMessage).toContain("Alice: earlier reply");
      expect(agentCall.userMessage).not.toContain("Alice: help");
    });

    it("includes user email in channel mention message", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<sender>Alice (alice@test.com)</sender>");
    });

    it("starts the shimmer on channel mention", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("C1", "1", "💭 Thinking…");
      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("C1", "1", "");
    });

    it("tells channel users to mention the bot with /new when the prompt is too long", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("Claude Code returned an error result: Prompt is too long")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("C1", "1", "");
      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith("C1", "1", PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE);
    });

    it("applies bound agent overlay when channel.agent_user_id is set", async () => {
      const baseDeps = makeDeps();
      const agentUser = makeUser({
        id: "agent-1",
        name: "Marketing Maven",
        type: "agent",
        description: "You are the marketing maven. Always cite source URLs.",
        allowed_tools: JSON.stringify(["Read", "WebSearch", "mcp__sketch__Search"]),
      });
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(makeUser()),
            findById: vi.fn().mockImplementation(async (id) => (id === "agent-1" ? agentUser : makeUser({ id }))),
            findByEmail: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["users"],
          channels: {
            findBySlackChannelId: vi.fn().mockResolvedValue(makeChannel({ agent_user_id: "agent-1" })),
            findById: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["channels"],
        },
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.workspaceKey).toBe("agent-agent-1/channel-C1");
      expect(agentCall.agentInstructions).toBe("You are the marketing maven. Always cite source URLs.");
      expect(agentCall.agentAllowedTools).toEqual(["Read", "WebSearch", "mcp__sketch__Search"]);
    });

    it("uses the bound agent's workspace key when /new is sent in a bound channel", async () => {
      const baseDeps = makeDeps();
      const agentUser = makeUser({ id: "agent-1", type: "agent" });
      const deps = makeDeps({
        repos: {
          ...baseDeps.repos,
          users: {
            findBySlackId: vi.fn().mockResolvedValue(makeUser()),
            findById: vi.fn().mockImplementation(async (id) => (id === "agent-1" ? agentUser : makeUser({ id }))),
            findByEmail: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["users"],
          channels: {
            findBySlackChannelId: vi.fn().mockResolvedValue(makeChannel({ agent_user_id: "agent-1" })),
            findById: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(),
            update: vi.fn(),
          } as unknown as SlackAdapterDeps["repos"]["channels"],
        },
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();
      const sessions = await import("../agent/sessions");

      await mention({
        text: "/new",
        userId: "S1",
        channelId: "C1",
        ts: "1",
        threadTs: "0.9",
        type: "channel_mention",
      });
      await flush();

      expect(sessions.deleteSessionId).toHaveBeenCalledWith(deps.db, "agent-agent-1/channel-C1", "0.9");
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("falls back to default workspace and no overlay when channel has no bound agent", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.channels.findBySlackChannelId).mockResolvedValue(makeChannel());
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.workspaceKey).toBe("channel-C1");
      expect(agentCall.agentInstructions).toBeNull();
      expect(agentCall.agentAllowedTools).toBeNull();
    });
  });

  describe("Assistant-pane DM shimmer", () => {
    it("calls setAssistantStatus and skips eyes/✅ reactions for DMs with a threadTs when EXPERIMENTAL_FLAG is on", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.addReaction).not.toHaveBeenCalledWith("D1", "1", "eyes");
      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "t1", "💭 Thinking…");
      expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("D1", "t1", "");
    });

    it("streams tool-progress renderer output into the shimmer", async () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const deps = makeDeps({
          config: createTestConfig({
            DATA_DIR: "/tmp/test-data",
            PORT: 0,
            LOG_LEVEL: "error",
            EXPERIMENTAL_FLAG: true,
          }),
          runAgent: vi.fn().mockImplementation(async (params) => {
            await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
            return makeAgentResult();
          }),
        });
        createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

        const { dm } = getHandlers();
        await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
        await flush();

        expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "t1", '📖 Reading "a.ts"');
      } finally {
        randomSpy.mockRestore();
      }
    });

    it("honors the selected tool-progress mode for Assistant shimmer text", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          return makeAgentResult();
        }),
      });
      vi.mocked(deps.repos.users.findBySlackId).mockResolvedValue(makeUser({ tool_progress: "technical" }));
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "t1", '📖 Read: "a.ts"');
    });

    it("streams reasoning text into the shimmer when reasoningText is on", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "intermediate_text", text: "thinking about it" });
          return makeAgentResult();
        }),
      });
      vi.mocked(deps.repos.users.findBySlackId).mockResolvedValue(makeUser({ reasoning_text: 1 }));
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "t1", "💬 thinking about it");
    });

    it("collapses repeated tool calls into an (xN) multiplier in the shimmer", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          return makeAgentResult();
        }),
      });
      vi.mocked(deps.repos.users.findBySlackId).mockResolvedValue(makeUser({ tool_progress: "technical" }));
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "t1", '📖 Read: "a.ts" (x2)');
    });

    it("passes threadTs to runAgent for assistant-pane DMs", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hello world", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.threadTs).toBe("t1");
    });

    it("posts the final reply inside the assistant thread", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith("D1", "t1", "hello back");
      expect(mockBotInstance.postMessage).not.toHaveBeenCalledWith("D1", expect.any(String));
    });

    it("posts _No response_ as a thread reply for assistant-pane DMs", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi
          .fn()
          .mockResolvedValue(makeAgentResult({ messageSent: false, trace: { progressEvents: [], finalText: null } })),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "quiet", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith("D1", "t1", "_No response_");
      expect(mockBotInstance.postMessage).not.toHaveBeenCalledWith("D1", "_No response_");
    });

    it("posts the error message as a thread reply for assistant-pane DMs", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith("D1", "t1", "_Something went wrong, try again_");
      expect(mockBotInstance.postMessage).not.toHaveBeenCalledWith("D1", "_Something went wrong, try again_");
    });

    it("uploads pending files inside the assistant thread", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
        runAgent: vi.fn().mockResolvedValue(makeAgentResult({ pendingUploads: ["/tmp/out.pdf"] })),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "make pdf", userId: "S1", channelId: "D1", ts: "1", threadTs: "t1", type: "dm" });
      await flush();

      expect(mockBotInstance.uploadFile).toHaveBeenCalledWith("D1", "/tmp/out.pdf", "t1");
    });

    it("does not pass threadTs to runAgent for top-level (no-thread) Messages-tab DMs", async () => {
      const deps = makeDeps({
        config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error", EXPERIMENTAL_FLAG: true }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      const { dm } = getHandlers();
      await dm({ text: "hi", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.threadTs).toBeUndefined();
      expect(mockBotInstance.setAssistantStatus).toHaveBeenCalledWith("D1", "1", "💭 Thinking…");
    });
  });

  describe("validateSlackTokens", () => {
    it("calls auth.test with bot token", async () => {
      const { slackApiCall } = await import("./api");

      await validateSlackTokens("xoxb-test", "xapp-test");

      expect(slackApiCall).toHaveBeenCalledWith("xoxb-test", "auth.test");
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

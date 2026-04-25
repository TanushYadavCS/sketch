import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_SESSION_CONFIRMATIONS } from "../commands";
import { QueueManager } from "../queue";
import { createTestConfig, flush } from "../test-utils";
import type { SlackAdapterDeps } from "./adapter";
import { createConfiguredSlackBot, validateSlackTokens } from "./adapter";

// --- Fixtures ---

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Alice",
    email: "alice@test.com",
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
    created_at: "2025-01-01",
    ...overrides,
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
    },
    queue: new QueueManager(),
    slack: {
      threadBuffer: {
        register: vi.fn(),
        hasThread: vi.fn().mockReturnValue(false),
        append: vi.fn(),
        drain: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      } as unknown as SlackAdapterDeps["slack"]["threadBuffer"],
      userCache: {
        resolve: vi.fn().mockImplementation(async (_id, fetcher) => fetcher(_id)),
      } as unknown as SlackAdapterDeps["slack"]["userCache"],
    },
    runAgent: vi.fn().mockResolvedValue({
      ...makeAgentResult(),
    }),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    findIntegrationProvider: vi.fn().mockResolvedValue(null),
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
    onThreadMessage: vi.fn(),
    onChannelMention: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue("new-ts"),
    postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
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

// Stub workspace to avoid filesystem access
vi.mock("../agent/workspace", () => ({
  ensureWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/u1"),
  ensureChannelWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/channel-C1"),
  ensureGroupWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/wa-group-g1"),
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
    thread: mockBotInstance.onThreadMessage.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
    mention: mockBotInstance.onChannelMention.mock.calls[0]?.[0] as (msg: unknown) => Promise<void>,
  };
}

describe("slack/adapter", () => {
  beforeEach(() => {
    mockBotInstance = freshMockBot();
  });

  describe("createConfiguredSlackBot", () => {
    it("registers DM, thread, and channel mention handlers", () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);

      expect(mockBotInstance.onMessage).toHaveBeenCalledOnce();
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

      expect(mockBotInstance.uploadFile).toHaveBeenCalledWith("D1", "/tmp/out.pdf");
    });

    it("updates thinking message on agent error", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "crash", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.removeReaction).toHaveBeenCalled();
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_Something went wrong, try again_");
    });

    it("flushes buffered progress before posting the DM error reply", async () => {
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

      expect(mockBotInstance.updateMessage).toHaveBeenCalled();
      const errorCallIndex = mockBotInstance.postMessage.mock.calls.findIndex(
        ([channelId, text]) => channelId === "D1" && text === "_Something went wrong, try again_",
      );
      expect(errorCallIndex).toBeGreaterThanOrEqual(0);
      const errorOrder = mockBotInstance.postMessage.mock.invocationCallOrder[errorCallIndex];
      const flushOrder = mockBotInstance.updateMessage.mock.invocationCallOrder.at(-1);
      expect(flushOrder).toBeLessThan(errorOrder);
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

    it("updates the DM user's tool progress on /toolprogress", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "/toolprogress concise", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u1", { toolProgress: "concise" });
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "🎯 Tool progress set to concise.");
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
        "🛠️ Tool progress: technical. 🧠 Reasoning text: off.\nUse /toolprogress off|friendly|concise|technical|verbose",
      );
    });
  });

  describe("thread handler", () => {
    it("ignores messages for unregistered threads", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { thread } = getHandlers();

      await thread({ text: "reply", userId: "S1", channelId: "C1", ts: "2", threadTs: "1", type: "thread_message" });

      expect(deps.slack.threadBuffer.append).not.toHaveBeenCalled();
    });

    it("buffers messages for registered threads", async () => {
      const deps = makeDeps();
      vi.mocked(deps.slack.threadBuffer.hasThread).mockReturnValue(true);
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { thread } = getHandlers();

      await thread({ text: "reply", userId: "S1", channelId: "C1", ts: "2", threadTs: "1", type: "thread_message" });

      expect(deps.slack.threadBuffer.append).toHaveBeenCalledWith(
        "C1",
        "1",
        expect.objectContaining({ text: "reply" }),
      );
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

    it("registers thread in buffer on mention", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.slack.threadBuffer.register).toHaveBeenCalledWith("C1", "1");
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
      expect(deps.slack.threadBuffer.reset).toHaveBeenCalledWith("C1", "0.9");
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mockBotInstance.postThreadReply).toHaveBeenCalledWith(
        "C1",
        "0.9",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
    });

    it("skips bootstrap history after a thread has been reset", async () => {
      const deps = makeDeps();
      vi.mocked(deps.slack.threadBuffer.hasThread).mockReturnValue(true);
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.slack.threadBuffer.drain).toHaveBeenCalledWith("C1", "1");
      expect(mockBotInstance.getChannelHistory).not.toHaveBeenCalled();
      expect(mockBotInstance.getThreadReplies).not.toHaveBeenCalled();
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

    it("adds eyes reaction on channel mention", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(mockBotInstance.addReaction).toHaveBeenCalledWith("C1", "1", "eyes");
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

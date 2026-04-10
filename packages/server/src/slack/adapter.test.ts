import { beforeEach, describe, expect, it, vi } from "vitest";
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
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch1",
    name: "general",
    slack_channel_id: "C1",
    type: "channel",
    created_at: "2025-01-01",
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
        findByEmail: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockImplementation(async (data) => makeUser({ id: "new-u", ...data })),
        update: vi.fn().mockImplementation(async (id, data) => makeUser({ id, ...data })),
      } as unknown as SlackAdapterDeps["repos"]["users"],
      channels: {
        findBySlackChannelId: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockImplementation(async (data) => makeChannel({ ...data })),
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
      } as unknown as SlackAdapterDeps["slack"]["threadBuffer"],
      userCache: {
        resolve: vi.fn().mockImplementation(async (_id, fetcher) => fetcher(_id)),
      } as unknown as SlackAdapterDeps["slack"]["userCache"],
    },
    runAgent: vi.fn().mockResolvedValue({
      messageSent: true,
      sessionId: "sess-1",
      costUsd: 0.01,
      pendingUploads: [],
    }),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    findIntegrationProvider: vi.fn().mockResolvedValue(null),
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

    it("uploads pending files after agent run", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockResolvedValue({
          messageSent: true,
          sessionId: "s1",
          costUsd: 0,
          pendingUploads: ["/tmp/out.pdf"],
        }),
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

    it("shows _No response_ when agent sends nothing", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockResolvedValue({
          messageSent: false,
          sessionId: "s1",
          costUsd: 0,
          pendingUploads: [],
        }),
      });
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { dm } = getHandlers();

      await dm({ text: "quiet", userId: "S1", channelId: "D1", ts: "1", type: "dm" });
      await flush();

      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_No response_");
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
    it("creates channel if not found, runs agent with channel context", async () => {
      const deps = makeDeps();
      createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
      const { mention } = getHandlers();

      await mention({ text: "help", userId: "S1", channelId: "C1", ts: "1", type: "channel_mention" });
      await flush();

      expect(deps.repos.channels.create).toHaveBeenCalled();
      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.channelContext).toEqual({ channelName: "general" });
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

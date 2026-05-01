import { describe, expect, it, vi } from "vitest";
import { NEW_SESSION_CONFIRMATIONS } from "../commands";
import { QueueManager } from "../queue";
import { createTestConfig, flush } from "../test-utils";
import type { WhatsAppAdapterDeps } from "./adapter";
import { wireWhatsAppHandlers } from "./adapter";

// --- Fixtures ---

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    name: "Alice",
    email: "alice@test.com",
    password_hash: null,
    auth_role: "member",
    slack_user_id: null,
    whatsapp_number: "+1234567890",
    created_at: "2025-01-01",
    email_verified_at: null,
    description: null,
    type: "human",
    role: null,
    reports_to: null,
    tool_progress: null,
    reasoning_text: null,
    timezone: null,
    ...overrides,
  };
}

function createMockWhatsApp(connected = true) {
  const handler = { fn: null as unknown };
  return {
    mock: {
      isConnected: connected,
      socket: {},
      onMessage: vi.fn().mockImplementation((fn) => {
        handler.fn = fn;
      }),
      sendText: vi.fn().mockResolvedValue({ key: { remoteJid: "jid", id: "sent-1", fromMe: true } }),
      editText: vi.fn().mockResolvedValue({ key: { remoteJid: "jid", id: "edit-1", fromMe: true } }),
      sendFile: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      startComposing: vi.fn(),
      stopComposing: vi.fn(),
      getGroupMetadata: vi.fn().mockResolvedValue({ subject: "Test Group", desc: "A test group" }),
      getGroupName: vi.fn().mockResolvedValue("Test Group"),
    },
    getHandler: () => handler.fn as (msg: unknown) => Promise<void>,
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

function makeDeps(overrides: Partial<WhatsAppAdapterDeps> = {}): WhatsAppAdapterDeps {
  return {
    db: {} as WhatsAppAdapterDeps["db"],
    config: createTestConfig({ DATA_DIR: "/tmp/test-data", PORT: 0, LOG_LEVEL: "error" }),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as WhatsAppAdapterDeps["logger"],
    repos: {
      users: {
        findByWhatsappNumber: vi.fn().mockResolvedValue(makeUser()),
        findById: vi.fn().mockImplementation(async (id) => makeUser({ id })),
        update: vi.fn().mockImplementation(async (id, data) => makeUser({ id, ...data })),
      } as unknown as WhatsAppAdapterDeps["repos"]["users"],
      settings: {
        get: vi.fn().mockResolvedValue({
          org_name: "TestOrg",
          bot_name: "TestBot",
        }),
      } as unknown as WhatsAppAdapterDeps["repos"]["settings"],
      whatsappGroups: {
        getByJid: vi.fn().mockResolvedValue(undefined),
        upsert: vi.fn().mockResolvedValue(undefined),
        updateProgressSettings: vi.fn().mockResolvedValue(undefined),
      } as unknown as WhatsAppAdapterDeps["repos"]["whatsappGroups"],
    },
    queue: new QueueManager(),
    groupBuffer: {
      append: vi.fn(),
      drain: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as WhatsAppAdapterDeps["groupBuffer"],
    runAgent: vi.fn().mockResolvedValue({
      ...makeAgentResult(),
    }),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    findIntegrationProvider: vi.fn().mockResolvedValue(null),
    inboxMessagesRepo: {
      listPendingForRecipient: vi.fn().mockResolvedValue([]),
      markConsumed: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
    } as unknown as WhatsAppAdapterDeps["inboxMessagesRepo"],
    sendDm: vi.fn().mockResolvedValue({ channelId: "outreach@s.whatsapp.net", messageRef: "" }),
    ...overrides,
  };
}

// Stub workspace to avoid filesystem access
vi.mock("../agent/workspace", () => ({
  ensureWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/u1"),
  ensureChannelWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/channel-C1"),
  ensureGroupWorkspace: vi.fn().mockResolvedValue("/tmp/test-data/workspaces/wa-group-g1"),
}));

// Stub file download
vi.mock("../files", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    downloadWhatsAppMedia: vi.fn().mockResolvedValue({
      originalName: "photo.jpg",
      mimeType: "image/jpeg",
      localPath: "/tmp/photo.jpg",
      sizeBytes: 5000,
    }),
  };
});

vi.mock("../agent/sessions", () => ({
  deleteSessionId: vi.fn().mockResolvedValue(undefined),
}));

describe("whatsapp/adapter", () => {
  describe("DM handler", () => {
    it("rejects unauthorized users", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });

      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("runs agent for authorized DM users", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("hello");
      expect(agentCall.platform).toBe("whatsapp");
      expect(agentCall.userName).toBe("Alice");
    });

    it("starts and stops composing indicator", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.startComposing).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
      expect(mock.stopComposing).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
    });

    it("adds 👀 at start and swaps to ✅ on success", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "1234@s.whatsapp.net", id: "m1", fromMe: false } };

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.addReaction).toHaveBeenNthCalledWith(1, "1234@s.whatsapp.net", rawMessage.key, "👀");
      expect(mock.removeReaction).toHaveBeenCalledWith("1234@s.whatsapp.net", rawMessage.key);
      expect(mock.addReaction).toHaveBeenNthCalledWith(2, "1234@s.whatsapp.net", rawMessage.key, "✅");
    });

    it("sends error message on agent failure", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "crash",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "Something went wrong, try again.");
    });

    it("flushes buffered progress before sending the DM error reply", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } });
          throw new Error("boom");
        }),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "crash",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.editText).toHaveBeenCalled();
      const errorCallIndex = mock.sendText.mock.calls.findIndex(
        ([jid, text]) => jid === "1234567890@s.whatsapp.net" && text === "Something went wrong, try again.",
      );
      expect(errorCallIndex).toBeGreaterThanOrEqual(0);
      const errorOrder = mock.sendText.mock.invocationCallOrder[errorCallIndex];
      const flushOrder = mock.editText.mock.invocationCallOrder.at(-1);
      expect(flushOrder).toBeLessThan(errorOrder);
    });

    it("still sends the final reply when progress flush fails", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "final reply" } });
        }),
      });
      const { mock, getHandler } = createMockWhatsApp();
      mock.editText.mockRejectedValue(new Error("progress boom"));
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "final reply");
      expect(mock.sendText).not.toHaveBeenCalledWith("1234567890@s.whatsapp.net", "Something went wrong, try again.");
    });

    it("removes 👀 and does not add ✅ when the DM run fails", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "1234@s.whatsapp.net", id: "m1", fromMe: false } };

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.addReaction).toHaveBeenCalledWith("1234@s.whatsapp.net", rawMessage.key, "👀");
      expect(mock.removeReaction).toHaveBeenCalledWith("1234@s.whatsapp.net", rawMessage.key);
      expect(mock.addReaction).not.toHaveBeenCalledWith("1234@s.whatsapp.net", rawMessage.key, "✅");
    });

    it("uploads pending files after agent run", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockResolvedValue(makeAgentResult({ pendingUploads: ["/tmp/out.pdf"] })),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "make pdf",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendFile).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        "/tmp/out.pdf",
        "application/pdf",
        "out.pdf",
      );
    });

    it("passes MCP servers to agent for DMs", async () => {
      const mcpServers = { canvas: { type: "http" as const, url: "https://mcp.test" } };
      const deps = makeDeps({
        buildMcpServers: vi.fn().mockResolvedValue(mcpServers),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.integrationMcpServers).toEqual(mcpServers);
    });

    it("resets the current DM session on /new", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const sessions = await import("../agent/sessions");

      await handler({
        type: "dm",
        text: "/new",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(sessions.deleteSessionId).toHaveBeenCalledWith(deps.db, "u1");
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
    });

    it("updates the DM user's tool progress on /toolprogress", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "/toolprogress verbose",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u1", { toolProgress: "verbose" });
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "🔍 Tool progress set to verbose.");
    });

    it("injects inbox messages into DM context and marks them consumed after success", async () => {
      const deps = makeDeps({
        inboxMessagesRepo: {
          listPendingForRecipient: vi.fn().mockResolvedValue([
            {
              id: "inbox-1",
              sender_user_id: "sender-1",
              recipient_user_id: "u1",
              message: "Please send your latest update.",
              platform: "whatsapp",
              channel_id: "1234567890@s.whatsapp.net",
              message_ref: "",
              created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
              consumed_at: null,
            },
          ]),
          markConsumed: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
        } as unknown as WhatsAppAdapterDeps["inboxMessagesRepo"],
      });
      vi.mocked(deps.repos.users.findById).mockImplementation(async (id) =>
        id === "sender-1" ? makeUser({ id, name: "Bob" }) : makeUser({ id }),
      );
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<inbox>");
      expect(agentCall.userMessage).toContain("From Bob, 5m ago:");
      expect(agentCall.userMessage).toContain("Please send your latest update.");
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
              message: "Please send your latest update.",
              platform: "whatsapp",
              channel_id: "1234567890@s.whatsapp.net",
              message_ref: "",
              created_at: new Date().toISOString(),
              consumed_at: null,
            },
          ]),
          markConsumed: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
        } as unknown as WhatsAppAdapterDeps["inboxMessagesRepo"],
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.inboxMessagesRepo?.markConsumed).not.toHaveBeenCalled();
    });

    it("passes user phone to agent context in DM", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userPhone).toBe("+1234567890");
    });

    it("replies to normalized phone JID when inbound DM uses @lid", async () => {
      const deps = makeDeps({
        runAgent: vi
          .fn()
          .mockResolvedValue(makeAgentResult({ trace: { progressEvents: [], finalText: "hello back" } })),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "86702773280883@lid",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.startComposing).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "hello back");
      expect(mock.stopComposing).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
    });

    it("wires DM tool progress as a separate unquoted message", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async ({ onProgressEvent }) => {
          await onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "hello back" } });
        }),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: { key: { remoteJid: "1234@s.whatsapp.net", id: "m1", fromMe: false } },
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendText.mock.calls[0]).toEqual([
        "1234567890@s.whatsapp.net",
        expect.stringMatching(/^📖 /),
        undefined,
      ]);
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "hello back");
    });

    it("hydrates users.timezone from the phone number's country code on first message (+91 → Asia/Kolkata)", async () => {
      const existing = makeUser({ id: "u-india", whatsapp_number: "+919876543210", timezone: null });
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(existing);
      vi.mocked(deps.repos.users.update).mockImplementation(async (_id, data) => makeUser({ ...existing, ...data }));
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "919876543210@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: { key: { remoteJid: "919876543210@s.whatsapp.net", id: "m1", fromMe: false } },
        phoneNumber: "+919876543210",
      });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u-india", { timezone: "Asia/Kolkata" });
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("Asia/Kolkata");
    });

    it("uses the documented +1 default (America/New_York) when hydrating from a US/CA number", async () => {
      const existing = makeUser({ id: "u-na", whatsapp_number: "+14155551234", timezone: null });
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(existing);
      vi.mocked(deps.repos.users.update).mockImplementation(async (_id, data) => makeUser({ ...existing, ...data }));
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "14155551234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: { key: { remoteJid: "14155551234@s.whatsapp.net", id: "m1", fromMe: false } },
        phoneNumber: "+14155551234",
      });
      await flush();

      expect(deps.repos.users.update).toHaveBeenCalledWith("u-na", { timezone: "America/New_York" });
    });

    it("does not overwrite an existing users.timezone on subsequent messages", async () => {
      const existing = makeUser({
        id: "u-existing",
        whatsapp_number: "+14155551234",
        timezone: "America/Los_Angeles",
      });
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(existing);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hello",
        jid: "14155551234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: { key: { remoteJid: "14155551234@s.whatsapp.net", id: "m1", fromMe: false } },
        phoneNumber: "+14155551234",
      });
      await flush();

      const updateCalls = vi.mocked(deps.repos.users.update).mock.calls;
      expect(updateCalls.find(([, data]) => "timezone" in (data ?? {}))).toBeUndefined();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("America/Los_Angeles");
    });
  });

  describe("group handler", () => {
    it("buffers non-mention group messages", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "random chat",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        isMentioned: false,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });

      expect(deps.groupBuffer.append).toHaveBeenCalledWith(
        "group@g.us",
        expect.objectContaining({ text: "random chat" }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("uses user name from DB when available for buffered messages", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(makeUser({ name: "DB Alice" }));
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "hi",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "PushAlice",
        rawMessage: {},
        isMentioned: false,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });

      expect(deps.groupBuffer.append).toHaveBeenCalledWith(
        "group@g.us",
        expect.objectContaining({ senderName: "DB Alice" }),
      );
    });

    it("runs agent on mention with group metadata in the user message context", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<group>");
      expect(agentCall.userMessage).toContain("name: Test Group");
      expect(agentCall.userMessage).toContain("description: A test group");
    });

    it("drains group buffer on mention", async () => {
      const deps = makeDeps();
      vi.mocked(deps.groupBuffer.drain).mockReturnValue([{ senderName: "Bob", text: "earlier msg", timestamp: 1000 }]);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(deps.groupBuffer.drain).toHaveBeenCalledWith("group@g.us");
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("Bob");
      expect(agentCall.userMessage).toContain("earlier msg");
    });

    it("passes MCP servers to agent for group mentions", async () => {
      const mcpServers = { canvas: { type: "http" as const, url: "https://mcp.test" } };
      const deps = makeDeps({
        buildMcpServers: vi.fn().mockResolvedValue(mcpServers),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(deps.buildMcpServers).toHaveBeenCalledWith("alice@test.com");
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.integrationMcpServers).toEqual(mcpServers);
    });

    it("passes teammate messaging deps to agent for group mentions", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userRepo).toBe(deps.repos.users);
      expect(agentCall.inboxMessagesRepo).toBe(deps.inboxMessagesRepo);
      expect(agentCall.currentUserId).toBe("u1");
      expect(agentCall.sendDm).toBe(deps.sendDm);
    });

    it("passes user email to agent for group mentions", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userEmail).toBe("alice@test.com");
    });

    it("includes user phone and email in group mention message", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<sender>Alice (+1234567890, alice@test.com)</sender>");
    });

    it("passes sender phone to agent context in group mention", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userPhone).toBe("+1234567890");
    });

    it("does NOT pass phone for unregistered group users", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        isMentioned: true,
        senderJid: "9999@s.whatsapp.net",
        senderPhone: "+9999",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      // Phone must not be set for unregistered users — only registered users get phone in context
      expect(agentCall.userPhone == null).toBe(true);
    });

    it("calls buildMcpServers with null for unregistered group users", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        isMentioned: true,
        senderJid: "9999@s.whatsapp.net",
        senderPhone: "+9999",
      });
      await flush();

      expect(deps.buildMcpServers).toHaveBeenCalledWith(null);
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<sender>Bob</sender>");
      expect(agentCall.userMessage).not.toContain("<sender>Bob (");
    });

    it("starts and stops composing for group mentions", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.startComposing).toHaveBeenCalledWith("group@g.us");
      expect(mock.stopComposing).toHaveBeenCalledWith("group@g.us");
    });

    it("adds 👀 at start and swaps to ✅ on group success", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "m1", fromMe: false } };

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.addReaction).toHaveBeenNthCalledWith(1, "group@g.us", rawMessage.key, "👀");
      expect(mock.removeReaction).toHaveBeenCalledWith("group@g.us", rawMessage.key);
      expect(mock.addReaction).toHaveBeenNthCalledWith(2, "group@g.us", rawMessage.key, "✅");
    });

    it("removes 👀 and does not add ✅ when the group run fails", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "m1", fromMe: false } };

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.addReaction).toHaveBeenCalledWith("group@g.us", rawMessage.key, "👀");
      expect(mock.removeReaction).toHaveBeenCalledWith("group@g.us", rawMessage.key);
      expect(mock.addReaction).not.toHaveBeenCalledWith("group@g.us", rawMessage.key, "✅");
    });

    it("resets the current group session on /new", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const sessions = await import("../agent/sessions");
      const rawMessage = { key: { id: "m1" } };

      await handler({
        type: "group",
        text: "/new",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(sessions.deleteSessionId).toHaveBeenCalledWith(deps.db, "wa-group-group@g.us");
      expect(deps.groupBuffer.clear).toHaveBeenCalledWith("group@g.us");
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
        { quoted: rawMessage },
      );
    });

    it("upserts the group tool progress on /toolprogress", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "m1", fromMe: false } };

      await handler({
        type: "group",
        text: "/toolprogress friendly",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(deps.repos.whatsappGroups.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: "group@g.us",
          name: "Test Group",
          description: "A test group",
          tool_progress: "friendly",
          reasoning_text: 0,
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", "🪄 Tool progress set to friendly.", {
        quoted: rawMessage,
      });
    });

    it("wires group tool progress and final reply as separate quoted messages", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async ({ onProgressEvent }) => {
          await onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "hello back" } });
        }),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "m1", fromMe: false } };

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.sendText.mock.calls[0]).toEqual([
        "group@g.us",
        expect.stringMatching(/^📖 /),
        { quoted: rawMessage },
      ]);
      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", "hello back", { quoted: rawMessage });
    });

    it("group handler uses senderPhone for user lookup instead of senderJid", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      // senderJid is a LID-style JID; senderPhone is the already-resolved phone
      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "86702773280883@lid",
        senderPhone: "+1234567890",
      });
      await flush();

      // Should use senderPhone, not a JID-derived number, for the DB lookup
      expect(deps.repos.users.findByWhatsappNumber).toHaveBeenCalledWith("+1234567890");
      expect(deps.repos.users.findByWhatsappNumber).not.toHaveBeenCalledWith("+86702773280883");
    });

    it("group handler falls back to pushName when senderPhone is null", async () => {
      const deps = makeDeps();
      // Ensure user lookup is not called (senderPhone is null, so no DB lookup possible)
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot help",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "FallbackName",
        rawMessage: {},
        isMentioned: true,
        senderJid: "86702773280883@lid",
        senderPhone: null,
      });
      await flush();

      // When senderPhone is null, skip the DB lookup entirely
      expect(deps.repos.users.findByWhatsappNumber).not.toHaveBeenCalled();

      // The agent should run using pushName as the sender identity
      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<sender>FallbackName</sender>");
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

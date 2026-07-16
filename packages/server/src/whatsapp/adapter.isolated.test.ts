import { describe, expect, it, vi } from "vitest";
import { PROMPT_TOO_LONG_RECOVERY_MESSAGE, PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE } from "../agent/errors";
import { NEW_SESSION_CONFIRMATIONS } from "../commands";
import { type Attachment, downloadWhatsAppMedia } from "../files";
import { QueueManager } from "../queue";
import { createTestConfig, flush } from "../test-utils";
import type { WhatsAppAdapterDeps } from "./adapter";
import { wireWhatsAppHandlers } from "./adapter";
import { encodeWhatsAppBackfillCheckpointKey } from "./backfill-checkpoint";
import type { WhatsAppInboundMessage, WhatsAppTarget } from "./provider";

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
    allowed_tools: null,
    timezone: null,
    ...overrides,
  };
}

function createMockWhatsApp(connected = true) {
  const handler = { fn: null as unknown };
  const historyHandler = { fn: null as unknown };
  const targetId = (target: WhatsAppTarget | string) =>
    typeof target === "string"
      ? target
      : target.kind === "group"
        ? target.groupId
        : (target.providerConversationId ?? `${target.phoneE164.replace("+", "")}@s.whatsapp.net`);
  const normalizeLastCall = (mockFn: ReturnType<typeof vi.fn>, args: unknown[]) => {
    mockFn.mock.calls[mockFn.mock.calls.length - 1] = args;
  };
  const baileysOptions = (options: unknown) => {
    const quotedMessage = (options as { quotedMessage?: WhatsAppInboundMessage } | undefined)?.quotedMessage;
    if (!quotedMessage) return options;
    return { quoted: quotedMessage.rawProviderPayload };
  };
  const sendText = vi.fn(async (target: WhatsAppTarget | string, text: string, options?: unknown) => {
    const id = targetId(target);
    const normalizedOptions = baileysOptions(options);
    normalizeLastCall(sendText, normalizedOptions === undefined ? [id, text] : [id, text, normalizedOptions]);
    return { providerMessageId: "sent-1", providerConversationId: id, providerTimestamp: null };
  });
  const sendFile = vi.fn(
    async (target: WhatsAppTarget | string, filePath: string, mimeType: string, fileName: string) => {
      normalizeLastCall(sendFile, [targetId(target), filePath, mimeType, fileName]);
    },
  );
  const startComposing = vi.fn((target: WhatsAppTarget | string) => {
    normalizeLastCall(startComposing, [targetId(target)]);
  });
  const stopComposing = vi.fn((target: WhatsAppTarget | string) => {
    normalizeLastCall(stopComposing, [targetId(target)]);
  });
  const addReaction = vi.fn(async (message: WhatsAppInboundMessage, emoji: string) => {
    const rawMessage = message.rawProviderPayload as { key?: { remoteJid?: string } };
    normalizeLastCall(addReaction, [
      rawMessage.key?.remoteJid ?? message.providerConversationId,
      rawMessage.key,
      emoji,
    ]);
  });
  const removeReaction = vi.fn(async (message: WhatsAppInboundMessage) => {
    const rawMessage = message.rawProviderPayload as { key?: { remoteJid?: string } };
    normalizeLastCall(removeReaction, [rawMessage.key?.remoteJid ?? message.providerConversationId, rawMessage.key]);
  });
  return {
    mock: {
      isConnected: connected,
      socket: {},
      onMessage: vi.fn().mockImplementation((fn) => {
        handler.fn = fn;
      }),
      onHistoryMessages: vi.fn().mockImplementation((fn) => {
        historyHandler.fn = fn;
      }),
      sendText,
      editText: vi.fn(),
      sendFile,
      addReaction,
      removeReaction,
      startComposing,
      stopComposing,
      downloadMedia: vi.fn(async (message: WhatsAppInboundMessage, workspaceDir: string) => {
        if (!message.mediaType) return [] as Attachment[];
        const attachment = await downloadWhatsAppMedia(
          message.rawProviderPayload as never,
          {} as never,
          `${workspaceDir}/attachments`,
          20 * 1024 * 1024,
          {} as never,
        );
        return [attachment];
      }),
      sendTemplate: vi.fn(async (target: WhatsAppTarget) => ({
        providerMessageId: "sent-template-1",
        providerConversationId: targetId(target),
        providerTimestamp: null,
      })),
      getGroupMetadata: vi.fn().mockResolvedValue({ subject: "Test Group", desc: "A test group" }),
      getGroupName: vi.fn().mockResolvedValue("Test Group"),
      resolveJidToPhone: vi.fn().mockResolvedValue(null),
    },
    getHandler: () => async (msg: unknown) => {
      await (handler.fn as (message: WhatsAppInboundMessage) => Promise<void>)(normalizeInboundTestMessage(msg));
    },
    getHistoryHandler: () => async (messages: unknown[]) => {
      return (historyHandler.fn as (messages: WhatsAppInboundMessage[]) => Promise<unknown>)(
        messages.map(normalizeInboundTestMessage),
      );
    },
  };
}

function providerTimestamp(rawMessage: unknown): string | null {
  const seconds = Number((rawMessage as { messageTimestamp?: unknown })?.messageTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeInboundTestMessage(message: unknown): WhatsAppInboundMessage {
  const input = message as Record<string, unknown>;
  if (input.kind === "dm" || input.kind === "group") return input as unknown as WhatsAppInboundMessage;

  if (input.type === "dm") {
    const phoneNumber = String(input.phoneNumber);
    const providerConversationId = `${phoneNumber.replace("+", "")}@s.whatsapp.net`;
    return {
      kind: "dm",
      providerId: "baileys",
      providerMessageId: String(input.messageId),
      providerConversationId,
      canonicalConversationId: `dm:${phoneNumber}`,
      providerTimestamp: providerTimestamp(input.rawMessage),
      senderName: String(input.pushName ?? "Unknown"),
      senderProviderId: String(input.jid ?? providerConversationId),
      senderPhoneE164: phoneNumber,
      target: { kind: "dm", phoneE164: phoneNumber, providerConversationId },
      text: String(input.text ?? ""),
      rawProviderPayload: input.rawMessage,
      ...(typeof input.mediaType === "string" ? { mediaType: input.mediaType } : {}),
      ...(input.quotedMessage ? { quotedMessage: input.quotedMessage as WhatsAppInboundMessage["quotedMessage"] } : {}),
    };
  }

  const groupId = String(input.jid);
  return {
    kind: "group",
    providerId: "baileys",
    providerMessageId: String(input.messageId),
    providerConversationId: groupId,
    canonicalConversationId: `group:${groupId}`,
    providerTimestamp: providerTimestamp(input.rawMessage),
    senderName: String(input.pushName ?? "Unknown"),
    senderProviderId: String(input.senderJid ?? ""),
    senderPhoneE164: typeof input.senderPhone === "string" ? input.senderPhone : null,
    target: { kind: "group", groupId },
    text: String(input.text ?? ""),
    isMentioned: Boolean(input.isMentioned),
    rawProviderPayload: input.rawMessage,
    ...(typeof input.mediaType === "string" ? { mediaType: input.mediaType } : {}),
    ...(input.quotedMessage ? { quotedMessage: input.quotedMessage as WhatsAppInboundMessage["quotedMessage"] } : {}),
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
    pendingIntegrationConnections: [],
    trace: { progressEvents: [], finalText: "hello back" },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WhatsAppAdapterDeps> = {}): WhatsAppAdapterDeps {
  let nextMessageId = 1;
  const conversationRow = {
    id: 1,
    platform: "whatsapp",
    kind: "group",
    provider_conversation_id: "group@g.us",
    display_name: null,
    last_seen_message_id: null,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
  };
  const messages: unknown[] = [];
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
        create: vi.fn().mockImplementation(async (data) => makeUser({ id: "new-u", ...data })),
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
      conversations: {
        getOrCreate: vi.fn().mockResolvedValue(conversationRow),
        insertMessage: vi.fn().mockImplementation(async (data) => {
          const row = {
            id: nextMessageId++,
            conversationId: data.conversationId,
            providerMessageId: data.providerMessageId,
            senderJid: data.senderJid ?? "",
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
            receivedAt: data.receivedAt ?? "2025-01-01T00:00:00.000Z",
            createdAt: "2025-01-01T00:00:00.000Z",
          };
          messages.push(row);
          return { row, inserted: true };
        }),
        listBacklog: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        findMessageByProviderMessageId: vi.fn().mockResolvedValue(undefined),
        updateWatermark: vi.fn().mockResolvedValue(conversationRow),
        advanceWatermarkToCurrentMax: vi.fn().mockResolvedValue(conversationRow),
        getMaxMessageId: vi.fn().mockResolvedValue(null),
        find: vi.fn().mockResolvedValue(undefined),
        claimProviderConversationId: vi.fn().mockResolvedValue(conversationRow),
      } as unknown as WhatsAppAdapterDeps["repos"]["conversations"],
      conversationSlices: {
        getBackfillCheckpoint: vi.fn().mockResolvedValue(undefined),
        setBackfillCheckpoint: vi.fn().mockImplementation(async (input) => ({
          group_jid: input.groupJid,
          last_fetched_key: input.lastFetchedKey ?? null,
          status: input.status,
          updated_at: new Date().toISOString(),
        })),
      } as unknown as WhatsAppAdapterDeps["repos"]["conversationSlices"],
    },
    queue: new QueueManager(),
    runAgent: vi.fn().mockResolvedValue({
      ...makeAgentResult(),
    }),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
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
  ensureAgentSubWorkspace: vi
    .fn()
    .mockImplementation(async (_config, agentId, subKey) => `/tmp/test-data/workspaces/agent-${agentId}/${subKey}`),
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
  archiveRuntimeSessions: vi.fn().mockResolvedValue(undefined),
}));

describe("whatsapp/adapter", () => {
  describe("DM handler", () => {
    it.each([
      ["confirm done a1b2", "Marked the follow-up done."],
      ["  track c3d4  ", "Now tracking that follow-up."],
    ])("handles follow-up review command %s without running the agent", async (text, reply) => {
      const followupReviewHandler = vi.fn().mockResolvedValue({ handled: true, message: reply });
      const deps = makeDeps({ followupReviewHandler });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text,
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(followupReviewHandler).toHaveBeenCalledWith({ text, userId: "u1", surface: "whatsapp" });
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", reply);
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

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

    it("routes unknown senders to the fallback agent when configured", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      vi.mocked(deps.repos.settings.get).mockResolvedValue({
        org_name: "TestOrg",
        bot_name: "TestBot",
        whatsapp_fallback_agent_id: "agent-1",
      } as never);
      const fallbackAgent = makeUser({
        id: "agent-1",
        name: "Support Agent",
        type: "agent",
        description: "You are the support agent. Be concise.",
        allowed_tools: JSON.stringify(["Read"]),
      });
      vi.mocked(deps.repos.users.findById).mockImplementation(async (id) =>
        id === "agent-1" ? fallbackAgent : makeUser({ id }),
      );
      const externalUser = makeUser({
        id: "ext-1",
        name: "External user",
        type: "external",
        whatsapp_number: "+1234567890",
        email: null,
      });
      vi.mocked(deps.repos.users.create).mockResolvedValue(externalUser);
      vi.mocked(deps.repos.users.update).mockImplementation(async (_id, data) => ({ ...externalUser, ...data }));

      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hi there",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Stranger",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.repos.users.create).toHaveBeenCalledWith({
        name: "External user",
        type: "external",
        whatsappNumber: "+1234567890",
      });
      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.workspaceKey).toBe("agent-agent-1/ext-1");
      expect(agentCall.agentInstructions).toBe("You are the support agent. Be concise.");
      expect(agentCall.agentAllowedTools).toEqual(["Read"]);
      expect(agentCall.claudeConfigDir).toBeUndefined();
    });

    it("drops unknown senders when no fallback agent is configured", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(undefined);
      vi.mocked(deps.repos.settings.get).mockResolvedValue({
        org_name: "TestOrg",
        bot_name: "TestBot",
        whatsapp_fallback_agent_id: null,
      } as never);

      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "hi",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Stranger",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(deps.repos.users.create).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        "Sorry, you're not authorized to use this bot. Contact your admin to get access.",
      );
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

    it("masks personal DM provider conversation ids in reaction failure logs", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      mock.addReaction.mockRejectedValueOnce(new Error("reaction failed"));
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        kind: "dm" as const,
        providerId: "wati",
        providerMessageId: "wamid.reaction",
        providerConversationId: "dm:+1234567890",
        canonicalConversationId: "dm:+1234567890",
        providerTimestamp: "2026-07-01T00:00:00.000Z",
        senderName: "Alice",
        senderProviderId: "1234567890",
        senderPhoneE164: "+1234567890",
        target: { kind: "dm" as const, phoneE164: "+1234567890" },
        text: "hello",
      });
      await flush();

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConversationId: "dm:+********90",
          emoji: "👀",
        }),
        "Failed to update WhatsApp reaction",
      );
      expect(JSON.stringify(vi.mocked(deps.logger.debug).mock.calls)).not.toContain("+1234567890");
    });

    it("persists valid provider timestamps as received_at for live DM capture", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const providerTimestamp = new Date(Date.now() - 60_000).toISOString();

      await handler({
        kind: "dm" as const,
        providerId: "wati",
        providerMessageId: "wamid.timestamped",
        providerConversationId: "wati-conversation-1",
        canonicalConversationId: "dm:+1234567890",
        providerTimestamp,
        senderName: "Alice",
        senderProviderId: "1234567890",
        senderPhoneE164: "+1234567890",
        target: { kind: "dm" as const, phoneE164: "+1234567890" },
        text: "hello",
      });
      await flush();

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "wamid.timestamped",
          providerTimestamp,
          receivedAt: providerTimestamp,
        }),
      );
    });

    it("does not persist or run duplicate Wati DM retries", async () => {
      const deps = makeDeps();
      const insertMessage = vi.mocked(deps.repos.conversations.insertMessage);
      const originalInsert = insertMessage.getMockImplementation();
      if (!originalInsert) throw new Error("expected insertMessage mock");
      const persistedUserMessages = new Map<string, unknown>();
      let persistedUserMessageCount = 0;
      insertMessage.mockImplementation(async (data) => {
        const dedupeKey = [
          data.conversationId,
          data.providerMessageId,
          data.senderJid ?? "",
          data.isBot ? "bot" : "user",
        ].join(":");
        if (!data.isBot && persistedUserMessages.has(dedupeKey)) {
          return { row: persistedUserMessages.get(dedupeKey) as never, inserted: false };
        }

        const result = await originalInsert(data);
        if (!data.isBot) {
          persistedUserMessages.set(dedupeKey, result.row);
          persistedUserMessageCount += 1;
        }
        return result;
      });

      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const message = {
        kind: "dm" as const,
        providerId: "wati",
        providerMessageId: "wamid.retry",
        providerConversationId: "wati-conversation-1",
        canonicalConversationId: "dm:+1234567890",
        providerTimestamp: "2026-07-01T00:00:00.000Z",
        senderName: "Alice",
        senderProviderId: "1234567890",
        senderPhoneE164: "+1234567890",
        target: { kind: "dm" as const, phoneE164: "+1234567890" },
        text: "hello",
      };

      await handler(message);
      await handler(message);
      await flush();

      expect(persistedUserMessageCount).toBe(1);
      expect(deps.runAgent).toHaveBeenCalledOnce();
    });

    it("claims legacy Wati DM conversations before capturing canonical inbound messages", async () => {
      const legacyConversation = {
        id: 42,
        platform: "whatsapp",
        kind: "dm",
        provider_conversation_id: "wati-conversation-1",
        display_name: "Alice",
        last_seen_message_id: null,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      };
      const canonicalConversation = {
        ...legacyConversation,
        provider_conversation_id: "dm:+1234567890",
      };
      const deps = makeDeps();
      let legacyClaimed = false;
      vi.mocked(deps.repos.conversations.find).mockImplementation(async (ref) => {
        if (!legacyClaimed && ref.providerConversationId === "wati-conversation-1") return legacyConversation;
        return undefined;
      });
      vi.mocked(deps.repos.conversations.claimProviderConversationId).mockImplementation(async () => {
        legacyClaimed = true;
        return canonicalConversation;
      });
      vi.mocked(deps.repos.conversations.getOrCreate).mockResolvedValue(canonicalConversation);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        kind: "dm" as const,
        providerId: "wati",
        providerMessageId: "wamid.legacy",
        providerConversationId: "wati-conversation-1",
        canonicalConversationId: "dm:+1234567890",
        providerTimestamp: "2026-07-01T00:00:00.000Z",
        senderName: "Alice",
        senderProviderId: "1234567890",
        senderPhoneE164: "+1234567890",
        target: { kind: "dm" as const, phoneE164: "+1234567890" },
        text: "hello",
      });
      await flush();

      expect(deps.repos.conversations.claimProviderConversationId).toHaveBeenCalledWith(
        42,
        { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+1234567890" },
        "Alice",
      );
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 42, providerMessageId: "wamid.legacy" }),
      );
      expect(deps.runAgent).toHaveBeenCalledOnce();
    });

    it("claims all matching legacy Wati DM conversations before capturing", async () => {
      const legacyWatiConversation = {
        id: 42,
        platform: "whatsapp",
        kind: "dm",
        provider_conversation_id: "wati-conversation-1",
        display_name: "Alice",
        last_seen_message_id: null,
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      };
      const legacyJidConversation = {
        ...legacyWatiConversation,
        id: 43,
        provider_conversation_id: "1234567890@s.whatsapp.net",
      };
      const canonicalConversation = {
        ...legacyWatiConversation,
        id: 99,
        provider_conversation_id: "dm:+1234567890",
      };
      const deps = makeDeps();
      const claimedLegacyIds = new Set<number>();
      vi.mocked(deps.repos.conversations.find).mockImplementation(async (ref) => {
        if (ref.providerConversationId === "wati-conversation-1" && !claimedLegacyIds.has(42)) {
          return legacyWatiConversation;
        }
        if (ref.providerConversationId === "1234567890@s.whatsapp.net" && !claimedLegacyIds.has(43)) {
          return legacyJidConversation;
        }
        return undefined;
      });
      vi.mocked(deps.repos.conversations.claimProviderConversationId).mockImplementation(async (id) => {
        claimedLegacyIds.add(id);
        return canonicalConversation;
      });
      vi.mocked(deps.repos.conversations.getOrCreate).mockResolvedValue(canonicalConversation);
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        kind: "dm" as const,
        providerId: "wati",
        providerMessageId: "wamid.legacy-all",
        providerConversationId: "wati-conversation-1",
        canonicalConversationId: "dm:+1234567890",
        providerTimestamp: "2026-07-01T00:00:00.000Z",
        senderName: "Alice",
        senderProviderId: "1234567890@s.whatsapp.net",
        senderPhoneE164: "+1234567890",
        target: { kind: "dm" as const, phoneE164: "+1234567890" },
        text: "hello",
      });
      await flush();

      expect(deps.repos.conversations.claimProviderConversationId).toHaveBeenCalledTimes(2);
      expect(deps.repos.conversations.claimProviderConversationId).toHaveBeenNthCalledWith(
        1,
        42,
        { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+1234567890" },
        "Alice",
      );
      expect(deps.repos.conversations.claimProviderConversationId).toHaveBeenNthCalledWith(
        2,
        43,
        { platform: "whatsapp", kind: "dm", providerConversationId: "dm:+1234567890" },
        "Alice",
      );
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 99, providerMessageId: "wamid.legacy-all" }),
      );
      expect(deps.runAgent).toHaveBeenCalledOnce();
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

    it("tells DM users to start a new session when the prompt is too long", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("Claude Code returned an error result: Prompt is too long")),
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

      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", PROMPT_TOO_LONG_RECOVERY_MESSAGE);
    });

    it("does not send buffered progress before sending the DM error reply", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async (params) => {
          await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "a.ts" } });
          await params.onProgressEvent({ kind: "tool_use", toolName: "Edit", input: { file_path: "a.ts" } });
          throw new Error("boom");
        }),
      });
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(
        makeUser({ tool_progress: "friendly", timezone: "America/New_York" }),
      );
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

      expect(mock.editText).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "Something went wrong, try again.");
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

    it("appends an integration connection link to DM replies", async () => {
      const deps = makeDeps({
        config: createTestConfig({
          DATA_DIR: "/tmp/test-data",
          PORT: 0,
          LOG_LEVEL: "error",
          BASE_URL: "https://sketch.test",
        }),
        runAgent: vi.fn().mockResolvedValue(
          makeAgentResult({
            trace: { progressEvents: [], finalText: "GitHub needs connection" },
            pendingIntegrationConnections: [
              {
                requestId: "req-1",
                appId: "github",
                appName: "GitHub",
                state: "connect",
                connectUrl: "https://canvas.example.com/connect/secrets?token=github",
              },
            ],
          }),
        ),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "create issue",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        "GitHub needs connection\n\nTo continue, connect GitHub: https://sketch.test/integrations?connect=github",
      );
    });

    it("sends a DM connection link when the agent has no final text", async () => {
      const deps = makeDeps({
        config: createTestConfig({
          DATA_DIR: "/tmp/test-data",
          PORT: 0,
          LOG_LEVEL: "error",
          BASE_URL: "https://sketch.test",
        }),
        runAgent: vi.fn().mockResolvedValue(
          makeAgentResult({
            trace: { progressEvents: [], finalText: null },
            pendingIntegrationConnections: [
              {
                requestId: "req-1",
                appId: "github",
                appName: "GitHub",
                state: "connect",
                connectUrl: "https://canvas.example.com/connect/secrets?token=github",
              },
            ],
          }),
        ),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "create issue",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        "To continue, connect GitHub: https://sketch.test/integrations?connect=github",
      );
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

    it("archives the current DM session on /new", async () => {
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

      expect(sessions.archiveRuntimeSessions).toHaveBeenCalledWith(deps.db, "u1");
      expect(deps.repos.conversations.advanceWatermarkToCurrentMax).toHaveBeenCalledWith(1);
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
      );
    });

    it("ignores DM /toolprogress without updating settings or sending text", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(makeUser({ timezone: "America/New_York" }));
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "dm",
        text: "/toolprogress technical",
        jid: "1234@s.whatsapp.net",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(deps.repos.users.update).not.toHaveBeenCalled();
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).not.toHaveBeenCalled();
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

    it("does not send DM tool progress by default", async () => {
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

      expect(mock.sendText).toHaveBeenCalledTimes(1);
      expect(mock.sendText).toHaveBeenCalledWith("1234567890@s.whatsapp.net", "hello back");
    });

    it("does not wire DM tool progress when explicitly enabled", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async ({ onProgressEvent }) => {
          await onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "hello back" } });
        }),
      });
      vi.mocked(deps.repos.users.findByWhatsappNumber).mockResolvedValue(
        makeUser({ tool_progress: "friendly", timezone: "America/New_York" }),
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
        rawMessage: { key: { remoteJid: "1234@s.whatsapp.net", id: "m1", fromMe: false } },
        phoneNumber: "+1234567890",
      });
      await flush();

      expect(mock.editText).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledTimes(1);
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
    it.each([
      ["keep open z9y8", "Kept the follow-up open."],
      ["dismiss ef56", "Dismissed that reconstructed follow-up."],
    ])("handles non-mentioned follow-up review command %s without running the agent", async (text, reply) => {
      const followupReviewHandler = vi.fn().mockResolvedValue({ handled: true, message: reply });
      const deps = makeDeps({ followupReviewHandler });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text,
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: false,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });

      expect(followupReviewHandler).toHaveBeenCalledWith({ text, userId: "u1", surface: "whatsapp" });
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text, addressedToSketch: false }),
      );
      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", reply, expect.objectContaining({ quoted: {} }));
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("handles a mentioned group follow-up command without running the agent", async () => {
      const followupReviewHandler = vi.fn().mockResolvedValue({ handled: true, message: "Marked the follow-up done." });
      const deps = makeDeps({ followupReviewHandler });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "confirm done a1b2",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(followupReviewHandler).toHaveBeenCalledWith({
        text: "confirm done a1b2",
        userId: "u1",
        surface: "whatsapp",
      });
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        "Marked the follow-up done.",
        expect.objectContaining({ quoted: {} }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("stores non-mention group messages without running the agent", async () => {
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

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "random chat", addressedToSketch: false }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("ignores invalid provider timestamps for live group capture received_at", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const futureTimestamp = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();

      await handler({
        kind: "group" as const,
        providerId: "baileys",
        providerMessageId: "future-timestamp",
        providerConversationId: "group@g.us",
        canonicalConversationId: "group:group@g.us",
        providerTimestamp: futureTimestamp,
        senderName: "Bob",
        senderProviderId: "5555@s.whatsapp.net",
        senderPhoneE164: "+5555",
        target: { kind: "group" as const, groupId: "group@g.us" },
        text: "random chat",
        isMentioned: false,
      });
      await handler({
        kind: "group" as const,
        providerId: "baileys",
        providerMessageId: "epoch-timestamp",
        providerConversationId: "group@g.us",
        canonicalConversationId: "group:group@g.us",
        providerTimestamp: "1970-01-01T00:00:00.000Z",
        senderName: "Bob",
        senderProviderId: "5555@s.whatsapp.net",
        senderPhoneE164: "+5555",
        target: { kind: "group" as const, groupId: "group@g.us" },
        text: "more chat",
        isMentioned: false,
      });

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "future-timestamp",
          providerTimestamp: null,
          receivedAt: undefined,
        }),
      );
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "epoch-timestamp",
          providerTimestamp: null,
          receivedAt: undefined,
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("persists recent group history with provider received_at and dedupes reruns", async () => {
      const deps = makeDeps();
      const insertMessage = vi.mocked(deps.repos.conversations.insertMessage);
      const originalInsert = insertMessage.getMockImplementation();
      if (!originalInsert) throw new Error("expected insertMessage mock");

      const persistedRows: Array<{ providerMessageId: string; receivedAt: string; addressedToSketch: boolean }> = [];
      const persistedByKey = new Map<string, (typeof persistedRows)[number]>();
      insertMessage.mockImplementation(async (data) => {
        const dedupeKey = [
          data.conversationId,
          data.providerMessageId,
          data.senderJid ?? "",
          data.isBot ? "bot" : "user",
        ].join(":");
        const existing = persistedByKey.get(dedupeKey);
        if (existing) return { row: existing as never, inserted: false };

        const result = await originalInsert(data);
        const row = result.row as (typeof persistedRows)[number];
        persistedRows.push(row);
        persistedByKey.set(dedupeKey, row);
        return result;
      });

      const recentTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const oldTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const batch: WhatsAppInboundMessage[] = [
        {
          kind: "group",
          providerId: "baileys",
          providerMessageId: "history-recent",
          providerConversationId: "group@g.us",
          canonicalConversationId: "group:group@g.us",
          providerTimestamp: recentTimestamp,
          senderName: "Bob",
          senderProviderId: "5555@s.whatsapp.net",
          senderPhoneE164: "+5555",
          target: { kind: "group", groupId: "group@g.us" },
          text: "recent context",
          isMentioned: false,
        },
        {
          kind: "group",
          providerId: "baileys",
          providerMessageId: "history-from-me",
          providerConversationId: "group@g.us",
          canonicalConversationId: "group:group@g.us",
          providerTimestamp: recentTimestamp,
          senderName: "Sketch",
          senderProviderId: "bot@s.whatsapp.net",
          senderPhoneE164: "+7777",
          target: { kind: "group", groupId: "group@g.us" },
          text: "bot-authored context",
          isMentioned: false,
          rawProviderPayload: { key: { remoteJid: "group@g.us", id: "history-from-me", fromMe: true } },
        },
        {
          kind: "group",
          providerId: "baileys",
          providerMessageId: "history-old",
          providerConversationId: "group@g.us",
          canonicalConversationId: "group:group@g.us",
          providerTimestamp: oldTimestamp,
          senderName: "Carol",
          senderProviderId: "6666@s.whatsapp.net",
          senderPhoneE164: "+6666",
          target: { kind: "group", groupId: "group@g.us" },
          text: "old context",
          isMentioned: false,
        },
      ];

      const { mock, getHistoryHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const historyHandler = getHistoryHandler();

      await expect(historyHandler(batch)).resolves.toEqual({
        persisted: 1,
        skippedOld: 1,
        skippedDup: 0,
      });
      await expect(historyHandler(batch)).resolves.toEqual({
        persisted: 0,
        skippedOld: 1,
        skippedDup: 1,
      });

      const setBackfillCheckpoint = deps.repos.conversationSlices?.setBackfillCheckpoint;
      if (!setBackfillCheckpoint) throw new Error("expected checkpoint repository");
      expect(setBackfillCheckpoint).toHaveBeenCalledWith({
        groupJid: "group@g.us",
        lastFetchedKey: encodeWhatsAppBackfillCheckpointKey({
          providerTimestamp: recentTimestamp,
          providerMessageId: "history-recent",
        }),
        status: "in_progress",
      });
      expect(persistedRows).toHaveLength(1);
      expect(persistedRows[0]).toEqual(
        expect.objectContaining({
          providerMessageId: "history-recent",
          receivedAt: recentTimestamp,
          addressedToSketch: false,
        }),
      );
      expect(deps.repos.conversations.getOrCreate).toHaveBeenCalledWith(
        { platform: "whatsapp", kind: "group", providerConversationId: "group@g.us" },
        "group@g.us",
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).not.toHaveBeenCalled();
    });

    it("persists history messages that arrive at or before a complete checkpoint", async () => {
      const deps = makeDeps();
      const checkpointRepo = deps.repos.conversationSlices;
      if (!checkpointRepo) throw new Error("expected checkpoint repository");
      const completeCheckpointKey = encodeWhatsAppBackfillCheckpointKey({
        providerTimestamp: "2026-07-07T09:05:00.000Z",
        providerMessageId: "checkpoint",
      });
      vi.mocked(checkpointRepo.getBackfillCheckpoint).mockResolvedValue({
        group_jid: "group@g.us",
        last_fetched_key: completeCheckpointKey,
        status: "complete",
        updated_at: "2026-07-07T09:05:00.000Z",
      });

      const { mock, getHistoryHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const historyHandler = getHistoryHandler();

      await expect(
        historyHandler([
          {
            kind: "group",
            providerId: "baileys",
            providerMessageId: "history-not-yet-stored",
            providerConversationId: "group@g.us",
            canonicalConversationId: "group:group@g.us",
            providerTimestamp: "2026-07-07T09:00:00.000Z",
            senderName: "Bob",
            senderProviderId: "5555@s.whatsapp.net",
            senderPhoneE164: "+5555",
            target: { kind: "group", groupId: "group@g.us" },
            text: "missing replayed history",
            isMentioned: false,
          },
        ]),
      ).resolves.toEqual({
        persisted: 1,
        skippedOld: 0,
        skippedDup: 0,
      });

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ providerMessageId: "history-not-yet-stored" }),
      );
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ checkpointKey: completeCheckpointKey }),
        "WhatsApp history group batch arrived at or before complete checkpoint",
      );
    });

    it("uses user name from DB when available for stored passive group messages", async () => {
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

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: "DB Alice" }),
      );
    });

    it("downloads and stores untagged group audio without running the agent", async () => {
      const deps = makeDeps();
      vi.mocked(downloadWhatsAppMedia).mockClear();
      vi.mocked(downloadWhatsAppMedia).mockResolvedValueOnce({
        originalName: "voice.ogg",
        mimeType: "audio/ogg",
        localPath: "/tmp/test-data/workspaces/wa-group-g1/attachments/voice.ogg",
        sizeBytes: 100,
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        mediaType: "audioMessage",
        isMentioned: false,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });

      expect(downloadWhatsAppMedia).toHaveBeenCalledOnce();
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "See attached files.",
          attachments: [expect.objectContaining({ originalName: "voice.ogg" })],
        }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
    });

    it("stores untagged group non-audio media metadata", async () => {
      const deps = makeDeps();
      vi.mocked(downloadWhatsAppMedia).mockClear();
      vi.mocked(downloadWhatsAppMedia).mockResolvedValueOnce({
        originalName: "photo.jpg",
        mimeType: "image/jpeg",
        localPath: "/tmp/test-data/workspaces/wa-group-g1/attachments/photo.jpg",
        sizeBytes: 100,
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Bob",
        rawMessage: {},
        mediaType: "imageMessage",
        isMentioned: false,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });

      expect(downloadWhatsAppMedia).toHaveBeenCalledOnce();
      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [expect.objectContaining({ originalName: "photo.jpg" })] }),
      );
      expect(deps.runAgent).not.toHaveBeenCalled();
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

    it("does not send builder links for automations created by unknown group senders", async () => {
      const deps = makeDeps({
        repos: {
          ...makeDeps().repos,
          users: {
            findByWhatsappNumber: vi.fn().mockResolvedValue(null),
            findById: vi.fn(),
            update: vi.fn(),
            create: vi.fn(),
          } as unknown as WhatsAppAdapterDeps["repos"]["users"],
        },
        runAgent: vi.fn().mockResolvedValue(
          makeAgentResult({
            trace: {
              progressEvents: [],
              finalText: null,
              automationArtifacts: [
                {
                  taskId: "task-1",
                  kind: "New automation",
                  title: "Design wins",
                  description: "Post wins",
                  tags: ["WhatsApp"],
                  scheduleLabel: "External trigger",
                  deliveryLabel: "WhatsApp group",
                  builderUrl: "https://sketch.test/scheduled-tasks/task-1/edit",
                  status: "active",
                },
              ],
            },
          }),
        ),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "@bot create an automation",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.sendText).not.toHaveBeenCalledWith(
        "group@g.us",
        expect.stringContaining("/scheduled-tasks/task-1/edit"),
        expect.anything(),
      );
    });

    it("injects durable missed messages on mention", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.conversations.listBacklog).mockResolvedValue({
        messages: [
          {
            id: 42,
            conversationId: 1,
            providerMessageId: "old",
            senderJid: "5555@s.whatsapp.net",
            senderName: "Bob",
            senderUserId: null,
            isBot: false,
            addressedToSketch: false,
            text: "earlier msg",
            attachments: [],
            providerThreadId: null,
            providerParentMessageId: null,
            isThreadReply: false,
            providerTimestamp: null,
            receivedAt: "2025-01-01T00:00:00.000Z",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        hasMore: false,
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

      expect(deps.repos.conversations.listBacklog).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 1, beforeMessageId: expect.any(Number), limit: 10 }),
      );
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("Bob");
      expect(agentCall.userMessage).toContain("earlier msg");
    });

    it("stores WhatsApp reply parent metadata and injects the stored quoted message", async () => {
      const deps = makeDeps();
      vi.mocked(deps.repos.conversations.findMessageByProviderMessageId).mockResolvedValue({
        id: 41,
        conversationId: 1,
        providerMessageId: "parent-wa-id",
        senderJid: "4444@s.whatsapp.net",
        senderName: "Bob",
        senderUserId: null,
        isBot: false,
        addressedToSketch: false,
        text: "Checkout fails after payment",
        attachments: [
          {
            originalName: "checkout.png",
            mimeType: "image/png",
            localPath: "/tmp/test-data/workspaces/wa-group-g1/attachments/checkout.png",
            sizeBytes: 123,
          },
        ],
        providerThreadId: null,
        providerParentMessageId: null,
        isThreadReply: false,
        providerTimestamp: "2026-01-01T00:00:00.000Z",
        receivedAt: "2026-01-01T00:00:01.000Z",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "please create this ticket",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "parent-wa-id",
          participantJid: "4444@s.whatsapp.net",
          text: "fallback should not be used",
        },
      });
      await flush();

      expect(deps.repos.conversations.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMessageId: "child-wa-id",
          providerParentMessageId: "parent-wa-id",
          isThreadReply: true,
        }),
      );
      expect(deps.repos.conversations.findMessageByProviderMessageId).toHaveBeenCalledWith(1, "parent-wa-id");
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<quoted_message>");
      expect(agentCall.userMessage).toContain("sender: Bob");
      expect(agentCall.userMessage).not.toContain("sender: Bob (4444@s.whatsapp.net)");
      expect(agentCall.userMessage).not.toContain("messageId=41");
      expect(agentCall.userMessage).not.toContain("providerMessageId: parent-wa-id");
      expect(agentCall.userMessage).toContain("text: Checkout fails after payment");
      expect(agentCall.attachments).toEqual([
        expect.objectContaining({
          originalName: "checkout.png",
          localPath: "/tmp/test-data/workspaces/wa-group-g1/attachments/checkout.png",
        }),
      ]);
      expect(agentCall.userMessage).not.toContain("fallback should not be used");
    });

    it("injects WhatsApp quoted text when the parent message was not stored", async () => {
      const deps = makeDeps();
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "please create this ticket",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage: {},
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "parent-wa-id",
          participantJid: "4444@s.whatsapp.net",
          text: "Quoted fallback issue text",
        },
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.userMessage).toContain("<quoted_message>");
      expect(agentCall.userMessage).not.toContain("sender: 4444@s.whatsapp.net");
      expect(agentCall.userMessage).not.toContain("providerMessageId: parent-wa-id");
      expect(agentCall.userMessage).toContain("text: Quoted fallback issue text");
    });

    it("asks for clarification instead of guessing when quoted context is unreadable", async () => {
      const deps = makeDeps();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "child-wa-id" } };
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "please create this ticket",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "missing-parent",
          participantJid: "4444@s.whatsapp.net",
          text: "",
        },
      });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        expect.stringContaining("I can see you're replying to a message"),
        { quoted: rawMessage },
      );
      expect(deps.repos.conversations.updateWatermark).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("asks for clarification when a group reply only mentions Sketch and quoted context is unreadable", async () => {
      const deps = makeDeps();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "child-wa-id" } };
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "missing-parent",
          participantJid: "4444@s.whatsapp.net",
          text: "",
        },
      });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        expect.stringContaining("I can see you're replying to a message"),
        { quoted: rawMessage },
      );
      expect(deps.repos.conversations.updateWatermark).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("asks for clarification when an action-only group reply has unreadable quoted context", async () => {
      const deps = makeDeps();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "child-wa-id" } };
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "summarize",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "missing-parent",
          participantJid: "4444@s.whatsapp.net",
          text: "",
        },
      });
      await flush();

      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        expect.stringContaining("I can see you're replying to a message"),
        { quoted: rawMessage },
      );
      expect(deps.repos.conversations.updateWatermark).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("runs the agent when an unreadable quoted context reply is self-contained", async () => {
      const deps = makeDeps();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "child-wa-id" } };
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();

      await handler({
        type: "group",
        text: "what's the weather?",
        jid: "group@g.us",
        messageId: "child-wa-id",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
        quotedMessage: {
          providerMessageId: "missing-parent",
          participantJid: "4444@s.whatsapp.net",
          text: "",
        },
      });
      await flush();

      expect(mock.sendText).not.toHaveBeenCalledWith(
        "group@g.us",
        expect.stringContaining("I can see you're replying to a message"),
        { quoted: rawMessage },
      );
      expect(deps.runAgent).toHaveBeenCalledOnce();
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

    it("tells group users to mention the bot with /new when the prompt is too long", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockRejectedValue(new Error("Claude Code returned an error result: Prompt is too long")),
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

      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE);
    });

    it("archives the current group session on /new", async () => {
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

      expect(sessions.archiveRuntimeSessions).toHaveBeenCalledWith(deps.db, "wa-group-group@g.us");
      expect(deps.repos.conversations.advanceWatermarkToCurrentMax).toHaveBeenCalledWith(1);
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        expect.stringMatching(new RegExp(`^(${NEW_SESSION_CONFIRMATIONS.map((m) => escapeRegExp(m)).join("|")})$`)),
        { quoted: rawMessage },
      );
    });

    it("ignores group /toolprogress without updating settings or sending text", async () => {
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

      expect(deps.repos.whatsappGroups.upsert).not.toHaveBeenCalled();
      expect(deps.runAgent).not.toHaveBeenCalled();
      expect(mock.sendText).not.toHaveBeenCalled();
    });

    it("does not send group tool progress by default", async () => {
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

      expect(mock.sendText).toHaveBeenCalledTimes(1);
      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", "hello back", { quoted: rawMessage });
    });

    it("does not wire group tool progress when explicitly enabled", async () => {
      const deps = makeDeps({
        runAgent: vi.fn().mockImplementation(async ({ onProgressEvent }) => {
          await onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "src/index.ts" } });
          return makeAgentResult({ trace: { progressEvents: [], finalText: "hello back" } });
        }),
      });
      vi.mocked(deps.repos.whatsappGroups.getByJid).mockResolvedValue({
        jid: "group@g.us",
        name: "Test Group",
        description: null,
        tool_progress: "friendly",
        reasoning_text: 0,
        agent_user_id: null,
        index_enabled: 0,
        slice_gap_minutes: null,
        slice_max_age_minutes: null,
        slice_max_messages: null,
        updated_at: "2025-01-01T00:00:00Z",
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

      expect(mock.editText).not.toHaveBeenCalled();
      expect(mock.sendText).toHaveBeenCalledTimes(1);
      expect(mock.sendText).toHaveBeenCalledWith("group@g.us", "hello back", { quoted: rawMessage });
    });

    it("appends an integration connection link to group mention replies", async () => {
      const deps = makeDeps({
        config: createTestConfig({
          DATA_DIR: "/tmp/test-data",
          PORT: 0,
          LOG_LEVEL: "error",
          BASE_URL: "https://sketch.test",
        }),
        runAgent: vi.fn().mockResolvedValue(
          makeAgentResult({
            trace: { progressEvents: [], finalText: "GitHub needs connection" },
            pendingIntegrationConnections: [
              {
                requestId: "req-1",
                appId: "github",
                appName: "GitHub",
                state: "connect",
                connectUrl: "https://canvas.example.com/connect/secrets?token=github",
              },
            ],
          }),
        ),
      });
      const { mock, getHandler } = createMockWhatsApp();
      wireWhatsAppHandlers(mock as never, deps);
      const handler = getHandler();
      const rawMessage = { key: { remoteJid: "group@g.us", id: "m1", fromMe: false } };

      await handler({
        type: "group",
        text: "@bot create issue",
        jid: "group@g.us",
        messageId: "m1",
        pushName: "Alice",
        rawMessage,
        isMentioned: true,
        senderJid: "5555@s.whatsapp.net",
        senderPhone: "+5555",
      });
      await flush();

      expect(mock.sendText).toHaveBeenCalledWith(
        "group@g.us",
        "GitHub needs connection\n\nTo continue, connect GitHub: https://sketch.test/integrations?connect=github",
        { quoted: rawMessage },
      );
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

    it("applies bound agent overlay when whatsapp_groups.agent_user_id is set", async () => {
      const deps = makeDeps();
      const agentUser = makeUser({
        id: "agent-1",
        name: "Marketing Maven",
        type: "agent",
        description: "You are the marketing maven. Always cite source URLs.",
        allowed_tools: JSON.stringify(["Read", "WebSearch", "mcp__sketch__Search"]),
      });
      vi.mocked(deps.repos.whatsappGroups.getByJid).mockResolvedValue({
        jid: "group@g.us",
        name: "Marketing Crew",
        description: null,
        tool_progress: null,
        reasoning_text: null,
        agent_user_id: "agent-1",
        index_enabled: 0,
        slice_gap_minutes: null,
        slice_max_age_minutes: null,
        slice_max_messages: null,
        updated_at: "2025-01-01T00:00:00Z",
      });
      vi.mocked(deps.repos.users.findById).mockImplementation(async (id) =>
        id === "agent-1" ? agentUser : makeUser({ id }),
      );

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
        senderJid: "1234@s.whatsapp.net",
        senderPhone: "+1234567890",
      });
      await flush();

      expect(deps.runAgent).toHaveBeenCalledOnce();
      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.workspaceKey).toBe("agent-agent-1/whatsappgroup-group@g.us");
      expect(agentCall.agentInstructions).toBe("You are the marketing maven. Always cite source URLs.");
      expect(agentCall.agentAllowedTools).toEqual(["Read", "WebSearch", "mcp__sketch__Search"]);
    });

    it("falls back to default workspace and no overlay when group has no bound agent", async () => {
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
        senderJid: "1234@s.whatsapp.net",
        senderPhone: "+1234567890",
      });
      await flush();

      const agentCall = vi.mocked(deps.runAgent).mock.calls[0][0];
      expect(agentCall.workspaceKey).toBe("wa-group-group@g.us");
      expect(agentCall.agentInstructions).toBeNull();
      expect(agentCall.agentAllowedTools).toBeNull();
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import { InProcessSocketFacade } from "../in-process-socket-facade";
import { phoneE164ToWhatsAppJid } from "../provider";
import { createBaileysWhatsAppProviders } from "./baileys";

function createMockBot() {
  let messageHandler: ((message: unknown, metadata: { socketGeneration: number }) => Promise<void>) | null = null;
  let historyHandler: ((messages: unknown[], metadata: { socketGeneration: number }) => Promise<unknown>) | null = null;
  const bot = {
    isConnected: true,
    socket: null,
    onMessage: vi.fn((handler) => {
      messageHandler = handler;
    }),
    onHistoryMessages: vi.fn((handler) => {
      historyHandler = handler;
    }),
    sendText: vi.fn(async (jid: string) => ({
      key: { id: `sent-${jid}`, remoteJid: jid, fromMe: true },
      messageTimestamp: 1_700_000_000,
    })),
    sendFile: vi.fn(),
    startComposing: vi.fn(),
    stopComposing: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    getGroupMetadata: vi.fn(),
    getProviderGroupMetadata: vi.fn(),
    resolveJidToPhone: vi.fn(),
  };
  return {
    bot,
    facade: new InProcessSocketFacade(bot as never, createTestLogger()),
    emit: async (message: unknown, socketGeneration = 1) => {
      await messageHandler?.(message, { socketGeneration });
    },
    emitHistory: async (messages: unknown[], socketGeneration = 1) => {
      await historyHandler?.(messages, { socketGeneration });
    },
  };
}

describe("createBaileysWhatsAppProviders", () => {
  it("sends DM targets to the current Baileys phone JID", async () => {
    const { bot, facade } = createMockBot();
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());

    const sent = await providers.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello");

    expect(bot.sendText).toHaveBeenCalledWith(phoneE164ToWhatsAppJid("+15551234567"), "hello", undefined);
    expect(sent).toMatchObject({
      providerMessageId: "sent-15551234567@s.whatsapp.net",
      providerConversationId: "15551234567@s.whatsapp.net",
      providerTimestamp: "2023-11-14T22:13:20.000Z",
    });
  });

  it("sends group targets to the Baileys group id", async () => {
    const { bot, facade } = createMockBot();
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());

    await providers.groupProvider.sendText({ kind: "group", groupId: "group@g.us" }, "hello");

    expect(bot.sendText).toHaveBeenCalledWith("group@g.us", "hello", undefined);
  });

  it("returns provider-safe group metadata with participants", async () => {
    const { bot, facade } = createMockBot();
    bot.getProviderGroupMetadata.mockResolvedValue({
      id: "group@g.us",
      subject: "Group",
      desc: null,
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: "admin" }],
    });
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());

    await expect(providers.groupProvider.getGroupMetadata?.("group@g.us")).resolves.toEqual({
      id: "group@g.us",
      subject: "Group",
      desc: null,
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: "admin" }],
    });
    expect(bot.getProviderGroupMetadata).toHaveBeenCalledWith("group@g.us", { refresh: false });
  });

  it("delegates composing, reaction add, and empty-emoji reaction removal", async () => {
    const { bot, facade } = createMockBot();
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());
    const message = {
      kind: "group" as const,
      providerId: "baileys",
      providerMessageId: "message-1",
      providerConversationId: "group@g.us",
      canonicalConversationId: "group:group@g.us",
      providerTimestamp: null,
      senderName: "Alice",
      senderProviderId: "15551234567@s.whatsapp.net",
      senderPhoneE164: "+15551234567",
      target: { kind: "group" as const, groupId: "group@g.us" },
      text: "hello",
      isMentioned: true,
      rawProviderPayload: {
        key: {
          id: "message-1",
          remoteJid: "group@g.us",
          participant: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
      },
    };

    providers.groupProvider.startComposing?.(message.target);
    providers.groupProvider.stopComposing?.(message.target);
    await providers.groupProvider.addReaction?.(message, "👀");
    await providers.groupProvider.removeReaction?.(message);

    expect(bot.startComposing).toHaveBeenCalledWith("group@g.us");
    expect(bot.stopComposing).toHaveBeenCalledWith("group@g.us");
    expect(bot.addReaction).toHaveBeenCalledWith("group@g.us", message.rawProviderPayload.key, "👀");
    expect(bot.removeReaction).toHaveBeenCalledWith("group@g.us", message.rawProviderPayload.key);
  });

  it("delegates media download and LID resolution through facade DTOs", async () => {
    const { bot, facade } = createMockBot();
    bot.resolveJidToPhone.mockResolvedValue("+15551234567");
    vi.spyOn(facade, "downloadMedia").mockResolvedValue({
      stagedPath: "/workspace/attachments/media.jpg",
      mime: "image/jpeg",
      size: 42,
      sha256: "a".repeat(64),
      originalName: "media.jpg",
    });
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());
    const message = {
      kind: "dm" as const,
      providerId: "baileys",
      providerMessageId: "media-1",
      providerConversationId: "15551234567@s.whatsapp.net",
      canonicalConversationId: "dm:+15551234567",
      providerTimestamp: null,
      senderName: "Alice",
      senderProviderId: "86702773280883@lid",
      senderPhoneE164: "+15551234567",
      target: { kind: "dm" as const, phoneE164: "+15551234567" },
      text: "",
      mediaType: "imageMessage",
      rawProviderPayload: { key: { id: "media-1", remoteJid: "86702773280883@lid", fromMe: false } },
    };

    await expect(providers.dmProvider.downloadMedia?.(message, "/workspace", { maxFileBytes: 1024 })).resolves.toEqual([
      {
        originalName: "media.jpg",
        mimeType: "image/jpeg",
        localPath: "/workspace/attachments/media.jpg",
        sizeBytes: 42,
      },
    ]);
    await expect(providers.dmProvider.resolveProviderContactToPhone?.("86702773280883@lid")).resolves.toBe(
      "+15551234567",
    );
    expect(facade.downloadMedia).toHaveBeenCalledWith({
      messageRef: {
        kind: "providerMessageId",
        providerConversationId: "15551234567@s.whatsapp.net",
        value: "media-1",
      },
      destinationDir: "/workspace/attachments",
      maxFileBytes: 1024,
    });
  });

  it("normalizes Baileys inbound DMs before emitting provider events", async () => {
    const { bot, facade, emit } = createMockBot();
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger());
    const handler = vi.fn();
    providers.inboundProvider.onMessage(handler);

    await emit({
      type: "dm",
      text: "hello",
      phoneNumber: "+15551234567",
      jid: "lid-user@lid",
      messageId: "m1",
      pushName: "Alice",
      rawMessage: { key: { id: "m1" }, messageTimestamp: 1_700_000_000 },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dm",
        providerId: "baileys",
        providerMessageId: "m1",
        providerConversationId: "15551234567@s.whatsapp.net",
        canonicalConversationId: "dm:+15551234567",
        senderProviderId: "lid-user@lid",
        senderPhoneE164: "+15551234567",
        text: "hello",
      }),
    );
  });

  it("stamps in-process live and history messages with the composite connection key", async () => {
    const { bot, facade, emit, emitHistory } = createMockBot();
    const providers = createBaileysWhatsAppProviders(facade, bot as never, createTestLogger(), {
      getLeaseGeneration: () => 7,
    });
    const liveHandler = vi.fn();
    const historyHandler = vi.fn(async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }));
    providers.inboundProvider.onMessage(liveHandler);
    providers.inboundProvider.onHistoryMessages?.(historyHandler);
    const groupMessage = {
      type: "group",
      text: "hello",
      jid: "group@g.us",
      messageId: "m1",
      pushName: "Alice",
      rawMessage: {
        key: { id: "m1", remoteJid: "group@g.us", participant: "15551234567@s.whatsapp.net", fromMe: false },
        messageTimestamp: 1_700_000_000,
      },
      isMentioned: false,
      senderJid: "15551234567@s.whatsapp.net",
      senderPhone: "+15551234567",
    };

    await emit(groupMessage, 19);
    await emitHistory([groupMessage], 20);

    expect(liveHandler).toHaveBeenCalledWith(expect.objectContaining({ connectionKey: "000000000007:000000000019" }));
    expect(historyHandler).toHaveBeenCalledWith(
      [expect.objectContaining({ connectionKey: "000000000007:000000000020" })],
      expect.objectContaining({ socketGeneration: 20 }),
    );
  });
});

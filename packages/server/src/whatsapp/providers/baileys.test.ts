import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import { phoneE164ToWhatsAppJid } from "../provider";
import { createBaileysWhatsAppProviders } from "./baileys";

function createMockBot() {
  let messageHandler: ((message: unknown) => Promise<void>) | null = null;
  return {
    bot: {
      isConnected: true,
      socket: null,
      onMessage: vi.fn((handler) => {
        messageHandler = handler;
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
    },
    emit: async (message: unknown) => {
      await messageHandler?.(message);
    },
  };
}

describe("createBaileysWhatsAppProviders", () => {
  it("sends DM targets to the current Baileys phone JID", async () => {
    const { bot } = createMockBot();
    const providers = createBaileysWhatsAppProviders(bot as never, createTestLogger());

    const sent = await providers.dmProvider.sendText({ kind: "dm", phoneE164: "+15551234567" }, "hello");

    expect(bot.sendText).toHaveBeenCalledWith(phoneE164ToWhatsAppJid("+15551234567"), "hello", undefined);
    expect(sent).toMatchObject({
      providerMessageId: "sent-15551234567@s.whatsapp.net",
      providerConversationId: "15551234567@s.whatsapp.net",
      providerTimestamp: "2023-11-14T22:13:20.000Z",
    });
  });

  it("sends group targets to the Baileys group id", async () => {
    const { bot } = createMockBot();
    const providers = createBaileysWhatsAppProviders(bot as never, createTestLogger());

    await providers.groupProvider.sendText({ kind: "group", groupId: "group@g.us" }, "hello");

    expect(bot.sendText).toHaveBeenCalledWith("group@g.us", "hello", undefined);
  });

  it("returns provider-safe group metadata with participants", async () => {
    const { bot } = createMockBot();
    bot.getProviderGroupMetadata.mockResolvedValue({
      id: "group@g.us",
      subject: "Group",
      desc: null,
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: "admin" }],
    });
    const providers = createBaileysWhatsAppProviders(bot as never, createTestLogger());

    await expect(providers.groupProvider.getGroupMetadata?.("group@g.us")).resolves.toEqual({
      id: "group@g.us",
      subject: "Group",
      desc: null,
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: "admin" }],
    });
    expect(bot.getProviderGroupMetadata).toHaveBeenCalledWith("group@g.us");
  });

  it("normalizes Baileys inbound DMs before emitting provider events", async () => {
    const { bot, emit } = createMockBot();
    const providers = createBaileysWhatsAppProviders(bot as never, createTestLogger());
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
});

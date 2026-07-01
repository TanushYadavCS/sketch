import { describe, expect, it, vi } from "vitest";
import { createWhatsAppMessageHandler } from "./message-handler";
import type { WhatsAppInboundMessage, WhatsAppTarget } from "./provider";

const dmTarget: WhatsAppTarget = { kind: "dm", phoneE164: "+15551234567", providerConversationId: "jid" };
const groupTarget: WhatsAppTarget = { kind: "group", groupId: "group@g.us" };

function createMockWhatsApp(connected = true) {
  return {
    isConnected: connected,
    sendText: vi
      .fn()
      .mockResolvedValue(
        connected ? { providerMessageId: "sent-1", providerConversationId: "jid", providerTimestamp: null } : null,
      ),
  };
}

describe("createWhatsAppMessageHandler", () => {
  it("sends text when connected", async () => {
    const bot = createMockWhatsApp();
    const onMessage = createWhatsAppMessageHandler(bot as never, dmTarget);

    await onMessage("Hello!");

    expect(bot.sendText).toHaveBeenCalledWith(dmTarget, "Hello!");
  });

  it("sends multiple messages", async () => {
    const bot = createMockWhatsApp();
    const onMessage = createWhatsAppMessageHandler(bot as never, dmTarget);

    await onMessage("First");
    await onMessage("Second");

    expect(bot.sendText).toHaveBeenCalledTimes(2);
    expect(bot.sendText).toHaveBeenCalledWith(dmTarget, "Second");
  });

  it("skips sendText when disconnected", async () => {
    const bot = createMockWhatsApp(false);
    const onMessage = createWhatsAppMessageHandler(bot as never, dmTarget);

    await onMessage("Hello!");

    expect(bot.sendText).not.toHaveBeenCalled();
  });

  describe("quoted replies", () => {
    const quotedMsg = {
      kind: "group",
      providerId: "baileys",
      providerMessageId: "QUOTED123",
      providerConversationId: "group@g.us",
      canonicalConversationId: "group:group@g.us",
      providerTimestamp: null,
      senderName: "Alice",
      senderProviderId: "111@s.whatsapp.net",
      senderPhoneE164: "+111",
      target: groupTarget,
      text: "original message",
      isMentioned: true,
      rawProviderPayload: { key: { remoteJid: "group@g.us", id: "QUOTED123", fromMe: false } },
    } satisfies WhatsAppInboundMessage;

    it("quotes the first message when quotedMessage is provided", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, groupTarget, quotedMsg);

      await onMessage("Reply text");

      expect(bot.sendText).toHaveBeenCalledWith(groupTarget, "Reply text", { quotedMessage: quotedMsg });
    });

    it("does not quote subsequent messages", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, groupTarget, quotedMsg);

      await onMessage("First reply");
      await onMessage("Second reply");

      expect(bot.sendText).toHaveBeenNthCalledWith(1, groupTarget, "First reply", { quotedMessage: quotedMsg });
      expect(bot.sendText).toHaveBeenNthCalledWith(2, groupTarget, "Second reply");
    });

    it("sends without quote when no quotedMessage provided", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, dmTarget);

      await onMessage("No quote");

      expect(bot.sendText).toHaveBeenCalledWith(dmTarget, "No quote");
    });

    it("does not quote when disconnected (skips entirely)", async () => {
      const bot = createMockWhatsApp(false);
      const onMessage = createWhatsAppMessageHandler(bot as never, groupTarget, quotedMsg);

      await onMessage("Should not send");

      expect(bot.sendText).not.toHaveBeenCalled();
    });
  });
});

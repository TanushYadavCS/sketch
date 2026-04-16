import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppMessageHandler } from "./message-handler";

function createMockWhatsApp(connected = true) {
  return {
    isConnected: connected,
    sendText: vi.fn().mockResolvedValue(connected ? { key: { remoteJid: "jid", id: "sent-1", fromMe: true } } : null),
    editText: vi.fn().mockResolvedValue(connected ? { key: { remoteJid: "jid", id: "edit-1", fromMe: true } } : null),
  };
}

describe("createWhatsAppMessageHandler", () => {
  it("sends text when connected", async () => {
    const bot = createMockWhatsApp();
    const onMessage = createWhatsAppMessageHandler(bot as never, "jid");

    await onMessage("Hello!");

    expect(bot.sendText).toHaveBeenCalledWith("jid", "Hello!");
  });

  it("sends multiple messages", async () => {
    const bot = createMockWhatsApp();
    const onMessage = createWhatsAppMessageHandler(bot as never, "jid");

    await onMessage("First");
    await onMessage("Second");

    expect(bot.sendText).toHaveBeenCalledTimes(2);
    expect(bot.sendText).toHaveBeenCalledWith("jid", "Second");
  });

  it("skips sendText when disconnected", async () => {
    const bot = createMockWhatsApp(false);
    const onMessage = createWhatsAppMessageHandler(bot as never, "jid");

    await onMessage("Hello!");

    expect(bot.sendText).not.toHaveBeenCalled();
  });

  describe("quoted replies", () => {
    const quotedMsg = {
      key: { remoteJid: "group@g.us", id: "QUOTED123", fromMe: false },
      message: { conversation: "original message" },
    } as WAMessage;

    it("quotes the first message when quotedMessage is provided", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, "group@g.us", quotedMsg);

      await onMessage("Reply text");

      expect(bot.sendText).toHaveBeenCalledWith("group@g.us", "Reply text", { quoted: quotedMsg });
    });

    it("does not quote subsequent messages", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, "group@g.us", quotedMsg);

      await onMessage("First reply");
      await onMessage("Second reply");

      expect(bot.sendText).toHaveBeenNthCalledWith(1, "group@g.us", "First reply", { quoted: quotedMsg });
      expect(bot.sendText).toHaveBeenNthCalledWith(2, "group@g.us", "Second reply");
    });

    it("sends without quote when no quotedMessage provided", async () => {
      const bot = createMockWhatsApp();
      const onMessage = createWhatsAppMessageHandler(bot as never, "jid");

      await onMessage("No quote");

      expect(bot.sendText).toHaveBeenCalledWith("jid", "No quote");
    });

    it("does not quote when disconnected (skips entirely)", async () => {
      const bot = createMockWhatsApp(false);
      const onMessage = createWhatsAppMessageHandler(bot as never, "group@g.us", quotedMsg);

      await onMessage("Should not send");

      expect(bot.sendText).not.toHaveBeenCalled();
    });
  });
});

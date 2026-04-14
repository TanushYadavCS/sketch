import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppMessageHandler, createWhatsAppToolProgressHandler } from "./message-handler";

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

describe("createWhatsAppToolProgressHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first progress update as a new message", async () => {
    const bot = createMockWhatsApp();
    const onProgress = createWhatsAppToolProgressHandler(bot as never, "jid");

    await onProgress(['📖 Read: "src/index.ts"']);

    expect(bot.sendText).toHaveBeenCalledWith("jid", '📖 Read: "src/index.ts"', undefined);
    expect(bot.editText).not.toHaveBeenCalled();
  });

  it("edits the same progress message on subsequent updates", async () => {
    const bot = createMockWhatsApp();
    const onProgress = createWhatsAppToolProgressHandler(bot as never, "jid");

    await onProgress(['📖 Read: "src/index.ts"']);
    await vi.advanceTimersByTimeAsync(1_500);
    await onProgress(['📖 Read: "src/index.ts"', '💻 Bash: "pnpm test"']);

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.editText).toHaveBeenCalledWith(
      "jid",
      { remoteJid: "jid", id: "sent-1", fromMe: true },
      '📖 Read: "src/index.ts"\n💻 Bash: "pnpm test"',
    );
  });

  it("quotes the first progress message in groups", async () => {
    const bot = createMockWhatsApp();
    const quotedMsg = {
      key: { remoteJid: "group@g.us", id: "QUOTED123", fromMe: false },
      message: { conversation: "original message" },
    } as WAMessage;
    const onProgress = createWhatsAppToolProgressHandler(bot as never, "group@g.us", quotedMsg);

    await onProgress(['📖 Read: "src/index.ts"']);

    expect(bot.sendText).toHaveBeenCalledWith("group@g.us", '📖 Read: "src/index.ts"', { quoted: quotedMsg });
  });

  it("throttles rapid progress updates and applies only the latest edit", async () => {
    const bot = createMockWhatsApp();
    const onProgress = createWhatsAppToolProgressHandler(bot as never, "jid");

    await onProgress(['📖 Read: "src/index.ts"']);
    await onProgress(['📖 Read: "src/index.ts"', '💻 Bash: "pnpm test"']);
    await onProgress(['📖 Read: "src/index.ts"', '💻 Bash: "pnpm test"', '🔧 Edit: "src/app.ts"']);

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.editText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(bot.editText).toHaveBeenCalledTimes(1);
    expect(bot.editText).toHaveBeenCalledWith(
      "jid",
      { remoteJid: "jid", id: "sent-1", fromMe: true },
      '📖 Read: "src/index.ts"\n💻 Bash: "pnpm test"\n🔧 Edit: "src/app.ts"',
    );
  });

  it("skips progress updates when disconnected", async () => {
    const bot = createMockWhatsApp(false);
    const onProgress = createWhatsAppToolProgressHandler(bot as never, "jid");

    await onProgress(['📖 Read: "src/index.ts"']);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(bot.sendText).toHaveBeenCalledWith("jid", '📖 Read: "src/index.ts"', undefined);
    expect(bot.editText).not.toHaveBeenCalled();
  });
});

import type { WAMessage } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppProgressTransport } from "./progress-transport";

function createMockWhatsApp(connected = true) {
  return {
    isConnected: connected,
    sendText: vi
      .fn()
      .mockResolvedValueOnce(connected ? { key: { remoteJid: "jid", id: "sent-1", fromMe: true } } : null)
      .mockResolvedValueOnce(connected ? { key: { remoteJid: "jid", id: "sent-2", fromMe: true } } : null),
    editText: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createWhatsAppProgressTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("quotes only the first progress message when a quoted message is provided", async () => {
    const bot = createMockWhatsApp();
    const quotedMessage = {
      key: { remoteJid: "group@g.us", id: "quoted-1", fromMe: false },
      message: { conversation: "original" },
    } as WAMessage;
    const transport = createWhatsAppProgressTransport(bot, "group@g.us", "accumulate", quotedMessage);

    await transport.pushLines(["📖 Read"]);
    await transport.pushLines(["🔧 Edit"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.sendText).toHaveBeenNthCalledWith(1, "group@g.us", "📖 Read", { quoted: quotedMessage });
    expect(bot.editText).toHaveBeenCalledWith(
      "group@g.us",
      { remoteJid: "jid", id: "sent-1", fromMe: true },
      "📖 Read\n🔧 Edit",
    );
  });

  it("rolls over when the progress text exceeds the WhatsApp limit", async () => {
    const bot = createMockWhatsApp();
    const transport = createWhatsAppProgressTransport(bot, "jid", "accumulate");

    await transport.pushLines(["a".repeat(3_995)]);
    await transport.pushLines(["second line"]);
    await transport.flush();

    expect(bot.sendText).toHaveBeenNthCalledWith(1, "jid", "a".repeat(3_995), undefined);
    expect(bot.sendText).toHaveBeenNthCalledWith(2, "jid", "second line", undefined);
    expect(bot.editText).not.toHaveBeenCalled();
  });

  it("replaces the latest concise status in place", async () => {
    const bot = createMockWhatsApp();
    const transport = createWhatsAppProgressTransport(bot, "jid", "replace");

    await transport.pushLines(["📖 Checking"]);
    await transport.pushLines(["🔧 Updating"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.editText).toHaveBeenCalledWith("jid", { remoteJid: "jid", id: "sent-1", fromMe: true }, "🔧 Updating");
  });
});

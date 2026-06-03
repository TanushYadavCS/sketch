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

    await transport.syncLines(["📖 Read"]);
    await transport.syncLines(["📖 Read", "🔧 Edit"]);
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

    await transport.syncLines(["a".repeat(3_995)]);
    await transport.syncLines(["a".repeat(3_995), "second line"]);
    await transport.flush();

    expect(bot.sendText).toHaveBeenNthCalledWith(1, "jid", "a".repeat(3_995), undefined);
    expect(bot.sendText).toHaveBeenNthCalledWith(2, "jid", "second line", undefined);
    expect(bot.editText).not.toHaveBeenCalled();
  });

  it("splits a single oversized progress line into multiple WhatsApp messages", async () => {
    const bot = createMockWhatsApp();
    const transport = createWhatsAppProgressTransport(bot, "jid", "accumulate");
    const hugeLine = `Write: ${"x".repeat(6_000)}`;

    await transport.syncLines([hugeLine]);
    await transport.flush();

    expect(bot.sendText.mock.calls.length).toBeGreaterThan(1);
    for (const call of bot.sendText.mock.calls) {
      expect(String(call[1]).length).toBeLessThanOrEqual(4_000);
    }
    expect(bot.editText).not.toHaveBeenCalled();
  });

  it("retries with smaller progress segments when WhatsApp rejects a send as too long", async () => {
    let sentCount = 0;
    const deliveredTexts: string[] = [];
    const bot = {
      isConnected: true,
      sendText: vi.fn(async (_jid: string, text: string) => {
        if (text.length > 200) {
          const err = new Error("msg_too_long");
          Object.assign(err, { data: { error: "msg_too_long" } });
          throw err;
        }
        deliveredTexts.push(text);
        sentCount += 1;
        return { key: { remoteJid: "jid", id: `sent-${sentCount}`, fromMe: true } };
      }),
      editText: vi.fn().mockResolvedValue(undefined),
    };
    const transport = createWhatsAppProgressTransport(bot, "jid", "accumulate");

    await transport.syncLines([`Write: ${"x".repeat(1_000)}`]);
    await transport.flush();

    expect(deliveredTexts.length).toBeGreaterThan(1);
    for (const text of deliveredTexts) {
      expect(text.length).toBeLessThanOrEqual(200);
    }
  });

  it("replaces the latest status in place", async () => {
    const bot = createMockWhatsApp();
    const transport = createWhatsAppProgressTransport(bot, "jid", "replace");

    await transport.syncLines(["📖 Checking"]);
    await transport.syncLines(["🔧 Updating"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.editText).toHaveBeenCalledWith("jid", { remoteJid: "jid", id: "sent-1", fromMe: true }, "🔧 Updating");
  });

  it("edits the current progress message when dedup rewrites the rendered state", async () => {
    const bot = createMockWhatsApp();
    const transport = createWhatsAppProgressTransport(bot, "jid", "accumulate");

    await transport.syncLines(['🔧 Editing "a.ts"']);
    await transport.syncLines(['🔧 Editing "a.ts" (x2)']);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.sendText).toHaveBeenCalledWith("jid", '🔧 Editing "a.ts"', undefined);
    expect(bot.editText).toHaveBeenCalledWith(
      "jid",
      { remoteJid: "jid", id: "sent-1", fromMe: true },
      '🔧 Editing "a.ts" (x2)',
    );
  });
});

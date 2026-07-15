import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import type { WhatsAppBot } from "./bot";
import { InProcessSocketFacade } from "./in-process-socket-facade";

function createMockBot() {
  const bot = {
    isConnected: true,
    phoneNumber: "+15550001111",
    socket: null,
    startPairing: vi.fn(async (callbacks) => {
      await callbacks.onQr("qr-value");
      await callbacks.onConnected("+15550001111");
    }),
    cancelPairing: vi.fn(),
    disconnect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendText: vi.fn(async (target: string) => ({
      key: { id: `sent-${target}`, remoteJid: target, fromMe: true },
      messageTimestamp: 1_700_000_000,
    })),
    sendFile: vi.fn(async (target: string) => ({
      key: { id: `file-${target}`, remoteJid: target, fromMe: true },
      messageTimestamp: 1_700_000_001,
    })),
    startComposing: vi.fn(),
    stopComposing: vi.fn(),
    addReaction: vi.fn(async () => null),
    removeReaction: vi.fn(async () => null),
    getProviderGroupMetadata: vi.fn(async () => ({
      id: "group@g.us",
      subject: "Group",
      desc: null,
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: null }],
    })),
    syncAllGroups: vi.fn(async () => 1),
    resolveJidToPhone: vi.fn(async () => "+15551234567"),
  };
  return { bot, facade: new InProcessSocketFacade(bot as unknown as WhatsAppBot, createTestLogger()) };
}

describe("InProcessSocketFacade", () => {
  it("delegates text, file, composing, metadata, sync, LID, and lifecycle operations", async () => {
    const { bot, facade } = createMockBot();

    await expect(
      facade.send("group@g.us", { kind: "text", text: "hello" }, { idempotencyKey: "send-text" }),
    ).resolves.toMatchObject({
      providerMessageId: "sent-group@g.us",
      providerConversationId: "group@g.us",
      providerTimestamp: "2023-11-14T22:13:20.000Z",
    });
    expect(bot.sendText).toHaveBeenCalledWith("group@g.us", "hello", undefined);

    await facade.send(
      "group@g.us",
      { kind: "file", filePath: "/tmp/report.pdf", mimeType: "application/pdf", fileName: "report.pdf" },
      { idempotencyKey: "send-file" },
    );
    expect(bot.sendFile).toHaveBeenCalledWith("group@g.us", "/tmp/report.pdf", "application/pdf", "report.pdf");

    await facade.sendComposing("group@g.us", true);
    await facade.sendComposing("group@g.us", false);
    expect(bot.startComposing).toHaveBeenCalledWith("group@g.us");
    expect(bot.stopComposing).toHaveBeenCalledWith("group@g.us");

    await expect(facade.groupMetadata("group@g.us", { refresh: true })).resolves.toMatchObject({
      participants: [{ jid: "15551234567@s.whatsapp.net" }],
    });
    expect(bot.getProviderGroupMetadata).toHaveBeenCalledWith("group@g.us", { refresh: true });
    await expect(facade.syncAllGroups({ force: true })).resolves.toEqual({ synced: 1 });
    await expect(facade.resolveLid("86702773280883@lid")).resolves.toBe("15551234567@s.whatsapp.net");

    const pairingEvents: unknown[] = [];
    await facade.pairing.startQr(async (event) => {
      pairingEvents.push(event);
    });
    expect(pairingEvents).toEqual([
      { type: "qr", qr: "qr-value" },
      { type: "connected", phoneNumber: "+15550001111" },
    ]);
    await expect(facade.pairing.status()).resolves.toEqual({ connected: true, phoneNumber: "+15550001111" });
    await facade.pairing.cancel();
    await facade.pairing.logout();
    await facade.shutdown();
    expect(bot.cancelPairing).toHaveBeenCalledOnce();
    expect(bot.disconnect).toHaveBeenCalledOnce();
    expect(bot.stop).toHaveBeenCalledOnce();
  });

  it("preserves quoted sends and reaction removal through normalized message references", async () => {
    const { bot, facade } = createMockBot();
    const rawMessage = {
      key: { id: "quoted-1", remoteJid: "group@g.us", participant: "15551234567@s.whatsapp.net", fromMe: false },
      message: { conversation: "quoted" },
    };
    const quotedRef = {
      kind: "providerMessageId" as const,
      providerConversationId: "group@g.us",
      value: "quoted-1",
    };
    facade.rememberMessage({
      providerConversationId: "group@g.us",
      providerMessageId: "quoted-1",
      rawProviderPayload: rawMessage,
    });

    await facade.send("group@g.us", { kind: "text", text: "reply" }, { quotedRef, idempotencyKey: "reply-1" });
    expect(bot.sendText).toHaveBeenCalledWith("group@g.us", "reply", { quoted: rawMessage });

    await expect(facade.react("group@g.us", quotedRef, "👀")).resolves.toEqual({ ok: true });
    expect(bot.addReaction).toHaveBeenCalledWith("group@g.us", rawMessage.key, "👀");
    await expect(facade.react("group@g.us", quotedRef, "")).resolves.toEqual({ ok: true });
    expect(bot.removeReaction).toHaveBeenCalledWith("group@g.us", rawMessage.key);
  });

  it("returns the specified unknown-message miss without calling the bot", async () => {
    const { bot, facade } = createMockBot();
    const missingRef = {
      kind: "providerMessageId" as const,
      providerConversationId: "group@g.us",
      value: "missing",
    };

    await expect(facade.react("group@g.us", missingRef, "👀")).resolves.toEqual({ error: "unknown-message" });
    await expect(
      facade.downloadMedia({ messageRef: missingRef, destinationDir: "/tmp/attachments", maxFileBytes: 1024 }),
    ).resolves.toBeNull();
    expect(bot.addReaction).not.toHaveBeenCalled();
  });
});

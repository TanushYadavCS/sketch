import type { proto } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  WhatsAppBot,
  extractContextInfo,
  extractText,
  hasMediaContent,
  jidToPhoneNumber,
  stripBotMention,
} from "./bot";

describe("extractText", () => {
  it("returns text from conversation field", () => {
    const msg = { message: { conversation: "hello" } } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBe("hello");
  });

  it("returns text from extendedTextMessage", () => {
    const msg = {
      message: { extendedTextMessage: { text: "quoted reply" } },
    } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBe("quoted reply");
  });

  it("returns caption from imageMessage", () => {
    const msg = {
      message: { imageMessage: { caption: "photo caption" } },
    } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBe("photo caption");
  });

  it("returns caption from videoMessage", () => {
    const msg = {
      message: { videoMessage: { caption: "video caption" } },
    } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBe("video caption");
  });

  it("returns caption from documentMessage", () => {
    const msg = {
      message: { documentMessage: { caption: "doc caption" } },
    } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBe("doc caption");
  });

  it("returns null for media-only messages without caption", () => {
    const msg = {
      message: { imageMessage: { url: "https://example.com/img.jpg" } },
    } as proto.IWebMessageInfo;
    expect(extractText(msg)).toBeNull();
  });

  it("returns null when message is undefined", () => {
    const msg = {} as proto.IWebMessageInfo;
    expect(extractText(msg)).toBeNull();
  });
});

describe("hasMediaContent", () => {
  it("returns true for imageMessage", () => {
    expect(hasMediaContent("imageMessage")).toBe(true);
  });

  it("returns true for videoMessage", () => {
    expect(hasMediaContent("videoMessage")).toBe(true);
  });

  it("returns true for audioMessage", () => {
    expect(hasMediaContent("audioMessage")).toBe(true);
  });

  it("returns true for documentMessage", () => {
    expect(hasMediaContent("documentMessage")).toBe(true);
  });

  it("returns true for stickerMessage", () => {
    expect(hasMediaContent("stickerMessage")).toBe(true);
  });

  it("returns false for conversation", () => {
    expect(hasMediaContent("conversation")).toBe(false);
  });

  it("returns false for extendedTextMessage", () => {
    expect(hasMediaContent("extendedTextMessage")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasMediaContent(undefined)).toBe(false);
  });
});

describe("jidToPhoneNumber", () => {
  it("strips @s.whatsapp.net and prepends +", () => {
    expect(jidToPhoneNumber("14155238886@s.whatsapp.net")).toBe("+14155238886");
  });

  it("handles LID format (number:device@s.whatsapp.net)", () => {
    expect(jidToPhoneNumber("919876543210:0@s.whatsapp.net")).toBe("+919876543210");
  });

  it("handles number with device suffix > 0", () => {
    expect(jidToPhoneNumber("14155238886:2@s.whatsapp.net")).toBe("+14155238886");
  });

  it("handles @lid JID format", () => {
    expect(jidToPhoneNumber("86702773280883@lid")).toBe("+86702773280883");
  });

  it("handles @lid JID with device suffix", () => {
    expect(jidToPhoneNumber("86702773280883:0@lid")).toBe("+86702773280883");
  });
});

describe("WhatsAppBot.phoneNumber", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns null when not connected (no socket)", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    expect(bot.phoneNumber).toBeNull();
  });

  it("returns null when socket has no user", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    // Access private sock field via cast to set up the test scenario
    (bot as unknown as { sock: { user: undefined } }).sock = { user: undefined };
    expect(bot.phoneNumber).toBeNull();
  });

  it("extracts phone number from sock.user.id (simple format)", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    (bot as unknown as { sock: { user: { id: string } } }).sock = {
      user: { id: "919876543210@s.whatsapp.net" },
    };
    expect(bot.phoneNumber).toBe("+919876543210");
  });

  it("extracts phone number from sock.user.id (LID format with device)", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    (bot as unknown as { sock: { user: { id: string } } }).sock = {
      user: { id: "14155238886:0@s.whatsapp.net" },
    };
    expect(bot.phoneNumber).toBe("+14155238886");
  });
});

describe("WhatsAppBot.disconnect", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("clears credentials from DB", async () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });

    // Seed some creds so there's something to clear
    await db.insertInto("whatsapp_creds").values({ id: "default", creds: "{}" }).execute();
    await db.insertInto("whatsapp_keys").values({ type: "pre-key", key_id: "1", value: "{}" }).execute();

    // Verify creds exist before disconnect
    const before = await db.selectFrom("whatsapp_creds").selectAll().execute();
    expect(before).toHaveLength(1);

    await bot.disconnect();

    // Verify creds and keys are cleared
    const credsAfter = await db.selectFrom("whatsapp_creds").selectAll().execute();
    const keysAfter = await db.selectFrom("whatsapp_keys").selectAll().execute();
    expect(credsAfter).toHaveLength(0);
    expect(keysAfter).toHaveLength(0);
  });

  it("is safe to call when not connected", async () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    // Should not throw
    await bot.disconnect();
    expect(bot.isConnected).toBe(false);
  });
});

describe("WhatsAppBot reconnect lifecycle", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  function createConnectionSocket() {
    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const socket = {
      ev: {
        on: (event: string, handler: (payload: unknown) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
    };
    return {
      socket,
      emitConnectionUpdate: (payload: unknown) => handlers.get("connection.update")?.(payload),
    };
  }

  it("ignores close events from stale sockets", async () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const stale = createConnectionSocket();
    const current = createConnectionSocket();
    const createSocket = vi.fn().mockResolvedValue(undefined);

    (bot as unknown as { sock: unknown; activeSocketGeneration: number; createSocket: typeof createSocket }).sock =
      current.socket;
    (bot as unknown as { activeSocketGeneration: number }).activeSocketGeneration = 2;
    (bot as unknown as { createSocket: typeof createSocket }).createSocket = createSocket;
    (
      bot as unknown as {
        registerConnectionHandler: (
          socket: unknown,
          authState: { clearCreds: () => Promise<void> },
          socketGeneration: number,
        ) => void;
      }
    ).registerConnectionHandler(stale.socket as never, { clearCreds: vi.fn().mockResolvedValue(undefined) }, 1);

    await stale.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "stale close" } },
    });
    await vi.runAllTimersAsync();

    expect(createSocket).not.toHaveBeenCalled();
  });

  it("schedules only one reconnect for repeated close events", async () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const current = createConnectionSocket();
    const createSocket = vi.fn().mockResolvedValue(undefined);

    (bot as unknown as { sock: unknown; activeSocketGeneration: number; createSocket: typeof createSocket }).sock =
      current.socket;
    (bot as unknown as { activeSocketGeneration: number }).activeSocketGeneration = 1;
    (bot as unknown as { createSocket: typeof createSocket }).createSocket = createSocket;
    (
      bot as unknown as {
        registerConnectionHandler: (
          socket: unknown,
          authState: { clearCreds: () => Promise<void> },
          socketGeneration: number,
        ) => void;
      }
    ).registerConnectionHandler(current.socket as never, { clearCreds: vi.fn().mockResolvedValue(undefined) }, 1);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "disconnect" } },
    });
    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "disconnect again" } },
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(createSocket).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
  });

  it("cancels a pending reconnect when the socket opens again", async () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const current = createConnectionSocket();
    const createSocket = vi.fn().mockResolvedValue(undefined);

    (bot as unknown as { sock: unknown; activeSocketGeneration: number; createSocket: typeof createSocket }).sock =
      current.socket;
    (bot as unknown as { activeSocketGeneration: number }).activeSocketGeneration = 1;
    (bot as unknown as { createSocket: typeof createSocket }).createSocket = createSocket;
    (
      bot as unknown as {
        registerConnectionHandler: (
          socket: unknown,
          authState: { clearCreds: () => Promise<void> },
          socketGeneration: number,
        ) => void;
      }
    ).registerConnectionHandler(current.socket as never, { clearCreds: vi.fn().mockResolvedValue(undefined) }, 1);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "disconnect" } },
    });
    await current.emitConnectionUpdate({ connection: "open" });
    await vi.runAllTimersAsync();

    expect(createSocket).not.toHaveBeenCalled();

    randomSpy.mockRestore();
  });
});

describe("WhatsAppBot.composing", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  function createBotWithMockSock() {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const sendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
    (bot as unknown as { sock: { sendPresenceUpdate: typeof sendPresenceUpdate } }).sock = {
      sendPresenceUpdate,
    };
    return { bot, sendPresenceUpdate };
  }

  it("sends composing immediately on startComposing", () => {
    const { bot, sendPresenceUpdate } = createBotWithMockSock();
    bot.startComposing("123@s.whatsapp.net");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "123@s.whatsapp.net");
    bot.stopComposing("123@s.whatsapp.net");
  });

  it("re-sends composing every 5 seconds", () => {
    const { bot, sendPresenceUpdate } = createBotWithMockSock();
    bot.startComposing("123@s.whatsapp.net");
    expect(sendPresenceUpdate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(sendPresenceUpdate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5000);
    expect(sendPresenceUpdate).toHaveBeenCalledTimes(3);

    bot.stopComposing("123@s.whatsapp.net");
  });

  it("stopComposing clears interval and sends paused", () => {
    const { bot, sendPresenceUpdate } = createBotWithMockSock();
    bot.startComposing("123@s.whatsapp.net");
    sendPresenceUpdate.mockClear();

    bot.stopComposing("123@s.whatsapp.net");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("paused", "123@s.whatsapp.net");

    // No more composing calls after stop
    vi.advanceTimersByTime(10_000);
    expect(sendPresenceUpdate).toHaveBeenCalledTimes(1); // only the paused call
  });

  it("auto-stops after TTL (3 minutes)", () => {
    const { bot, sendPresenceUpdate } = createBotWithMockSock();
    bot.startComposing("123@s.whatsapp.net");
    sendPresenceUpdate.mockClear();

    vi.advanceTimersByTime(3 * 60_000);
    // Should have sent paused via TTL auto-cleanup
    expect(sendPresenceUpdate).toHaveBeenCalledWith("paused", "123@s.whatsapp.net");

    // No more composing after TTL
    sendPresenceUpdate.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("startComposing is safe when no socket", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    // Should not throw
    bot.startComposing("123@s.whatsapp.net");
    bot.stopComposing("123@s.whatsapp.net");
  });
});

describe("WhatsAppBot sending helpers", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  function createBotWithSendMessage() {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ key: { remoteJid: "123@s.whatsapp.net", id: "MSG1", fromMe: true } });
    (bot as unknown as { sock: { sendMessage: typeof sendMessage } }).sock = { sendMessage };
    return { bot, sendMessage };
  }

  it("sendText returns the first sent message reference", async () => {
    const { bot, sendMessage } = createBotWithSendMessage();

    const sent = await bot.sendText("123@s.whatsapp.net", "hello");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hello" }, undefined);
    expect(sent?.key?.id).toBe("MSG1");
  });

  it("editText sends a WhatsApp edit payload", async () => {
    const { bot, sendMessage } = createBotWithSendMessage();

    await bot.editText(
      "123@s.whatsapp.net",
      { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: true },
      "updated",
    );

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", {
      text: "updated",
      edit: { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: true },
    });
  });

  it("addReaction sends a WhatsApp reaction payload", async () => {
    const { bot, sendMessage } = createBotWithSendMessage();

    await bot.addReaction("123@s.whatsapp.net", { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: false }, "👀");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", {
      react: {
        text: "👀",
        key: { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: false },
      },
    });
  });

  it("removeReaction sends an empty-text reaction payload", async () => {
    const { bot, sendMessage } = createBotWithSendMessage();

    await bot.removeReaction("123@s.whatsapp.net", { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: false });

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", {
      react: {
        text: "",
        key: { remoteJid: "123@s.whatsapp.net", id: "TARGET", fromMe: false },
      },
    });
  });
});

describe("WhatsAppBot group metadata persistence", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists fetched group metadata on first lookup", async () => {
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn().mockResolvedValue({ subject: "Product Team", desc: "Roadmap syncs" });
    (bot as unknown as { sock: { groupMetadata: typeof groupMetadata } }).sock = { groupMetadata };

    const meta = await bot.getGroupMetadata("123@g.us");

    expect(meta?.subject).toBe("Product Team");
    const stored = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", "123@g.us").executeTakeFirst();
    expect(stored?.name).toBe("Product Team");
    expect(stored?.description).toBe("Roadmap syncs");
  });

  it("refreshes persisted metadata when a groups.update event arrives", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn().mockResolvedValue({ subject: "Renamed Group", desc: "Updated desc" });
    (
      bot as unknown as {
        sock: {
          groupMetadata: typeof groupMetadata;
          ev: { on: (event: string, handler: (...args: unknown[]) => Promise<void>) => void };
        };
      }
    ).sock = {
      groupMetadata,
      ev: {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      },
    };

    (bot as unknown as { registerGroupEventHandlers: () => void }).registerGroupEventHandlers();
    await handlers.get("groups.update")?.([{ id: "group@g.us" }]);

    const stored = await db
      .selectFrom("whatsapp_groups")
      .selectAll()
      .where("jid", "=", "group@g.us")
      .executeTakeFirst();
    expect(stored?.name).toBe("Renamed Group");
    expect(stored?.description).toBe("Updated desc");
  });

  it("does not throw when group metadata refresh fails during event handling", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn().mockRejectedValue(new Error("boom"));
    (
      bot as unknown as {
        sock: {
          groupMetadata: typeof groupMetadata;
          ev: { on: (event: string, handler: (...args: unknown[]) => Promise<void>) => void };
        };
      }
    ).sock = {
      groupMetadata,
      ev: {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
      },
    };

    (bot as unknown as { registerGroupEventHandlers: () => void }).registerGroupEventHandlers();

    await expect(handlers.get("group-participants.update")?.({ id: "group@g.us" })).resolves.toBeUndefined();
    await expect(
      db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", "group@g.us").executeTakeFirst(),
    ).resolves.toBeUndefined();
  });
});

describe("WhatsAppBot handleGroupMessage LID resolution", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  /**
   * Builds a bot with a mock socket wired for message handling, a mock resolveLidToPhone,
   * and a captured handler from onMessage. Calls registerMessageHandler() directly to
   * avoid needing a real Baileys socket/connection.
   */
  function createBotWithMockSocket(resolveLidToPhoneImpl: (lid: string) => Promise<string | null>) {
    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });

    const mockSock = {
      user: { id: "99999@s.whatsapp.net", name: "Sketch", lid: undefined },
      ev: {
        on: (event: string, handler: (payload: unknown) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
    };

    (bot as unknown as { sock: typeof mockSock }).sock = mockSock;

    // Inject a mock resolveLidToPhone to control LID resolution without Baileys
    (bot as unknown as { resolveLidToPhone: (lid: string) => Promise<string | null> }).resolveLidToPhone =
      resolveLidToPhoneImpl;

    // Register the message handler directly (avoids makeWASocket)
    (bot as unknown as { registerMessageHandler: () => void }).registerMessageHandler();

    const captured: unknown[] = [];
    bot.onMessage(async (msg) => {
      captured.push(msg);
    });

    const fire = (payload: unknown) => handlers.get("messages.upsert")?.(payload);

    return { bot, fire, captured };
  }

  function makeGroupMsg(participantJid: string): proto.IWebMessageInfo {
    return {
      key: {
        remoteJid: "group-1@g.us",
        fromMe: false,
        id: "msg-001",
        participant: participantJid,
      },
      message: { conversation: "hello @Sketch" },
      pushName: "Charlie",
    } as proto.IWebMessageInfo;
  }

  it("resolves LID senderJid to phone number via resolveLidToPhone", async () => {
    const { fire, captured } = createBotWithMockSocket(async () => "+15550001111");

    await fire({
      type: "notify",
      messages: [makeGroupMsg("86702773280883@lid")],
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0] as { type: string; senderPhone: string | null };
    expect(msg.type).toBe("group");
    expect(msg.senderPhone).toBe("+15550001111");
  });

  it("passes standard phone JID as senderPhone directly without calling resolveLidToPhone", async () => {
    const resolveLid = vi.fn().mockResolvedValue(null);
    const { fire, captured } = createBotWithMockSocket(resolveLid);

    await fire({
      type: "notify",
      messages: [makeGroupMsg("14155238886@s.whatsapp.net")],
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0] as { type: string; senderPhone: string | null };
    expect(msg.type).toBe("group");
    expect(msg.senderPhone).toBe("+14155238886");
    expect(resolveLid).not.toHaveBeenCalled();
  });

  it("passes null senderPhone when LID resolution fails", async () => {
    const { fire, captured } = createBotWithMockSocket(async () => null);

    await fire({
      type: "notify",
      messages: [makeGroupMsg("86702773280883@lid")],
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0] as { type: string; senderPhone: string | null };
    expect(msg.type).toBe("group");
    expect(msg.senderPhone).toBeNull();
  });
});

describe("extractContextInfo", () => {
  it("returns contextInfo from extendedTextMessage", () => {
    const msg: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.mentionedJid).toEqual(["123@s.whatsapp.net"]);
  });

  it("returns contextInfo from imageMessage", () => {
    const msg: proto.IMessage = {
      imageMessage: {
        contextInfo: { mentionedJid: ["456@s.whatsapp.net"] },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.mentionedJid).toEqual(["456@s.whatsapp.net"]);
  });

  it("returns contextInfo from videoMessage", () => {
    const msg: proto.IMessage = {
      videoMessage: {
        contextInfo: { mentionedJid: ["789@s.whatsapp.net"] },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.mentionedJid).toEqual(["789@s.whatsapp.net"]);
  });

  it("returns contextInfo from audioMessage", () => {
    const msg: proto.IMessage = {
      audioMessage: {
        contextInfo: { participant: "bot@s.whatsapp.net" },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.participant).toBe("bot@s.whatsapp.net");
  });

  it("returns contextInfo from documentMessage", () => {
    const msg: proto.IMessage = {
      documentMessage: {
        contextInfo: { mentionedJid: ["doc@s.whatsapp.net"] },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.mentionedJid).toEqual(["doc@s.whatsapp.net"]);
  });

  it("returns contextInfo from stickerMessage", () => {
    const msg: proto.IMessage = {
      stickerMessage: {
        contextInfo: { participant: "sticker@s.whatsapp.net" },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.participant).toBe("sticker@s.whatsapp.net");
  });

  it("returns undefined for conversation-only message", () => {
    const msg: proto.IMessage = { conversation: "hello" };
    expect(extractContextInfo(msg)).toBeUndefined();
  });

  it("returns undefined when no contextInfo present", () => {
    const msg: proto.IMessage = {
      imageMessage: { url: "https://example.com/img.jpg" },
    };
    expect(extractContextInfo(msg)).toBeUndefined();
  });

  it("prioritizes extendedTextMessage over imageMessage", () => {
    const msg: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: ["text@s.whatsapp.net"] },
      },
      imageMessage: {
        contextInfo: { mentionedJid: ["image@s.whatsapp.net"] },
      },
    };
    const info = extractContextInfo(msg);
    expect(info?.mentionedJid).toEqual(["text@s.whatsapp.net"]);
  });
});

describe("stripBotMention", () => {
  it("strips @BotName when bot name matches", () => {
    expect(stripBotMention("@Sketch what's the weather?", "Sketch")).toBe("what's the weather?");
  });

  it("strips @BotName case-insensitively", () => {
    expect(stripBotMention("@sketch hello", "Sketch")).toBe("hello");
  });

  it("strips @mention with zero-width characters", () => {
    expect(stripBotMention("@\u200BSketch help me", "Sketch")).toBe("help me");
  });

  it("strips @mention at end of message", () => {
    expect(stripBotMention("hey @Sketch", "Sketch")).toBe("hey");
  });

  it("collapses double spaces after stripping", () => {
    expect(stripBotMention("hello @Sketch world", "Sketch")).toBe("hello world");
  });

  it("falls back to stripping first @token when no bot name", () => {
    expect(stripBotMention("@Someone help", null)).toBe("help");
  });

  it("falls back when bot name doesn't match", () => {
    expect(stripBotMention("@OtherBot hello", "Sketch")).toBe("hello");
  });

  it("handles message with only a mention", () => {
    expect(stripBotMention("@Sketch", "Sketch")).toBe("");
  });

  it("escapes regex special chars in bot name", () => {
    expect(stripBotMention("@Bot++ hello", "Bot++")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(stripBotMention("", "Sketch")).toBe("");
  });

  it("returns text unchanged when no @mention present", () => {
    expect(stripBotMention("no mention here", "Sketch")).toBe("no mention here");
  });
});

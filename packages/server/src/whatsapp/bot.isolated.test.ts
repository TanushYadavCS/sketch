import { DisconnectReason, type GroupMetadata, proto } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  WhatsAppBot,
  extractContextInfo,
  extractQuotedMessage,
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

  it("exposes the connected account LID", () => {
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    (bot as unknown as { sock: { user: { id: string; lid: string } } }).sock = {
      user: { id: "14155238886:0@s.whatsapp.net", lid: "86702773280883@lid" },
    };
    expect(bot.accountLid).toBe("86702773280883@lid");
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

  it("does not report a disconnect while stopping", async () => {
    const onConnectionClose = vi.fn().mockResolvedValue(undefined);
    const bot = new WhatsAppBot({ db, logger: createTestLogger(), onConnectionClose });
    const current = createConnectionSocket();
    (bot as unknown as { sock: unknown; activeSocketGeneration: number; stopping: boolean }).sock = current.socket;
    (bot as unknown as { activeSocketGeneration: number }).activeSocketGeneration = 1;
    (bot as unknown as { stopping: boolean }).stopping = true;
    (
      bot as unknown as {
        registerConnectionHandler: (
          socket: unknown,
          authState: { clearCreds: () => Promise<void> },
          socketGeneration: number,
        ) => void;
      }
    ).registerConnectionHandler(current.socket as never, { clearCreds: vi.fn().mockResolvedValue(undefined) }, 1);

    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 }, message: "shutdown" } },
    });

    expect(onConnectionClose).not.toHaveBeenCalled();
  });

  it("uses the gateway reconnect delay hook for restart-required closes", async () => {
    const reconnectDelayMs = vi.fn().mockReturnValue(1_000);
    const bot = new WhatsAppBot({ db, logger: createTestLogger(), reconnectDelayMs });
    const current = createConnectionSocket();
    const createSocket = vi.fn().mockResolvedValue(undefined);
    (bot as unknown as { sock: unknown }).sock = current.socket;
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

    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });
    expect(reconnectDelayMs).toHaveBeenCalledWith(DisconnectReason.restartRequired);
    await vi.advanceTimersByTimeAsync(999);
    expect(createSocket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(createSocket).toHaveBeenCalledOnce();
  });

  it("clears fenced auth and surfaces logged-out without scheduling a reconnect", async () => {
    const onLoggedOut = vi.fn().mockResolvedValue(undefined);
    const bot = new WhatsAppBot({ db, logger: createTestLogger(), onLoggedOut });
    const current = createConnectionSocket();
    const createSocket = vi.fn().mockResolvedValue(undefined);
    const clearCreds = vi.fn().mockResolvedValue(undefined);
    (bot as unknown as { sock: unknown }).sock = current.socket;
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
    ).registerConnectionHandler(current.socket as never, { clearCreds }, 1);

    await current.emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    await vi.runAllTimersAsync();
    expect(clearCreds).toHaveBeenCalledOnce();
    expect(onLoggedOut).toHaveBeenCalledWith(1);
    expect(createSocket).not.toHaveBeenCalled();
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

    const groupMetadata = vi.fn().mockResolvedValue({
      subject: "Product Team",
      desc: "Roadmap syncs",
      participants: [{ id: "15551234567@s.whatsapp.net", admin: "admin" }],
    });
    (bot as unknown as { sock: { groupMetadata: typeof groupMetadata } }).sock = { groupMetadata };

    const meta = await bot.getGroupMetadata("123@g.us");

    expect(meta?.subject).toBe("Product Team");
    const stored = await db.selectFrom("whatsapp_groups").selectAll().where("jid", "=", "123@g.us").executeTakeFirst();
    expect(stored?.name).toBe("Product Team");
    expect(stored?.description).toBe("Roadmap syncs");
    await expect(db.selectFrom("whatsapp_group_participants").selectAll().execute()).resolves.toEqual([
      expect.objectContaining({
        group_jid: "123@g.us",
        participant_jid: "15551234567@s.whatsapp.net",
        phone_e164: "+15551234567",
        admin_role: "admin",
      }),
    ]);
  });

  it("persists unresolvable LID participants and skips unknown participant shapes", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const bot = new WhatsAppBot({
      db,
      logger,
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn().mockResolvedValue({
      subject: "Product Team",
      desc: null,
      participants: [
        { id: "lid-member@lid", admin: "superadmin" },
        { id: "abc@s.whatsapp.net", admin: "admin" },
        { id: "unknown-shape" },
      ],
    });
    (bot as unknown as { sock: { groupMetadata: typeof groupMetadata } }).sock = { groupMetadata };

    await bot.getGroupMetadata("123@g.us");

    await expect(
      db.selectFrom("whatsapp_group_participants").selectAll().orderBy("participant_jid", "asc").execute(),
    ).resolves.toEqual([
      expect.objectContaining({
        group_jid: "123@g.us",
        participant_jid: "abc@s.whatsapp.net",
        phone_e164: null,
        lid: null,
        admin_role: "admin",
      }),
      expect.objectContaining({
        group_jid: "123@g.us",
        participant_jid: "lid-member@lid",
        phone_e164: null,
        lid: "lid-member@lid",
        admin_role: "superadmin",
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupJid: "123@g.us", skippedCount: 1 }),
      "Skipped unrecognized WhatsApp group participants",
    );
  });

  it("returns provider metadata with normalized participant contract", async () => {
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn().mockResolvedValue({
      subject: "Product Team",
      desc: "Roadmap syncs",
      participants: [{ id: "15551234567@s.whatsapp.net", admin: "admin" }],
    });
    (bot as unknown as { sock: { groupMetadata: typeof groupMetadata } }).sock = { groupMetadata };

    await expect(bot.getProviderGroupMetadata("123@g.us")).resolves.toEqual({
      id: "123@g.us",
      subject: "Product Team",
      desc: "Roadmap syncs",
      participants: [{ jid: "15551234567@s.whatsapp.net", phoneE164: "+15551234567", lid: null, admin: "admin" }],
    });
  });

  it("persists Baileys participant phoneNumber and lid fields for both id shapes", async () => {
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });
    const getPNForLID = vi.fn().mockResolvedValue("15559999999@s.whatsapp.net");
    const groupMetadata = vi.fn().mockResolvedValue({
      subject: "Product Team",
      desc: null,
      participants: [
        { id: "15551000001@s.whatsapp.net", lid: "participant-one@lid", admin: "admin" },
        { id: "participant-two@lid", phoneNumber: "+1 (555) 100-0002", admin: null },
      ],
    });
    (
      bot as unknown as {
        sock: {
          groupMetadata: typeof groupMetadata;
          signalRepository: { lidMapping: { getPNForLID: typeof getPNForLID } };
        };
      }
    ).sock = { groupMetadata, signalRepository: { lidMapping: { getPNForLID } } };

    await expect(bot.getProviderGroupMetadata("123@g.us")).resolves.toEqual({
      id: "123@g.us",
      subject: "Product Team",
      desc: null,
      participants: [
        { jid: "15551000001@s.whatsapp.net", phoneE164: "+15551000001", lid: "participant-one@lid", admin: "admin" },
        { jid: "participant-two@lid", phoneE164: "+15551000002", lid: "participant-two@lid", admin: null },
      ],
    });
    await expect(
      db
        .selectFrom("whatsapp_group_participants")
        .select(["participant_jid", "phone_e164", "lid", "admin_role"])
        .orderBy("participant_jid", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        participant_jid: "15551000001@s.whatsapp.net",
        phone_e164: "+15551000001",
        lid: "participant-one@lid",
        admin_role: "admin",
      },
      {
        participant_jid: "participant-two@lid",
        phone_e164: "+15551000002",
        lid: "participant-two@lid",
        admin_role: null,
      },
    ]);
    expect(getPNForLID).not.toHaveBeenCalled();
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

  it("persists a newly joined group from groups.upsert without an extra metadata query", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });

    const groupMetadata = vi.fn();
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
    await handlers.get("groups.upsert")?.([
      {
        id: "joined@g.us",
        subject: "Just Added",
        desc: "New group",
        participants: [{ id: "15551234567@s.whatsapp.net", admin: "admin" }],
      },
    ]);

    const stored = await db
      .selectFrom("whatsapp_groups")
      .selectAll()
      .where("jid", "=", "joined@g.us")
      .executeTakeFirst();
    expect(stored?.name).toBe("Just Added");
    expect(stored?.index_enabled).toBe(1);
    expect(groupMetadata).not.toHaveBeenCalled();

    /** The roster lands too — it feeds the access checks in salience and chat-search. */
    const participants = await db
      .selectFrom("whatsapp_group_participants")
      .select(["participant_jid", "admin_role"])
      .where("group_jid", "=", "joined@g.us")
      .execute();
    expect(participants).toEqual([{ participant_jid: "15551234567@s.whatsapp.net", admin_role: "admin" }]);
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

describe("WhatsAppBot syncAllGroups", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  function metadata(id: string, subject: string, desc?: string): GroupMetadata {
    return {
      id,
      owner: undefined,
      subject,
      desc,
      participants: [],
    };
  }

  function attachGroupSyncSocket(bot: WhatsAppBot, groups: Record<string, GroupMetadata>) {
    const groupFetchAllParticipating = vi.fn().mockResolvedValue(groups);
    (bot as unknown as { sock: { groupFetchAllParticipating: typeof groupFetchAllParticipating } }).sock = {
      groupFetchAllParticipating,
    };
    return groupFetchAllParticipating;
  }

  it("upserts every fetched group while preserving agent bindings", async () => {
    const repo = createWhatsAppGroupRepository(db);
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: repo,
    });

    await db.insertInto("users").values({ id: "agent-1", name: "Agent One" }).execute();
    await repo.upsert({
      jid: "existing@g.us",
      name: "Old Group",
      description: "Old desc",
      updated_at: "2026-03-13T10:00:00.000Z",
    });
    await db
      .updateTable("whatsapp_groups")
      .set({ agent_user_id: "agent-1" })
      .where("jid", "=", "existing@g.us")
      .execute();

    attachGroupSyncSocket(bot, {
      "existing@g.us": metadata("existing@g.us", "Renamed Group", "New desc"),
      "new@g.us": metadata("new@g.us", "New Group"),
    });

    await expect(bot.syncAllGroups()).resolves.toBe(2);

    const existing = await db
      .selectFrom("whatsapp_groups")
      .selectAll()
      .where("jid", "=", "existing@g.us")
      .executeTakeFirstOrThrow();
    const inserted = await db
      .selectFrom("whatsapp_groups")
      .selectAll()
      .where("jid", "=", "new@g.us")
      .executeTakeFirstOrThrow();

    expect(existing.name).toBe("Renamed Group");
    expect(existing.description).toBe("New desc");
    expect(existing.agent_user_id).toBe("agent-1");
    expect(inserted.name).toBe("New Group");
    expect(inserted.description).toBeNull();
    await expect(bot.getGroupMetadata("new@g.us")).resolves.toMatchObject({ subject: "New Group" });
  });

  it("returns the synced count so far and warns when the socket fetch fails", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const bot = new WhatsAppBot({
      db,
      logger,
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });
    const groupFetchAllParticipating = vi.fn().mockRejectedValue(new Error("socket unavailable"));
    (bot as unknown as { sock: { groupFetchAllParticipating: typeof groupFetchAllParticipating } }).sock = {
      groupFetchAllParticipating,
    };

    await expect(bot.syncAllGroups()).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), syncedCount: 0 }),
      "Failed to sync WhatsApp groups",
    );
  });

  it("throttles repeated syncs and allows forced refreshes", async () => {
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const bot = new WhatsAppBot({
      db,
      logger: createTestLogger(),
      groupMetadataStore: createWhatsAppGroupRepository(db),
    });
    const groupFetchAllParticipating = attachGroupSyncSocket(bot, {
      "team@g.us": metadata("team@g.us", "Team"),
    });

    await expect(bot.syncAllGroups()).resolves.toBe(1);
    await expect(bot.syncAllGroups()).resolves.toBe(0);
    (bot as unknown as { activeSocketGeneration: number }).activeSocketGeneration = 2;
    const nextGenerationFetch = attachGroupSyncSocket(bot, {
      "next-team@g.us": metadata("next-team@g.us", "Next Team"),
    });
    await expect(bot.syncAllGroups()).resolves.toBe(1);
    await expect(bot.syncAllGroups({ force: true })).resolves.toBe(1);

    expect(groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(nextGenerationFetch).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
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
    const capturedMetadata: unknown[] = [];
    bot.onMessage(async (msg, metadata) => {
      captured.push(msg);
      capturedMetadata.push(metadata);
    });

    const fire = (payload: unknown) => handlers.get("messages.upsert")?.(payload);

    return { bot, fire, captured, capturedMetadata };
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

  it("forwards an offline append once when a normal notify overlaps", async () => {
    const { fire, captured, capturedMetadata } = createBotWithMockSocket(async () => "+15550001111");

    await fire({
      type: "append",
      messages: [makeGroupMsg("86702773280883@lid")],
    });
    await fire({
      type: "notify",
      messages: [makeGroupMsg("86702773280883@lid")],
    });

    expect(captured).toHaveLength(1);
    expect(capturedMetadata).toEqual([{ socketGeneration: 0, upsertType: "append" }]);
  });
});

describe("WhatsAppBot history sync", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists group history when Baileys puts sender on the top-level participant field", async () => {
    const handlers = new Map<string, (payload: { messages: proto.IWebMessageInfo[] }) => Promise<void>>();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof createTestLogger>;
    const bot = new WhatsAppBot({ db, logger });
    const mockSock = {
      user: { id: "99999@s.whatsapp.net", name: "Sketch", lid: undefined },
      ev: {
        on: (event: string, handler: (payload: { messages: proto.IWebMessageInfo[] }) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
    };
    const captured: unknown[][] = [];

    (bot as unknown as { sock: typeof mockSock }).sock = mockSock;
    bot.onHistoryMessages(async (messages) => {
      captured.push(messages);
      return { persisted: messages.length, skippedOld: 0, skippedDup: 0 };
    });
    (bot as unknown as { registerHistoryHandler: () => void }).registerHistoryHandler();

    await handlers.get("messaging-history.set")?.({
      messages: [
        {
          key: {
            remoteJid: "group-1@g.us",
            fromMe: false,
            id: "history-001",
          },
          participant: "14155238886@s.whatsapp.net",
          message: { conversation: "history context" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "History Sender",
        } as proto.IWebMessageInfo,
        {
          key: {
            remoteJid: "group-1@g.us",
            fromMe: false,
            id: "history-002",
          },
          message: { conversation: "missing sender" },
          messageTimestamp: Math.floor(Date.now() / 1000),
          pushName: "Unknown",
        } as proto.IWebMessageInfo,
      ],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0][0]).toEqual(
      expect.objectContaining({
        type: "group",
        senderJid: "14155238886@s.whatsapp.net",
        senderPhone: "+14155238886",
        text: "history context",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 2,
        candidates: 1,
        persisted: 1,
        skippedNoSender: 1,
      }),
      "WhatsApp history batch processed",
    );
  });

  it("threads an empty on-demand response session to the history handler", async () => {
    const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
    const bot = new WhatsAppBot({ db, logger: createTestLogger() });
    const mockSock = {
      user: { id: "99999@s.whatsapp.net", name: "Sketch", lid: undefined },
      ev: {
        on: (event: string, handler: (payload: Record<string, unknown>) => Promise<void>) => {
          handlers.set(event, handler);
        },
      },
    };
    const historyHandler = vi.fn(async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }));
    (bot as unknown as { sock: typeof mockSock }).sock = mockSock;
    bot.onHistoryMessages(historyHandler);
    (bot as unknown as { registerHistoryHandler: () => void }).registerHistoryHandler();

    await handlers.get("messaging-history.set")?.({
      messages: [],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "request-empty",
    });

    expect(historyHandler).toHaveBeenCalledWith([], {
      socketGeneration: 0,
      isLatest: undefined,
      progress: undefined,
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "request-empty",
    });
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

describe("extractQuotedMessage", () => {
  it("extracts quoted message id, participant, and text", () => {
    const quoted = extractQuotedMessage({
      stanzaId: "parent-1",
      participant: "111@s.whatsapp.net",
      quotedMessage: { conversation: "quoted issue text" },
    });

    expect(quoted).toEqual({
      providerMessageId: "parent-1",
      participantJid: "111@s.whatsapp.net",
      text: "quoted issue text",
    });
  });

  it("uses captions from quoted media messages", () => {
    const quoted = extractQuotedMessage({
      stanzaId: "parent-1",
      participant: "111@s.whatsapp.net",
      quotedMessage: { imageMessage: { caption: "screenshot caption" } },
    });

    expect(quoted?.text).toBe("screenshot caption");
  });

  it("returns undefined without a quoted provider message id", () => {
    expect(
      extractQuotedMessage({
        participant: "111@s.whatsapp.net",
        quotedMessage: { conversation: "quoted issue text" },
      }),
    ).toBeUndefined();
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

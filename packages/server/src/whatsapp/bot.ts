import type { Boom } from "@hapi/boom";
/**
 * WhatsApp adapter using Baileys — connection management, message handling,
 * reconnection with exponential backoff, composing indicators, echo detection.
 *
 * Supports DMs (@s.whatsapp.net, @lid) and groups (@g.us).
 * Groups: mention-only activation (explicit @mention or reply-to-bot).
 * LID JIDs resolved to phone numbers via Baileys' signalRepository.lidMapping.
 * Auth state persisted in DB via createDbAuthState.
 * Group metadata cached in-memory (5-min TTL) and wired into cachedGroupMetadata
 * socket config to avoid re-fetching participant lists on every sendMessage.
 */
import {
  DisconnectReason,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WASocket,
  type WAVersion,
  areJidsSameUser,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  makeWASocket,
  type proto,
} from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import { createDbAuthState } from "./auth-store";
import { WHATSAPP_TEXT_LIMIT, chunkText } from "./chunking";

const ECHO_TTL_MS = 60_000;
const COMPOSING_INTERVAL_MS = 5_000;
const COMPOSING_TTL_MS = 3 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_STALE_MS = 30 * 60_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const GROUP_META_TTL_MS = 5 * 60_000;

/** Cached WA version — fetched once from GitHub, reused for all subsequent connections. */
let cachedVersion: WAVersion | null = null;

async function getWaVersion(): Promise<WAVersion | undefined> {
  if (cachedVersion) return cachedVersion;
  const { version } = await fetchLatestBaileysVersion();
  cachedVersion = version as WAVersion;
  return version;
}

interface WhatsAppBaseMessage {
  text: string;
  jid: string;
  messageId: string;
  pushName: string;
  rawMessage: proto.IWebMessageInfo;
  mediaType?: string;
  quotedMessage?: WhatsAppQuotedMessage;
}

export interface WhatsAppQuotedMessage {
  providerMessageId: string;
  participantJid: string | null;
  text: string;
}

export interface WhatsAppDmMessage extends WhatsAppBaseMessage {
  type: "dm";
  phoneNumber: string;
}

export interface WhatsAppGroupMessage extends WhatsAppBaseMessage {
  type: "group";
  isMentioned: boolean;
  senderJid: string;
  senderPhone: string | null;
}

export type WhatsAppMessage = WhatsAppDmMessage | WhatsAppGroupMessage;

export type WhatsAppMessageHandler = (message: WhatsAppMessage) => Promise<void>;

export interface PairingCallbacks {
  onQr: (qr: string) => Promise<void>;
  onConnected: (phoneNumber: string) => Promise<void>;
  onError: (message: string) => Promise<void>;
}

export interface WhatsAppBotConfig {
  db: Kysely<DB>;
  logger: Logger;
  groupMetadataStore?: {
    upsert: (group: { jid: string; name: string; description: string | null; updated_at: string }) => Promise<unknown>;
  };
}

export class WhatsAppBot {
  private db: Kysely<DB>;
  private logger: Logger;
  private groupMetadataStore?: WhatsAppBotConfig["groupMetadataStore"];
  private sock: WASocket | null = null;
  private handler: WhatsAppMessageHandler | null = null;
  private recentlySent = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSocketGeneration = 0;
  private stopping = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private authState: Awaited<ReturnType<typeof createDbAuthState>> | null = null;
  private composingTimers = new Map<
    string,
    { interval: ReturnType<typeof setInterval>; ttl: ReturnType<typeof setTimeout> }
  >();
  private groupMetaCache = new Map<string, { meta: GroupMetadata; expires: number }>();

  constructor(config: WhatsAppBotConfig) {
    this.db = config.db;
    this.logger = config.logger;
    this.groupMetadataStore = config.groupMetadataStore;
  }

  onMessage(handler: WhatsAppMessageHandler): void {
    this.handler = handler;
  }

  /**
   * Check if WhatsApp creds exist in DB.
   * If yes, connect automatically. If no, skip — wait for /whatsapp/pair.
   * Returns true if connected, false if waiting for pairing.
   */
  async start(): Promise<boolean> {
    const row = await this.db.selectFrom("whatsapp_creds").select("id").where("id", "=", "default").executeTakeFirst();

    if (!row) {
      this.logger.info("No WhatsApp creds in DB — waiting for pairing");
      return false;
    }

    await this.createSocket();
    return true;
  }

  /**
   * Start a fresh pairing session with SSE-friendly callbacks.
   * Emits multiple QR codes (each ~20-30s lifetime), a connected event on success,
   * or an error event on failure. Returns a promise that resolves when pairing
   * completes (connected or failed) — keeps the SSE stream alive until then.
   */
  async startPairing(callbacks: PairingCallbacks): Promise<void> {
    this.clearReconnectTimer();
    this.stopping = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.stopWatchdog();

    const authState = await createDbAuthState(this.db, this.logger);
    this.authState = authState;
    const version = await getWaVersion();

    this.sock = makeWASocket({
      version: version as WAVersion,
      auth: {
        creds: authState.state.creds,
        keys: authState.state.keys,
      },
      logger: this.logger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
      printQRInTerminal: false,
      syncFullHistory: false,
      fireInitQueries: false,
      markOnlineOnConnect: false,
    });
    this.activeSocketGeneration += 1;

    this.sock.ev.on("creds.update", authState.saveCreds);
    this.registerGroupEventHandlers();

    return new Promise<void>((resolve) => {
      this.sock?.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          await callbacks.onQr(qr);
        }

        if (connection === "open") {
          this.logger.info("WhatsApp connected after pairing");
          this.reconnectAttempt = 0;
          this.registerMessageHandler();
          this.startWatchdog();
          await callbacks.onConnected(this.phoneNumber ?? "unknown");
          resolve();
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message ?? "";

          if (statusCode === DisconnectReason.restartRequired) {
            this.logger.info("WhatsApp restart required after pairing — reconnecting");
            await this.createSocket();
            // Wait for the reconnected socket to open before sending the connected event.
            // Without this, the SSE stream closes before the frontend receives "connected".
            this.sock?.ev.on("connection.update", async (reconnectUpdate) => {
              if (reconnectUpdate.connection === "open") {
                await callbacks.onConnected(this.phoneNumber ?? "unknown");
                resolve();
              }
              if (reconnectUpdate.connection === "close") {
                await callbacks.onError("Connection failed after pairing");
                resolve();
              }
            });
            return;
          }

          if (statusCode === DisconnectReason.loggedOut) {
            this.logger.warn("WhatsApp logged out during pairing");
            await authState.clearCreds();
            this.stopWatchdog();
            await callbacks.onError("Logged out — please try again");
            resolve();
            return;
          }

          if (errorMsg.includes("QR refs")) {
            this.logger.info("WhatsApp QR expired");
            this.sock?.end(undefined);
            this.sock = null;
            await callbacks.onError("QR code expired");
            resolve();
            return;
          }

          this.logger.info({ statusCode, error: errorMsg }, "WhatsApp disconnected during pairing");
          this.sock?.end(undefined);
          this.sock = null;
          await callbacks.onError(errorMsg || "Connection closed");
          resolve();
        }
      });
    });
  }

  cancelPairing(): void {
    try {
      this.sock?.ws?.close();
    } catch {
      // Socket may already be closed
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.stopWatchdog();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.stopWatchdog();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    if (this.authState) {
      await this.authState.clearCreds();
      this.authState = null;
    } else {
      const authState = await createDbAuthState(this.db, this.logger);
      await authState.clearCreds();
    }
  }

  get isConfigured(): boolean {
    return this.sock !== null;
  }

  get isConnected(): boolean {
    return this.sock?.user !== undefined;
  }

  get phoneNumber(): string | null {
    if (!this.sock?.user?.id) return null;
    return `+${this.sock.user.id.split(":")[0].split("@")[0]}`;
  }

  get socket(): WASocket | null {
    return this.sock;
  }

  // --- Sending ---

  async sendText(jid: string, text: string, options?: MiscMessageGenerationOptions): Promise<WAMessage | null> {
    if (!this.sock) return null;
    const chunks = chunkText(text, WHATSAPP_TEXT_LIMIT);
    let firstSent: WAMessage | null = null;
    for (let i = 0; i < chunks.length; i++) {
      // Only apply options (e.g. quoted reply) to the first chunk
      const sent = await this.sock.sendMessage(jid, { text: chunks[i] }, i === 0 ? options : undefined);
      if (i === 0) firstSent = sent ?? null;
      this.trackSentMessageId(sent?.key?.id);
    }
    return firstSent;
  }

  async editText(jid: string, targetKey: proto.IMessageKey, text: string): Promise<WAMessage | null> {
    if (!this.sock) return null;
    const sent = await this.sock.sendMessage(jid, { text, edit: targetKey });
    this.trackSentMessageId(sent?.key?.id);
    return sent ?? null;
  }

  async addReaction(jid: string, targetKey: proto.IMessageKey, emoji: string): Promise<WAMessage | null> {
    if (!this.sock) return null;
    const sent = await this.sock.sendMessage(jid, { react: { text: emoji, key: targetKey } });
    this.trackSentMessageId(sent?.key?.id);
    return sent ?? null;
  }

  async removeReaction(jid: string, targetKey: proto.IMessageKey): Promise<WAMessage | null> {
    if (!this.sock) return null;
    const sent = await this.sock.sendMessage(jid, { react: { text: "", key: targetKey } });
    this.trackSentMessageId(sent?.key?.id);
    return sent ?? null;
  }

  async sendFile(jid: string, filePath: string, mimeType: string, fileName: string): Promise<void> {
    if (!this.sock) return;
    const isImage = mimeType.startsWith("image/");

    if (isImage) {
      const sent = await this.sock.sendMessage(jid, {
        image: { url: filePath },
        caption: fileName,
      });
      this.trackSentMessageId(sent?.key?.id);
    } else {
      const sent = await this.sock.sendMessage(jid, {
        document: { url: filePath },
        mimetype: mimeType,
        fileName,
      });
      this.trackSentMessageId(sent?.key?.id);
    }
  }

  startComposing(jid: string): void {
    this.stopComposing(jid);
    if (!this.sock) return;

    this.sock.sendPresenceUpdate("composing", jid).catch(() => {});

    const interval = setInterval(() => {
      this.sock?.sendPresenceUpdate("composing", jid).catch(() => {});
    }, COMPOSING_INTERVAL_MS);

    const ttl = setTimeout(() => this.stopComposing(jid), COMPOSING_TTL_MS);

    this.composingTimers.set(jid, { interval, ttl });
  }

  stopComposing(jid: string): void {
    const timer = this.composingTimers.get(jid);
    if (!timer) return;

    clearInterval(timer.interval);
    clearTimeout(timer.ttl);
    this.composingTimers.delete(jid);
    this.sock?.sendPresenceUpdate("paused", jid).catch(() => {});
  }

  // --- Group metadata ---

  async getGroupMetadata(groupJid: string): Promise<GroupMetadata | undefined> {
    const cached = this.groupMetaCache.get(groupJid);
    if (cached && cached.expires > Date.now()) return cached.meta;

    return this.refreshGroupMetadata(groupJid);
  }

  async getGroupName(groupJid: string): Promise<string> {
    const meta = await this.getGroupMetadata(groupJid);
    return meta?.subject ?? "Unknown Group";
  }

  // --- Internal ---

  private async createSocket(): Promise<void> {
    this.clearReconnectTimer();
    this.stopping = false;
    const authState = await createDbAuthState(this.db, this.logger);
    this.authState = authState;
    const version = await getWaVersion();
    const socketGeneration = this.activeSocketGeneration + 1;

    const socket = makeWASocket({
      version: version as WAVersion,
      auth: {
        creds: authState.state.creds,
        keys: authState.state.keys,
      },
      logger: this.logger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
      printQRInTerminal: false,
      syncFullHistory: false,
      fireInitQueries: false,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid) => {
        const cached = this.groupMetaCache.get(jid);
        if (cached && cached.expires > Date.now()) return cached.meta;
        return undefined;
      },
    });

    this.activeSocketGeneration = socketGeneration;
    this.sock = socket;
    socket.ev.on("creds.update", authState.saveCreds);
    this.registerConnectionHandler(socket, authState, socketGeneration);
    this.registerMessageHandler(socket, socketGeneration);
    this.registerGroupEventHandlers(socket, socketGeneration);
    this.startWatchdog();
  }

  private registerConnectionHandler(
    socket: WASocket,
    authState: Awaited<ReturnType<typeof createDbAuthState>>,
    socketGeneration: number,
  ): void {
    socket.ev.on("connection.update", async (update) => {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        this.logger.debug({ socketGeneration }, "Ignoring WhatsApp connection update from stale socket");
        return;
      }

      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        this.clearReconnectTimer();
        this.logger.info({ socketGeneration }, "WhatsApp connected");
        this.reconnectAttempt = 0;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          this.clearReconnectTimer();
          this.logger.warn({ socketGeneration }, "WhatsApp logged out — clearing credentials");
          await authState.clearCreds();
          this.stopWatchdog();
          if (socket === this.sock) {
            this.sock = null;
          }
          return;
        }

        if (this.stopping) {
          this.logger.info({ socketGeneration }, "WhatsApp socket closed during shutdown");
          return;
        }

        const nextAttempt = this.reconnectAttempt + 1;
        const delay = Math.min(RECONNECT_BASE_MS * RECONNECT_FACTOR ** (nextAttempt - 1), RECONNECT_MAX_MS);
        const jitter = delay * RECONNECT_JITTER * Math.random();
        if (this.scheduleReconnect(delay + jitter, socketGeneration, nextAttempt)) {
          this.reconnectAttempt = nextAttempt;
        }
      }
    });
  }

  private registerMessageHandler(
    socket: WASocket = this.sock as WASocket,
    socketGeneration = this.activeSocketGeneration,
  ): void {
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        return;
      }

      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        const isStandardDm = jid.endsWith("@s.whatsapp.net");
        const isLidDm = jid.endsWith("@lid");
        const isGroup = jid.endsWith("@g.us");
        if (!isStandardDm && !isLidDm && !isGroup) continue;

        if (msg.key.id && this.recentlySent.has(msg.key.id)) continue;

        const messageType = getContentType(msg.message);
        const text = extractText(msg);
        const hasMedia = hasMediaContent(messageType);

        if (!text && !hasMedia) continue;

        if (isGroup) {
          await this.handleGroupMessage(msg, jid, text, messageType, hasMedia);
        } else {
          await this.handleDmMessage(msg, jid, isStandardDm, text, messageType, hasMedia);
        }
      }
    });
  }

  private async handleDmMessage(
    msg: proto.IWebMessageInfo,
    jid: string,
    isStandardDm: boolean,
    text: string | null,
    messageType: string | undefined,
    hasMedia: boolean,
  ): Promise<void> {
    let phoneNumber: string | null = null;

    if (isStandardDm) {
      phoneNumber = jidToPhoneNumber(jid);
    } else {
      phoneNumber = await this.resolveLidToPhone(jid);
      if (!phoneNumber) {
        this.logger.warn({ lid: jid }, "Could not resolve LID to phone number — dropping message");
        return;
      }
    }

    if (this.handler) {
      const quotedMessage = extractQuotedMessage(msg.message ? extractContextInfo(msg.message) : undefined);
      this.lastMessageAt = Date.now();
      await this.handler({
        type: "dm",
        text: text ?? "",
        phoneNumber,
        jid,
        messageId: msg.key?.id ?? "",
        pushName: msg.pushName ?? "Unknown",
        rawMessage: msg,
        mediaType: hasMedia ? (messageType ?? undefined) : undefined,
        ...(quotedMessage ? { quotedMessage } : {}),
      });
    }
  }

  private async handleGroupMessage(
    msg: proto.IWebMessageInfo,
    groupJid: string,
    text: string | null,
    messageType: string | undefined,
    hasMedia: boolean,
  ): Promise<void> {
    const senderJid = msg.key?.participant;
    if (!senderJid) return;

    if (!msg.message) return;
    const contextInfo = extractContextInfo(msg.message);
    const isMentioned = this.isBotMentioned(contextInfo);

    // Strip bot mention text from the message when explicitly mentioned
    let cleanText = text;
    if (cleanText && isMentioned && contextInfo?.mentionedJid?.length) {
      cleanText = stripBotMention(cleanText, this.sock?.user?.name);
    }

    const senderPhone = senderJid.endsWith("@lid")
      ? await this.resolveLidToPhone(senderJid)
      : jidToPhoneNumber(senderJid);

    if (this.handler) {
      const quotedMessage = extractQuotedMessage(contextInfo);
      this.lastMessageAt = Date.now();
      await this.handler({
        type: "group",
        text: cleanText ?? "",
        jid: groupJid,
        messageId: msg.key?.id ?? "",
        pushName: msg.pushName ?? "Unknown",
        rawMessage: msg,
        mediaType: hasMedia ? (messageType ?? undefined) : undefined,
        isMentioned,
        senderJid,
        senderPhone,
        ...(quotedMessage ? { quotedMessage } : {}),
      });
    }
  }

  /**
   * Check if the bot is mentioned in a message — either explicitly via @mention
   * in mentionedJid, or implicitly by replying to a bot message.
   */
  private isBotMentioned(contextInfo: proto.IContextInfo | undefined): boolean {
    const botId = this.sock?.user?.id;
    if (!botId) return false;

    const botLid = this.sock?.user?.lid;

    // Explicit @mention — check mentionedJid array
    const mentionedJids = contextInfo?.mentionedJid;
    if (mentionedJids?.length) {
      const hasBotMention = mentionedJids.some(
        (mentionJid) => areJidsSameUser(mentionJid, botId) || (botLid && areJidsSameUser(mentionJid, botLid)),
      );
      if (hasBotMention) return true;
    }

    // Implicit mention — reply to a bot message
    const quotedParticipant = contextInfo?.participant;
    if (quotedParticipant) {
      if (areJidsSameUser(quotedParticipant, botId)) return true;
      if (botLid && areJidsSameUser(quotedParticipant, botLid)) return true;
    }

    return false;
  }

  /**
   * Refresh group metadata cache on group changes so cachedGroupMetadata
   * stays fresh and Baileys doesn't re-fetch on every sendMessage.
   */
  private registerGroupEventHandlers(
    socket: WASocket = this.sock as WASocket,
    socketGeneration = this.activeSocketGeneration,
  ): void {
    socket.ev.on("groups.update", async (updates) => {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        return;
      }

      for (const update of updates) {
        if (!update.id) continue;
        await this.refreshGroupMetadata(update.id);
      }
    });

    socket.ev.on("group-participants.update", async (event) => {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        return;
      }

      await this.refreshGroupMetadata(event.id);
    });
  }

  private async refreshGroupMetadata(groupJid: string): Promise<GroupMetadata | undefined> {
    try {
      const meta = await this.sock?.groupMetadata(groupJid);
      if (meta) {
        this.groupMetaCache.set(groupJid, { meta, expires: Date.now() + GROUP_META_TTL_MS });
        await this.groupMetadataStore?.upsert({
          jid: groupJid,
          name: meta.subject ?? "Unknown Group",
          description: meta.desc ?? null,
          updated_at: new Date().toISOString(),
        });
      }
      return meta;
    } catch (err) {
      this.logger.warn({ err, groupJid }, "Failed to fetch group metadata");
      return undefined;
    }
  }

  /**
   * Resolve a LID JID to an E.164 phone number using Baileys' in-memory mapping.
   * Returns null if the mapping is unavailable.
   */
  private async resolveLidToPhone(lidJid: string): Promise<string | null> {
    try {
      const pnJid = await this.sock?.signalRepository?.lidMapping?.getPNForLID(lidJid);
      if (pnJid) {
        return jidToPhoneNumber(pnJid);
      }
    } catch (err) {
      this.logger.debug({ lid: lidJid, err }, "LID mapping lookup failed");
    }
    return null;
  }

  private trackSentMessage(messageId: string): void {
    this.recentlySent.add(messageId);
    setTimeout(() => this.recentlySent.delete(messageId), ECHO_TTL_MS);
  }

  private trackSentMessageId(messageId: string | null | undefined): void {
    if (!messageId) return;
    this.trackSentMessage(messageId);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastMessageAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > WATCHDOG_STALE_MS) {
        this.logger.warn("WhatsApp watchdog — no messages in 30 minutes, forcing reconnect");
        if (this.sock) {
          this.sock.end(undefined);
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(delayMs: number, socketGeneration: number, attempt: number): boolean {
    if (this.reconnectTimer) {
      this.logger.debug({ socketGeneration }, "WhatsApp reconnect already scheduled");
      return false;
    }

    const roundedDelay = Math.round(delayMs);
    this.logger.info({ attempt, delayMs: roundedDelay, socketGeneration }, "WhatsApp reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || socketGeneration !== this.activeSocketGeneration) {
        this.logger.debug({ socketGeneration }, "Skipping WhatsApp reconnect from stale socket");
        return;
      }
      void this.createSocket();
    }, delayMs);
    return true;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// --- Pure utility functions (exported for testing) ---

export function extractText(msg: proto.IWebMessageInfo): string | null {
  return msg.message ? extractTextFromMessage(msg.message) : null;
}

export function extractTextFromMessage(message: proto.IMessage): string | null {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  return null;
}

export function hasMediaContent(messageType: string | undefined): boolean {
  if (!messageType) return false;
  return ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"].includes(messageType);
}

export function jidToPhoneNumber(jid: string): string {
  const raw = jid.replace("@s.whatsapp.net", "").replace("@lid", "");
  const number = raw.includes(":") ? raw.split(":")[0] : raw;
  return `+${number}`;
}

/**
 * Extract contextInfo from any message type — mentions and reply-to context
 * can live on extendedTextMessage, imageMessage, videoMessage, etc.
 */
export function extractContextInfo(message: proto.IMessage): proto.IContextInfo | undefined {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    undefined
  );
}

export function extractQuotedMessage(contextInfo: proto.IContextInfo | undefined): WhatsAppQuotedMessage | undefined {
  const providerMessageId = contextInfo?.stanzaId;
  if (!providerMessageId) return undefined;

  const quotedMessage = contextInfo?.quotedMessage;
  return {
    providerMessageId,
    participantJid: contextInfo?.participant ?? null,
    text: quotedMessage ? (extractTextFromMessage(quotedMessage) ?? "") : "",
  };
}

/**
 * Strip the bot's @mention text from a message. WhatsApp renders mentions as
 * @DisplayName in the text. We remove the first @-prefixed token that looks
 * like a bot mention so the agent sees a clean message.
 */
export function stripBotMention(text: string, botName?: string | null): string {
  if (botName) {
    // Try exact match first: @BotName (possibly with unicode zero-width chars)
    const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`@[\\u200B-\\u200F\\uFEFF]*${escaped}\\b`, "i");
    const stripped = text.replace(namePattern, "").trim();
    if (stripped !== text) return stripped.replace(/\s{2,}/g, " ");
  }
  // Fallback: strip the first @mention token (WhatsApp inserts mention at the position)
  return text
    .replace(/@[\u200B-\u200F\uFEFF]*\S+/, "")
    .trim()
    .replace(/\s{2,}/g, " ");
}

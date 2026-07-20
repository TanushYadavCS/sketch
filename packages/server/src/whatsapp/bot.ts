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
import type {
  WhatsAppGroupParticipantInput,
  WhatsAppGroupParticipantRefreshLogger,
} from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import { createDbAuthState } from "./auth-store";
import { WHATSAPP_TEXT_LIMIT, chunkText } from "./chunking";
import { collectWhatsAppGroupParticipants, toParticipantInputs } from "./group-participants";
import type { WhatsAppGroupMetadata as ProviderWhatsAppGroupMetadata } from "./provider";

const ECHO_TTL_MS = 60_000;
const INBOUND_DEDUPE_TTL_MS = 60_000;
const COMPOSING_INTERVAL_MS = 5_000;
const COMPOSING_TTL_MS = 3 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_STALE_MS = 30 * 60_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const GROUP_META_TTL_MS = 5 * 60_000;
const GROUP_SYNC_THROTTLE_MS = 5 * 60_000;

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

export interface WhatsAppCaptureMetadata {
  socketGeneration: number;
  upsertType?: "notify" | "append";
}

export type WhatsAppMessageHandler = (message: WhatsAppMessage, metadata: WhatsAppCaptureMetadata) => Promise<void>;

export interface WhatsAppHistoryBatchResult {
  persisted: number;
  skippedOld: number;
  skippedDup: number;
}

export interface WhatsAppHistoryBatchMetadata {
  socketGeneration: number;
  isLatest?: boolean;
  progress?: number | null;
  syncType?: proto.HistorySync.HistorySyncType | null;
  peerDataRequestSessionId?: string | null;
}

export type WhatsAppHistoryMessagesHandler = (
  messages: WhatsAppGroupMessage[],
  metadata: WhatsAppHistoryBatchMetadata,
) => Promise<WhatsAppHistoryBatchResult>;

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
    refreshParticipants?: (
      groupJid: string,
      participants: WhatsAppGroupParticipantInput[],
      lastSeenAt?: string,
      logger?: WhatsAppGroupParticipantRefreshLogger,
    ) => Promise<unknown>;
  };
  authStateFactory?: () => ReturnType<typeof createDbAuthState>;
  getMessage?: (key: proto.IMessageKey) => Promise<proto.IMessage | undefined>;
  reconnectDelayMs?: (statusCode: number | undefined) => number;
  onConnectionOpen?: (socketGeneration: number) => Promise<void> | void;
  onConnectionClose?: (statusCode: number | undefined, socketGeneration: number) => Promise<void> | void;
  onLoggedOut?: (socketGeneration: number) => Promise<void> | void;
  watchdogEnabled?: boolean;
  beforeSocketOpen?: () => Promise<void>;
}

export class WhatsAppBot {
  private db: Kysely<DB>;
  private logger: Logger;
  private groupMetadataStore?: WhatsAppBotConfig["groupMetadataStore"];
  private authStateFactory: () => ReturnType<typeof createDbAuthState>;
  private getMessage?: WhatsAppBotConfig["getMessage"];
  private reconnectDelayMs?: WhatsAppBotConfig["reconnectDelayMs"];
  private onConnectionOpen?: WhatsAppBotConfig["onConnectionOpen"];
  private onConnectionClose?: WhatsAppBotConfig["onConnectionClose"];
  private onLoggedOut?: WhatsAppBotConfig["onLoggedOut"];
  private watchdogEnabled: boolean;
  private beforeSocketOpen?: () => Promise<void>;
  private sock: WASocket | null = null;
  private handler: WhatsAppMessageHandler | null = null;
  private historyHandler: WhatsAppHistoryMessagesHandler | null = null;
  private recentlySent = new Set<string>();
  private recentlyReceived = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSocketGeneration = 0;
  private stopping = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastGroupSyncAt = 0;
  private lastGroupSyncSocketGeneration = 0;
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
    this.authStateFactory = config.authStateFactory ?? (() => createDbAuthState(this.db, this.logger));
    this.getMessage = config.getMessage;
    this.reconnectDelayMs = config.reconnectDelayMs;
    this.onConnectionOpen = config.onConnectionOpen;
    this.onConnectionClose = config.onConnectionClose;
    this.onLoggedOut = config.onLoggedOut;
    this.watchdogEnabled = config.watchdogEnabled ?? true;
    this.beforeSocketOpen = config.beforeSocketOpen;
  }

  onMessage(handler: WhatsAppMessageHandler): void {
    this.handler = handler;
  }

  onHistoryMessages(handler: WhatsAppHistoryMessagesHandler): void {
    this.historyHandler = handler;
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
    await this.beforeSocketOpen?.();
    this.clearReconnectTimer();
    this.stopping = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.stopWatchdog();

    const authState = await this.authStateFactory();
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
      syncFullHistory: true,
      fireInitQueries: false,
      markOnlineOnConnect: false,
      ...(this.getMessage ? { getMessage: this.getMessage } : {}),
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
          this.registerHistoryHandler();
          this.startWatchdog();
          void this.syncAllGroups();
          await this.onConnectionOpen?.(this.activeSocketGeneration);
          await callbacks.onConnected(this.phoneNumber ?? "unknown");
          resolve();
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message ?? "";
          await this.onConnectionClose?.(statusCode, this.activeSocketGeneration);

          if (statusCode === DisconnectReason.restartRequired) {
            this.logger.info("WhatsApp restart required after pairing — reconnecting");
            const reconnectDelayMs = this.reconnectDelayMs;
            if (reconnectDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(statusCode)));
            }
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
            await this.onLoggedOut?.(this.activeSocketGeneration);
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
      const authState = await this.authStateFactory();
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

  get accountLid(): string | null {
    return this.sock?.user?.lid ?? null;
  }

  get socket(): WASocket | null {
    return this.sock;
  }

  async fetchMessageHistory(input: {
    count: number;
    oldestMessageKey: { remoteJid: string; id: string; fromMe: boolean };
    oldestMessageTimestamp: number;
  }): Promise<string> {
    if (!this.sock) throw new Error("WhatsApp socket is unavailable for history sync");
    return this.sock.fetchMessageHistory(input.count, input.oldestMessageKey, input.oldestMessageTimestamp);
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

  async sendFile(jid: string, filePath: string, mimeType: string, fileName: string): Promise<WAMessage | null> {
    if (!this.sock) return null;
    const isImage = mimeType.startsWith("image/");

    if (isImage) {
      const sent = await this.sock.sendMessage(jid, {
        image: { url: filePath },
        caption: fileName,
      });
      this.trackSentMessageId(sent?.key?.id);
      return sent ?? null;
    }

    const sent = await this.sock.sendMessage(jid, {
      document: { url: filePath },
      mimetype: mimeType,
      fileName,
    });
    this.trackSentMessageId(sent?.key?.id);
    return sent ?? null;
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

  async getProviderGroupMetadata(
    groupJid: string,
    opts: { refresh?: boolean } = {},
  ): Promise<ProviderWhatsAppGroupMetadata | undefined> {
    const meta = opts.refresh ? await this.refreshGroupMetadata(groupJid) : await this.getGroupMetadata(groupJid);
    return meta ? this.toProviderGroupMetadata(groupJid, meta) : undefined;
  }

  async syncAllGroups(opts: { force?: boolean } = {}): Promise<number> {
    const socket = this.sock;
    const store = this.groupMetadataStore;
    if (!socket || !store) return 0;

    const now = Date.now();
    const socketGeneration = this.activeSocketGeneration;
    if (
      !opts.force &&
      this.lastGroupSyncSocketGeneration === socketGeneration &&
      this.lastGroupSyncAt > 0 &&
      now - this.lastGroupSyncAt < GROUP_SYNC_THROTTLE_MS
    ) {
      return 0;
    }

    this.lastGroupSyncAt = now;
    this.lastGroupSyncSocketGeneration = socketGeneration;
    let syncedCount = 0;

    try {
      const groups = await socket.groupFetchAllParticipating();
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        if (this.lastGroupSyncAt === now && this.lastGroupSyncSocketGeneration === socketGeneration) {
          this.lastGroupSyncAt = 0;
          this.lastGroupSyncSocketGeneration = 0;
        }
        return 0;
      }

      for (const [jid, meta] of Object.entries(groups)) {
        this.groupMetaCache.set(jid, { meta, expires: Date.now() + GROUP_META_TTL_MS });
        await this.persistGroupMetadata(jid, meta, new Date().toISOString());
        syncedCount += 1;
      }

      return syncedCount;
    } catch (err) {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        if (this.lastGroupSyncAt === now && this.lastGroupSyncSocketGeneration === socketGeneration) {
          this.lastGroupSyncAt = 0;
          this.lastGroupSyncSocketGeneration = 0;
        }
      }
      this.logger.warn({ err, syncedCount }, "Failed to sync WhatsApp groups");
      return syncedCount;
    }
  }

  async resolveJidToPhone(jid: string): Promise<string | null> {
    if (jid.endsWith("@lid")) return this.resolveLidToPhone(jid);
    if (jid.endsWith("@s.whatsapp.net")) return jidToPhoneNumber(jid);
    return null;
  }

  // --- Internal ---

  private async createSocket(): Promise<void> {
    await this.beforeSocketOpen?.();
    this.clearReconnectTimer();
    this.stopping = false;
    const authState = await this.authStateFactory();
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
      syncFullHistory: true,
      fireInitQueries: false,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid) => {
        const cached = this.groupMetaCache.get(jid);
        if (cached && cached.expires > Date.now()) return cached.meta;
        return undefined;
      },
      ...(this.getMessage ? { getMessage: this.getMessage } : {}),
    });

    this.activeSocketGeneration = socketGeneration;
    this.sock = socket;
    socket.ev.on("creds.update", authState.saveCreds);
    this.registerConnectionHandler(socket, authState, socketGeneration);
    this.registerMessageHandler(socket, socketGeneration);
    this.registerHistoryHandler(socket, socketGeneration);
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
        await this.onConnectionOpen?.(socketGeneration);
        void this.syncAllGroups();
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        await this.onConnectionClose?.(statusCode, socketGeneration);

        if (statusCode === DisconnectReason.loggedOut) {
          this.clearReconnectTimer();
          this.logger.warn({ socketGeneration }, "WhatsApp logged out — clearing credentials");
          await authState.clearCreds();
          this.stopWatchdog();
          if (socket === this.sock) {
            this.sock = null;
          }
          await this.onLoggedOut?.(socketGeneration);
          return;
        }

        if (this.stopping) {
          this.logger.info({ socketGeneration }, "WhatsApp socket closed during shutdown");
          return;
        }

        const nextAttempt = this.reconnectAttempt + 1;
        const defaultDelay = Math.min(RECONNECT_BASE_MS * RECONNECT_FACTOR ** (nextAttempt - 1), RECONNECT_MAX_MS);
        const delay =
          this.reconnectDelayMs?.(statusCode) ?? defaultDelay + defaultDelay * RECONNECT_JITTER * Math.random();
        if (this.scheduleReconnect(delay, socketGeneration, nextAttempt)) {
          this.reconnectAttempt = nextAttempt;
        }
      }
    });
  }

  private registerHistoryHandler(
    socket: WASocket = this.sock as WASocket,
    socketGeneration = this.activeSocketGeneration,
  ): void {
    socket.ev.on(
      "messaging-history.set",
      async ({ messages, isLatest, progress, syncType, peerDataRequestSessionId }) => {
        if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
          return;
        }

        let skippedNontext = 0;
        let skippedNonGroup = 0;
        let skippedNoSender = 0;
        const groupMessages: WhatsAppGroupMessage[] = [];

        for (const msg of messages) {
          if (!msg.message) {
            skippedNontext += 1;
            continue;
          }

          const jid = msg.key.remoteJid;
          if (!jid?.endsWith("@g.us")) {
            skippedNonGroup += 1;
            continue;
          }

          const messageType = getContentType(msg.message);
          const text = extractText(msg);
          const hasMedia = hasMediaContent(messageType);

          if (!text && !hasMedia) {
            skippedNontext += 1;
            continue;
          }

          const groupMessage = await this.buildGroupMessage(msg, jid, text, messageType, hasMedia);
          if (groupMessage) {
            groupMessages.push(groupMessage);
          } else {
            skippedNoSender += 1;
          }
        }

        let result: WhatsAppHistoryBatchResult = { persisted: 0, skippedOld: 0, skippedDup: 0 };
        try {
          if ((groupMessages.length > 0 || peerDataRequestSessionId) && this.historyHandler) {
            result = await this.historyHandler(groupMessages, {
              socketGeneration,
              isLatest,
              progress,
              syncType,
              peerDataRequestSessionId,
            });
          }
        } catch (err) {
          this.logger.warn(
            {
              err,
              total: messages.length,
              candidates: groupMessages.length,
              skippedNontext,
              skippedNonGroup,
              skippedNoSender,
            },
            "Failed to persist WhatsApp history batch",
          );
          return;
        }

        this.logger.info(
          {
            total: messages.length,
            candidates: groupMessages.length,
            persisted: result.persisted,
            skippedOld: result.skippedOld,
            skippedDup: result.skippedDup,
            skippedNontext,
            skippedNonGroup,
            skippedNoSender,
            isLatest,
            progress,
            syncType,
            peerDataRequestSessionId,
          },
          "WhatsApp history batch processed",
        );
      },
    );
  }

  private registerMessageHandler(
    socket: WASocket = this.sock as WASocket,
    socketGeneration = this.activeSocketGeneration,
  ): void {
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (socketGeneration !== this.activeSocketGeneration || socket !== this.sock) {
        return;
      }

      if (type !== "notify" && type !== "append") return;
      const metadata: WhatsAppCaptureMetadata = { socketGeneration, upsertType: type };

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
          await this.handleGroupMessage(msg, jid, text, messageType, hasMedia, metadata);
        } else {
          await this.handleDmMessage(msg, jid, isStandardDm, text, messageType, hasMedia, metadata);
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
    metadata: WhatsAppCaptureMetadata,
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
      await this.dispatchInboundOnce(msg, async () => {
        this.lastMessageAt = Date.now();
        await this.handler?.(
          {
            type: "dm",
            text: text ?? "",
            phoneNumber,
            jid,
            messageId: msg.key?.id ?? "",
            pushName: msg.pushName ?? "Unknown",
            rawMessage: msg,
            mediaType: hasMedia ? (messageType ?? undefined) : undefined,
            ...(quotedMessage ? { quotedMessage } : {}),
          },
          metadata,
        );
      });
    }
  }

  private async handleGroupMessage(
    msg: proto.IWebMessageInfo,
    groupJid: string,
    text: string | null,
    messageType: string | undefined,
    hasMedia: boolean,
    metadata: WhatsAppCaptureMetadata,
  ): Promise<void> {
    const groupMessage = await this.buildGroupMessage(msg, groupJid, text, messageType, hasMedia);
    if (groupMessage && this.handler) {
      await this.dispatchInboundOnce(msg, async () => {
        this.lastMessageAt = Date.now();
        await this.handler?.(groupMessage, metadata);
      });
    }
  }

  private async dispatchInboundOnce(msg: proto.IWebMessageInfo, dispatch: () => Promise<void>): Promise<void> {
    const providerMessageId = msg.key?.id;
    const providerConversationId = msg.key?.remoteJid;
    if (!providerMessageId || !providerConversationId) {
      await dispatch();
      return;
    }
    const key = `${providerConversationId}\u001f${providerMessageId}\u001f${String(Boolean(msg.key?.fromMe))}`;
    if (this.recentlyReceived.has(key)) return;
    this.recentlyReceived.add(key);
    try {
      await dispatch();
    } catch (error) {
      this.recentlyReceived.delete(key);
      throw error;
    }
    const expiry = setTimeout(() => this.recentlyReceived.delete(key), INBOUND_DEDUPE_TTL_MS);
    expiry.unref?.();
  }

  /**
   * Historical group sync keeps messages sent by the authenticated account
   * because they are part of the group's context. If Baileys omits participant
   * on those rows, the socket user id is the closest provider identity.
   */
  private async buildGroupMessage(
    msg: proto.IWebMessageInfo,
    groupJid: string,
    text: string | null,
    messageType: string | undefined,
    hasMedia: boolean,
  ): Promise<WhatsAppGroupMessage | null> {
    const senderJid = this.resolveGroupSenderJid(msg);
    if (!senderJid) return null;

    if (!msg.message) return null;
    const contextInfo = extractContextInfo(msg.message);
    const isMentioned = this.isBotMentioned(contextInfo);

    let cleanText = text;
    if (cleanText && isMentioned && contextInfo?.mentionedJid?.length) {
      cleanText = stripBotMention(cleanText, this.sock?.user?.name);
    }

    const senderPhone = await this.resolveJidToPhone(senderJid);
    const quotedMessage = extractQuotedMessage(contextInfo);

    return {
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
    };
  }

  private resolveGroupSenderJid(msg: proto.IWebMessageInfo): string | null {
    const senderJid = msg.key?.participant ?? msg.participant ?? (msg.key?.fromMe ? this.sock?.user?.id : undefined);
    return senderJid ? jidNormalizedUser(senderJid) : null;
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
        await this.persistGroupMetadata(groupJid, meta, new Date().toISOString());
      }
      return meta;
    } catch (err) {
      this.logger.warn({ err, groupJid }, "Failed to fetch group metadata");
      return undefined;
    }
  }

  private async toProviderGroupMetadata(groupJid: string, meta: GroupMetadata): Promise<ProviderWhatsAppGroupMetadata> {
    const collected = await collectWhatsAppGroupParticipants(meta, (jid) => this.resolveLidToPhone(jid));
    if (collected.skippedCount > 0) {
      this.logger.warn(
        { groupJid, skippedCount: collected.skippedCount },
        "Skipped unrecognized WhatsApp group participants",
      );
    }
    return {
      id: groupJid,
      subject: meta.subject ?? "Unknown Group",
      desc: meta.desc ?? null,
      participants: collected.participants,
    };
  }

  private async persistGroupMetadata(groupJid: string, meta: GroupMetadata, updatedAt: string): Promise<void> {
    const providerMetadata = await this.toProviderGroupMetadata(groupJid, meta);
    await this.groupMetadataStore?.upsert({
      jid: groupJid,
      name: providerMetadata.subject,
      description: providerMetadata.desc ?? null,
      updated_at: updatedAt,
    });
    await this.groupMetadataStore?.refreshParticipants?.(
      groupJid,
      toParticipantInputs(providerMetadata.participants),
      updatedAt,
      this.logger,
    );
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
    if (!this.watchdogEnabled) return;
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

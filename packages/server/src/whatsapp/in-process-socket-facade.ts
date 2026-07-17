import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WAMessage } from "@whiskeysockets/baileys";
import { downloadWhatsAppMedia } from "../files";
import type { Logger } from "../logger";
import type { WhatsAppBot } from "./bot";
import {
  WHATSAPP_FACADE_CONTRACT_VERSION,
  type WhatsAppFacadeHealth,
  type WhatsAppHistorySyncRequest,
  type WhatsAppMediaDownloadRef,
  type WhatsAppPairingEvent,
  type WhatsAppQuotedRef,
  type WhatsAppReactionResult,
  type WhatsAppSendContent,
  type WhatsAppSocketFacade,
} from "./facade-contract";
import { phoneE164ToWhatsAppJid } from "./provider";

const MESSAGE_CACHE_LIMIT = 512;

export interface InProcessMessageReferenceStore {
  rememberMessage(params: {
    providerConversationId: string;
    providerMessageId: string;
    rawProviderPayload: unknown;
    eventKey?: string;
  }): void;
}

function providerTimestamp(message: WAMessage | null): string | null {
  const timestamp = message?.messageTimestamp;
  if (timestamp == null) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function messageRefKey(ref: WhatsAppQuotedRef): string {
  return ref.kind === "eventKey" ? `event:${ref.value}` : `provider:${ref.providerConversationId}\u0000${ref.value}`;
}

export class InProcessSocketFacade implements WhatsAppSocketFacade, InProcessMessageReferenceStore {
  private readonly messages = new Map<string, WAMessage>();

  readonly pairing = {
    startQr: async (onEvent: (event: WhatsAppPairingEvent) => Promise<void>): Promise<void> => {
      await this.bot.startPairing({
        onQr: (qr) => onEvent({ type: "qr", qr }),
        onConnected: (phoneNumber) => onEvent({ type: "connected", phoneNumber }),
        onError: (message) => onEvent({ type: "error", message }),
      });
    },
    status: async () => ({ connected: this.bot.isConnected, phoneNumber: this.bot.phoneNumber }),
    cancel: async (): Promise<void> => {
      this.bot.cancelPairing();
    },
    logout: async (): Promise<void> => {
      await this.bot.disconnect();
      await this.onLogout?.();
    },
  };

  constructor(
    private readonly bot: WhatsAppBot,
    private readonly logger: Logger,
    private readonly onLogout?: () => Promise<void>,
  ) {}

  rememberMessage(params: {
    providerConversationId: string;
    providerMessageId: string;
    rawProviderPayload: unknown;
    eventKey?: string;
  }): void {
    if (!params.rawProviderPayload || typeof params.rawProviderPayload !== "object") return;
    const message = params.rawProviderPayload as WAMessage;
    this.remember(
      {
        kind: "providerMessageId",
        providerConversationId: params.providerConversationId,
        value: params.providerMessageId,
      },
      message,
    );
    if (params.eventKey) this.remember({ kind: "eventKey", value: params.eventKey }, message);
  }

  async send(
    target: string,
    content: WhatsAppSendContent,
    opts: { quotedRef?: WhatsAppQuotedRef; idempotencyKey: string },
  ) {
    const quoted = opts.quotedRef ? this.findMessage(opts.quotedRef) : null;
    if (opts.quotedRef && !quoted) {
      this.logger.warn(
        { target, quotedRef: opts.quotedRef },
        "WhatsApp quoted message is unavailable; sending unquoted",
      );
    }

    const sent =
      content.kind === "text"
        ? await this.bot.sendText(target, content.text, quoted ? { quoted } : undefined)
        : await this.bot.sendFile(target, content.filePath, content.mimeType, content.fileName);
    if (!sent) return null;
    return {
      providerMessageId: sent.key?.id ?? null,
      providerConversationId: target,
      providerTimestamp: providerTimestamp(sent),
      rawProviderPayload: sent,
    };
  }

  async sendComposing(target: string, on: boolean): Promise<void> {
    if (on) {
      this.bot.startComposing(target);
      return;
    }
    this.bot.stopComposing(target);
  }

  async react(target: string, quotedRef: WhatsAppQuotedRef, emoji: string): Promise<WhatsAppReactionResult> {
    const message = this.findMessage(quotedRef);
    if (!message?.key) return { error: "unknown-message" };
    if (emoji === "") {
      await this.bot.removeReaction(target, message.key);
    } else {
      await this.bot.addReaction(target, message.key, emoji);
    }
    return { ok: true };
  }

  async downloadMedia(ref: WhatsAppMediaDownloadRef) {
    const message = this.findMessage(ref.messageRef);
    const socket = this.bot.socket;
    if (!message || !socket) return null;
    const attachment = await downloadWhatsAppMedia(message, socket, ref.destinationDir, ref.maxFileBytes, this.logger);
    const sha256 = createHash("sha256")
      .update(await readFile(attachment.localPath))
      .digest("hex");
    return {
      stagedPath: attachment.localPath,
      mime: attachment.mimeType,
      size: attachment.sizeBytes,
      sha256,
      originalName: attachment.originalName,
    };
  }

  async groupMetadata(jid: string, opts: { refresh: boolean }) {
    return (await this.bot.getProviderGroupMetadata(jid, opts)) ?? null;
  }

  async syncAllGroups(opts: { force: boolean }) {
    return { synced: await this.bot.syncAllGroups(opts) };
  }

  async resolveLid(jid: string): Promise<string | null> {
    const phoneE164 = await this.bot.resolveJidToPhone(jid);
    return phoneE164 ? phoneE164ToWhatsAppJid(phoneE164) : null;
  }

  fetchMessageHistory(request: WhatsAppHistorySyncRequest): Promise<string> {
    return this.bot.fetchMessageHistory(request);
  }

  async shutdown(): Promise<void> {
    await this.bot.stop();
  }

  async health(): Promise<WhatsAppFacadeHealth> {
    return {
      socketState: this.bot.isConnected ? "connected" : "disconnected",
      queueDepth: 0,
      insertFailures: 0,
      uptime: process.uptime(),
      scriptHash: "inprocess",
      contractVersion: WHATSAPP_FACADE_CONTRACT_VERSION,
    };
  }

  private remember(ref: WhatsAppQuotedRef, message: WAMessage): void {
    const key = messageRefKey(ref);
    this.messages.delete(key);
    this.messages.set(key, message);
    while (this.messages.size > MESSAGE_CACHE_LIMIT) {
      const oldest = this.messages.keys().next().value;
      if (oldest === undefined) break;
      this.messages.delete(oldest);
    }
  }

  private findMessage(ref: WhatsAppQuotedRef): WAMessage | null {
    const key = messageRefKey(ref);
    const message = this.messages.get(key);
    if (!message) return null;
    this.messages.delete(key);
    this.messages.set(key, message);
    return message;
  }
}

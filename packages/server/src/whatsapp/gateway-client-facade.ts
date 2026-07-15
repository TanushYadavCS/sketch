import type { ZodType } from "zod";
import type { Logger } from "../logger";
import {
  type WhatsAppFacadeHealth,
  type WhatsAppMediaDownloadRef,
  type WhatsAppPairingEvent,
  type WhatsAppQuotedRef,
  type WhatsAppReactionResult,
  type WhatsAppSendContent,
  type WhatsAppSocketFacade,
  whatsAppFacadeHealthSchema,
  whatsAppGroupMetadataResponseSchema,
  whatsAppGroupSyncSummarySchema,
  whatsAppMediaDownloadResponseSchema,
  whatsAppOkResponseSchema,
  whatsAppPairingEventSchema,
  whatsAppPairingStatusSchema,
  whatsAppReactionResponseSchema,
  whatsAppResolveLidResponseSchema,
  whatsAppSendResponseSchema,
} from "./facade-contract";

export const WHATSAPP_GATEWAY_SEND_TIMEOUT_MS = 60_000;
export const WHATSAPP_GATEWAY_QUERY_TIMEOUT_MS = 30_000;
export const WHATSAPP_GATEWAY_HEALTH_TIMEOUT_MS = 5_000;

interface GatewayClientFacadeOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  fetch?: typeof fetch;
}

function usableRef(ref: WhatsAppQuotedRef | undefined): ref is WhatsAppQuotedRef {
  if (!ref) return false;
  return ref.kind === "eventKey"
    ? ref.value.trim().length > 0
    : ref.value.trim().length > 0 && ref.providerConversationId.trim().length > 0;
}

export class GatewayClientFacade implements WhatsAppSocketFacade {
  private readonly fetchImpl: typeof fetch;

  readonly pairing = {
    startQr: async (onEvent: (event: WhatsAppPairingEvent) => Promise<void>): Promise<void> => {
      const response = await this.requestRaw(
        "/pairing-sessions",
        { method: "POST" },
        WHATSAPP_GATEWAY_QUERY_TIMEOUT_MS,
      );
      if (!response.body) throw new Error("WhatsApp gateway pairing response had no body");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += next.value;
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
          if (!data) continue;
          await onEvent(whatsAppPairingEventSchema.parse(JSON.parse(data)));
        }
      }
    },
    status: () => this.request("/pairing-sessions/current", {}, whatsAppPairingStatusSchema),
    cancel: async (): Promise<void> => {
      await this.request("/pairing-sessions/current", { method: "DELETE" }, whatsAppOkResponseSchema);
    },
    logout: async (): Promise<void> => {
      await this.request("/authentication", { method: "DELETE" }, whatsAppOkResponseSchema);
    },
  };

  constructor(private readonly options: GatewayClientFacadeOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get gatewayToken(): string {
    return this.options.token;
  }

  async send(
    target: string,
    content: WhatsAppSendContent,
    opts: { quotedRef?: WhatsAppQuotedRef; idempotencyKey: string },
  ) {
    const response = await this.request(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify({
          target,
          content,
          opts: { ...opts, quotedRef: usableRef(opts.quotedRef) ? opts.quotedRef : undefined },
        }),
      },
      whatsAppSendResponseSchema,
      WHATSAPP_GATEWAY_SEND_TIMEOUT_MS,
    );
    return response.result;
  }

  async sendComposing(target: string, on: boolean): Promise<void> {
    await this.request("/presence", { method: "PUT", body: JSON.stringify({ target, on }) }, whatsAppOkResponseSchema);
  }

  async react(target: string, quotedRef: WhatsAppQuotedRef, emoji: string): Promise<WhatsAppReactionResult> {
    if (!usableRef(quotedRef)) {
      this.options.logger.warn({ target }, "Skipped WhatsApp reaction for an empty message reference");
      return { error: "unknown-message" };
    }
    const response = await this.request(
      "/reactions",
      { method: "POST", body: JSON.stringify({ target, quotedRef, emoji }) },
      whatsAppReactionResponseSchema,
    );
    return response.result;
  }

  async downloadMedia(ref: WhatsAppMediaDownloadRef) {
    if (!usableRef(ref.messageRef)) {
      this.options.logger.warn("Skipped WhatsApp media download for an empty message reference");
      return null;
    }
    const response = await this.request(
      "/media-downloads",
      { method: "POST", body: JSON.stringify(ref) },
      whatsAppMediaDownloadResponseSchema,
    );
    return response.result;
  }

  async groupMetadata(jid: string, opts: { refresh: boolean }) {
    const response = await this.request(
      "/group-metadata-queries",
      { method: "POST", body: JSON.stringify({ jid, opts }) },
      whatsAppGroupMetadataResponseSchema,
    );
    return response.result;
  }

  syncAllGroups(opts: { force: boolean }) {
    return this.request("/group-syncs", { method: "POST", body: JSON.stringify(opts) }, whatsAppGroupSyncSummarySchema);
  }

  async resolveLid(jid: string): Promise<string | null> {
    const response = await this.request(
      "/lid-resolutions",
      { method: "POST", body: JSON.stringify({ jid }) },
      whatsAppResolveLidResponseSchema,
    );
    return response.phoneJid;
  }

  async shutdown(timeoutMs = WHATSAPP_GATEWAY_QUERY_TIMEOUT_MS): Promise<void> {
    await this.request("/process", { method: "DELETE" }, whatsAppOkResponseSchema, timeoutMs);
  }

  health(): Promise<WhatsAppFacadeHealth> {
    return this.request("/health", {}, whatsAppFacadeHealthSchema, WHATSAPP_GATEWAY_HEALTH_TIMEOUT_MS);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: ZodType<T>,
    timeoutMs = WHATSAPP_GATEWAY_QUERY_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.requestRaw(path, init, timeoutMs);
    const body = await response.json();
    return schema.parse(body);
  }

  private async requestRaw(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`WhatsApp gateway request failed: ${response.status}`);
    }
    return response;
  }
}

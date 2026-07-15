import { resolve, sep } from "node:path";
import type { Logger } from "../../logger";
import {
  WHATSAPP_FACADE_CONTRACT_VERSION,
  type WhatsAppFacadeHealth,
  type WhatsAppMediaDownloadRef,
  type WhatsAppPairingEvent,
  type WhatsAppQuotedRef,
  type WhatsAppReactionResult,
  type WhatsAppSendContent,
  type WhatsAppSocketFacade,
} from "../facade-contract";
import type { InProcessMessageReferenceStore } from "../in-process-socket-facade";
import type { WhatsAppSendResult } from "../provider";

const SEND_TIMEOUT_MS = 60_000;
const QUERY_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_CACHE_CAPACITY = 512;
const IDEMPOTENCY_CACHE_TTL_MS = 10 * 60_000;

interface CachedSendResult {
  result: WhatsAppSendResult;
  expiresAt: number;
}

export type WhatsAppGatewaySocketState = "disconnected" | "connecting" | "connected" | "logged-out";

export interface GatewaySocketFacadeDeps {
  delegate: WhatsAppSocketFacade & InProcessMessageReferenceStore;
  stagingDir: string;
  maxFileBytes: number;
  logger: Logger;
  socketState: () => WhatsAppGatewaySocketState;
  queueDepth: () => Promise<number>;
  insertFailures: () => number;
  scriptHash: string;
  shutdown: () => Promise<void>;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

export class GatewaySocketFacade implements WhatsAppSocketFacade, InProcessMessageReferenceStore {
  private readonly cache = new Map<string, CachedSendResult>();
  private readonly now: () => number;
  private sendTail: Promise<void> = Promise.resolve();

  readonly pairing = {
    startQr: (onEvent: (event: WhatsAppPairingEvent) => Promise<void>) => this.deps.delegate.pairing.startQr(onEvent),
    status: () => withTimeout(this.deps.delegate.pairing.status(), QUERY_TIMEOUT_MS, "WhatsApp pairing status"),
    cancel: () => this.deps.delegate.pairing.cancel(),
    logout: () =>
      this.serializeSend(() => withTimeout(this.deps.delegate.pairing.logout(), SEND_TIMEOUT_MS, "WhatsApp logout")),
  };

  constructor(private readonly deps: GatewaySocketFacadeDeps) {
    this.now = deps.now ?? Date.now;
  }

  rememberMessage(params: {
    providerConversationId: string;
    providerMessageId: string;
    rawProviderPayload: unknown;
    eventKey?: string;
  }): void {
    this.deps.delegate.rememberMessage(params);
  }

  async send(
    target: string,
    content: WhatsAppSendContent,
    opts: { quotedRef?: WhatsAppQuotedRef; idempotencyKey: string },
  ): Promise<WhatsAppSendResult | null> {
    return this.serializeSend(async () => {
      const cached = this.readCache(opts.idempotencyKey);
      if (cached) return cached;
      const sent = await withTimeout(this.deps.delegate.send(target, content, opts), SEND_TIMEOUT_MS, "WhatsApp send");
      if (!sent) return null;
      const result: WhatsAppSendResult = {
        providerMessageId: sent.providerMessageId,
        providerConversationId: sent.providerConversationId,
        providerTimestamp: sent.providerTimestamp,
      };
      this.writeCache(opts.idempotencyKey, result);
      return result;
    });
  }

  async sendComposing(target: string, on: boolean): Promise<void> {
    await withTimeout(this.deps.delegate.sendComposing(target, on), QUERY_TIMEOUT_MS, "WhatsApp composing update");
  }

  async react(target: string, quotedRef: WhatsAppQuotedRef, emoji: string): Promise<WhatsAppReactionResult> {
    return this.serializeSend(() =>
      withTimeout(this.deps.delegate.react(target, quotedRef, emoji), SEND_TIMEOUT_MS, "WhatsApp reaction"),
    );
  }

  async downloadMedia(ref: WhatsAppMediaDownloadRef) {
    const result = await withTimeout(
      this.deps.delegate.downloadMedia({
        ...ref,
        destinationDir: this.deps.stagingDir,
        maxFileBytes: Math.min(ref.maxFileBytes, this.deps.maxFileBytes),
      }),
      QUERY_TIMEOUT_MS,
      "WhatsApp media download",
    );
    if (!result) return null;
    const stagingRoot = resolve(this.deps.stagingDir);
    const stagedPath = resolve(result.stagedPath);
    if (stagedPath !== stagingRoot && !stagedPath.startsWith(`${stagingRoot}${sep}`)) {
      throw new Error("WhatsApp facade media path escaped the staging root");
    }
    return { ...result, stagedPath };
  }

  groupMetadata(jid: string, opts: { refresh: boolean }) {
    return withTimeout(this.deps.delegate.groupMetadata(jid, opts), QUERY_TIMEOUT_MS, "WhatsApp group metadata");
  }

  syncAllGroups(opts: { force: boolean }) {
    return withTimeout(this.deps.delegate.syncAllGroups(opts), QUERY_TIMEOUT_MS, "WhatsApp group sync");
  }

  resolveLid(jid: string): Promise<string | null> {
    return withTimeout(this.deps.delegate.resolveLid(jid), QUERY_TIMEOUT_MS, "WhatsApp LID resolution");
  }

  shutdown(): Promise<void> {
    return this.deps.shutdown();
  }

  async health(): Promise<WhatsAppFacadeHealth> {
    return {
      socketState: this.deps.socketState(),
      queueDepth: await this.deps.queueDepth(),
      insertFailures: this.deps.insertFailures(),
      uptime: process.uptime(),
      scriptHash: this.deps.scriptHash,
      contractVersion: WHATSAPP_FACADE_CONTRACT_VERSION,
    };
  }

  private serializeSend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sendTail.then(operation, operation);
    this.sendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private readCache(key: string): WhatsAppSendResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.result;
  }

  private writeCache(key: string, result: WhatsAppSendResult): void {
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt: this.now() + IDEMPOTENCY_CACHE_TTL_MS });
    while (this.cache.size > IDEMPOTENCY_CACHE_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

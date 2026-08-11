import type { Logger } from "../logger";
import type { WhatsAppSocketFacade } from "./facade-contract";
import { safeWhatsAppErrorFields } from "./privacy";

export interface WhatsAppLidRefreshCandidate {
  id: string;
  whatsapp_number: string | null;
}

export interface WhatsAppLidRefreshStore {
  listDue(attemptedBefore: string, limit: number): Promise<WhatsAppLidRefreshCandidate[]>;
  attachIfPhoneUnchanged(
    userId: string,
    phoneE164: string,
    lid: string,
    observedAt: string,
  ): Promise<"attached" | "already-owned" | "ownership-conflict" | "stale-phone">;
  markAttempt(userId: string, phoneE164: string, attemptedAt: string, providerCurrent: boolean): Promise<boolean>;
}

export interface WhatsAppUserLidRefreshOptions {
  whatsapp: Pick<WhatsAppSocketFacade, "health" | "resolvePhoneToLid">;
  store: WhatsAppLidRefreshStore;
  logger: Logger;
  intervalMs?: number;
  retryAfterMs?: number;
  batchSize?: number;
  interRequestDelayMs?: number;
  interRequestJitterMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INTER_REQUEST_DELAY_MS = 1_000;
const DEFAULT_INTER_REQUEST_JITTER_MS = 1_000;

export class WhatsAppUserLidRefresh {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: WhatsAppUserLidRefreshOptions) {
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.runDetached("periodic_whatsapp_lid_refresh"),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.timer.unref();
    this.runDetached("initial_whatsapp_lid_refresh");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async wake(): Promise<void> {
    if (this.running) return this.running;
    const run = this.refreshDue().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  async capture(userId: string, phoneE164: string): Promise<void> {
    if (!this.options.whatsapp.resolvePhoneToLid) return;
    const observedAt = this.now().toISOString();
    let providerCurrent = false;
    try {
      const resolution = await this.options.whatsapp.resolvePhoneToLid(phoneE164);
      providerCurrent = resolution?.source === "provider-current";
      if (resolution) {
        const attached = await this.options.store.attachIfPhoneUnchanged(userId, phoneE164, resolution.lid, observedAt);
        if (attached === "ownership-conflict") {
          this.options.logger.error({ operation: "attach_whatsapp_lid" }, "WhatsApp LID ownership conflict");
        }
      }
    } catch (error) {
      this.options.logger.warn(
        { operation: "refresh_whatsapp_lid", ...safeWhatsAppErrorFields(error) },
        "WhatsApp LID refresh failed",
      );
    } finally {
      try {
        await this.options.store.markAttempt(userId, phoneE164, observedAt, providerCurrent);
      } catch (error) {
        this.options.logger.warn(
          { operation: "mark_whatsapp_lid_attempt", ...safeWhatsAppErrorFields(error) },
          "WhatsApp LID attempt timestamp failed",
        );
      }
    }
  }

  private async refreshDue(): Promise<void> {
    const health = await this.options.whatsapp.health().catch((error) => {
      this.options.logger.warn(
        { operation: "check_whatsapp_lid_refresh_health", ...safeWhatsAppErrorFields(error) },
        "WhatsApp LID refresh health check failed",
      );
      return null;
    });
    if (health?.socketState !== "connected") return;
    const attemptedBefore = new Date(
      this.now().getTime() - (this.options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
    ).toISOString();
    const candidates = await this.options.store.listDue(attemptedBefore, this.options.batchSize ?? DEFAULT_BATCH_SIZE);
    const refreshable = candidates.filter(
      (candidate): candidate is WhatsAppLidRefreshCandidate & { whatsapp_number: string } =>
        candidate.whatsapp_number !== null,
    );
    for (const [index, candidate] of refreshable.entries()) {
      if (index > 0) await this.sleepBeforeNextRequest();
      await this.capture(candidate.id, candidate.whatsapp_number);
    }
  }

  private async sleepBeforeNextRequest(): Promise<void> {
    const baseMs = this.options.interRequestDelayMs ?? DEFAULT_INTER_REQUEST_DELAY_MS;
    const jitterMs = this.options.interRequestJitterMs ?? DEFAULT_INTER_REQUEST_JITTER_MS;
    const random = this.options.random ?? Math.random;
    const delayMs = Math.max(0, baseMs) + Math.floor(random() * Math.max(0, jitterMs));
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    await sleep(delayMs);
  }

  private runDetached(operation: string): void {
    void this.wake().catch((error) => {
      this.options.logger.warn(
        { operation, ...safeWhatsAppErrorFields(error) },
        "Detached WhatsApp LID refresh failed",
      );
    });
  }
}

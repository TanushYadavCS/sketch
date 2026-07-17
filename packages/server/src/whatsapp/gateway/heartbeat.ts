import type { Logger } from "../../logger";

export const WHATSAPP_GATEWAY_HEARTBEAT_INTERVAL_MS = 10_000;
export const WHATSAPP_GATEWAY_HEARTBEAT_SELF_EXIT_MS = 25_000;

export interface WhatsAppGatewayHeartbeatDeps {
  heartbeat: (markLive: boolean) => Promise<boolean>;
  isSocketHealthy: () => boolean;
  onOwnershipLost: (reason: string) => Promise<void> | void;
  logger: Logger;
  now?: () => bigint;
  intervalMs?: number;
}

export class WhatsAppGatewayHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessfulHeartbeat: bigint;
  private consecutiveFailures = 0;
  private running = false;

  constructor(private readonly deps: WhatsAppGatewayHeartbeatDeps) {
    this.lastSuccessfulHeartbeat = (deps.now ?? process.hrtime.bigint)();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? WHATSAPP_GATEWAY_HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owned = await this.deps.heartbeat(this.deps.isSocketHealthy());
      if (!owned) {
        await this.deps.onOwnershipLost("lease heartbeat rejected the owner token");
        return;
      }
      this.consecutiveFailures = 0;
      this.lastSuccessfulHeartbeat = (this.deps.now ?? process.hrtime.bigint)();
    } catch (error) {
      this.consecutiveFailures += 1;
      const now = (this.deps.now ?? process.hrtime.bigint)();
      const elapsedMs = Number(now - this.lastSuccessfulHeartbeat) / 1_000_000;
      this.deps.logger.warn(
        { error, consecutiveFailures: this.consecutiveFailures, elapsedMs },
        "WhatsApp gateway heartbeat failed",
      );
      if (this.consecutiveFailures >= 3 && elapsedMs > WHATSAPP_GATEWAY_HEARTBEAT_SELF_EXIT_MS) {
        await this.deps.onOwnershipLost("heartbeat deadline exceeded after consecutive database failures");
      }
    } finally {
      this.running = false;
    }
  }
}

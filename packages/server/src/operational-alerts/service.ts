import type { createOperationalAlertsRepository } from "../db/repositories/operational-alerts";
import type { Logger } from "../logger";
import type { WhatsAppSocketStateChange } from "../whatsapp/facade-contract";
import { BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY } from "./types";

export const BAILEYS_DISCONNECT_GRACE_MS = 5 * 60 * 1000;

export function createOperationalAlertService(params: {
  alerts: ReturnType<typeof createOperationalAlertsRepository>;
  logger?: Logger;
  now?: () => Date;
}) {
  const now = params.now ?? (() => new Date());
  let wake: () => void = () => {};

  return {
    setWake(nextWake: () => void): void {
      wake = nextWake;
    },

    async observeBaileysSocketState(change: WhatsAppSocketStateChange): Promise<void> {
      try {
        const observedAt = change.occurredAt ?? now().toISOString();
        if (change.socketState === "connected") {
          await params.alerts.resolve(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY, observedAt);
          wake();
          return;
        }
        if (change.socketState !== "disconnected" && change.socketState !== "logged-out") return;

        const graceMs = change.socketState === "logged-out" ? 0 : BAILEYS_DISCONNECT_GRACE_MS;
        await params.alerts.observe({
          type: BAILEYS_DISCONNECTED_ALERT_TYPE,
          resourceKey: BAILEYS_GATEWAY_RESOURCE_KEY,
          severity: change.socketState === "logged-out" ? "critical" : "warning",
          payload: JSON.stringify({
            version: 1,
            socketState: change.socketState,
            occurredAt: observedAt,
            ...(change.statusCode === undefined ? {} : { statusCode: change.statusCode }),
            ...(change.reason ? { reason: change.reason } : {}),
            gatewayGeneration: change.generation,
          }),
          observedAt,
          notifyAfter: new Date(Date.parse(observedAt) + graceMs).toISOString(),
        });
        wake();
      } catch (error) {
        params.logger?.warn(
          { error, socketState: change.socketState, statusCode: change.statusCode },
          "Operational alert observation failed",
        );
      }
    },
  };
}

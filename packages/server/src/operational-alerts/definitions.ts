import type { OperationalAlertRow } from "../db/repositories/operational-alerts";
import {
  BAILEYS_DISCONNECTED_ALERT_TYPE,
  type BaileysDisconnectedAlertPayload,
  type OperationalAlertDefinition,
} from "./types";

function parseBaileysPayload(alert: OperationalAlertRow): BaileysDisconnectedAlertPayload {
  const parsed = JSON.parse(alert.payload) as BaileysDisconnectedAlertPayload;
  if (parsed.version !== 1 || !["disconnected", "logged-out"].includes(parsed.socketState)) {
    throw new Error("Unsupported Baileys disconnect alert payload");
  }
  return parsed;
}

function renderBaileysAlert(alert: OperationalAlertRow, context: { orgName: string; botName: string }) {
  const payload = parseBaileysPayload(alert);
  const status = payload.socketState === "logged-out" ? "logged out" : "disconnected";
  const diagnostic = [
    payload.statusCode === undefined ? null : `status code ${payload.statusCode}`,
    payload.reason ? `reason ${payload.reason}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const diagnosticSuffix = diagnostic ? ` (${diagnostic})` : "";
  const directMessage = alert.resolved_at
    ? `Operational alert for ${context.orgName}: the Baileys WhatsApp connection ${status} at ${payload.occurredAt}${diagnosticSuffix} and recovered at ${alert.resolved_at}. This notification was delayed until after the connection recovered.`
    : `Operational alert for ${context.orgName}: the Baileys WhatsApp connection ${status} at ${payload.occurredAt}${diagnosticSuffix}. WhatsApp messages may be delayed until an admin reconnects it in Settings > Channels.`;
  return {
    directMessage,
    templateSummary: directMessage,
  };
}

export function createOperationalAlertDefinitions(params: {
  isBaileysGatewayDisconnected: () => Promise<boolean> | boolean;
}): Map<string, OperationalAlertDefinition> {
  return new Map([
    [
      BAILEYS_DISCONNECTED_ALERT_TYPE,
      {
        type: BAILEYS_DISCONNECTED_ALERT_TYPE,
        channels: ["whatsapp"],
        isStillActive: params.isBaileysGatewayDisconnected,
        render: renderBaileysAlert,
      },
    ],
  ]);
}

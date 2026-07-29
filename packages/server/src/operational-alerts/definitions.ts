import type { OperationalAlertRow } from "../db/repositories/operational-alerts";
import { buildReconnectNotificationTemplate } from "../whatsapp/templates";
import {
  BAILEYS_DISCONNECTED_ALERT_TYPE,
  type BaileysDisconnectedAlertPayload,
  type OperationalAlertDefinition,
  type OperationalAlertRenderContext,
  type OperationalAlertRenderResult,
} from "./types";

const RECONNECT_LOCATION_FALLBACK = "Settings > Channels in your Sketch dashboard";

function parseBaileysPayload(alert: OperationalAlertRow): BaileysDisconnectedAlertPayload {
  const parsed = JSON.parse(alert.payload) as BaileysDisconnectedAlertPayload;
  if (parsed.version !== 1 || !["disconnected", "logged-out"].includes(parsed.socketState)) {
    throw new Error("Unsupported Baileys disconnect alert payload");
  }
  return parsed;
}

/**
 * Builds the reconnect page URL from the configured public base URL. Returns null
 * when the base URL is missing or malformed so callers can fall back to
 * describing the location in words instead of sending a broken link.
 */
export function channelsReconnectUrl(baseUrl: string | undefined): string | null {
  const configured = baseUrl?.trim().replace(/\/+$/, "");
  if (!configured) return null;
  try {
    const url = new URL("/channels", `${configured}/`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createOperationalAlertDefinitions(params: {
  isBaileysGatewayDisconnected: () => Promise<boolean> | boolean;
  getConnectedWhatsAppNumber?: () => Promise<string | null> | string | null;
  reconnectUrl?: string | null;
}): Map<string, OperationalAlertDefinition> {
  /**
   * The connection lookup can fail while the gateway is down, which is exactly
   * when this alert fires, so failures degrade to the org-name label instead of
   * blocking delivery.
   */
  async function connectionLabel(context: OperationalAlertRenderContext): Promise<string> {
    try {
      const phoneNumber = await params.getConnectedWhatsAppNumber?.();
      return phoneNumber?.trim() || context.orgName;
    } catch {
      return context.orgName;
    }
  }

  /**
   * Copy is aligned with the Meta-approved `whatsapp_reconnect_notification`
   * template and must stay free of technical jargon: no status codes, no
   * Baileys references, no raw timestamps (SKE-309).
   */
  async function renderBaileysAlert(
    alert: OperationalAlertRow,
    context: OperationalAlertRenderContext,
  ): Promise<OperationalAlertRenderResult> {
    parseBaileysPayload(alert);
    const label = await connectionLabel(context);
    if (alert.resolved_at) {
      const directMessage = `Hi ${context.recipientName}, your WhatsApp connection for ${label} was briefly interrupted and is now reconnected. Everything is back to normal and no action is needed.`;
      return { directMessage, templateSummary: directMessage };
    }
    const reconnectLocation = params.reconnectUrl ?? RECONNECT_LOCATION_FALLBACK;
    const directMessage = `Hi ${context.recipientName}, your WhatsApp connection for ${label} needs a quick reconnect. Please rescan the QR code on ${reconnectLocation} to restore the group updates.`;
    return {
      directMessage,
      templateSummary: directMessage,
      template: buildReconnectNotificationTemplate({
        recipientName: context.recipientName,
        phoneNumber: label,
        reconnectUrl: reconnectLocation,
        fallbackText: directMessage,
      }),
    };
  }

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

import type { OperationalAlertRow } from "../db/repositories/operational-alerts";
import type { WhatsAppTemplateRequest } from "../whatsapp/templates";

export const BAILEYS_DISCONNECTED_ALERT_TYPE = "whatsapp.baileys.disconnected";
export const BAILEYS_GATEWAY_RESOURCE_KEY = "whatsapp:baileys:gateway";

export interface BaileysDisconnectedAlertPayload {
  version: 1;
  socketState: "disconnected" | "logged-out";
  occurredAt: string;
  statusCode?: number;
  reason?: string;
  gatewayGeneration?: number;
}

export interface OperationalAlertRenderContext {
  orgName: string;
  botName: string;
  recipientName: string;
}

/**
 * `template` lets a definition pick a purpose-built provider template for
 * out-of-window delivery; transports fall back to the generic proactive-update
 * template when it is absent.
 */
export interface OperationalAlertRenderResult {
  directMessage: string;
  templateSummary: string;
  template?: WhatsAppTemplateRequest;
}

export interface OperationalAlertDefinition {
  type: string;
  channels: readonly ("whatsapp" | "slack")[];
  isStillActive: (alert: OperationalAlertRow) => Promise<boolean> | boolean;
  render: (
    alert: OperationalAlertRow,
    context: OperationalAlertRenderContext,
  ) => OperationalAlertRenderResult | Promise<OperationalAlertRenderResult>;
}

export interface OperationalAlertTransportResult {
  providerMessageId: string | null;
}

export class OperationalAlertRetryableError extends Error {
  readonly retryIndefinitely = true;

  constructor(
    message: string,
    readonly providerCode: string,
  ) {
    super(message);
    this.name = "OperationalAlertRetryableError";
  }
}

export interface OperationalAlertRecipient {
  id: string;
  name: string;
  destination: string;
}

export interface OperationalAlertChannelTransport {
  send(params: {
    alert: OperationalAlertRow;
    recipient: OperationalAlertRecipient;
    directMessage: string;
    templateSummary: string;
    template?: WhatsAppTemplateRequest;
    orgName: string;
    botName: string;
    now: Date;
  }): Promise<OperationalAlertTransportResult>;
}

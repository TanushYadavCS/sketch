import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { Logger } from "../logger";
import type { WhatsAppSendResult, WhatsAppTarget } from "./provider";
import type { WhatsAppRuntime } from "./runtime";
import { buildTaskNudgeTemplate } from "./templates";

export const WORKFLOW_OUTPUT_INBOX_KIND = "workflow_output";

const CUSTOMER_SERVICE_WINDOW_MS = 23 * 60 * 60 * 1000;
const FALLBACK_PROVIDER_CODES = new Set(["contact_not_found", "window_expired"]);

export type ProactiveDeliveryMode = "text" | "nudge" | "parked";

export interface ProactiveDeliveryResult {
  mode: ProactiveDeliveryMode;
  sent: WhatsAppSendResult | null;
  inboxMessageId?: string | undefined;
}

export interface DeliverProactiveDmParams {
  target: WhatsAppTarget;
  recipientUserId: string;
  senderUserId: string;
  text: string;
  whatsapp: Pick<WhatsAppRuntime, "getCapabilities" | "sendText" | "sendTemplate">;
  conversations: Pick<ReturnType<typeof createConversationRepository>, "findLatestInboundWhatsAppDmFromRecipient">;
  inboxMessages: Pick<ReturnType<typeof createInboxMessagesRepository>, "create" | "hasPendingForRecipientByKind">;
  logger: Pick<Logger, "debug">;
  recipientName?: string | null | undefined;
  recipientPhoneE164?: string | null | undefined;
  inboxKind?: string | undefined;
  inboxMetadata?: Record<string, unknown> | null | undefined;
  now?: Date | undefined;
}

export async function deliverProactiveDm(params: DeliverProactiveDmParams): Promise<ProactiveDeliveryResult> {
  if (params.target.kind === "group") {
    const sent = await params.whatsapp.sendText(params.target, params.text);
    return { mode: "text", sent };
  }

  if (!params.whatsapp.getCapabilities(params.target).templates) {
    const sent = await params.whatsapp.sendText(params.target, params.text);
    return { mode: "text", sent };
  }

  const lastInbound = await params.conversations.findLatestInboundWhatsAppDmFromRecipient({
    recipientUserId: params.recipientUserId,
    phoneE164: params.recipientPhoneE164 ?? params.target.phoneE164,
  });

  if (lastInbound && isInsideCustomerServiceWindow(lastInbound, params.now ?? new Date())) {
    try {
      const sent = await params.whatsapp.sendText(params.target, params.text);
      return { mode: "text", sent };
    } catch (err) {
      if (!shouldParkAfterTextError(err)) throw err;
      return parkThenNudge(params);
    }
  }

  return parkThenNudge(params);
}

async function parkThenNudge(params: DeliverProactiveDmParams): Promise<ProactiveDeliveryResult> {
  const kind = params.inboxKind ?? WORKFLOW_OUTPUT_INBOX_KIND;
  const hadPendingWorkflowOutput = await params.inboxMessages.hasPendingForRecipientByKind(
    params.recipientUserId,
    kind,
  );
  const inboxMessage = await params.inboxMessages.create({
    senderUserId: params.senderUserId,
    recipientUserId: params.recipientUserId,
    message: params.text,
    kind,
    metadata: params.inboxMetadata ?? null,
    resolutionMode: "auto_consume",
    platform: "whatsapp",
    channelId: params.target.kind === "dm" ? params.target.phoneE164 : params.target.groupId,
  });

  if (hadPendingWorkflowOutput) {
    params.logger.debug(
      {
        recipientUserId: params.recipientUserId,
        inboxMessageId: inboxMessage.id,
        inboxKind: kind,
        nudgeSent: false,
      },
      "WhatsApp proactive delivery parked without duplicate nudge",
    );
    return { mode: "parked", sent: null, inboxMessageId: inboxMessage.id };
  }

  const sent = await params.whatsapp.sendTemplate(
    params.target,
    buildTaskNudgeTemplate({ recipientName: params.recipientName }),
  );
  return { mode: "nudge", sent, inboxMessageId: inboxMessage.id };
}

function isInsideCustomerServiceWindow(
  message: Awaited<
    ReturnType<ReturnType<typeof createConversationRepository>["findLatestInboundWhatsAppDmFromRecipient"]>
  >,
  now: Date,
): boolean {
  if (!message) return false;
  const timestamp = parseTimestamp(message.receivedAt) ?? parseTimestamp(message.providerTimestamp);
  if (!timestamp) return false;
  return now.getTime() - timestamp.getTime() <= CUSTOMER_SERVICE_WINDOW_MS;
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function shouldParkAfterTextError(error: unknown): boolean {
  const code = providerCodeFromError(error);
  return Boolean(code && FALLBACK_PROVIDER_CODES.has(code));
}

function providerCodeFromError(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("providerCode" in error)) return null;
  const code = (error as { providerCode?: unknown }).providerCode;
  return typeof code === "string" ? code : null;
}

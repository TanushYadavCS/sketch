import type { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { Logger } from "../logger";
import { WHATSAPP_TEXT_LIMIT, chunkText } from "./chunking";
import type { WhatsAppSendResult, WhatsAppTarget } from "./provider";
import type { WhatsAppRuntime } from "./runtime";
import { buildTaskNudgeTemplate } from "./templates";

export const WORKFLOW_OUTPUT_INBOX_KIND = "workflow_output";

const CUSTOMER_SERVICE_WINDOW_MS = 23 * 60 * 60 * 1000;
const FALLBACK_PROVIDER_CODES = new Set(["contact_not_found", "window_expired"]);

export type ProactiveDeliveryMode = "text" | "nudge" | "parked";

export interface ProactiveDeliveryTextSend {
  text: string;
  sent: WhatsAppSendResult | null;
}

export class ProactiveDeliveryTextSendError extends Error {
  readonly cause: unknown;
  readonly textSends: ProactiveDeliveryTextSend[];

  constructor(cause: unknown, textSends: ProactiveDeliveryTextSend[]) {
    super(cause instanceof Error ? cause.message : "WhatsApp text send failed");
    this.name = "ProactiveDeliveryTextSendError";
    this.cause = cause;
    this.textSends = textSends;
  }
}

export interface ProactiveDeliveryResult {
  mode: ProactiveDeliveryMode;
  sent: WhatsAppSendResult | null;
  textSends: ProactiveDeliveryTextSend[];
  inboxMessageId?: string | undefined;
}

export interface DeliverProactiveDmParams {
  target: WhatsAppTarget;
  recipientUserId: string;
  senderUserId: string;
  text: string;
  whatsapp: Pick<WhatsAppRuntime, "getCapabilities" | "sendText" | "sendTemplate">;
  conversations: Pick<ReturnType<typeof createConversationRepository>, "findLatestInboundWhatsAppDmFromRecipient">;
  inboxMessages: Pick<ReturnType<typeof createInboxMessagesRepository>, "create" | "listPendingForRecipientByKind">;
  logger: Pick<Logger, "debug">;
  recipientName?: string | null | undefined;
  recipientPhoneE164?: string | null | undefined;
  inboxKind?: string | undefined;
  inboxMetadata?: Record<string, unknown> | null | undefined;
  now?: Date | undefined;
}

export async function deliverProactiveDm(params: DeliverProactiveDmParams): Promise<ProactiveDeliveryResult> {
  if (params.target.kind === "group") {
    const textSends = await sendTextChunks(params);
    return { mode: "text", sent: lastSent(textSends), textSends };
  }

  if (!params.whatsapp.getCapabilities(params.target).templates) {
    const textSends = await sendTextChunks(params);
    return { mode: "text", sent: lastSent(textSends), textSends };
  }

  const lastInbound = await params.conversations.findLatestInboundWhatsAppDmFromRecipient({
    recipientUserId: params.recipientUserId,
    phoneE164: params.recipientPhoneE164 ?? params.target.phoneE164,
  });

  if (lastInbound && isInsideCustomerServiceWindow(lastInbound, params.now ?? new Date())) {
    try {
      const textSends = await sendTextChunks(params);
      return { mode: "text", sent: lastSent(textSends), textSends };
    } catch (err) {
      if (!shouldParkAfterTextError(err)) throw err;
      return parkThenNudge(params);
    }
  }

  return parkThenNudge(params);
}

async function parkThenNudge(params: DeliverProactiveDmParams): Promise<ProactiveDeliveryResult> {
  const kind = params.inboxKind ?? WORKFLOW_OUTPUT_INBOX_KIND;
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

  if (!(await shouldSendNudgeForInboxMessage(params, kind, inboxMessage.id))) {
    params.logger.debug(
      {
        recipientUserId: params.recipientUserId,
        inboxMessageId: inboxMessage.id,
        inboxKind: kind,
        nudgeSent: false,
      },
      "WhatsApp proactive delivery parked without duplicate nudge",
    );
    return { mode: "parked", sent: null, textSends: [], inboxMessageId: inboxMessage.id };
  }

  const sent = await params.whatsapp.sendTemplate(
    params.target,
    buildTaskNudgeTemplate({ recipientName: params.recipientName }),
  );
  return { mode: "nudge", sent, textSends: [], inboxMessageId: inboxMessage.id };
}

/**
 * The nudge winner is the earliest unconsumed and unresolved row ordered by
 * created_at, then id. Each delivery inserts its durable inbox row before this
 * read, so concurrent contenders that can see the same pending set choose the
 * same winner without dialect-specific locks or unique constraints.
 */
async function shouldSendNudgeForInboxMessage(
  params: DeliverProactiveDmParams,
  kind: string,
  inboxMessageId: string,
): Promise<boolean> {
  const pending = await params.inboxMessages.listPendingForRecipientByKind(params.recipientUserId, kind);
  return pending[0]?.id === inboxMessageId;
}

async function sendTextChunks(
  params: Pick<DeliverProactiveDmParams, "target" | "text" | "whatsapp">,
): Promise<ProactiveDeliveryTextSend[]> {
  const textSends: ProactiveDeliveryTextSend[] = [];
  for (const chunk of chunkText(params.text, WHATSAPP_TEXT_LIMIT)) {
    try {
      const sent = await params.whatsapp.sendText(params.target, chunk);
      textSends.push({ text: chunk, sent });
    } catch (cause) {
      throw new ProactiveDeliveryTextSendError(cause, textSends);
    }
  }
  return textSends;
}

function lastSent(textSends: ProactiveDeliveryTextSend[]): WhatsAppSendResult | null {
  for (let index = textSends.length - 1; index >= 0; index--) {
    const sent = textSends[index]?.sent;
    if (sent) return sent;
  }
  return null;
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
  if (error instanceof ProactiveDeliveryTextSendError) return providerCodeFromError(error.cause);
  if (!error || typeof error !== "object" || !("providerCode" in error)) return null;
  const code = (error as { providerCode?: unknown }).providerCode;
  return typeof code === "string" ? code : null;
}

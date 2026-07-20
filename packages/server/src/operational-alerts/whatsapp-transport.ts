import type { createConversationRepository } from "../db/repositories/conversations";
import { isInsideWhatsAppCustomerServiceWindow } from "../whatsapp/proactive-delivery";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { buildProactiveUpdateTemplate } from "../whatsapp/templates";
import { type OperationalAlertChannelTransport, OperationalAlertRetryableError } from "./types";

const TEMPLATE_FALLBACK_PROVIDER_CODES = new Set(["contact_not_found", "window_expired"]);

function providerCodeFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("cause" in error) {
    const causeCode = providerCodeFromError((error as { cause?: unknown }).cause);
    if (causeCode) return causeCode;
  }
  if (!("providerCode" in error)) return null;
  const code = (error as { providerCode?: unknown }).providerCode;
  return typeof code === "string" ? code : null;
}

function requireSent(result: Awaited<ReturnType<WhatsAppRuntime["sendText"]>>) {
  if (!result) {
    throw new OperationalAlertRetryableError(
      "WhatsApp provider accepted the request without sending a message",
      "transport_unavailable",
    );
  }
  return result;
}

export function createWhatsAppOperationalAlertTransport(params: {
  whatsapp: Pick<WhatsAppRuntime, "getCapabilities" | "sendText" | "sendTemplate">;
  conversations: Pick<ReturnType<typeof createConversationRepository>, "findLatestInboundWhatsAppDmFromRecipient">;
}): OperationalAlertChannelTransport {
  return {
    async send(input) {
      const target = { kind: "dm" as const, phoneE164: input.recipient.destination };
      const capabilities = params.whatsapp.getCapabilities(target);
      const lastInbound = await params.conversations.findLatestInboundWhatsAppDmFromRecipient({
        recipientUserId: input.recipient.id,
        phoneE164: input.recipient.destination,
      });
      const canSendDirect = isInsideWhatsAppCustomerServiceWindow(lastInbound, input.now);

      if (canSendDirect) {
        try {
          const sent = requireSent(await params.whatsapp.sendText(target, input.directMessage));
          return { providerMessageId: sent.providerMessageId };
        } catch (error) {
          const code = providerCodeFromError(error);
          if (!capabilities.templates || !code || !TEMPLATE_FALLBACK_PROVIDER_CODES.has(code)) throw error;
        }
      }

      if (!capabilities.templates) {
        throw new Error("WhatsApp templates are unavailable outside the customer service window");
      }
      const sent = requireSent(
        await params.whatsapp.sendTemplate(
          target,
          buildProactiveUpdateTemplate({
            recipientName: input.recipient.name,
            botName: input.botName,
            messageSummary: input.templateSummary,
            fallbackText: input.directMessage,
          }),
        ),
      );
      return { providerMessageId: sent.providerMessageId };
    },
  };
}

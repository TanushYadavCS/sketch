/**
 * Final message delivery helper for WhatsApp.
 *
 * In groups, the first message quotes the original mention message.
 */
import type { WhatsAppInboundMessage, WhatsAppSendResult, WhatsAppTarget } from "./provider";
import type { WhatsAppRuntime } from "./runtime";

export function createWhatsAppMessageHandler(
  whatsapp: WhatsAppRuntime,
  target: WhatsAppTarget,
  quotedMessage?: WhatsAppInboundMessage,
): (text: string) => Promise<WhatsAppSendResult | null> {
  let isFirstMessage = true;
  return async (text: string) => {
    if (!whatsapp.isConnected) return null;
    let sent: WhatsAppSendResult | null;
    if (isFirstMessage && quotedMessage) {
      sent = await whatsapp.sendText(target, text, { quotedMessage });
      isFirstMessage = false;
    } else {
      sent = await whatsapp.sendText(target, text);
      isFirstMessage = false;
    }
    return sent;
  };
}

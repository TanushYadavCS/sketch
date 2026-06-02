/**
 * Final message delivery helper for WhatsApp.
 *
 * In groups, the first message quotes the original mention message.
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import type { WhatsAppBot } from "./bot";

export function createWhatsAppMessageHandler(
  whatsapp: WhatsAppBot,
  jid: string,
  quotedMessage?: WAMessage,
): (text: string) => Promise<WAMessage | null> {
  let isFirstMessage = true;
  return async (text: string) => {
    if (!whatsapp.isConnected) return null;
    let sent: WAMessage | null;
    if (isFirstMessage && quotedMessage) {
      sent = await whatsapp.sendText(jid, text, { quoted: quotedMessage });
      isFirstMessage = false;
    } else {
      sent = await whatsapp.sendText(jid, text);
      isFirstMessage = false;
    }
    return sent;
  };
}

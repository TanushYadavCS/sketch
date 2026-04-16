import type { WAMessage } from "@whiskeysockets/baileys";
import {
  type ProgressTransport,
  type ProgressTransportStrategy,
  createProgressTransport,
} from "../agent/progress-transport";
import { WHATSAPP_TEXT_LIMIT } from "./chunking";

interface WhatsAppProgressBot {
  isConnected: boolean;
  sendText: (
    jid: string,
    text: string,
    options?: { quoted?: WAMessage },
  ) => Promise<{ key?: WAMessage["key"] } | WAMessage | null>;
  editText: (jid: string, targetKey: WAMessage["key"], text: string) => Promise<unknown>;
}

const PROGRESS_THROTTLE_MS = 1_500;

export function createWhatsAppProgressTransport(
  whatsapp: WhatsAppProgressBot,
  jid: string,
  strategy: ProgressTransportStrategy,
  quotedMessage?: WAMessage,
): ProgressTransport {
  let shouldQuoteNextMessage = Boolean(quotedMessage);

  return createProgressTransport({
    charLimit: WHATSAPP_TEXT_LIMIT,
    throttleMs: PROGRESS_THROTTLE_MS,
    strategy,
    postText: async (text) => {
      if (!whatsapp.isConnected) return null;
      const sent = await whatsapp.sendText(
        jid,
        text,
        shouldQuoteNextMessage && quotedMessage ? { quoted: quotedMessage } : undefined,
      );
      shouldQuoteNextMessage = false;
      return sent?.key ?? null;
    },
    editText: async (ref, text) => {
      if (!whatsapp.isConnected) return;
      await whatsapp.editText(jid, ref, text);
    },
  });
}

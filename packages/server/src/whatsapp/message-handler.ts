/**
 * Factory for the onMessage callback passed to runAgent().
 * Sends each text chunk via WhatsApp, skipping if disconnected.
 * In groups, the first message quotes the original mention message.
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import type { WhatsAppBot } from "./bot";

const PROGRESS_THROTTLE_MS = 1_500;

export function createWhatsAppMessageHandler(
  whatsapp: WhatsAppBot,
  jid: string,
  quotedMessage?: WAMessage,
): (text: string) => Promise<void> {
  let isFirstMessage = true;
  return async (text: string) => {
    if (!whatsapp.isConnected) return;
    if (isFirstMessage && quotedMessage) {
      await whatsapp.sendText(jid, text, { quoted: quotedMessage });
      isFirstMessage = false;
    } else {
      await whatsapp.sendText(jid, text);
      isFirstMessage = false;
    }
  };
}

export function createWhatsAppToolProgressHandler(
  whatsapp: WhatsAppBot,
  jid: string,
  quotedMessage?: WAMessage,
): (lines: string[]) => Promise<void> {
  let progressKey: WAMessage["key"] | null = null;
  let didSendInitialMessage = false;
  let lastEditAt = 0;
  let pendingLines: string[] | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const doEdit = async (lines: string[]) => {
    const text = lines.join("\n");

    if (!progressKey) {
      const sent = await whatsapp.sendText(
        jid,
        text,
        !didSendInitialMessage && quotedMessage ? { quoted: quotedMessage } : undefined,
      );
      progressKey = sent?.key ?? null;
      didSendInitialMessage = sent !== null;
    } else {
      await whatsapp.editText(jid, progressKey, text);
    }

    lastEditAt = Date.now();
    pendingLines = null;
  };

  return async (lines: string[]) => {
    const now = Date.now();
    const elapsed = now - lastEditAt;

    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      await doEdit(lines);
    } else {
      pendingLines = lines;
      if (!pendingTimer) {
        pendingTimer = setTimeout(async () => {
          pendingTimer = null;
          if (pendingLines) {
            try {
              await doEdit(pendingLines);
            } catch {}
          }
        }, PROGRESS_THROTTLE_MS - elapsed);
      }
    }
  };
}

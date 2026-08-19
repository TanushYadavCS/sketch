import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";
import { whatsappJidToPhoneE164 } from "../whatsapp/provider";

export function phoneFromParticipantJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  return normalizeWhatsAppIdentityPhone(whatsappJidToPhoneE164(jid));
}

export function lidFromParticipantRow(row: { participant_jid: string; lid: string | null }): string | null {
  return normalizeWhatsAppIdentityLid(row.lid ?? (row.participant_jid.endsWith("@lid") ? row.participant_jid : null));
}

import { normalizeContactPointValue } from "../db/repositories/entities";
import type { WhatsAppGroupParticipantInput } from "../db/repositories/whatsapp-groups";
import { type WhatsAppGroupParticipantMetadata, isWhatsAppDmPhoneE164, whatsappJidToPhoneE164 } from "./provider";

export interface CollectedWhatsAppGroupParticipants {
  participants: WhatsAppGroupParticipantMetadata[];
  skippedCount: number;
}

type LidResolver = (lidJid: string) => Promise<string | null>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeAdmin(value: unknown): WhatsAppGroupParticipantMetadata["admin"] {
  return value === "admin" || value === "superadmin" ? value : null;
}

function participantJid(value: unknown): string | null {
  const row = asRecord(value);
  if (!row) return null;
  return asString(row.id) ?? asString(row.jid);
}

function participantLid(row: Record<string, unknown>, jid: string): string | null {
  return asString(row.lid) ?? (jid.endsWith("@lid") ? jid : null);
}

/**
 * In lid-addressed groups — now WhatsApp's default — the participant phone
 * arrives as a PN JID (`919969577769@s.whatsapp.net`), not bare E.164. Prefixing
 * that with `+` produces a value `normalizeContactPointValue` rejects, so the
 * number WhatsApp handed us was discarded and resolution fell through to the
 * cache-dependent LID lookup. Strip the server and device suffix first.
 *
 * A `@lid` value is an opaque identifier that happens to be numeric: stripping
 * its suffix yields something that passes an E.164 shape check while being a
 * phone number nobody owns. Reject it outright rather than mint a fake.
 */
function explicitPhoneNumber(value: unknown): string | null {
  const phoneNumber = asString(value);
  if (!phoneNumber || /@lid$/i.test(phoneNumber)) return null;
  const bare = phoneNumber
    .replace(/@s\.whatsapp\.net$/i, "")
    .split(":")[0]
    .trim();
  if (!bare) return null;
  const candidate = bare.startsWith("+") || bare.startsWith("00") ? bare : `+${bare}`;
  try {
    const normalized = normalizeContactPointValue("whatsapp", candidate);
    return isWhatsAppDmPhoneE164(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function phoneFromSWhitelistedJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const phone = whatsappJidToPhoneE164(jid);
  return isWhatsAppDmPhoneE164(phone) ? phone : null;
}

async function phoneForParticipant(
  row: Record<string, unknown>,
  jid: string,
  resolveLidToPhone: LidResolver,
): Promise<string | null | undefined> {
  const phoneNumber = explicitPhoneNumber(row.phoneNumber);
  if (phoneNumber) return phoneNumber;
  if (jid.endsWith("@s.whatsapp.net")) return phoneFromSWhitelistedJid(jid);
  if (!jid.endsWith("@lid")) return undefined;

  try {
    const phone = await resolveLidToPhone(jid);
    return isWhatsAppDmPhoneE164(phone) ? phone : null;
  } catch {
    return null;
  }
}

export async function collectWhatsAppGroupParticipants(
  metadata: { participants?: unknown },
  resolveLidToPhone: LidResolver,
): Promise<CollectedWhatsAppGroupParticipants> {
  const rawParticipants = Array.isArray(metadata.participants) ? metadata.participants : [];
  const participants: WhatsAppGroupParticipantMetadata[] = [];
  let skippedCount = 0;

  for (const rawParticipant of rawParticipants) {
    const row = asRecord(rawParticipant);
    const jid = participantJid(rawParticipant);
    if (!row || !jid) {
      skippedCount += 1;
      continue;
    }

    const phoneE164 = await phoneForParticipant(row, jid, resolveLidToPhone);
    if (phoneE164 === undefined) {
      skippedCount += 1;
      continue;
    }

    participants.push({
      jid,
      phoneE164,
      lid: participantLid(row, jid),
      admin: normalizeAdmin(row.admin),
    });
  }

  return { participants, skippedCount };
}

export function toParticipantInputs(participants: WhatsAppGroupParticipantMetadata[]): WhatsAppGroupParticipantInput[] {
  return participants.map((participant) => ({
    participantJid: participant.jid,
    phoneE164: participant.phoneE164,
    lid: participant.lid,
    adminRole: participant.admin,
  }));
}

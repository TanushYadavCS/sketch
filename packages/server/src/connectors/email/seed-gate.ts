import { isRoleAccountEmail } from "../../entities/affiliations";
import type { EmailAddr, NormalizedEmail } from "./normalized-email";
import { normalizeEmailValue, visibleParticipants } from "./normalized-email";

export interface EmailSeedGate {
  seedableEmails: ReadonlySet<string>;
}

export function updateReciprocitySet(sentMessages: NormalizedEmail[], ownerEmail?: string | null): Set<string> {
  const owner = normalizeEmailValue(ownerEmail);
  const result = new Set<string>();
  for (const message of sentMessages) {
    if (message.folder !== "sent") continue;
    for (const participant of [...message.to, ...message.cc]) {
      const email = normalizeEmailValue(participant.email);
      if (!email || email === owner || isRoleAccountEmail(email)) continue;
      result.add(email);
    }
  }
  return result;
}

export function createSeedGate(email: NormalizedEmail, reciprocitySet: ReadonlySet<string>): EmailSeedGate {
  const seedableEmails = new Set<string>();
  for (const participant of visibleParticipants(email)) {
    const normalized = normalizeEmailValue(participant.email);
    if (!normalized || isRoleAccountEmail(normalized)) continue;
    if (reciprocitySet.has(normalized)) seedableEmails.add(normalized);
  }
  return { seedableEmails };
}

export function applySeedGate(participant: EmailAddr, gate: EmailSeedGate): boolean {
  const email = normalizeEmailValue(participant.email);
  return Boolean(email && gate.seedableEmails.has(email) && !isRoleAccountEmail(email));
}

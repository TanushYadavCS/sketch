import { createHash } from "node:crypto";
import type { SyncedItem } from "../types";
import { cleanEmailBody } from "./body-text";
import {
  type NormalizedEmail,
  type NormalizedEmailEnvelope,
  emailEnvelope,
  normalizeEmailAddrs,
  normalizeEmailValue,
  visibleParticipantEmails,
} from "./normalized-email";
import type { EmailSeedGate } from "./seed-gate";
import { applySeedGate } from "./seed-gate";

export interface EmailSyncedItem extends SyncedItem {
  emailEnvelope: NormalizedEmailEnvelope;
}

export function isEmailSyncedItem(item: SyncedItem): item is EmailSyncedItem {
  return "emailEnvelope" in item;
}

export function emailToSyncedItem(
  connectorConfigId: string,
  email: NormalizedEmail,
  gate: EmailSeedGate,
): EmailSyncedItem {
  const body = cleanEmailBody({ bodyText: email.bodyText, bodyHtml: email.bodyHtml });
  const subject = email.subject?.trim() || "(no subject)";
  const content = [subject, body].filter(Boolean).join("\n\n");
  const visibleEmails = visibleParticipantEmails(email);
  const owner = normalizeEmailValue(email.ownerEmail);
  const accessEmails = Array.from(new Set([...visibleEmails, ...(owner ? [owner] : [])]));
  const seedableRecipients = normalizeEmailAddrs([...email.to, ...email.cc]).filter((participant) =>
    applySeedGate(participant, gate),
  );
  const seedableFrom = applySeedGate(email.from, gate) ? email.from : null;
  const envelope = emailEnvelope(connectorConfigId, email);

  return {
    providerFileId: email.providerFileId,
    providerMessageId: email.providerMessageId,
    threadId: email.threadId ?? undefined,
    providerUrl: email.providerUrl,
    fileName: subject,
    fileType: "email_message",
    contentCategory: "document",
    content,
    sourcePath: email.folder,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: email.sentAt,
    sourceUpdatedAt: email.sentAt,
    accessEmails,
    attendees: seedableRecipients.length > 0 ? seedableRecipients : undefined,
    authorEmail: seedableFrom?.email,
    authorName: seedableFrom?.name,
    emailEnvelope: envelope,
  };
}

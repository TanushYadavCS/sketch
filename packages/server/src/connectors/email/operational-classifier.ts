import { isRoleAccountEmail } from "../../entities/affiliations";
import type { NormalizedEmail } from "./normalized-email";
import { getHeader, normalizeEmailValue, visibleParticipantEmails } from "./normalized-email";

export interface OperationalClassification {
  isOperational: boolean;
  reason?: string;
}

const SUBJECT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(otp|one[-\s]?time password|verification code|security code|2fa|mfa)\b/i, "security_code"],
  [/\b(password reset|reset your password|sign[-\s]?in alert|new login)\b/i, "account_security"],
  [/\b(receipt|invoice|payment (received|failed|due)|billing statement|tax invoice)\b/i, "billing"],
  [/\b(order confirmation|shipping|delivery|your order|tracking number)\b/i, "commerce"],
  [/\b(calendar|invitation|accepted:|declined:|tentative:|reminder)\b/i, "calendar_notification"],
  [/\b(ticket|case|status update|incident|alert|monitor|build failed|deployment)\b/i, "status_notification"],
];

const OPERATIONAL_LOCALS = new Set([
  "billing",
  "invoices",
  "invoice",
  "receipts",
  "receipt",
  "security",
  "alerts",
  "notifications",
  "noreply",
  "no-reply",
]);

export function classifyOperational(email: NormalizedEmail): OperationalClassification {
  const subject = email.subject ?? "";
  for (const [pattern, reason] of SUBJECT_PATTERNS) {
    if (pattern.test(subject)) return { isOperational: true, reason };
  }
  const from = normalizeEmailValue(email.from.email);
  const local = from?.split("@")[0] ?? "";
  if (OPERATIONAL_LOCALS.has(local) || isRoleAccountEmail(email.from.email)) {
    return { isOperational: true, reason: "role_or_automation_sender" };
  }
  const autoSubmitted = getHeader(email.headers, "auto-submitted")?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { isOperational: true, reason: "auto_submitted" };
  }
  const participants = visibleParticipantEmails(email).filter(
    (participant) => participant !== normalizeEmailValue(email.ownerEmail),
  );
  if (participants.length > 0 && participants.every(isRoleAccountEmail)) {
    return { isOperational: true, reason: "role_account_participants" };
  }
  return { isOperational: false };
}

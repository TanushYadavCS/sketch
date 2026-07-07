const WHATSAPP_JID_TOKEN_PATTERN = /[^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b/giu;
const PHONE_LIKE_IDENTIFIER_PATTERN = /(?:\+|00)?(?=(?:[\d\s().-]*\d){7})[1-9][\d\s().-]*\d/gu;

function maskDigitsKeepingLastTwo(match: string): string {
  const digits = match.replace(/\D/gu, "");
  const prefix = match.trimStart().startsWith("+") ? "+" : "";
  return `${prefix}${"*".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}

/**
 * Masks personal numbers while keeping the last two digits and any JID suffix,
 * so operational logs stay correlatable without exposing a full number.
 */
export function maskPersonalNumberIdentifier(value: string): string {
  return value
    .replace(WHATSAPP_JID_TOKEN_PATTERN, (token) => {
      const at = token.lastIndexOf("@");
      return `${maskDigitsKeepingLastTwo(token.slice(0, at))}${token.slice(at)}`;
    })
    .replace(PHONE_LIKE_IDENTIFIER_PATTERN, maskDigitsKeepingLastTwo);
}

/**
 * Fully redacts identifiers for user-facing or persisted display text (roster
 * snapshots, rendered names), where even a masked number is unnecessary.
 */
export function sanitizeWhatsAppDisplayText(value: string): string {
  return value
    .replace(WHATSAPP_JID_TOKEN_PATTERN, "[whatsapp-id]")
    .replace(PHONE_LIKE_IDENTIFIER_PATTERN, maskDigitsKeepingLastTwo)
    .replace(/\s{2,}/gu, " ")
    .trim();
}

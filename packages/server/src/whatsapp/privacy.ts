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
 * Sanitizes identifiers for persisted display text by replacing JIDs and
 * masking phone-like tokens.
 */
export function sanitizeWhatsAppDisplayText(value: string): string {
  return value
    .replace(WHATSAPP_JID_TOKEN_PATTERN, "[whatsapp-id]")
    .replace(PHONE_LIKE_IDENTIFIER_PATTERN, maskDigitsKeepingLastTwo)
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/**
 * Strips personal numbers for user-facing rendered surfaces where no digits are
 * allowed. This is distinct from log masking: masking preserves partial digits
 * for operational correlation, while stripping removes the identifier entirely.
 */
export function stripPersonalNumberTokens(value: string): string {
  return value
    .replace(WHATSAPP_JID_TOKEN_PATTERN, "")
    .replace(PHONE_LIKE_IDENTIFIER_PATTERN, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s+([,.)\]])/gu, "$1")
    .replace(/([(])\s+/gu, "$1")
    .trim();
}

function safeErrorToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/iu.test(value)) return undefined;
  return value;
}

export function safeWhatsAppErrorFields(error: unknown): { errorClass: string; errorCode?: string } {
  const errorClass = safeErrorToken(error instanceof Error ? error.name : undefined) ?? "UnknownError";
  if (!error || typeof error !== "object" || !("code" in error)) return { errorClass };
  const errorCode = safeErrorToken((error as { code?: unknown }).code);
  return errorCode ? { errorClass, errorCode } : { errorClass };
}

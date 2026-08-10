export function normalizePhoneLike(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(withPlus)) {
    throw new Error("Phone contact points must be E.164, for example +14155551234");
  }
  return withPlus;
}

export function normalizeWhatsAppIdentityPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizePhoneLike(value);
  } catch {
    return null;
  }
}

export function normalizeWhatsAppIdentityLid(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  const withoutSuffix = trimmed.endsWith("@lid") ? trimmed.slice(0, -4) : trimmed;
  const deviceSeparator = withoutSuffix.indexOf(":");
  const bare = deviceSeparator === -1 ? withoutSuffix : withoutSuffix.slice(0, deviceSeparator);
  return bare.length > 0 ? `${bare}@lid` : null;
}

export function normalizeSlackIdentityUserId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

/**
 * The value to persist in `users.whatsapp_number`.
 *
 * Normalises to E.164 so one number has one spelling in the database. A value
 * that cannot be normalised is kept as given: refusing it here would turn a
 * previously accepted save into an error, and dropping it would lose the only
 * contact detail we hold for that person.
 */
export function storedWhatsAppNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return normalizeWhatsAppIdentityPhone(trimmed) ?? trimmed;
}

/**
 * The values a `users.whatsapp_number` lookup must consider.
 *
 * Migration 167 normalises existing rows, but a number it could not parse stays
 * in its original spelling, so a lookup still has to try both forms.
 */
export function whatsappNumberLookupValues(value: string): string[] {
  const trimmed = value.trim();
  const normalized = normalizeWhatsAppIdentityPhone(trimmed);
  return normalized === null || normalized === trimmed ? [trimmed] : [normalized, trimmed];
}

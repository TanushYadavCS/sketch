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

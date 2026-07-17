export const WHATSAPP_PROVIDER_TIMESTAMP_FLOOR_MS = Date.parse("2009-01-01T00:00:00.000Z");
export const WHATSAPP_PROVIDER_TIMESTAMP_MAX_FUTURE_MS = 48 * 60 * 60 * 1000;

export function validWhatsAppProviderTimestamp(
  providerTimestamp: string | null | undefined,
  now = new Date(),
): string | null {
  if (!providerTimestamp) return null;
  const timestampMs = Date.parse(providerTimestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= WHATSAPP_PROVIDER_TIMESTAMP_FLOOR_MS) return null;
  if (timestampMs >= now.getTime() + WHATSAPP_PROVIDER_TIMESTAMP_MAX_FUTURE_MS) return null;
  return new Date(timestampMs).toISOString();
}

export function normalizeWhatsAppReceivedAt(receivedAt: string): string {
  const receivedAtMs = Date.parse(receivedAt);
  return Number.isFinite(receivedAtMs) ? new Date(receivedAtMs).toISOString() : receivedAt;
}

export function effectiveWhatsAppMessageTimestamp(
  providerTimestamp: string | null | undefined,
  receivedAt: string,
  now = new Date(),
): string {
  return validWhatsAppProviderTimestamp(providerTimestamp, now) ?? normalizeWhatsAppReceivedAt(receivedAt);
}

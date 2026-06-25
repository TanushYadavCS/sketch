const NAIVE_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const naive = NAIVE_TIMESTAMP_PATTERN.exec(trimmed);
  const parsed = Date.parse(naive ? `${naive[1]}T${naive[2]}${naive[3] ?? ""}Z` : trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function normalizeSourceTimestampForStorage(value: string | null | undefined): string | null {
  const parsed = parseTimestampMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

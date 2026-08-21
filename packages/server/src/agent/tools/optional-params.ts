/**
 * Models fill optional parameters with placeholder values rather than omitting them, so a
 * blank string means "not supplied" and must never reach validation as content. Schemas for
 * model-facing tools therefore accept any string and normalize here, instead of rejecting
 * blanks with `.min(1)` before the handler ever runs.
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Applies {@link blankToUndefined} to every string-valued key of a tool argument object. */
export function withoutBlankStrings<T extends Record<string, unknown>>(args: T): T {
  const normalized: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string") normalized[key] = blankToUndefined(value);
  }
  return normalized as T;
}

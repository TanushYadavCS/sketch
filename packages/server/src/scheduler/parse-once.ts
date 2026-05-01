/**
 * Parse a "once" schedule_value into an absolute Date, interpreting naive ISO
 * local strings in the supplied IANA timezone rather than the process timezone.
 *
 * `new Date("2026-05-02T17:00:00")` interprets a tz-less string in the host's
 * local tz (UTC on our EC2). If the agent emits a wall-clock for an IST user,
 * that's a 5.5-hour error. This helper resolves the wall-clock against the
 * user's tz instead.
 *
 * Strings that already carry a Z or numeric offset are absolute and pass
 * through to `new Date()` unchanged.
 */

const NAIVE_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const ABSOLUTE_SUFFIX = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function getTzOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // hour can come back as "24" for the 00:00 boundary in some locales; clamp.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return (asUtc - instant.getTime()) / 60000;
}

export function parseOnceSchedule(value: string, timeZone: string): Date {
  const trimmed = value.trim();
  if (ABSOLUTE_SUFFIX.test(trimmed)) {
    return new Date(trimmed);
  }
  const match = NAIVE_ISO.exec(trimmed);
  if (!match) {
    return new Date(trimmed);
  }
  const [, y, mo, d, h, mi, s = "0", ms = "0"] = match;
  const msPadded = ms.length === 0 ? 0 : Number(ms.padEnd(3, "0").slice(0, 3));
  // Compute the offset using a whole-second instant so milliseconds aren't
  // double-counted: `getTzOffsetMinutes` reads the formatter's integer-second
  // parts and subtracts; if the source instant had ms, the difference would
  // include `-ms`, and applying it would re-add ms a second time.
  const utcGuessNoMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offsetMinutes = getTzOffsetMinutes(new Date(utcGuessNoMs), timeZone);
  return new Date(utcGuessNoMs - offsetMinutes * 60_000 + msPadded);
}

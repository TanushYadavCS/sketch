import { describe, expect, it } from "vitest";
import { parseOnceSchedule } from "./parse-once";

describe("parseOnceSchedule", () => {
  it("interprets a naive ISO local string in the supplied tz, not the process tz", () => {
    // 5pm IST is 11:30 UTC.
    const result = parseOnceSchedule("2026-05-02T17:00:00", "Asia/Kolkata");
    expect(result.toISOString()).toBe("2026-05-02T11:30:00.000Z");
  });

  it("interprets a naive ISO local string in America/New_York (EDT, -04:00 in May)", () => {
    // 9am EDT on 2026-05-02 = 13:00 UTC.
    const result = parseOnceSchedule("2026-05-02T09:00:00", "America/New_York");
    expect(result.toISOString()).toBe("2026-05-02T13:00:00.000Z");
  });

  it("interprets a naive ISO local string in America/New_York (EST, -05:00 in January)", () => {
    // 9am EST on 2026-01-15 = 14:00 UTC.
    const result = parseOnceSchedule("2026-01-15T09:00:00", "America/New_York");
    expect(result.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("falls through to absolute parsing when the string has a Z suffix", () => {
    const result = parseOnceSchedule("2026-05-02T17:00:00Z", "Asia/Kolkata");
    expect(result.toISOString()).toBe("2026-05-02T17:00:00.000Z");
  });

  it("falls through to absolute parsing when the string has an explicit offset", () => {
    const result = parseOnceSchedule("2026-05-02T17:00:00+05:30", "America/New_York");
    expect(result.toISOString()).toBe("2026-05-02T11:30:00.000Z");
  });

  it("treats UTC as a passthrough — naive string parsed as UTC", () => {
    const result = parseOnceSchedule("2026-05-02T17:00:00", "UTC");
    expect(result.toISOString()).toBe("2026-05-02T17:00:00.000Z");
  });

  it("supports milliseconds in the naive ISO format", () => {
    const result = parseOnceSchedule("2026-05-02T17:00:00.250", "Asia/Kolkata");
    expect(result.toISOString()).toBe("2026-05-02T11:30:00.250Z");
  });

  it("supports space separator instead of T", () => {
    const result = parseOnceSchedule("2026-05-02 17:00:00", "Asia/Kolkata");
    expect(result.toISOString()).toBe("2026-05-02T11:30:00.000Z");
  });

  it("returns Invalid Date for unparseable input (matches new Date semantics)", () => {
    const result = parseOnceSchedule("not-a-date", "Asia/Kolkata");
    expect(Number.isNaN(result.getTime())).toBe(true);
  });

  // DST in America/New_York for 2026: spring-forward 2026-03-08 02:00 EST → 03:00 EDT,
  // fall-back 2026-11-01 02:00 EDT → 01:00 EST.
  it("handles spring-forward day: a valid post-transition local time resolves to EDT, not EST", () => {
    // 03:30 EDT on 2026-03-08 = 07:30 UTC. The pre-fix one-pass code returned 08:30Z.
    const result = parseOnceSchedule("2026-03-08T03:30:00", "America/New_York");
    expect(result.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("handles fall-back day: a post-transition local time resolves to EST, not EDT", () => {
    // 03:00 EST on 2026-11-01 = 08:00 UTC. The pre-fix one-pass code returned 07:00Z.
    const result = parseOnceSchedule("2026-11-01T03:00:00", "America/New_York");
    expect(result.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });
});

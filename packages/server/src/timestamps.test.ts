import { describe, expect, it } from "vitest";
import { normalizeSourceTimestampForStorage, parseTimestampMs } from "./timestamps";

describe("timestamp helpers", () => {
  it("normalizes offset timestamps to UTC ISO strings", () => {
    expect(normalizeSourceTimestampForStorage("2026-01-01T00:00:00+05:30")).toBe("2025-12-31T18:30:00.000Z");
  });

  it("keeps UTC ISO timestamps in canonical shape", () => {
    expect(normalizeSourceTimestampForStorage("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("treats naive database timestamps as UTC", () => {
    expect(normalizeSourceTimestampForStorage("2026-01-03 10:15:30")).toBe("2026-01-03T10:15:30.000Z");
    expect(normalizeSourceTimestampForStorage("2026-01-03T10:15:30")).toBe("2026-01-03T10:15:30.000Z");
  });

  it("returns null for null, empty, or invalid values", () => {
    expect(normalizeSourceTimestampForStorage(null)).toBeNull();
    expect(normalizeSourceTimestampForStorage("")).toBeNull();
    expect(normalizeSourceTimestampForStorage("not-a-date")).toBeNull();
    expect(parseTimestampMs("not-a-date")).toBeNull();
  });
});

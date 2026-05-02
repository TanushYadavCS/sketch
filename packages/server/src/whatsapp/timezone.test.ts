import { describe, expect, it } from "vitest";
import { phoneToTimezone } from "./timezone";

describe("phoneToTimezone", () => {
  it("maps India (+91) to Asia/Kolkata", () => {
    expect(phoneToTimezone("+919876543210")).toBe("Asia/Kolkata");
  });

  it("maps UK (+44) to Europe/London", () => {
    expect(phoneToTimezone("+447700900123")).toBe("Europe/London");
  });

  it("maps Germany (+49) to Europe/Berlin", () => {
    expect(phoneToTimezone("+4915123456789")).toBe("Europe/Berlin");
  });

  it("maps Japan (+81) to Asia/Tokyo", () => {
    expect(phoneToTimezone("+819012345678")).toBe("Asia/Tokyo");
  });

  it("maps US/CA (+1) to America/New_York as the documented default", () => {
    expect(phoneToTimezone("+14155551234")).toBe("America/New_York");
  });

  it("prefers the longest matching prefix (e.g. +971 over +9)", () => {
    expect(phoneToTimezone("+971501234567")).toBe("Asia/Dubai");
  });

  it("handles numbers without the leading + sign", () => {
    expect(phoneToTimezone("919876543210")).toBe("Asia/Kolkata");
  });

  it("handles numbers with formatting characters", () => {
    expect(phoneToTimezone("+44 7700 900 123")).toBe("Europe/London");
    expect(phoneToTimezone("+1 (415) 555-1234")).toBe("America/New_York");
  });

  it("returns null for unknown country codes", () => {
    expect(phoneToTimezone("+99912345")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(phoneToTimezone("")).toBeNull();
    expect(phoneToTimezone("+")).toBeNull();
  });
});

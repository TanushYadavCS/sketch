import { describe, expect, it } from "vitest";
import { storedWhatsAppNumber, whatsappNumberLookupValues } from "./identity-normalization";

describe("storedWhatsAppNumber", () => {
  it("normalises the spellings observed in production to one form", () => {
    expect(storedWhatsAppNumber("+91 9101299347")).toBe("+919101299347");
    expect(storedWhatsAppNumber("+91-9667704669")).toBe("+919667704669");
    expect(storedWhatsAppNumber("+917007413075")).toBe("+917007413075");
  });

  it("accepts the shapes an admin form produces", () => {
    expect(storedWhatsAppNumber("+1 (415) 555-1234")).toBe("+14155551234");
    expect(storedWhatsAppNumber("  +919870808553  ")).toBe("+919870808553");
    expect(storedWhatsAppNumber("00919870808553")).toBe("+919870808553");
  });

  it("treats empty input as absent", () => {
    expect(storedWhatsAppNumber(null)).toBeNull();
    expect(storedWhatsAppNumber(undefined)).toBeNull();
    expect(storedWhatsAppNumber("   ")).toBeNull();
  });

  it("keeps a value it cannot normalise rather than dropping it", () => {
    expect(storedWhatsAppNumber("not a number")).toBe("not a number");
    expect(storedWhatsAppNumber("12345")).toBe("12345");
  });
});

describe("whatsappNumberLookupValues", () => {
  it("looks up both the normalised and the original spelling", () => {
    expect(whatsappNumberLookupValues("+91 9101299347")).toEqual(["+919101299347", "+91 9101299347"]);
  });

  it("returns a single value when the input is already normalised", () => {
    expect(whatsappNumberLookupValues("+919101299347")).toEqual(["+919101299347"]);
  });

  it("returns the raw value when it cannot be normalised", () => {
    expect(whatsappNumberLookupValues("not a number")).toEqual(["not a number"]);
  });
});

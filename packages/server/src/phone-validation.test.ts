import {
  DEFAULT_PHONE_COUNTRY,
  getPhoneNumberInputParts,
  normalizePhoneNumberToE164,
  whatsappNumberSchema,
} from "@sketch/shared";
import { describe, expect, it } from "vitest";

describe("phone number validation", () => {
  it("normalizes national input with a selected country to E.164", () => {
    expect(normalizePhoneNumberToE164("98765 43210", "IN")).toBe("+919876543210");
    expect(normalizePhoneNumberToE164("(415) 555-1234", "US")).toBe("+14155551234");
  });

  it("normalizes formatted international input through the shared schema", () => {
    expect(whatsappNumberSchema.parse("+91 98765 43210")).toBe("+919876543210");
  });

  it("requires an international number when the API schema has no selected country", () => {
    expect(whatsappNumberSchema.safeParse("98765 43210").success).toBe(false);
  });

  it("extracts country and national number from existing E.164 values", () => {
    expect(getPhoneNumberInputParts("+919876543210")).toEqual({
      country: "IN",
      nationalNumber: "9876543210",
    });
  });

  it("keeps the configured default country for empty values", () => {
    expect(getPhoneNumberInputParts(null)).toEqual({
      country: DEFAULT_PHONE_COUNTRY,
      nationalNumber: "",
    });
  });
});

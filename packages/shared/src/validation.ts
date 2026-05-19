import {
  type CountryCode,
  formatIncompletePhoneNumber,
  getCountries,
  getCountryCallingCode,
  parseIncompletePhoneNumber,
  parsePhoneNumberFromString,
} from "libphonenumber-js/max";
import { z } from "zod";

export type PhoneCountryCode = CountryCode;

export const DEFAULT_PHONE_COUNTRY: PhoneCountryCode = "IN";

export function getSupportedPhoneCountries(): Array<{ country: PhoneCountryCode; callingCode: string }> {
  return getCountries().map((country) => ({ country, callingCode: getCountryCallingCode(country) }));
}

export function normalizePhoneNumberToE164(value: string, country?: PhoneCountryCode): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed, {
    ...(country ? { defaultCountry: country } : {}),
    extract: false,
  });
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

export function getPhoneNumberInputParts(value: string | null | undefined): {
  country: PhoneCountryCode;
  nationalNumber: string;
} {
  if (!value) return { country: DEFAULT_PHONE_COUNTRY, nationalNumber: "" };

  const parsed = parsePhoneNumberFromString(value, { extract: false });
  if (!parsed?.country) return { country: DEFAULT_PHONE_COUNTRY, nationalNumber: value };

  return {
    country: parsed.country,
    nationalNumber: parsed.nationalNumber,
  };
}

export function formatPhoneNumberNationalInput(value: string, country = DEFAULT_PHONE_COUNTRY): string {
  const incomplete = parseIncompletePhoneNumber(value);
  if (!incomplete) return "";
  return formatIncompletePhoneNumber(incomplete, country);
}

export const whatsappNumberSchema = z.string().transform((value, ctx) => {
  const normalized = normalizePhoneNumberToE164(value);
  if (!normalized) {
    ctx.addIssue({
      code: "custom",
      message: "Enter a valid phone number with country code",
    });
    return z.NEVER;
  }
  return normalized;
});

export const emailSchema = z.string().email("Invalid email address");

// File path validation schemas for workspace API
export const filePathSchema = z
  .string()
  .min(1, "Path cannot be empty")
  .refine((path) => !path.startsWith("/"), "Absolute paths are not allowed")
  .refine((path) => !path.includes(".."), "Path cannot contain parent directory references");

export const descriptionSchema = z.string().max(500, "Description must be under 500 characters");

export const userTypeSchema = z.enum(["human", "agent"]);
export const roleSchema = z.string().max(100, "Role must be under 100 characters");

export const fileNameSchema = z
  .string()
  .min(1, "Name cannot be empty")
  .max(255, "Name must be less than 255 characters")
  .refine((name) => {
    // Check for special characters: <>:"|?*
    if (/[<>:"|?*]/.test(name)) return false;
    // Check for control characters (0x00-0x1f)
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code >= 0x00 && code <= 0x1f) return false;
    }
    return true;
  }, "Name contains invalid characters")
  .refine(
    (name) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split(".")[0] ?? ""),
    "Name is a reserved system name",
  )
  .refine((name) => !name.endsWith(".") && !name.endsWith(" "), "Name cannot end with dot or space");

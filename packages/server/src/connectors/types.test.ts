import { describe, expect, it } from "vitest";
import { normalizeAccessPrincipals } from "./types";

describe("normalizeAccessPrincipals", () => {
  it("normalizes email-typed object values", () => {
    expect(normalizeAccessPrincipals([{ type: "email", value: "  Alice@Example.COM " }])).toEqual([
      { type: "email", value: "alice@example.com" },
    ]);
  });

  it("canonicalizes phone, Slack user, and WhatsApp LID values", () => {
    expect(
      normalizeAccessPrincipals([
        { type: "phone", value: "+91 9101299347" },
        { type: "slack_user", value: "  U-RAW  " },
        { type: "whatsapp_lid", value: "12345:7@LID" },
        { type: "phone", value: "+919101299347" },
      ]),
    ).toEqual([
      { type: "phone", value: "+919101299347" },
      { type: "slack_user", value: "U-RAW" },
      { type: "whatsapp_lid", value: "12345@lid" },
    ]);
  });

  it("drops invalid phones instead of constructing empty-string principals", () => {
    expect(normalizeAccessPrincipals([{ type: "phone", value: "not-a-phone" }])).toEqual([]);
  });
});

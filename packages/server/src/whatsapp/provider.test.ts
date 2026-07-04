import { describe, expect, it } from "vitest";
import { whatsappDeliveryTargetFromTarget, whatsappJidToPhoneE164, whatsappTargetFromDeliveryTarget } from "./provider";

describe("whatsappTargetFromDeliveryTarget", () => {
  it.each([
    [
      "opaque Wati conversation id",
      "6a436a0b5a5429ba2f5d8153",
      { kind: "dm", phoneE164: "", providerConversationId: "6a436a0b5a5429ba2f5d8153" },
    ],
    [
      "Wati phone fallback",
      "wati:+919867673672",
      { kind: "dm", phoneE164: "+919867673672", providerConversationId: "wati:+919867673672" },
    ],
    [
      "WhatsApp jid",
      "919867673672@s.whatsapp.net",
      { kind: "dm", phoneE164: "+919867673672", providerConversationId: "919867673672@s.whatsapp.net" },
    ],
    ["canonical DM", "dm:+919867673672", { kind: "dm", phoneE164: "+919867673672" }],
    ["bare E.164 phone", "+919867673672", { kind: "dm", phoneE164: "+919867673672" }],
    ["group jid", "120363000000001@g.us", { kind: "group", groupId: "120363000000001@g.us" }],
  ] as const)("parses %s", (_label, deliveryTarget, expected) => {
    expect(whatsappTargetFromDeliveryTarget(deliveryTarget)).toEqual(expected);
  });

  it("parses Wati phone fallback ids when passed through the jid helper", () => {
    expect(whatsappJidToPhoneE164("wati:+919867673672")).toBe("+919867673672");
  });

  it("canonicalizes valid DM phones for storage while preserving opaque ids without a valid phone", () => {
    expect(
      whatsappDeliveryTargetFromTarget({
        kind: "dm",
        phoneE164: "+919867673672",
        providerConversationId: "6a436a0b5a5429ba2f5d8153",
      }),
    ).toBe("dm:+919867673672");
    expect(
      whatsappDeliveryTargetFromTarget({
        kind: "dm",
        phoneE164: "",
        providerConversationId: "6a436a0b5a5429ba2f5d8153",
      }),
    ).toBe("6a436a0b5a5429ba2f5d8153");
  });
});

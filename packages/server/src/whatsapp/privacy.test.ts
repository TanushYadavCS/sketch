import { describe, expect, it } from "vitest";
import { maskPersonalNumberIdentifier, stripPersonalNumberTokens } from "./privacy";

describe("WhatsApp privacy helpers", () => {
  it("strips phone-like tokens without keeping correlation digits", () => {
    const stripped = stripPersonalNumberTokens("External +15550000002 15550000003@s.whatsapp.net");

    expect(maskPersonalNumberIdentifier("External +15550000002")).toBe("External +*********02");
    expect(stripped).toBe("External");
    expect(stripped).not.toMatch(/\d/u);
  });
});

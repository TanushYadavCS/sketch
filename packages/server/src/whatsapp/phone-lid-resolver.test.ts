import type { WASocket } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createTestLogger } from "../test-utils";
import { resolvePhoneToLidWithSocket } from "./bot";

function socket(providerResult: unknown, fallbackResult: string | null) {
  const getLIDForPN = vi.fn(async () => fallbackResult);
  const executeUSyncQuery = vi.fn(async () => providerResult);
  return {
    getLIDForPN,
    executeUSyncQuery,
    value: { executeUSyncQuery, signalRepository: { lidMapping: { getLIDForPN } } } as unknown as Pick<
      WASocket,
      "executeUSyncQuery" | "signalRepository"
    >,
  };
}

describe("phone-to-LID resolver", () => {
  it("returns the provider mapping without consulting fallback", async () => {
    const mock = socket({ list: [{ id: "14155551234@s.whatsapp.net", lid: "12345:7@lid" }], sideList: [] }, "999@lid");
    await expect(resolvePhoneToLidWithSocket(mock.value, "+14155551234", createTestLogger())).resolves.toEqual({
      lid: "12345@lid",
      source: "provider-current",
    });
    expect(mock.getLIDForPN).not.toHaveBeenCalled();
  });

  it("uses the Baileys mapping after a provider miss or failure", async () => {
    const miss = socket({ list: [], sideList: [] }, "54321:3@lid");
    await expect(resolvePhoneToLidWithSocket(miss.value, "+14155551234", createTestLogger())).resolves.toEqual({
      lid: "54321@lid",
      source: "baileys-fallback",
    });
    const failure = socket(null, null);
    const warn = vi.fn();
    const providerError = Object.assign(new Error("provider failed for +14155551234 and 12345@lid"), {
      code: "ETIMEDOUT",
    });
    failure.executeUSyncQuery.mockRejectedValueOnce(providerError);
    await expect(
      resolvePhoneToLidWithSocket(failure.value, "+14155551234", { warn } as unknown as Logger),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { operation: "phone_to_lid_provider_query", errorClass: "Error", errorCode: "ETIMEDOUT" },
      "WhatsApp phone-to-LID provider query failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("+14155551234");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("12345@lid");
  });
});

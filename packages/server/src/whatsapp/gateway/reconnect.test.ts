import { DisconnectReason } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { whatsappGatewayReconnectDelayMs } from "./reconnect";

describe("WhatsApp gateway reconnect policy", () => {
  it("uses one second for restart-required and a bounded three-second jitter otherwise", () => {
    expect(whatsappGatewayReconnectDelayMs(DisconnectReason.restartRequired, () => 0.9)).toBe(1_000);
    expect(whatsappGatewayReconnectDelayMs(500, () => 0)).toBe(3_000);
    expect(whatsappGatewayReconnectDelayMs(undefined, () => 1)).toBe(3_751);
  });
});

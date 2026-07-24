import { describe, expect, it } from "vitest";
import { isSameWhatsAppSocketStatePublication } from "./socket-state-publication";

describe("WhatsApp socket state publication identity", () => {
  const disconnected = {
    socketState: "disconnected" as const,
    socketGeneration: 2,
    statusCode: 408,
  };

  it("deduplicates only identical state publications", () => {
    expect(isSameWhatsAppSocketStatePublication(disconnected, disconnected)).toBe(true);
    expect(isSameWhatsAppSocketStatePublication(disconnected, { ...disconnected, socketGeneration: 3 })).toBe(false);
    expect(isSameWhatsAppSocketStatePublication(disconnected, { ...disconnected, statusCode: 413 })).toBe(false);
    expect(isSameWhatsAppSocketStatePublication(disconnected, { ...disconnected, reason: "connection_closed" })).toBe(
      false,
    );
  });
});

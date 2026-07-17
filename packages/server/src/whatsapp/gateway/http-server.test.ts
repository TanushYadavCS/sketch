import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppSocketFacade } from "../facade-contract";
import { createWhatsAppGatewayHttpApp } from "./http-server";

function facade(): WhatsAppSocketFacade {
  return {
    send: async () => null,
    sendComposing: async () => undefined,
    react: async () => ({ ok: true }),
    downloadMedia: async () => null,
    groupMetadata: async () => null,
    syncAllGroups: async () => ({ synced: 0 }),
    resolveLid: async () => null,
    pairing: {
      startQr: async (onEvent) => onEvent({ type: "qr", qr: "qr-data" }),
      status: async () => ({ connected: false, phoneNumber: null }),
      cancel: async () => undefined,
      logout: async () => undefined,
    },
    shutdown: async () => undefined,
    health: async () => ({
      socketState: "disconnected",
      queueDepth: 2,
      insertFailures: 1,
      uptime: 5,
      scriptHash: "abc",
      contractVersion: "1.0",
    }),
  };
}

describe("WhatsApp gateway HTTP facade", () => {
  it("requires the lease token on every endpoint", async () => {
    const app = createWhatsAppGatewayHttpApp({ token: "secret", facade: facade(), logger: createTestLogger() });
    const response = await app.request("/health");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("represents a socket-down send as a successful nullable result", async () => {
    const app = createWhatsAppGatewayHttpApp({ token: "secret", facade: facade(), logger: createTestLogger() });
    const response = await app.request("/messages", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "120363000000001@g.us",
        content: { kind: "text", text: "hello" },
        opts: { idempotencyKey: "send-1" },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: null });
  });

  it("serves authenticated health and pairing status responses", async () => {
    const app = createWhatsAppGatewayHttpApp({ token: "secret", facade: facade(), logger: createTestLogger() });
    const headers = { Authorization: "Bearer secret" };
    const health = await app.request("/health", { headers });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ queueDepth: 2, scriptHash: "abc" });
    const pairing = await app.request("/pairing-sessions/current", { headers });
    await expect(pairing.json()).resolves.toEqual({ connected: false, phoneNumber: null });
  });
});

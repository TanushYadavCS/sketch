import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils";
import type { WhatsAppSocketFacade } from "../facade-contract";
import { createWhatsAppGatewayHttpApp } from "./http-server";

function facade(overrides: Partial<WhatsAppSocketFacade> = {}): WhatsAppSocketFacade {
  return {
    send: async () => null,
    sendComposing: async () => undefined,
    react: async () => ({ ok: true }),
    downloadMedia: async () => null,
    groupMetadata: async () => null,
    syncAllGroups: async () => ({ synced: 0 }),
    resolveLid: async () => null,
    fetchMessageHistory: async () => "request-session-1",
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
    ...overrides,
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

  it("preserves the provider completeness marker in group metadata responses", async () => {
    const groupMetadata = vi.fn(async () => ({
      id: "123@g.us",
      subject: "Product Team",
      desc: null,
      participants: [],
      participantIdentityComplete: true,
    }));
    const app = createWhatsAppGatewayHttpApp({
      token: "secret",
      facade: facade({ groupMetadata }),
      logger: createTestLogger(),
    });
    const response = await app.request("/group-metadata-queries", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jid: "123@g.us", opts: { refresh: true } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { id: "123@g.us", participantIdentityComplete: true },
    });
    expect(groupMetadata).toHaveBeenCalledWith("123@g.us", { refresh: true });
  });

  it("round-trips authenticated history requests and rejects counts above the Baileys cap", async () => {
    const fetchMessageHistory = vi.fn(async () => "request-session-7");
    const app = createWhatsAppGatewayHttpApp({
      token: "secret",
      facade: facade({ fetchMessageHistory }),
      logger: createTestLogger(),
    });
    const input = {
      count: 50,
      oldestMessageKey: { remoteJid: "120363000000001@g.us", id: "oldest-1", fromMe: false },
      oldestMessageTimestamp: 1_768_464_420,
    };
    const response = await app.request("/history-sync-requests", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ requestSessionId: "request-session-7" });
    expect(fetchMessageHistory).toHaveBeenCalledWith(input);

    const overCap = await app.request("/history-sync-requests", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, count: 51 }),
    });
    expect(overCap.status).toBe(400);
    const unauthorized = await app.request("/history-sync-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(unauthorized.status).toBe(401);
  });
});

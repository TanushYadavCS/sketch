import { describe, expect, it, vi } from "vitest";
import { WhatsAppGatewayAppNotifier } from "./app-notifier";

describe("WhatsAppGatewayAppNotifier", () => {
  it("posts socket state changes to the authenticated app endpoint", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = new WhatsAppGatewayAppNotifier({
      baseUrl: "http://127.0.0.1:3000",
      token: "gateway-secret",
      fetch,
    });

    notifier.socketStateChanged({
      ownerToken: "owner-1",
      generation: 7,
      socketGeneration: 3,
      socketState: "connected",
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/internal/whatsapp/socket-state",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer gateway-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerToken: "owner-1", generation: 7, socketGeneration: 3, socketState: "connected" }),
      }),
    );
  });

  it("does not throw when a socket state notification fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("app unavailable");
    });
    const notifier = new WhatsAppGatewayAppNotifier({
      baseUrl: "http://127.0.0.1:3000",
      token: "gateway-secret",
      fetch,
    });

    expect(() =>
      notifier.socketStateChanged({
        ownerToken: "owner-1",
        generation: 7,
        socketGeneration: 3,
        socketState: "disconnected",
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
});

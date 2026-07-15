import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import { GatewayClientFacade, WHATSAPP_GATEWAY_SEND_TIMEOUT_MS } from "./gateway-client-facade";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("GatewayClientFacade", () => {
  it("authenticates requests, applies the send timeout, and validates responses", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return json({
          result: {
            providerMessageId: "sent-1",
            providerConversationId: "15551234567@s.whatsapp.net",
            providerTimestamp: "2026-07-15T08:27:00.000Z",
          },
        });
      },
    });

    await expect(
      facade.send("15551234567@s.whatsapp.net", { kind: "text", text: "hello" }, { idempotencyKey: "send-1" }),
    ).resolves.toMatchObject({ providerMessageId: "sent-1" });
    expect(requests[0]?.input).toBe("http://127.0.0.1:3901/messages");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(WHATSAPP_GATEWAY_SEND_TIMEOUT_MS).toBe(60_000);
  });

  it("rejects a successful HTTP response that violates the facade contract", async () => {
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async () => json({ result: { providerMessageId: 123 } }),
    });
    await expect(
      facade.send("15551234567@s.whatsapp.net", { kind: "text", text: "hello" }, { idempotencyKey: "send-1" }),
    ).rejects.toThrow();
  });

  it("skips empty quoted references without issuing invalid gateway requests", async () => {
    const calls: Array<{ input: string; body: unknown }> = [];
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async (input, init) => {
        calls.push({ input: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return json({ result: null });
      },
    });
    const emptyRef = {
      kind: "providerMessageId" as const,
      providerConversationId: "15551234567@s.whatsapp.net",
      value: "",
    };

    await expect(facade.react("15551234567@s.whatsapp.net", emptyRef, "✅")).resolves.toEqual({
      error: "unknown-message",
    });
    await expect(
      facade.downloadMedia({ messageRef: emptyRef, destinationDir: "/tmp", maxFileBytes: 10 }),
    ).resolves.toBeNull();
    await expect(
      facade.send(
        "15551234567@s.whatsapp.net",
        { kind: "text", text: "hello" },
        { quotedRef: emptyRef, idempotencyKey: "send-empty-ref" },
      ),
    ).resolves.toBeNull();
    expect(calls).toEqual([
      {
        input: "http://127.0.0.1:3901/messages",
        body: {
          target: "15551234567@s.whatsapp.net",
          content: { kind: "text", text: "hello" },
          opts: { idempotencyKey: "send-empty-ref" },
        },
      },
    ]);
  });

  it("maps a valid null send envelope back to the provider null result", async () => {
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async () => json({ result: null }),
    });
    await expect(
      facade.send("15551234567@s.whatsapp.net", { kind: "text", text: "hello" }, { idempotencyKey: "null" }),
    ).resolves.toBeNull();
  });

  it("fails on non-success gateway responses", async () => {
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async () => json({ error: "nope" }, 503),
    });
    await expect(facade.health()).rejects.toThrow("WhatsApp gateway request failed: 503");
  });

  it("requests authenticated graceful process shutdown", async () => {
    let request: { input: string; init?: RequestInit } | null = null;
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      fetch: async (input, init) => {
        request = { input: String(input), init };
        return json({ ok: true });
      },
    });
    await facade.shutdown();
    expect(request).toMatchObject({ input: "http://127.0.0.1:3901/process", init: { method: "DELETE" } });
  });

  it("keeps a QR stream open after the query timeout once response headers arrive", async () => {
    const state: {
      stream?: ReadableStreamDefaultController<Uint8Array>;
      requestSignal?: AbortSignal;
    } = {};
    const encoder = new TextEncoder();
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      queryTimeoutMs: 5,
      fetch: async (_input, init) => {
        state.requestSignal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              state.stream = controller;
              controller.enqueue(encoder.encode('data: {"type":"qr","qr":"still-open"}\n\n'));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const events: unknown[] = [];
    const pairing = facade.pairing.startQr(async (event) => {
      events.push(event);
    });
    await vi.waitFor(() => expect(events).toEqual([{ type: "qr", qr: "still-open" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.requestSignal?.aborted).toBe(false);
    state.stream?.close();
    await expect(pairing).resolves.toBeUndefined();
  });
});

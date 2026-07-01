import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import { extractWebhookToken, isValidWebhookToken, watiWebhookRoutes } from "./wati-webhook";

function createTestApp(
  handleWebhook = vi.fn(async () => [
    { kind: "message" as const, providerMessageId: "wamid.1", senderPhoneE164: "+15551234567" },
  ]),
) {
  const app = new Hono();
  app.route(
    "/whatsapp/wati",
    watiWebhookRoutes(
      {
        webhookToken: "secret-token",
        handleWebhook,
      },
      createTestLogger(),
    ),
  );
  return { app, handleWebhook };
}

describe("watiWebhookRoutes", () => {
  it("accepts query-token authenticated webhook payloads for Wati setups without custom headers", async () => {
    const { app, handleWebhook } = createTestApp();

    const res = await app.request("/whatsapp/wati/events?token=secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType: "message" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledWith({ eventType: "message" }));
  });

  it("accepts bearer-token authenticated webhook payloads when headers are available", async () => {
    const { app, handleWebhook } = createTestApp();

    const res = await app.request("/whatsapp/wati/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventType: "message" }),
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledOnce());
  });

  it("acknowledges valid webhook payloads before provider processing finishes", async () => {
    const handleWebhook = vi.fn(() => new Promise<never>(() => undefined));
    const { app } = createTestApp(handleWebhook);

    const request = app.request("/whatsapp/wati/events?token=secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType: "message" }),
    });

    const res = await Promise.race([
      request,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledOnce());
  });

  it("rejects missing or incorrect webhook tokens before processing the body", async () => {
    const { app, handleWebhook } = createTestApp();

    const res = await app.request("/whatsapp/wati/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventType: "message" }),
    });

    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON after authentication", async () => {
    const { app, handleWebhook } = createTestApp();

    const res = await app.request("/whatsapp/wati/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});

describe("Wati webhook token helpers", () => {
  it("extracts bearer, custom header, and query tokens", () => {
    expect(
      extractWebhookToken(
        new Request("https://sketch.test/whatsapp/wati/events", {
          headers: { Authorization: "Bearer secret-token" },
        }),
      ),
    ).toBe("secret-token");
    expect(
      extractWebhookToken(
        new Request("https://sketch.test/whatsapp/wati/events", {
          headers: { "x-wati-webhook-token": "header-token" },
        }),
      ),
    ).toBe("header-token");
    expect(extractWebhookToken(new Request("https://sketch.test/whatsapp/wati/events?token=query-token"))).toBe(
      "query-token",
    );
  });

  it("compares webhook tokens safely", () => {
    expect(isValidWebhookToken("secret-token", "secret-token")).toBe(true);
    expect(isValidWebhookToken("wrong", "secret-token")).toBe(false);
    expect(isValidWebhookToken(null, "secret-token")).toBe(false);
  });
});

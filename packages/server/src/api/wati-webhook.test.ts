import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { QueueManager } from "../queue";
import { createTestLogger } from "../test-utils";
import {
  WATI_WEBHOOK_QUEUE_KEY,
  extractWebhookToken,
  isValidWebhookToken,
  watiWebhookQueueKey,
  watiWebhookRoutes,
} from "./wati-webhook";

function createTestApp(
  handleWebhook = vi.fn(async () => [
    { kind: "message" as const, providerMessageId: "wamid.1", senderPhoneE164: "+15551234567" },
  ]),
) {
  const app = new Hono();
  const queueManager = new QueueManager();
  const queue = {
    enqueue: vi.fn((work: () => Promise<void>) => {
      void work();
    }),
  };
  const getQueue = vi.spyOn(queueManager, "getQueue").mockReturnValue(queue as never);
  app.route(
    "/whatsapp/wati",
    watiWebhookRoutes(
      {
        webhookToken: "secret-token",
        handleWebhook,
      },
      queueManager,
      createTestLogger(),
    ),
  );
  return { app, handleWebhook, queue, getQueue };
}

describe("watiWebhookRoutes", () => {
  it("accepts query-token authenticated webhook payloads for Wati setups without custom headers", async () => {
    const { app, handleWebhook, queue, getQueue } = createTestApp();

    const res = await app.request("/whatsapp/wati/events?token=secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType: "message" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getQueue).toHaveBeenCalledWith(WATI_WEBHOOK_QUEUE_KEY);
    expect(queue.enqueue).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledWith({ eventType: "message" }));
  });

  it("routes traffic to a per-conversation queue key so one chat cannot block others", async () => {
    const { app, getQueue } = createTestApp();

    const res = await app.request("/whatsapp/wati/events?token=secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType: "message", waId: "15551234567", conversationId: "conv-42" }),
    });

    expect(res.status).toBe(200);
    expect(getQueue).toHaveBeenCalledWith(`${WATI_WEBHOOK_QUEUE_KEY}:conv-42`);
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
    const { app, handleWebhook, queue } = createTestApp();

    const res = await app.request("/whatsapp/wati/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventType: "message" }),
    });

    expect(res.status).toBe(401);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON after authentication", async () => {
    const { app, handleWebhook, queue } = createTestApp();

    const res = await app.request("/whatsapp/wati/events", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(queue.enqueue).not.toHaveBeenCalled();
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

describe("watiWebhookQueueKey", () => {
  it("prefers conversationId, then ticketId, then waId", () => {
    expect(watiWebhookQueueKey({ conversationId: "conv-1", ticketId: "t-1", waId: "15550001111" })).toBe(
      `${WATI_WEBHOOK_QUEUE_KEY}:conv-1`,
    );
    expect(watiWebhookQueueKey({ ticketId: "t-1", waId: "15550001111" })).toBe(`${WATI_WEBHOOK_QUEUE_KEY}:t-1`);
    expect(watiWebhookQueueKey({ waId: "15550001111" })).toBe(`${WATI_WEBHOOK_QUEUE_KEY}:15550001111`);
  });

  it("falls back to the global key when no conversation identifier is present", () => {
    expect(watiWebhookQueueKey({ eventType: "message" })).toBe(WATI_WEBHOOK_QUEUE_KEY);
    expect(watiWebhookQueueKey({ waId: "   " })).toBe(WATI_WEBHOOK_QUEUE_KEY);
    expect(watiWebhookQueueKey(null)).toBe(WATI_WEBHOOK_QUEUE_KEY);
    expect(watiWebhookQueueKey("not-an-object")).toBe(WATI_WEBHOOK_QUEUE_KEY);
  });
});

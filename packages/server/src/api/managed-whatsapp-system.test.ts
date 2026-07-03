import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppInboundMessage } from "../whatsapp/provider";
import { createManagedWhatsAppProvider } from "../whatsapp/providers/managed";
import { systemRoutes } from "./system";

const SYSTEM_SECRET = "test-system-secret";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event-1",
    type: "message",
    provider: "wati",
    providerMessageId: "wamid.inbound",
    providerConversationId: "conversation-1",
    senderPhoneE164: "+15551234567",
    senderName: "Alice",
    text: "hello",
    ...overrides,
  };
}

describe("POST /api/system/whatsapp/managed/events", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("requires the system secret", async () => {
    const app = new Hono();
    const handleInboundEvent = vi.fn();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: { handleInboundEvent },
      }),
    );

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(401);
    expect(handleInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects same-length wrong bearer values", async () => {
    const app = new Hono();
    const handleInboundEvent = vi.fn();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: { handleInboundEvent },
      }),
    );

    const wrongSecret = "wrong-system-token";
    expect(wrongSecret).toHaveLength(SYSTEM_SECRET.length);
    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${wrongSecret}` },
      body: JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(401);
    expect(handleInboundEvent).not.toHaveBeenCalled();
  });

  it("hands normalized inbound events to the managed provider", async () => {
    const handleInboundEvent = vi.fn(async () => ({
      kind: "message" as const,
      eventId: "event-1",
      providerMessageId: "wamid.inbound",
      senderPhoneE164: "+15551234567",
    }));
    const app = new Hono();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: { handleInboundEvent },
      }),
    );

    const payload = validPayload();
    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handleInboundEvent).toHaveBeenCalledWith(payload);
  });

  it("returns bad request when the managed provider rejects the event schema", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const app = new Hono();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: provider,
      }),
    );

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify(validPayload({ senderPhoneE164: "15551234567" })),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid managed WhatsApp event" } });
  });

  it("accepts unknown managed event types without invoking agent handlers", async () => {
    const provider = createManagedWhatsAppProvider({
      platformUrl: "https://app.getsketch.ai",
      tenantToken: "tenant-token",
      logger: createTestLogger(),
    });
    const handler = vi.fn(async (_message: WhatsAppInboundMessage) => undefined);
    provider.inboundProvider.onMessage(handler);
    const app = new Hono();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: provider,
      }),
    );

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify({ eventId: "event-status-1", type: "status", text: "ignored" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns unavailable when the managed provider is not configured", async () => {
    const app = new Hono();
    app.route("/api/system", systemRoutes(createSettingsRepository(db), { systemSecret: SYSTEM_SECRET }));

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(503);
  });
});

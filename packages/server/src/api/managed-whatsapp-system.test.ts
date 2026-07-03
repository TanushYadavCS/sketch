import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { systemRoutes } from "./system";

const SYSTEM_SECRET = "test-system-secret";

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
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: { handleInboundEvent: vi.fn() },
      }),
    );

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerMessageId: "wamid.inbound" }),
    });

    expect(res.status).toBe(401);
  });

  it("hands normalized inbound events to the managed provider", async () => {
    const handleInboundEvent = vi.fn(async () => undefined);
    const app = new Hono();
    app.route(
      "/api/system",
      systemRoutes(createSettingsRepository(db), {
        systemSecret: SYSTEM_SECRET,
        managedWhatsappInbound: { handleInboundEvent },
      }),
    );

    const payload = {
      provider: "wati",
      providerMessageId: "wamid.inbound",
      providerConversationId: "conversation-1",
      senderPhoneE164: "+15551234567",
      senderName: "Alice",
      text: "hello",
    };
    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handleInboundEvent).toHaveBeenCalledWith(payload);
  });

  it("returns unavailable when the managed provider is not configured", async () => {
    const app = new Hono();
    app.route("/api/system", systemRoutes(createSettingsRepository(db), { systemSecret: SYSTEM_SECRET }));

    const res = await app.request("/api/system/whatsapp/managed/events", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SYSTEM_SECRET}` },
      body: JSON.stringify({ providerMessageId: "wamid.inbound" }),
    });

    expect(res.status).toBe(503);
  });
});

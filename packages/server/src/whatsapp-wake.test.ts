import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./http";
import { createTestConfig, createTestDb } from "./test-utils";

describe("WhatsApp gateway wake route", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("accepts only the loopback token and invokes the consumer doorbell", async () => {
    let wakes = 0;
    const app = createApp(db, createTestConfig(), {
      whatsappWakeToken: "wake-secret",
      onWhatsAppWake: () => {
        wakes += 1;
      },
    });
    const unauthorized = await app.request("http://127.0.0.1/internal/whatsapp/wake", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const accepted = await app.request("http://127.0.0.1/internal/whatsapp/wake", {
      method: "POST",
      headers: { Authorization: "Bearer wake-secret" },
    });
    expect(accepted.status).toBe(204);
    expect(wakes).toBe(1);
  });

  it("rejects a correctly authenticated request addressed to a non-loopback host", async () => {
    const app = createApp(db, createTestConfig(), {
      whatsappWakeToken: "wake-secret",
      onWhatsAppWake: () => undefined,
    });
    const response = await app.request("https://example.test/internal/whatsapp/wake", {
      method: "POST",
      headers: { Authorization: "Bearer wake-secret" },
    });
    expect(response.status).toBe(403);
  });

  it("accepts authenticated socket state changes from the gateway", async () => {
    const changes: unknown[] = [];
    const app = createApp(db, createTestConfig(), {
      whatsappWakeToken: "wake-secret",
      onWhatsAppSocketStateChange: (change) => {
        changes.push(change);
      },
    });

    const response = await app.request("http://127.0.0.1/internal/whatsapp/socket-state", {
      method: "POST",
      headers: { Authorization: "Bearer wake-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ ownerToken: "owner-1", generation: 3, socketGeneration: 2, socketState: "connected" }),
    });

    expect(response.status).toBe(204);
    expect(changes).toEqual([{ ownerToken: "owner-1", generation: 3, socketGeneration: 2, socketState: "connected" }]);
  });
});

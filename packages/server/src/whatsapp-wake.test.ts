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
});

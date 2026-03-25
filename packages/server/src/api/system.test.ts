import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { systemRoutes } from "./system";

const SYSTEM_SECRET = "test-system-secret";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SEED = { adminEmail: "admin@test.com", adminPasswordHash: "" };

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const hash = await hashPassword("testpassword123");
  await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: hash });
}

async function rawField(db: Kysely<DB>, field: keyof DB["settings"]): Promise<string | null | undefined> {
  const row = await db.selectFrom("settings").select(field).where("id", "=", "default").executeTakeFirst();
  return row?.[field] as string | null | undefined;
}

function createTestSystemApp(
  settingsRepo: ReturnType<typeof createSettingsRepository>,
  deps: { systemSecret: string; onSlackTokensUpdated?: ReturnType<typeof vi.fn> },
) {
  const app = new Hono();
  app.route("/api/system", systemRoutes(settingsRepo, deps));
  return app;
}

describe("PUT /api/system/slack/tokens", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("with valid bearer updates bot token and calls onSlackTokensUpdated", async () => {
    const onSlackTokensUpdated = vi.fn().mockResolvedValue(undefined);
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, onSlackTokensUpdated });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ botToken: "xoxb-new-token" }),
    });

    expect(res.status).toBe(200);
    expect(onSlackTokensUpdated).toHaveBeenCalledOnce();
    expect(onSlackTokensUpdated).toHaveBeenCalledWith({ botToken: "xoxb-new-token" });

    const stored = await settingsRepo.get();
    expect(stored?.slack_bot_token).toBe("xoxb-new-token");
  });

  it("without Authorization header returns 401", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "xoxb-new-token" }),
    });

    expect(res.status).toBe(401);
  });

  it("with wrong bearer token returns 401", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: {
        Authorization: "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ botToken: "xoxb-new-token" }),
    });

    expect(res.status).toBe(401);
  });

  it("with appToken stores both tokens", async () => {
    const onSlackTokensUpdated = vi.fn().mockResolvedValue(undefined);
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, onSlackTokensUpdated });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ botToken: "xoxb-test", appToken: "xapp-test" }),
    });

    expect(res.status).toBe(200);
    expect(onSlackTokensUpdated).toHaveBeenCalledWith({ botToken: "xoxb-test", appToken: "xapp-test" });

    const stored = await settingsRepo.get();
    expect(stored?.slack_bot_token).toBe("xoxb-test");
    expect(stored?.slack_app_token).toBe("xapp-test");
  });

  it("without botToken returns 400", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("encrypts bot token when ENCRYPTION_KEY is set", async () => {
    const onSlackTokensUpdated = vi.fn().mockResolvedValue(undefined);
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, onSlackTokensUpdated });

    const res = await app.request("/api/system/slack/tokens", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ botToken: "xoxb-encrypted-token" }),
    });

    expect(res.status).toBe(200);

    const rawValue = await rawField(db, "slack_bot_token");
    expect(typeof rawValue).toBe("string");
    expect((rawValue as string).startsWith("enc:")).toBe(true);

    const decrypted = await settingsRepo.get();
    expect(decrypted?.slack_bot_token).toBe("xoxb-encrypted-token");
  });
});

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { createMcpServerRepository } from "../db/repositories/mcp-servers";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
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
  deps: {
    systemSecret: string;
    onSlackTokensUpdated?: ReturnType<typeof vi.fn>;
    onLlmSettingsUpdated?: ReturnType<typeof vi.fn>;
    userRepo?: ReturnType<typeof createUserRepository>;
    inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
    mcpServers?: ReturnType<typeof createMcpServerRepository>;
    sendSlackDmToSlackUser?: (params: {
      slackUserId: string;
      message: string;
    }) => Promise<{ channelId: string; messageRef: string }>;
    whatsappStatus?: () => { connected: boolean; phoneNumber: string | null; pairingInProgress: boolean };
    startWhatsAppPairing?: ReturnType<typeof vi.fn>;
    cancelWhatsAppPairing?: ReturnType<typeof vi.fn>;
  },
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

describe("PUT /api/system/identity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminEmail: "new@acme.com", adminPasswordHash: "hash123" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: "Bearer wrong-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ adminEmail: "new@acme.com", adminPasswordHash: "hash123" }),
    });

    expect(res.status).toBe(401);
  });

  it("creates settings row when none exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const hash = await hashPassword("newpassword");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        adminPasswordHash: hash,
        orgName: "Acme Corp",
        botName: "AcmeBot",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const settings = await settingsRepo.get();
    expect(settings?.admin_email).toBe("admin@acme.com");
    expect(settings?.admin_password_hash).toBe(hash);
    expect(settings?.org_name).toBe("Acme Corp");
    expect(settings?.bot_name).toBe("AcmeBot");
  });

  it("updates existing settings row", async () => {
    await seedAdmin(db);
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const newHash = await hashPassword("updatedpassword");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "updated@acme.com",
        adminPasswordHash: newHash,
        orgName: "Acme Updated",
      }),
    });

    expect(res.status).toBe(200);

    const settings = await settingsRepo.get();
    expect(settings?.admin_email).toBe("updated@acme.com");
    expect(settings?.org_name).toBe("Acme Updated");
  });

  it("creates admin user row with name derived from email when name not provided", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const hash = await hashPassword("password");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "newadmin@acme.com",
        adminPasswordHash: hash,
      }),
    });

    expect(res.status).toBe(200);

    const user = await userRepo.findByEmail("newadmin@acme.com");
    expect(user).toBeDefined();
    expect(user?.email).toBe("newadmin@acme.com");
    expect(user?.role).toBeNull();
    expect(user?.name).toBe("newadmin");
    expect(user?.email_verified_at).not.toBeNull();
  });

  it("creates admin user row with real name when name is provided", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const hash = await hashPassword("password");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "roopak@acme.com",
        adminPasswordHash: hash,
        name: "Roopak Nijhara",
      }),
    });

    expect(res.status).toBe(200);

    const user = await userRepo.findByEmail("roopak@acme.com");
    expect(user).toBeDefined();
    expect(user?.name).toBe("Roopak Nijhara");
    expect(user?.role).toBeNull();
    expect(user?.email_verified_at).not.toBeNull();
  });

  it("updates existing user row with name and verified email when user already exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await userRepo.create({ name: "Old Name", email: "existing@acme.com" });

    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const hash = await hashPassword("password");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "existing@acme.com",
        adminPasswordHash: hash,
        orgName: "Acme",
        name: "New Name",
      }),
    });

    expect(res.status).toBe(200);

    const user = await userRepo.findByEmail("existing@acme.com");
    expect(user).toBeDefined();
    expect(user?.role).toBeNull();
    expect(user?.name).toBe("New Name");
    expect(user?.email_verified_at).not.toBeNull();
  });

  it("validates adminEmail as a valid email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "not-an-email",
        adminPasswordHash: "hash",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("creates settings with orgName and botName via settings.create()", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const hash = await hashPassword("password");
    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        adminPasswordHash: hash,
        orgName: "Acme Inc",
        botName: "SketchBot",
      }),
    });

    expect(res.status).toBe(200);

    const settings = await settingsRepo.get();
    expect(settings?.org_name).toBe("Acme Inc");
    expect(settings?.bot_name).toBe("SketchBot");
  });
});

describe("POST /api/system/users", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@acme.com", name: "Member Name" }),
    });

    expect(res.status).toBe(401);
  });

  it("creates a verified member user and returns userId", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "member@acme.com", name: "Member Name" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.userId).toBe("string");

    const user = await userRepo.findByEmail("member@acme.com");
    expect(user).toBeDefined();
    expect(user?.role).toBeNull();
    expect(user?.name).toBe("Member Name");
    expect(user?.email_verified_at).toBeTruthy();
    expect(body.userId).toBe(user?.id);
  });

  it("returns the existing user when the email already exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "member@acme.com",
      name: "Existing Member",
      emailVerified: true,
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "member@acme.com", name: "New Name" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, userId: existing.id });

    const user = await userRepo.findByEmail("member@acme.com");
    expect(user?.id).toBe(existing.id);
    expect(user?.name).toBe("Existing Member");
  });

  it("returns 400 when email is missing or invalid", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const missingEmailRes = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Member Name" }),
    });

    const invalidEmailRes = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "not-an-email", name: "Member Name" }),
    });

    expect(missingEmailRes.status).toBe(400);
    expect(invalidEmailRes.status).toBe(400);
  });

  it("returns 400 when name is missing", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "member@acme.com" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/system/users", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("bulk upserts users by Slack ID and email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "alice@acme.com",
      name: "Alice Old",
      emailVerified: true,
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [
          { email: "alice@acme.com", name: "Alice Johnson", slackUserId: "U111" },
          { email: "bob@acme.com", name: "Bob Shah", slackUserId: "U222" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 1, updated: 1 });

    const alice = await userRepo.findById(existing.id);
    expect(alice?.name).toBe("Alice Johnson");
    expect(alice?.slack_user_id).toBe("U111");

    const bob = await userRepo.findByEmail("bob@acme.com");
    expect(bob?.name).toBe("Bob Shah");
    expect(bob?.slack_user_id).toBe("U222");
  });

  it("returns 409 when an email is already linked to a different Slack user", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await userRepo.create({
      email: "alice@acme.com",
      name: "Alice",
      slackUserId: "U123",
      emailVerified: true,
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ email: "alice@acme.com", name: "Alice", slackUserId: "U999" }],
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("rolls back earlier user writes when a later row conflicts", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await userRepo.create({
      email: "alice@acme.com",
      name: "Alice",
      slackUserId: "U123",
      emailVerified: true,
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [
          { email: "bob@acme.com", name: "Bob Shah", slackUserId: "U222" },
          { email: "alice@acme.com", name: "Alice", slackUserId: "U999" },
        ],
      }),
    });

    expect(res.status).toBe(409);
    expect(await userRepo.findByEmail("bob@acme.com")).toBeUndefined();
  });

  it("returns 400 when a row is missing email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ name: "Alice", slackUserId: "U111" }],
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/system/llm", () => {
  let db: Kysely<DB>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test" }),
    });

    expect(res.status).toBe(401);
  });

  it("stores Anthropic API key in settings", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const settings = await settingsRepo.get();
    expect(settings?.llm_provider).toBe("anthropic");
    expect(settings?.anthropic_api_key).toBe("sk-ant-test-key");
  });

  it("stores Bedrock credentials in settings", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "bedrock",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const settings = await settingsRepo.get();
    expect(settings?.llm_provider).toBe("bedrock");
    expect(settings?.aws_access_key_id).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(settings?.aws_secret_access_key).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(settings?.aws_region).toBe("us-east-1");
  });

  it("invokes onLlmSettingsUpdated after a successful update", async () => {
    const settingsRepo = createSettingsRepository(db);
    const onLlmSettingsUpdated = vi.fn().mockResolvedValue(undefined);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, onLlmSettingsUpdated });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "bedrock",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(onLlmSettingsUpdated).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid provider", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when Anthropic API key verification fails (401)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-bad-key" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_CREDENTIALS");

    const settings = await settingsRepo.get();
    expect(settings?.anthropic_api_key).toBeNull();
  });

  it("returns 400 when Anthropic API key verification fails (500)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-bad-key" }),
    });

    expect(res.status).toBe(400);

    const settings = await settingsRepo.get();
    expect(settings?.anthropic_api_key).toBeNull();
  });

  it("encrypts sensitive fields when ENCRYPTION_KEY is set", async () => {
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    // Re-seed with encrypted repo since seedAdmin used unencrypted repo
    await db.deleteFrom("settings").where("id", "=", "default").execute();
    const hash = await hashPassword("testpassword123");
    await settingsRepo.create({ adminEmail: "admin@test.com", adminPasswordHash: hash });

    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-secret-key" }),
    });

    expect(res.status).toBe(200);

    const rawApiKey = await rawField(db, "anthropic_api_key");
    expect(typeof rawApiKey).toBe("string");
    expect((rawApiKey as string).startsWith("enc:")).toBe(true);

    const decrypted = await settingsRepo.get();
    expect(decrypted?.anthropic_api_key).toBe("sk-ant-secret-key");
  });

  it("encrypts Bedrock secret access key when ENCRYPTION_KEY is set", async () => {
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    await db.deleteFrom("settings").where("id", "=", "default").execute();
    const hash = await hashPassword("testpassword123");
    await settingsRepo.create({ adminEmail: "admin@test.com", adminPasswordHash: hash });

    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "bedrock",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret-key-value",
        region: "us-west-2",
      }),
    });

    expect(res.status).toBe(200);

    const rawSecretKey = await rawField(db, "aws_secret_access_key");
    expect(typeof rawSecretKey).toBe("string");
    expect((rawSecretKey as string).startsWith("enc:")).toBe(true);

    const decrypted = await settingsRepo.get();
    expect(decrypted?.aws_secret_access_key).toBe("secret-key-value");
  });
});

describe("GET /api/system/whatsapp", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns defaults when no whatsappStatus callback is provided", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp", {
      method: "GET",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ connected: false, phoneNumber: null, pairingInProgress: false });
  });

  it("returns status from whatsappStatus callback", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      whatsappStatus: () => ({ connected: true, phoneNumber: "+919876543210", pairingInProgress: false }),
    });

    const res = await app.request("/api/system/whatsapp", {
      method: "GET",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ connected: true, phoneNumber: "+919876543210", pairingInProgress: false });
  });

  it("returns pairingInProgress when active", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      whatsappStatus: () => ({ connected: false, phoneNumber: null, pairingInProgress: true }),
    });

    const res = await app.request("/api/system/whatsapp", {
      method: "GET",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ connected: false, phoneNumber: null, pairingInProgress: true });
  });
});

describe("GET /api/system/whatsapp/pair", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp/pair", {
      method: "GET",
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp/pair", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-secret" },
    });

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/system/whatsapp/pair", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp/pair", {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/whatsapp/pair", {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong-secret" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 200 when no pairing is in progress", async () => {
    const settingsRepo = createSettingsRepository(db);
    const cancelWhatsAppPairing = vi.fn().mockReturnValue(undefined);
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      cancelWhatsAppPairing,
    });

    const res = await app.request("/api/system/whatsapp/pair", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe("POST /api/system/onboarding-introductions", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the workflow row and sends the admin opener once", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    await settingsRepo.create({ adminEmail: "admin@acme.com", adminPasswordHash: "hash", botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      slackUserId: "UADMIN",
      emailVerified: true,
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendSlackDmToSlackUser,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "started" });
    expect(sendSlackDmToSlackUser).toHaveBeenCalledWith({
      slackUserId: "UADMIN",
      message: "I've added your team to Sketch. Who should I introduce myself to first? Reply with names or @mentions.",
    });

    const workflow = await inboxMessagesRepo.findUnresolvedByRecipientAndKind(admin.id, "managed_onboarding_intro");
    expect(workflow).toBeDefined();
    expect(workflow?.message).toContain("Who should I introduce myself to first?");
    expect(workflow?.resolution_mode).toBe("explicit");
    expect(workflow?.metadata).toContain('"openingMessageSent":true');
  });

  it("returns already_exists when the opener was already delivered", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn();
    await settingsRepo.create({ adminEmail: "admin@acme.com", adminPasswordHash: "hash", botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      slackUserId: "UADMIN",
      emailVerified: true,
    });
    await inboxMessagesRepo.create({
      senderUserId: admin.id,
      recipientUserId: admin.id,
      message: "I've added your team to Sketch. Who should I introduce myself to first? Reply with names or @mentions.",
      kind: "managed_onboarding_intro",
      metadata: {
        openingMessageSent: true,
      },
      resolutionMode: "explicit",
      platform: "slack",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendSlackDmToSlackUser,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "already_exists" });
    expect(sendSlackDmToSlackUser).not.toHaveBeenCalled();
  });

  it("retries opener delivery when a workflow exists but opener was not sent", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    await settingsRepo.create({ adminEmail: "admin@acme.com", adminPasswordHash: "hash", botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      slackUserId: "UADMIN",
      emailVerified: true,
    });
    const workflow = await inboxMessagesRepo.create({
      senderUserId: admin.id,
      recipientUserId: admin.id,
      message: "I've added your team to Sketch. Who should I introduce myself to first? Reply with names or @mentions.",
      kind: "managed_onboarding_intro",
      metadata: {
        openingMessageSent: false,
      },
      resolutionMode: "explicit",
      platform: "slack",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendSlackDmToSlackUser,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "started" });
    const updated = await inboxMessagesRepo.findById(workflow.id);
    expect(updated?.metadata).toContain('"openingMessageSent":true');
  });
});

describe("POST /api/system/onboarding/complete", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns 401 without Authorization header", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/onboarding/complete", {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong bearer token", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/onboarding/complete", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
    });

    expect(res.status).toBe(401);
  });

  it("sets onboarding_completed_at in settings", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const before = await settingsRepo.get();
    expect(before?.onboarding_completed_at).toBeNull();

    const res = await app.request("/api/system/onboarding/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const after = await settingsRepo.get();
    expect(after?.onboarding_completed_at).toBeDefined();
    expect(after?.onboarding_completed_at).not.toBeNull();
  });

  it("is idempotent: calling again when already completed returns 200", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res1 = await app.request("/api/system/onboarding/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });
    expect(res1.status).toBe(200);

    const afterFirst = await settingsRepo.get();
    const firstTimestamp = afterFirst?.onboarding_completed_at;

    const res2 = await app.request("/api/system/onboarding/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });
    expect(res2.status).toBe(200);

    const afterSecond = await settingsRepo.get();
    expect(afterSecond?.onboarding_completed_at).toBeDefined();
    expect(afterSecond?.onboarding_completed_at).not.toBeNull();
  });
});

describe("settings.create() with orgName and botName", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("accepts orgName and botName in create()", async () => {
    const settingsRepo = createSettingsRepository(db);
    const hash = await hashPassword("password");

    await settingsRepo.create({
      adminEmail: "admin@acme.com",
      adminPasswordHash: hash,
      orgName: "Acme Corp",
      botName: "AcmeBot",
    });

    const settings = await settingsRepo.get();
    expect(settings?.admin_email).toBe("admin@acme.com");
    expect(settings?.org_name).toBe("Acme Corp");
    expect(settings?.bot_name).toBe("AcmeBot");
  });

  it("creates settings without orgName and botName (backward compatible)", async () => {
    const settingsRepo = createSettingsRepository(db);
    const hash = await hashPassword("password");

    await settingsRepo.create({
      adminEmail: "admin@acme.com",
      adminPasswordHash: hash,
    });

    const settings = await settingsRepo.get();
    expect(settings?.admin_email).toBe("admin@acme.com");
    expect(settings?.org_name).toBeNull();
  });
});

describe("PUT /api/system/integrations/canvas", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates Canvas provider with correct fields", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "canvas_sk_test_key", apiUrl: "https://app.canvasx.ai" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const provider = await mcpServers.findByType("canvas");
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("canvas");
    expect(provider?.display_name).toBe("Canvas");
    expect(provider?.url).toBe("https://app.canvasx.ai/mcp");
    expect(provider?.api_url).toBe("https://app.canvasx.ai");
    expect(provider?.credentials).toBe(JSON.stringify({ apiKey: "canvas_sk_test_key" }));
    expect(provider?.mode).toBe("skill");
  });

  it("updates existing provider on second call (idempotent)", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "key-1", apiUrl: "https://canvas-v1.example.com" }),
    });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "key-2", apiUrl: "https://canvas-v2.example.com" }),
    });

    expect(res.status).toBe(200);

    const all = await mcpServers.listAll();
    const canvasProviders = all.filter((s) => s.type === "canvas");
    expect(canvasProviders).toHaveLength(1);
    expect(canvasProviders[0].credentials).toBe(JSON.stringify({ apiKey: "key-2" }));
    expect(canvasProviders[0].api_url).toBe("https://canvas-v2.example.com");
    expect(canvasProviders[0].url).toBe("https://canvas-v2.example.com/mcp");
  });

  it("returns 401 without authorization", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "canvas_sk_test_key", apiUrl: "https://app.canvasx.ai" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 with missing apiKey", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiUrl: "https://app.canvasx.ai" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 with missing apiUrl", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "canvas_sk_test_key" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 with invalid apiUrl", async () => {
    const settingsRepo = createSettingsRepository(db);
    const mcpServers = createMcpServerRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, mcpServers });

    const res = await app.request("/api/system/integrations/canvas", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: "canvas_sk_test_key", apiUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
  });
});

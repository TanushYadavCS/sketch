import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import type { createEntityRepository } from "../db/repositories/entities";
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
  const users = createUserRepository(db);
  const hash = await hashPassword("testpassword123");
  await settings.create();
  await users.create({
    name: "admin",
    email: "admin@test.com",
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
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
    entityRepo?: ReturnType<typeof createEntityRepository>;
    inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
    mcpServers?: ReturnType<typeof createMcpServerRepository>;
    sendSlackDmToSlackUser?: (params: {
      slackUserId: string;
      message: string;
    }) => Promise<{ channelId: string; messageRef: string }>;
    sendDm?: (params: {
      userId: string;
      platform: "slack" | "whatsapp";
      message: string;
      template?: unknown;
      senderUserId?: string;
      storeInInbox?: boolean;
      inboxKind?: string;
      inboxMetadata?: Record<string, unknown> | null;
    }) => Promise<{
      channelId: string;
      messageRef: string;
      inboxMessageId?: string;
    }>;
    whatsappStatus?: () => { connected: boolean; phoneNumber: string | null; pairingInProgress: boolean };
    startWhatsAppPairing?: ReturnType<typeof vi.fn>;
    cancelWhatsAppPairing?: ReturnType<typeof vi.fn>;
    disconnectWhatsApp?: () => Promise<void>;
    reconcileManagedMembers?: () => Promise<{
      skipped: boolean;
      total: number;
      synced: number;
      conflictUserIds: string[];
      failedUserIds: string[];
    }>;
    syncManagedMemberMapping?: (input: {
      tenantUserId: string;
      email: string;
      name: string;
      phoneNumber: string;
      sendInvite?: boolean;
    }) => Promise<void>;
    withManagedMemberSyncLocks?: <T>(tenantUserIds: string[], operation: () => Promise<T>) => Promise<T>;
  },
) {
  const app = new Hono();
  app.route("/api/system", systemRoutes(settingsRepo, deps));
  return app;
}

function createManagedMemberLockRecorder() {
  const calls: string[][] = [];
  return {
    calls,
    withLocks: async <T>(tenantUserIds: string[], operation: () => Promise<T>): Promise<T> => {
      calls.push(tenantUserIds);
      return operation();
    },
  };
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

describe("POST /api/system/managed-member-reconciliations", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs the configured reconciliation behind system authentication", async () => {
    const reconcileManagedMembers = vi.fn(async () => ({
      skipped: false,
      total: 3,
      synced: 2,
      conflictUserIds: [],
      failedUserIds: ["user-3"],
    }));
    const app = createTestSystemApp(createSettingsRepository(db), {
      systemSecret: SYSTEM_SECRET,
      reconcileManagedMembers,
    });

    const res = await app.request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: false,
      total: 3,
      synced: 2,
      conflictUserIds: [],
      failedUserIds: ["user-3"],
    });
    expect(reconcileManagedMembers).toHaveBeenCalledOnce();
  });

  it("returns unavailable when reconciliation is not configured", async () => {
    const app = createTestSystemApp(createSettingsRepository(db), { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(503);
  });
});

describe("PUT /api/system/api-key", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates and returns a Sketch API key when none exists", async () => {
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/api-key", {
      method: "PUT",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; apiKey: string };
    expect(body.configured).toBe(true);
    expect(body.apiKey).toMatch(/^sk_live_/);

    const raw = await rawField(db, "sketch_api_key");
    expect(raw).not.toBe(body.apiKey);
    expect(raw?.startsWith("enc:")).toBe(true);
  });

  it("returns the existing Sketch API key on rerun", async () => {
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const first = await app.request("/api/system/api-key", {
      method: "PUT",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });
    const firstBody = (await first.json()) as { apiKey: string };

    const second = await app.request("/api/system/api-key", {
      method: "PUT",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });
    const secondBody = (await second.json()) as { apiKey: string };

    expect(second.status).toBe(200);
    expect(secondBody.apiKey).toBe(firstBody.apiKey);
  });

  it("returns one Sketch API key for concurrent ensure requests", async () => {
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const [first, second] = await Promise.all([
      app.request("/api/system/api-key", {
        method: "PUT",
        headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
      }),
      app.request("/api/system/api-key", {
        method: "PUT",
        headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
      }),
    ]);
    const firstBody = (await first.json()) as { apiKey: string };
    const secondBody = (await second.json()) as { apiKey: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.apiKey).toBe(secondBody.apiKey);

    const settingsRow = await settingsRepo.get();
    expect(settingsRow?.sketch_api_key).toBe(firstBody.apiKey);
  });

  it("rejects calls without the system secret", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/api-key", { method: "PUT" });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/system/entities/graph/hotness-recomputations", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs a hotness recomputation batch with cursor and limit", async () => {
    const settingsRepo = createSettingsRepository(db);
    const entityRepo = {
      recomputeHotnessBatch: vi.fn().mockResolvedValue({ processed: 25, nextCursor: "entity-25", done: false }),
    } as unknown as ReturnType<typeof createEntityRepository>;
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, entityRepo });

    const res = await app.request("/api/system/entities/graph/hotness-recomputations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cursor: "entity-0", limit: 25 }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ processed: 25, nextCursor: "entity-25", done: false });
    expect(entityRepo.recomputeHotnessBatch).toHaveBeenCalledWith({ cursor: "entity-0", limit: 25 });
  });

  it("defaults the batch request body", async () => {
    const settingsRepo = createSettingsRepository(db);
    const entityRepo = {
      recomputeHotnessBatch: vi.fn().mockResolvedValue({ processed: 0, nextCursor: null, done: true }),
    } as unknown as ReturnType<typeof createEntityRepository>;
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, entityRepo });

    const res = await app.request("/api/system/entities/graph/hotness-recomputations", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ processed: 0, nextCursor: null, done: true });
    expect(entityRepo.recomputeHotnessBatch).toHaveBeenCalledWith({ limit: 500 });
  });

  it("rejects invalid batch limits", async () => {
    const settingsRepo = createSettingsRepository(db);
    const entityRepo = {
      recomputeHotnessBatch: vi.fn(),
    } as unknown as ReturnType<typeof createEntityRepository>;
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, entityRepo });

    const res = await app.request("/api/system/entities/graph/hotness-recomputations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 0 }),
    });

    expect(res.status).toBe(400);
    expect(entityRepo.recomputeHotnessBatch).not.toHaveBeenCalled();
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
    expect(settings?.org_name).toBe("Acme Corp");
    expect(settings?.bot_name).toBe("AcmeBot");
    const admin = await userRepo.findByEmail("admin@acme.com");
    expect(admin?.auth_role).toBe("admin");
    expect(admin?.password_hash).toBe(hash);
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
    expect(settings?.org_name).toBe("Acme Updated");
    const admin = await userRepo.findByEmail("updated@acme.com");
    expect(admin?.auth_role).toBe("admin");
    expect(admin?.password_hash).toBe(newHash);
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

  it("creates an auth admin without a password hash when managed identity has no local password", async () => {
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
        adminEmail: "oauth-admin@acme.com",
        orgName: "Acme",
        name: "OAuth Admin",
      }),
    });

    expect(res.status).toBe(200);

    const user = await userRepo.findByEmail("oauth-admin@acme.com");
    expect(user).toBeDefined();
    expect(user?.name).toBe("OAuth Admin");
    expect(user?.auth_role).toBe("admin");
    expect(user?.password_hash).toBeNull();
    expect(user?.email_verified_at).not.toBeNull();
  });

  it("creates admin user row with WhatsApp number", async () => {
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
        adminEmail: "wa-admin@acme.com",
        name: "WhatsApp Admin",
        whatsappNumber: "+14155552671",
      }),
    });

    expect(res.status).toBe(200);
    const user = await userRepo.findByEmail("wa-admin@acme.com");
    expect(user?.auth_role).toBe("admin");
    expect(user?.whatsapp_number).toBe("+14155552671");
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

  it("updates existing admin user row with WhatsApp number", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      name: "Admin",
      email: "admin-wa-update@acme.com",
      emailVerified: true,
      authRole: "admin",
    });
    const lockRecorder = createManagedMemberLockRecorder();
    const syncManagedMemberMapping = vi.fn(async () => {});

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      withManagedMemberSyncLocks: lockRecorder.withLocks,
      syncManagedMemberMapping,
    });

    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "admin-wa-update@acme.com",
        name: "Admin Updated",
        whatsappNumber: "+919876543210",
      }),
    });

    expect(res.status).toBe(200);
    const user = await userRepo.findById(existing.id);
    expect(user?.name).toBe("Admin Updated");
    expect(user?.auth_role).toBe("admin");
    expect(user?.whatsapp_number).toBe("+919876543210");
    expect(lockRecorder.calls).toEqual([[existing.id]]);
    expect(syncManagedMemberMapping).toHaveBeenCalledWith({
      tenantUserId: existing.id,
      email: "admin-wa-update@acme.com",
      name: "Admin Updated",
      phoneNumber: "+919876543210",
      sendInvite: false,
    });
  });

  it("returns 409 when admin WhatsApp number belongs to another user", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await userRepo.create({
      name: "Existing Member",
      whatsappNumber: "+919876543210",
      authRole: "member",
    });

    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/identity", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        adminEmail: "admin-conflict@acme.com",
        name: "Admin Conflict",
        orgName: "Acme Conflict",
        whatsappNumber: "+919876543210",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "CONFLICT", message: "WhatsApp number is already linked to another user" },
    });
    expect(await settingsRepo.get()).toBeNull();
    expect(await userRepo.findByEmail("admin-conflict@acme.com")).toBeUndefined();
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
    expect(user?.auth_role).toBe("member");
    expect(user?.email_verified_at).toBeTruthy();
    expect(body.userId).toBe(user?.id);
  });

  it("creates a verified WhatsApp member user and returns userId", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const syncManagedMemberMapping = vi.fn(async () => {});
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      syncManagedMemberMapping,
    });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "contractor@gmail.com",
        name: "Contractor",
        whatsappNumber: "+14155550111",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const user = await userRepo.findByWhatsappNumber("+14155550111");
    expect(user?.id).toBe(body.userId);
    expect(user?.email).toBe("contractor@gmail.com");
    expect(user?.name).toBe("Contractor");
    expect(user?.email_verified_at).toBeTruthy();
    expect(syncManagedMemberMapping).toHaveBeenCalledWith({
      tenantUserId: user?.id,
      email: "contractor@gmail.com",
      name: "Contractor",
      phoneNumber: "+14155550111",
      sendInvite: false,
    });
  });

  it("serializes an existing WhatsApp member update by stable user id", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "member@acme.com",
      name: "Member",
      whatsappNumber: "+14155550111",
      type: "human",
    });
    const lockRecorder = createManagedMemberLockRecorder();
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      withManagedMemberSyncLocks: lockRecorder.withLocks,
    });

    const res = await app.request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "member@acme.com",
        name: "Member Updated",
        whatsappNumber: "+14155550111",
      }),
    });

    expect(res.status).toBe(200);
    expect((await userRepo.findById(existing.id))?.name).toBe("Member Updated");
    expect(lockRecorder.calls).toEqual([[existing.id]]);
  });

  it("returns and verifies the existing user when the email already exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "member@acme.com",
      name: "Existing Member",
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
    expect(user?.email_verified_at).toBeTruthy();
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
    expect(bob?.auth_role).toBe("member");
  });

  it("preserves admin auth_role when Slack sync matches the admin by email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin Old",
      emailVerified: true,
      passwordHash: null,
      authRole: "admin",
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ email: "admin@acme.com", name: "Admin From Slack", slackUserId: "UADMIN" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 0, updated: 1 });

    const syncedAdmin = await userRepo.findById(admin.id);
    expect(syncedAdmin?.name).toBe("Admin From Slack");
    expect(syncedAdmin?.slack_user_id).toBe("UADMIN");
    expect(syncedAdmin?.auth_role).toBe("admin");
    expect(syncedAdmin?.password_hash).toBeNull();
  });

  it("locks an existing Slack user when the bulk sync changes their email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "alice-old@acme.com",
      name: "Alice Old",
      slackUserId: "U111",
      emailVerified: true,
    });
    const lockRecorder = createManagedMemberLockRecorder();
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      withManagedMemberSyncLocks: lockRecorder.withLocks,
    });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ email: "alice-new@acme.com", name: "Alice Updated", slackUserId: "U111" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 0, updated: 1 });
    expect(lockRecorder.calls).toEqual([[existing.id]]);
    const synced = await userRepo.findById(existing.id);
    expect(synced?.email).toBe("alice-new@acme.com");
    expect(synced?.name).toBe("Alice Updated");
  });

  it("bulk upserts users by WhatsApp number and email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const existing = await userRepo.create({
      email: "alice@acme.com",
      name: "Alice Old",
      emailVerified: true,
    });
    const lockRecorder = createManagedMemberLockRecorder();
    const syncManagedMemberMapping = vi.fn(async () => {});
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      withManagedMemberSyncLocks: lockRecorder.withLocks,
      syncManagedMemberMapping,
    });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [
          { email: "alice@acme.com", name: "Alice WhatsApp", whatsappNumber: "+14155552671" },
          { email: "bob@acme.com", name: "Bob WhatsApp", whatsappNumber: "+919876543210" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 1, updated: 1 });

    const alice = await userRepo.findById(existing.id);
    expect(alice?.name).toBe("Alice WhatsApp");
    expect(alice?.whatsapp_number).toBe("+14155552671");

    const bob = await userRepo.findByWhatsappNumber("+919876543210");
    expect(bob?.email).toBe("bob@acme.com");
    expect(bob?.name).toBe("Bob WhatsApp");
    expect(bob?.auth_role).toBe("member");
    expect(lockRecorder.calls).toEqual([[existing.id]]);
    expect(syncManagedMemberMapping.mock.calls).toEqual([
      [
        {
          tenantUserId: existing.id,
          email: "alice@acme.com",
          name: "Alice WhatsApp",
          phoneNumber: "+14155552671",
          sendInvite: false,
        },
      ],
      [
        {
          tenantUserId: bob?.id,
          email: "bob@acme.com",
          name: "Bob WhatsApp",
          phoneNumber: "+919876543210",
          sendInvite: false,
        },
      ],
    ]);
  });

  it("bulk upserts Slack and WhatsApp identities from one row", async () => {
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
        users: [
          {
            email: "alice@acme.com",
            name: "Alice Cross Channel",
            slackUserId: "U111",
            whatsappNumber: "+14155552671",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 1, updated: 0 });

    const alice = await userRepo.findByEmail("alice@acme.com");
    expect(alice?.name).toBe("Alice Cross Channel");
    expect(alice?.slack_user_id).toBe("U111");
    expect(alice?.whatsapp_number).toBe("+14155552671");
    expect(alice?.auth_role).toBe("member");
  });

  it("preserves admin auth_role when WhatsApp sync matches the admin by email", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin Old",
      emailVerified: true,
      authRole: "admin",
    });
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET, userRepo });

    const res = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ email: "admin@acme.com", name: "Admin WhatsApp", whatsappNumber: "+14155550000" }],
      }),
    });

    expect(res.status).toBe(200);
    const syncedAdmin = await userRepo.findById(admin.id);
    expect(syncedAdmin?.name).toBe("Admin WhatsApp");
    expect(syncedAdmin?.whatsapp_number).toBe("+14155550000");
    expect(syncedAdmin?.auth_role).toBe("admin");
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

  it("returns 409 when an email is already linked to a different WhatsApp number", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await userRepo.create({
      email: "alice@acme.com",
      name: "Alice",
      whatsappNumber: "+14155550001",
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
        users: [{ email: "alice@acme.com", name: "Alice", whatsappNumber: "+14155550002" }],
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

    const whatsappRes = await app.request("/api/system/users", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        users: [{ name: "Alice", whatsappNumber: "+14155550003" }],
      }),
    });

    expect(whatsappRes.status).toBe(400);
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

  it("stores OpenRouter credentials in settings", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "openrouter",
        apiKey: "sk-or-v1-tenant-virtual-key",
        modelId: "anthropic/claude-sonnet-4.6@preset/sketch-bedrock",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const settings = await settingsRepo.get();
    expect(settings?.llm_provider).toBe("openrouter");
    expect(settings?.anthropic_api_key).toBe("sk-or-v1-tenant-virtual-key");
    expect(settings?.model_id).toBe("anthropic/claude-sonnet-4.6@preset/sketch-bedrock");
  });

  it("normalizes the legacy openrouter_bedrock provider alias to openrouter", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "openrouter_bedrock",
        apiKey: "sk-or-v1-tenant-virtual-key",
        modelId: "anthropic/claude-sonnet-4.6@preset/sketch-bedrock",
      }),
    });

    expect(res.status).toBe(200);

    const settings = await settingsRepo.get();
    expect(settings?.llm_provider).toBe("openrouter");
  });

  it("creates settings before storing OpenRouter credentials when the row is missing", async () => {
    await db.deleteFrom("settings").where("id", "=", "default").execute();
    const settingsRepo = createSettingsRepository(db, TEST_ENCRYPTION_KEY);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "openrouter",
        apiKey: "sk-or-v1-tenant-virtual-key",
        modelId: "anthropic/claude-sonnet-4.6@preset/sketch-bedrock",
      }),
    });

    expect(res.status).toBe(200);

    const settings = await settingsRepo.get();
    expect(settings?.llm_provider).toBe("openrouter");
    expect(settings?.anthropic_api_key).toBe("sk-or-v1-tenant-virtual-key");
    expect(settings?.model_id).toBe("anthropic/claude-sonnet-4.6@preset/sketch-bedrock");

    const rawApiKey = await rawField(db, "anthropic_api_key");
    expect(typeof rawApiKey).toBe("string");
    expect((rawApiKey as string).startsWith("enc:")).toBe(true);
  });

  it("rejects openrouter without modelId", async () => {
    const settingsRepo = createSettingsRepository(db);
    const app = createTestSystemApp(settingsRepo, { systemSecret: SYSTEM_SECRET });

    const res = await app.request("/api/system/llm", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SYSTEM_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "openrouter",
        apiKey: "sk-or-v1-tenant-virtual-key",
      }),
    });

    expect(res.status).toBe(400);
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

describe("POST /api/system/whatsapp/validate-pairing", () => {
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

    const res = await app.request("/api/system/whatsapp/validate-pairing", {
      method: "POST",
      body: JSON.stringify({ adminWhatsappNumber: "+919876543210" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns paired number when it differs from the admin number", async () => {
    const settingsRepo = createSettingsRepository(db);
    const disconnectWhatsApp = vi.fn();
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      whatsappStatus: () => ({ connected: true, phoneNumber: "+14155552671", pairingInProgress: false }),
      disconnectWhatsApp,
    });

    const res = await app.request("/api/system/whatsapp/validate-pairing", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ adminWhatsappNumber: "+919876543210" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, connected: true, phoneNumber: "+14155552671" });
    expect(disconnectWhatsApp).not.toHaveBeenCalled();
  });

  it("disconnects and rejects when paired number matches the admin number", async () => {
    const settingsRepo = createSettingsRepository(db);
    const disconnectWhatsApp = vi.fn().mockResolvedValue(undefined);
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      whatsappStatus: () => ({ connected: true, phoneNumber: "+919876543210", pairingInProgress: false }),
      disconnectWhatsApp,
    });

    const res = await app.request("/api/system/whatsapp/validate-pairing", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ adminWhatsappNumber: "+91 98765 43210" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "SAME_AS_ADMIN_WHATSAPP",
        message: "Use a different WhatsApp number for Sketch. The admin number cannot scan this QR.",
        phoneNumber: "+919876543210",
      },
    });
    expect(disconnectWhatsApp).toHaveBeenCalledOnce();
  });

  it("returns 409 when WhatsApp is not connected", async () => {
    const settingsRepo = createSettingsRepository(db);
    const disconnectWhatsApp = vi.fn();
    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      whatsappStatus: () => ({ connected: false, phoneNumber: null, pairingInProgress: false }),
      disconnectWhatsApp,
    });

    const res = await app.request("/api/system/whatsapp/validate-pairing", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ adminWhatsappNumber: "+919876543210" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "NOT_CONNECTED", message: "WhatsApp is not connected" } });
    expect(disconnectWhatsApp).not.toHaveBeenCalled();
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
      passwordHash: "hash",
      authRole: "admin",
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

  it("uses an auth admin without requiring a local password hash", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    await settingsRepo.create({ botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      slackUserId: "UADMIN",
      emailVerified: true,
      passwordHash: null,
      authRole: "admin",
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
    const workflow = await inboxMessagesRepo.findUnresolvedByRecipientAndKind(admin.id, "managed_onboarding_intro");
    expect(workflow).toBeDefined();
  });

  it("direct-sends WhatsApp introductions without creating inbox workflow rows", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendDm = vi.fn().mockResolvedValue({ channelId: "wa@s.whatsapp.net", messageRef: "" });
    await settingsRepo.create({ botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      whatsappNumber: "+14155552671",
      emailVerified: true,
      authRole: "admin",
    });
    const teammate = await userRepo.create({
      name: "Teammate",
      whatsappNumber: "+919876543210",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendDm,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        channel: "whatsapp",
        orgName: "Acme",
        whatsappNumbers: ["+14155552671", "+919876543210"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "sent", sent: 2, failed: 0 });
    expect(sendDm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: admin.id,
        platform: "whatsapp",
        message:
          "Hi, I'm Sketch, your AI coworker in Acme. You can message me here when you need help with your workspace.",
        template: expect.objectContaining({ key: "whatsapp.introduction" }),
      }),
    );
    expect(sendDm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: teammate.id,
        platform: "whatsapp",
        message:
          "Hi, I'm Sketch, your AI coworker in Acme. You can message me here when you need help with your workspace.",
        template: expect.objectContaining({ key: "whatsapp.introduction" }),
      }),
    );
    const workflow = await inboxMessagesRepo.findUnresolvedByRecipientAndKind(admin.id, "managed_onboarding_intro");
    expect(workflow).toBeUndefined();
  });

  it("surfaces partial WhatsApp introduction delivery failures", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const sendDm = vi
      .fn()
      .mockResolvedValueOnce({ channelId: "admin@s.whatsapp.net", messageRef: "" })
      .mockRejectedValueOnce(new Error("send failed"));
    await settingsRepo.create({ botName: "Sketch" });
    await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      whatsappNumber: "+14155552671",
      emailVerified: true,
      authRole: "admin",
    });
    await userRepo.create({
      name: "Teammate",
      whatsappNumber: "+919876543210",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      sendDm,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        channel: "whatsapp",
        whatsappNumbers: ["+14155552671", "+919876543210"],
      }),
    });

    expect(res.status).toBe(207);
    expect(await res.json()).toMatchObject({ ok: false, status: "partial_failure", sent: 1, failed: 1 });
  });

  it("reports missing WhatsApp introduction recipients as failures", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const sendDm = vi.fn().mockResolvedValue({ channelId: "admin@s.whatsapp.net", messageRef: "" });
    await settingsRepo.create({ botName: "Sketch" });
    const admin = await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      whatsappNumber: "+14155552671",
      emailVerified: true,
      authRole: "admin",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      sendDm,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        channel: "whatsapp",
        whatsappNumbers: ["+14155552671", "+919876543210"],
      }),
    });

    expect(res.status).toBe(207);
    expect(await res.json()).toMatchObject({
      ok: false,
      status: "partial_failure",
      sent: 1,
      failed: 1,
      deliveries: [
        {
          whatsappNumber: "+919876543210",
          ok: false,
          error: "WhatsApp user not found",
        },
        {
          userId: admin.id,
          ok: true,
        },
      ],
    });
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendDm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: admin.id,
        platform: "whatsapp",
        message:
          "Hi, I'm Sketch, your AI coworker in your workspace. You can message me here when you need help with your workspace.",
        template: expect.objectContaining({ key: "whatsapp.introduction" }),
      }),
    );
  });

  it("requires admin WhatsApp number before WhatsApp introductions", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const sendDm = vi.fn();
    await settingsRepo.create({ botName: "Sketch" });
    await userRepo.create({
      email: "admin@acme.com",
      name: "Admin",
      emailVerified: true,
      authRole: "admin",
    });
    await userRepo.create({
      name: "Teammate",
      whatsappNumber: "+919876543210",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      sendDm,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        adminEmail: "admin@acme.com",
        channel: "whatsapp",
        whatsappNumbers: ["+919876543210"],
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "CONFLICT", message: "Admin WhatsApp number is required for WhatsApp introductions" },
    });
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("uses the requested admin email instead of the first admin", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    await settingsRepo.create({ botName: "Sketch" });
    await userRepo.create({
      email: "old-admin@acme.com",
      name: "Old Admin",
      emailVerified: true,
      authRole: "admin",
    });
    const currentAdmin = await userRepo.create({
      email: "current-admin@acme.com",
      name: "Current Admin",
      slackUserId: "UCURRENT",
      emailVerified: true,
      authRole: "admin",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendSlackDmToSlackUser,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ adminEmail: "current-admin@acme.com" }),
    });

    expect(res.status).toBe(200);
    expect(sendSlackDmToSlackUser).toHaveBeenCalledWith({
      slackUserId: "UCURRENT",
      message: "I've added your team to Sketch. Who should I introduce myself to first? Reply with names or @mentions.",
    });
    const workflow = await inboxMessagesRepo.findUnresolvedByRecipientAndKind(
      currentAdmin.id,
      "managed_onboarding_intro",
    );
    expect(workflow).toBeDefined();
  });

  it("does not start introductions for a requested non-admin user", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const sendSlackDmToSlackUser = vi.fn();
    await settingsRepo.create({ botName: "Sketch" });
    await userRepo.create({
      email: "member@acme.com",
      name: "Member",
      slackUserId: "UMEMBER",
      emailVerified: true,
      authRole: "member",
    });

    const app = createTestSystemApp(settingsRepo, {
      systemSecret: SYSTEM_SECRET,
      userRepo,
      inboxMessagesRepo,
      sendSlackDmToSlackUser,
    });

    const res = await app.request("/api/system/onboarding-introductions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SYSTEM_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ adminEmail: "member@acme.com" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "BAD_REQUEST", message: "User is not an admin" } });
    expect(sendSlackDmToSlackUser).not.toHaveBeenCalled();
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
      passwordHash: "hash",
      authRole: "admin",
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
      passwordHash: "hash",
      authRole: "admin",
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

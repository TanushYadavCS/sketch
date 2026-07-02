import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppTemplateMappingRepository } from "../db/repositories/whatsapp-template-mappings";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { SlackBot } from "../slack/bot";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppBot } from "../whatsapp/bot";
import type { WatiWhatsAppProvider } from "../whatsapp/providers/wati";

const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

const config = createTestConfig();
const logger = createTestLogger();

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);

  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

function makeApp(
  db: Kysely<DB>,
  options: { whatsappConnected?: boolean; watiProvider?: Pick<WatiWhatsAppProvider, "listTemplates"> } = {},
) {
  let whatsappConnected = options.whatsappConnected ?? true;
  const slack = {
    listChannels: vi.fn().mockResolvedValue([]),
  } as unknown as SlackBot;
  const whatsapp = {
    get isConnected() {
      return whatsappConnected;
    },
    get phoneNumber() {
      return whatsappConnected ? "+15555550100" : null;
    },
    disconnect: vi.fn().mockImplementation(async () => {
      whatsappConnected = false;
    }),
    cancelPairing: vi.fn(),
    startPairing: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppBot;
  const onSlackDisconnect = vi.fn().mockResolvedValue(undefined);
  const onSmtpUpdated = vi.fn().mockResolvedValue(undefined);

  const app = createApp(db, config, {
    logger,
    getSlack: () => slack,
    whatsapp,
    watiWebhook: options.watiProvider as WatiWhatsAppProvider | undefined,
    onSlackDisconnect,
    onSmtpUpdated,
  });

  return { app, onSlackDisconnect, onSmtpUpdated, whatsapp };
}

describe("Channels API authorization", () => {
  let db: Kysely<DB>;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    const { app } = makeApp(db);
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("allows members to read channel status", async () => {
    const { app } = makeApp(db);

    const res = await app.request("/api/channels/status", {
      headers: { Cookie: memberCookie },
    });

    expect(res.status).toBe(200);
  });

  it("rejects channel management writes from members", async () => {
    const { app, onSlackDisconnect, onSmtpUpdated, whatsapp } = makeApp(db);

    const requests = [
      app.request("/api/channels/slack", { method: "DELETE", headers: { Cookie: memberCookie } }),
      app.request("/api/channels/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          host: "smtp.example.com",
          port: 465,
          user: "user",
          password: "password",
          from: "noreply@example.com",
        }),
      }),
      app.request("/api/channels/email", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          host: "smtp.example.com",
          port: 465,
          user: "user",
          password: "password",
          from: "noreply@example.com",
        }),
      }),
      app.request("/api/channels/email", { method: "DELETE", headers: { Cookie: memberCookie } }),
      app.request("/api/channels/whatsapp/pair", { headers: { Cookie: memberCookie } }),
      app.request("/api/channels/whatsapp", { method: "DELETE", headers: { Cookie: memberCookie } }),
      app.request("/api/channels/whatsapp/templates/provider", { headers: { Cookie: memberCookie } }),
      app.request("/api/channels/whatsapp/templates/mappings", { headers: { Cookie: memberCookie } }),
      app.request("/api/channels/whatsapp/templates/mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          logicalKey: "whatsapp.magic_link",
          providerTemplateName: "sketch_magic_link",
        }),
      }),
      app.request("/api/channels/whatsapp/templates/sync", {
        method: "POST",
        headers: { Cookie: memberCookie },
      }),
      app.request("/api/setup/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ botToken: "xoxb-member", appToken: "xapp-member" }),
      }),
      app.request("/api/setup/slack/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ botToken: "xoxb-member", appToken: "xapp-member" }),
      }),
    ];

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    expect(onSlackDisconnect).not.toHaveBeenCalled();
    expect(onSmtpUpdated).not.toHaveBeenCalled();
    expect(whatsapp.disconnect).not.toHaveBeenCalled();
    expect(whatsapp.startPairing).not.toHaveBeenCalled();
  });

  it("does not expose legacy email channel routes", async () => {
    const { app } = makeApp(db);

    const requests = [
      app.request("/api/channels/email/verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          host: "smtp.example.com",
          port: 465,
          user: "user",
          password: "password",
          from: "noreply@example.com",
          secure: true,
        }),
      }),
      app.request("/api/channels/email/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          host: "smtp.example.com",
          port: 465,
          user: "user",
          password: "password",
          from: "noreply@example.com",
          secure: true,
        }),
      }),
      app.request("/api/channels/email/config", { method: "DELETE", headers: { Cookie: adminCookie } }),
      app.request("/api/channels/email/verification-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ email: "user@example.com" }),
      }),
      app.request("/api/channels/email/verification-codes/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ email: "user@example.com", code: "123456" }),
      }),
    ];

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(404);
    }
  });

  it("keeps representative channel management writes available to admins", async () => {
    const { app, onSlackDisconnect, onSmtpUpdated, whatsapp } = makeApp(db);

    const slackRes = await app.request("/api/channels/slack", { method: "DELETE", headers: { Cookie: adminCookie } });
    expect(slackRes.status).toBe(200);
    expect(onSlackDisconnect).toHaveBeenCalledTimes(1);

    const saveEmailRes = await app.request("/api/channels/email", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        host: "smtp.example.com",
        port: 465,
        user: "user",
        password: "password",
        from: "noreply@example.com",
      }),
    });
    expect(saveEmailRes.status).toBe(200);

    const settingsAfterSave = await createSettingsRepository(db).get();
    expect(settingsAfterSave?.smtp_host).toBe("smtp.example.com");

    const deleteEmailRes = await app.request("/api/channels/email", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(deleteEmailRes.status).toBe(200);
    expect(onSmtpUpdated).toHaveBeenCalledTimes(2);

    const whatsappRes = await app.request("/api/channels/whatsapp", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(whatsappRes.status).toBe(200);
    expect(whatsapp.disconnect).toHaveBeenCalledTimes(1);

    const slackSetupRes = await app.request("/api/setup/slack", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ botToken: "xoxb-admin", appToken: "xapp-admin" }),
    });
    expect(slackSetupRes.status).toBe(200);

    const settingsAfterSlack = await createSettingsRepository(db).get();
    expect(settingsAfterSlack?.slack_bot_token).toBe("xoxb-admin");
    expect(settingsAfterSlack?.slack_app_token).toBe("xapp-admin");
  });

  it("allows admins to configure and sync WhatsApp template mappings", async () => {
    const listTemplates = vi.fn().mockResolvedValue([
      {
        providerTemplateName: "sketch_magic_link",
        language: "en_US",
        status: "APPROVED",
        category: "UTILITY",
      },
    ]);
    const { app } = makeApp(db, { watiProvider: { listTemplates } });

    const upsertRes = await app.request("/api/channels/whatsapp/templates/mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        logicalKey: "whatsapp.magic_link",
        providerTemplateName: "sketch_magic_link",
        status: "pending",
        parameterMap: { name: "recipientName", link: "magicLinkUrl" },
      }),
    });
    expect(upsertRes.status).toBe(200);
    await expect(upsertRes.json()).resolves.toMatchObject({
      mapping: {
        provider: "wati",
        logical_key: "whatsapp.magic_link",
        provider_template_name: "sketch_magic_link",
        status: "pending",
      },
    });

    const syncRes = await app.request("/api/channels/whatsapp/templates/sync", {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(syncRes.status).toBe(200);
    await expect(syncRes.json()).resolves.toMatchObject({ provider: "wati", updatedMappings: 1 });
    expect(listTemplates).toHaveBeenCalledOnce();

    const mappingsRes = await app.request("/api/channels/whatsapp/templates/mappings?provider=wati", {
      headers: { Cookie: adminCookie },
    });
    expect(mappingsRes.status).toBe(200);
    await expect(mappingsRes.json()).resolves.toMatchObject({
      mappings: [
        {
          provider: "wati",
          logical_key: "whatsapp.magic_link",
          provider_template_name: "sketch_magic_link",
          status: "approved",
          category: "UTILITY",
        },
      ],
    });

    const mapping = await createWhatsAppTemplateMappingRepository(db).findApprovedMapping(
      "wati",
      "whatsapp.magic_link",
    );
    expect(mapping?.parameterMap).toEqual({ name: "recipientName", link: "magicLinkUrl" });
  });
});

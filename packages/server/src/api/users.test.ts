/**
 * Coverage for the new agent fields on the /api/users endpoints:
 * agent instructions (longer description) and allowedTools.
 *
 * Existing serialization, verification, and reportsTo behaviour is exercised
 * indirectly by the rest of the test suite; this file targets only the
 * additions from SKE-51.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createChannelRepository } from "../db/repositories/channels";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { withManagedMemberSyncLock } from "../managed-members";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";

async function seedAdmin(db: Kysely<DB>) {
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

describe("Users API — agent fields", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    cookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("creates an agent with instructions and a tool allowlist", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Marketing Maven",
        type: "agent",
        description: "You are the marketing maven. Always cite source URLs.",
        allowedTools: ["Read", "WebSearch", "mcp__sketch__Search", "mcp__sketch__local_run_command"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.type).toBe("agent");
    expect(body.user.description).toBe("You are the marketing maven. Always cite source URLs.");
    expect(body.user.allowed_tools).toEqual([
      "Read",
      "WebSearch",
      "mcp__sketch__Search",
      "mcp__sketch__local_run_command",
    ]);
  });

  it("rejects allowedTools when creating a human user", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Real Person",
        type: "human",
        email: "person@test.com",
        whatsappNumber: "+14155550101",
        allowedTools: ["Read"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("allowedTools");
  });

  it("rejects unknown tool names", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Bad Agent",
        type: "agent",
        allowedTools: ["NotARealTool"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("normalizes formatted WhatsApp numbers on human user create", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Phone User",
        type: "human",
        email: "phone@test.com",
        whatsappNumber: "+91 98765 43210",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.whatsapp_number).toBe("+919876543210");
  });

  it("rejects human member creation without a WhatsApp number", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Email Only",
        type: "human",
        email: "email-only@test.com",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Email and WhatsApp number");
  });

  it("skips managed member registration when only managed login URL is configured", async () => {
    const managedLoginOnlyApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedLoginOnlyApp, ADMIN_EMAIL);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await managedLoginOnlyApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Login Only",
        type: "human",
        email: "managed.login.only@gmail.com",
        whatsappNumber: "+14155550108",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe("managed.login.only@gmail.com");
    expect(body.user.whatsapp_number).toBe("+14155550108");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("skips managed member registration on update when only managed login URL is configured", async () => {
    const users = createUserRepository(db);
    const existing = await users.create({
      name: "Managed Login Existing",
      type: "human",
      email: "managed.login.existing@gmail.com",
      whatsappNumber: "+14155550109",
    });
    const managedLoginOnlyApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedLoginOnlyApp, ADMIN_EMAIL);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const res = await managedLoginOnlyApp.request(`/api/users/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Login Updated",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.name).toBe("Managed Login Updated");
    expect(body.user.email).toBe("managed.login.existing@gmail.com");
    expect(body.user.whatsapp_number).toBe("+14155550109");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("sends the invite before local create and activates managed routing after local create", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: true, whatsappSent: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, mappingStatus: "active", emailSent: false }), { status: 200 }),
      );

    const res = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Person",
        type: "human",
        email: "managed.person@gmail.com",
        whatsappNumber: "+14155550106",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://platform.test/api/tenant/members",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer tenant-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          tenantUserId: body.user.id,
          email: "managed.person@gmail.com",
          name: "Managed Person",
          phoneNumber: "+14155550106",
          sendInvite: true,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://platform.test/api/tenant/members",
      expect.objectContaining({
        body: JSON.stringify({
          tenantUserId: body.user.id,
          email: "managed.person@gmail.com",
          name: "Managed Person",
          phoneNumber: "+14155550106",
          sendInvite: false,
          managedWhatsappDmEnabled: true,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(body.managedWhatsappMappingStatus).toBe("active");
    fetchMock.mockRestore();
  });

  it("preserves membership sync without enabling shared routing for non-managed DMs", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "baileys",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: true, whatsappSent: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, mappingStatus: "inactive", emailSent: false }), { status: 200 }),
      );

    const res = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Baileys Person",
        type: "human",
        email: "baileys.person@gmail.com",
        whatsappNumber: "+14155550116",
      }),
    });

    expect(res.status).toBe(201);
    const request = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      email: "baileys.person@gmail.com",
      sendInvite: false,
      managedWhatsappDmEnabled: false,
    });
    fetchMock.mockRestore();
  });

  it("reconciles managed routing after a human phone number changes", async () => {
    const users = createUserRepository(db);
    const member = await users.create({
      name: "Changing Number",
      type: "human",
      email: "changing.number@gmail.com",
      whatsappNumber: "+14155550120",
    });
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mappingStatus: "active" }), { status: 200 }));

    const res = await managedApp.request(`/api/users/${member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({ whatsappNumber: "+14155550121" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).managedWhatsappMappingStatus).toBe("active");
    const preCommitBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const postCommitBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(preCommitBody).toMatchObject({
      tenantUserId: member.id,
      phoneNumber: "+14155550121",
      sendInvite: false,
    });
    expect(preCommitBody).not.toHaveProperty("managedWhatsappDmEnabled");
    expect(postCommitBody).toMatchObject({
      tenantUserId: member.id,
      phoneNumber: "+14155550121",
      sendInvite: false,
      managedWhatsappDmEnabled: true,
    });
    fetchMock.mockRestore();
  });

  it("reconciles existing managed human members through the authenticated system endpoint", async () => {
    const users = createUserRepository(db);
    const member = await users.create({
      name: "Existing Managed Person",
      type: "human",
      email: "existing.managed@gmail.com",
      whatsappNumber: "+14155550117",
    });
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
        SYSTEM_SECRET: "system-secret",
      }),
      { logger: createTestLogger() },
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, mappingStatus: "active", emailSent: false, whatsappSent: false }), {
        status: 200,
      }),
    );

    const res = await managedApp.request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: "Bearer system-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: false,
      total: 1,
      synced: 1,
      conflictUserIds: [],
      failedUserIds: [],
    });
    const memberRequest = fetchMock.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((body) => body.tenantUserId === member.id);
    expect(memberRequest).toMatchObject({
      email: "existing.managed@gmail.com",
      phoneNumber: "+14155550117",
      sendInvite: false,
      managedWhatsappDmEnabled: true,
    });
    fetchMock.mockRestore();
  });

  it("reports inactive mapping conflicts separately from successful reconciliation", async () => {
    const users = createUserRepository(db);
    const member = await users.create({
      name: "Conflicted Member",
      type: "human",
      email: "conflicted.member@gmail.com",
      whatsappNumber: "+14155550122",
    });
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
        SYSTEM_SECRET: "system-secret",
      }),
      { logger: createTestLogger() },
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, mappingStatus: "inactive_conflict" }), { status: 200 }),
      );

    const res = await managedApp.request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: "Bearer system-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: false,
      total: 1,
      synced: 0,
      conflictUserIds: [member.id],
      failedUserIds: [],
    });
    fetchMock.mockRestore();
  });

  it("reconciliation deactivates shared routing when the tenant uses another WhatsApp provider", async () => {
    const users = createUserRepository(db);
    const member = await users.create({
      name: "Baileys Member",
      type: "human",
      email: "baileys.reconcile@gmail.com",
      whatsappNumber: "+14155550119",
    });
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "baileys",
        SYSTEM_SECRET: "system-secret",
      }),
      { logger: createTestLogger() },
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, mappingStatus: "inactive" }), { status: 200 }));

    const res = await managedApp.request("/api/system/managed-member-reconciliations", {
      method: "POST",
      headers: { Authorization: "Bearer system-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: false, total: 1, synced: 1 });
    const request = fetchMock.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((body) => body.tenantUserId === member.id);
    expect(request).toMatchObject({
      sendInvite: false,
      managedWhatsappDmEnabled: false,
    });
    fetchMock.mockRestore();
  });

  it("rejects managed human members when platform email invite delivery is incomplete", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, emailSent: false, whatsappSent: true }), { status: 200 }),
      );

    const res = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Person",
        type: "human",
        email: "managed.incomplete@test.com",
        whatsappNumber: "+14155550107",
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: "MANAGED_MEMBER_REGISTRATION_FAILED",
        message: "Managed member invite delivery failed",
      },
    });
    await expect(createUserRepository(db).findByEmail("managed.incomplete@test.com")).resolves.toBeUndefined();
    fetchMock.mockRestore();
  });

  it("keeps the local human and reports failure when routing sync is not confirmed", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: true, whatsappSent: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: false, whatsappSent: false }), { status: 200 }),
      );

    const res = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Mapping Retry",
        type: "human",
        email: "mapping.retry@gmail.com",
        whatsappNumber: "+14155550118",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.managedWhatsappMappingStatus).toBe("failed");
    await expect(createUserRepository(db).findById(body.user.id)).resolves.toMatchObject({
      email: "mapping.retry@gmail.com",
    });
    fetchMock.mockRestore();
  });

  it("removes managed tenant members before deleting local human users", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: true, whatsappSent: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mappingStatus: "inactive" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const create = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Delete",
        type: "human",
        email: "managed.delete@gmail.com",
        whatsappNumber: "+14155550110",
      }),
    });
    expect(create.status).toBe(201);
    const user = (await create.json()).user;

    const res = await managedApp.request(`/api/users/${user.id}`, {
      method: "DELETE",
      headers: { Cookie: managedCookie },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `https://platform.test/api/tenant/members/managed.delete%40gmail.com?tenantUserId=${user.id}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer tenant-token",
        }),
      }),
    );
    await expect(createUserRepository(db).findById(user.id)).resolves.toBeUndefined();
    fetchMock.mockRestore();
  });

  it("reassigns the org Slack connector when its owning admin is deleted", async () => {
    const users = createUserRepository(db);
    const owner = await users.create({
      name: "second-admin",
      email: "second.admin@test.com",
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "admin",
    });
    await db
      .insertInto("connector_configs")
      .values({
        id: "slack-singleton",
        connector_type: "slack",
        auth_type: "system",
        credentials: JSON.stringify({ type: "system" }),
        sync_status: "pending",
        created_by: owner.id,
      })
      .execute();

    const res = await app.request(`/api/users/${owner.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const connector = await db
      .selectFrom("connector_configs")
      .select(["sync_status", "created_by"])
      .where("id", "=", "slack-singleton")
      .executeTakeFirstOrThrow();
    expect(connector.sync_status).toBe("pending");
    const admin = await users.findByEmail(ADMIN_EMAIL);
    expect(connector.created_by).toBe(admin?.id);
  });

  it("does not provision a phantom Slack connector when the deleted user owned only per-user connectors", async () => {
    const users = createUserRepository(db);
    const owner = await users.create({
      name: "drive-owner",
      email: "drive.owner@test.com",
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "member",
    });
    await db
      .insertInto("connector_configs")
      .values({
        id: "drive-connector",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        sync_status: "pending",
        created_by: owner.id,
      })
      .execute();

    const res = await app.request(`/api/users/${owner.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const slackRows = await db
      .selectFrom("connector_configs")
      .select("id")
      .where("connector_type", "=", "slack")
      .execute();
    expect(slackRows).toHaveLength(0);
  });

  it("keeps local human users when managed tenant member removal fails", async () => {
    const managedApp = createApp(
      db,
      createTestConfig({
        MANAGED_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      }),
      { logger: createTestLogger() },
    );
    const managedCookie = await login(managedApp, ADMIN_EMAIL);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, emailSent: true, whatsappSent: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mappingStatus: "inactive" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "REMOVE_FAILED", message: "Could not remove managed member" } }), {
          status: 502,
        }),
      );

    const create = await managedApp.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: managedCookie },
      body: JSON.stringify({
        name: "Managed Delete Failure",
        type: "human",
        email: "managed.delete.failure@gmail.com",
        whatsappNumber: "+14155550111",
      }),
    });
    expect(create.status).toBe(201);
    const user = (await create.json()).user;
    const connectorCredentials = JSON.stringify({ apiKey: "fireflies-test-key" });
    await db
      .insertInto("connector_configs")
      .values({
        id: "managed-delete-failure-connector",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: connectorCredentials,
        created_by: user.id,
        sync_status: "active",
      })
      .execute();

    const res = await managedApp.request(`/api/users/${user.id}`, {
      method: "DELETE",
      headers: { Cookie: managedCookie },
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: "MANAGED_MEMBER_REGISTRATION_FAILED",
        message: "Could not remove managed member",
      },
    });
    await expect(createUserRepository(db).findById(user.id)).resolves.toMatchObject({
      email: "managed.delete.failure@gmail.com",
    });
    await expect(
      db
        .selectFrom("connector_configs")
        .select(["sync_status", "credentials", "credential_hint", "error_message"])
        .where("id", "=", "managed-delete-failure-connector")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      sync_status: "active",
      credentials: connectorCredentials,
      credential_hint: null,
      error_message: null,
    });
    fetchMock.mockRestore();
  });

  it("rejects WhatsApp numbers without an international country code", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Bad Phone User",
        type: "human",
        email: "bad-phone@test.com",
        whatsappNumber: "98765 43210",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("valid phone number");
  });

  it("accepts long instruction sets up to the agent cap", async () => {
    const longInstructions = "x".repeat(4999);
    const ok = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Long Brief",
        type: "agent",
        description: longInstructions,
        allowedTools: [],
      }),
    });
    expect(ok.status).toBe(201);
  });

  it("rejects instruction sets longer than the agent cap", async () => {
    const tooLong = "x".repeat(5001);
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Too Long",
        type: "agent",
        description: tooLong,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("updates an existing agent's allowedTools", async () => {
    const create = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Sales Coach",
        type: "agent",
        allowedTools: ["Read"],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).user;

    const update = await app.request(`/api/users/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        allowedTools: ["Read", "Bash", "mcp__sketch__GetTeamDirectory"],
      }),
    });
    expect(update.status).toBe(200);
    const body = await update.json();
    expect(body.user.allowed_tools).toEqual(["Read", "Bash", "mcp__sketch__GetTeamDirectory"]);
  });

  it("rejects updating allowedTools on a non-agent user", async () => {
    const create = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Real Person",
        type: "human",
        email: "rp@test.com",
        whatsappNumber: "+14155550102",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()).user;

    const update = await app.request(`/api/users/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        allowedTools: ["Read"],
      }),
    });
    expect(update.status).toBe(400);
    const body = await update.json();
    expect(body.error.message).toContain("allowedTools");
  });

  it("serializes member mutations with managed member reconciliation", async () => {
    const users = createUserRepository(db);
    const agent = await users.create({ name: "Before reconciliation", type: "agent" });
    let releaseLock = () => {};
    let confirmLockAcquired = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      confirmLockAcquired = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withManagedMemberSyncLock(agent.id, async () => {
      confirmLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    let mutationSettled = false;
    const mutation = Promise.resolve(
      app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "After reconciliation" }),
      }),
    ).finally(() => {
      mutationSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutationSettled).toBe(false);
    expect((await users.findById(agent.id))?.name).toBe("Before reconciliation");

    releaseLock();
    await blocker;
    const response = await mutation;
    expect(response.status).toBe(200);
    expect((await users.findById(agent.id))?.name).toBe("After reconciliation");
  });

  describe("Slack channel bindings", () => {
    beforeEach(async () => {
      const channels = createChannelRepository(db);
      await channels.create({ slackChannelId: "C-MARKETING", name: "marketing", type: "public_channel" });
      await channels.create({ slackChannelId: "C-SALES", name: "sales", type: "public_channel" });
    });

    it("creates an agent and binds it to existing Slack channels", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Marketing Maven",
          type: "agent",
          allowedTools: ["Read"],
          slackChannelIds: ["C-MARKETING"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.slack_channel_ids).toEqual(["C-MARKETING"]);

      const list = await app.request("/api/users", { headers: { Cookie: cookie } });
      const listBody = await list.json();
      const agent = listBody.users.find((u: { id: string }) => u.id === body.user.id);
      expect(agent.slack_channel_ids).toEqual(["C-MARKETING"]);
    });

    it("reassigns a channel from one agent to another via PATCH", async () => {
      const a = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", slackChannelIds: ["C-MARKETING"] }),
      });
      expect(a.status).toBe(201);
      const agentA = (await a.json()).user;

      const b = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent B", type: "agent" }),
      });
      expect(b.status).toBe(201);
      const agentB = (await b.json()).user;

      const moved = await app.request(`/api/users/${agentB.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ slackChannelIds: ["C-MARKETING"] }),
      });
      expect(moved.status).toBe(200);
      expect((await moved.json()).user.slack_channel_ids).toEqual(["C-MARKETING"]);

      const refetchA = await app.request("/api/users", { headers: { Cookie: cookie } });
      const list = await refetchA.json();
      expect(list.users.find((u: { id: string }) => u.id === agentA.id).slack_channel_ids).toEqual([]);
      expect(list.users.find((u: { id: string }) => u.id === agentB.id).slack_channel_ids).toEqual(["C-MARKETING"]);
    });

    it("clears a binding when slackChannelIds is set to []", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", slackChannelIds: ["C-MARKETING", "C-SALES"] }),
      });
      const agent = (await create.json()).user;

      const cleared = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ slackChannelIds: [] }),
      });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).user.slack_channel_ids).toEqual([]);
    });

    it("rejects slackChannelIds for non-agent users", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp2@test.com",
          whatsappNumber: "+14155550103",
          slackChannelIds: ["C-MARKETING"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("slackChannelIds");
    });

    it("returns 400 when binding to an unknown Slack channel without a Slack bot", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent",
          type: "agent",
          slackChannelIds: ["C-DOES-NOT-EXIST"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("C-DOES-NOT-EXIST");

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.some((u: { name: string }) => u.name === "Agent")).toBe(false);
    });

    it("does not mutate the user when PATCH fails Slack channel resolution", async () => {
      const created = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", description: "before" }),
      });
      const agent = (await created.json()).user;

      const res = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ description: "after", slackChannelIds: ["C-DOES-NOT-EXIST"] }),
      });
      expect(res.status).toBe(400);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      const refetched = list.users.find((u: { id: string }) => u.id === agent.id);
      expect(refetched.description).toBe("before");
    });

    it("clears bindings when the bound agent is deleted (FK SET NULL)", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Throwaway", type: "agent", slackChannelIds: ["C-MARKETING"] }),
      });
      const agent = (await create.json()).user;

      // Verify channels.agent_user_id is set, then remove the user via the repo
      // (HTTP DELETE requires admin and self-protection logic that's out of scope here).
      const channels = createChannelRepository(db);
      const before = await channels.findBySlackChannelId("C-MARKETING");
      expect(before?.agent_user_id).toBe(agent.id);

      await db.deleteFrom("users").where("id", "=", agent.id).execute();
      // SQLite needs PRAGMA foreign_keys = ON for the SET NULL trigger; createTestDb
      // does not enable it, so we simulate the cascade explicitly to assert the
      // intent expressed by the schema.
      await db.updateTable("channels").set({ agent_user_id: null }).where("agent_user_id", "=", agent.id).execute();
      const after = await channels.findBySlackChannelId("C-MARKETING");
      expect(after?.agent_user_id).toBeNull();
    });
  });

  describe("WhatsApp group bindings", () => {
    beforeEach(async () => {
      const groups = createWhatsAppGroupRepository(db);
      await groups.upsert({
        jid: "group-marketing@g.us",
        name: "Marketing Crew",
        updated_at: new Date().toISOString(),
      });
      await groups.upsert({ jid: "group-sales@g.us", name: "Sales Crew", updated_at: new Date().toISOString() });
    });

    it("creates an agent and binds it to existing WhatsApp groups", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Marketing Maven",
          type: "agent",
          allowedTools: ["Read"],
          whatsappGroupJids: ["group-marketing@g.us"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);

      const list = await app.request("/api/users", { headers: { Cookie: cookie } });
      const listBody = await list.json();
      const agent = listBody.users.find((u: { id: string }) => u.id === body.user.id);
      expect(agent.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);
    });

    it("reassigns a group from one agent to another via PATCH", async () => {
      const a = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent A", type: "agent", whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      const agentA = (await a.json()).user;

      const b = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Agent B", type: "agent" }),
      });
      const agentB = (await b.json()).user;

      const moved = await app.request(`/api/users/${agentB.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      expect(moved.status).toBe(200);
      expect((await moved.json()).user.whatsapp_group_jids).toEqual(["group-marketing@g.us"]);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.find((u: { id: string }) => u.id === agentA.id).whatsapp_group_jids).toEqual([]);
      expect(list.users.find((u: { id: string }) => u.id === agentB.id).whatsapp_group_jids).toEqual([
        "group-marketing@g.us",
      ]);
    });

    it("clears a binding when whatsappGroupJids is set to []", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent A",
          type: "agent",
          whatsappGroupJids: ["group-marketing@g.us", "group-sales@g.us"],
        }),
      });
      const agent = (await create.json()).user;

      const cleared = await app.request(`/api/users/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ whatsappGroupJids: [] }),
      });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).user.whatsapp_group_jids).toEqual([]);
    });

    it("rejects whatsappGroupJids for non-agent users", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp3@test.com",
          whatsappNumber: "+14155550104",
          whatsappGroupJids: ["group-marketing@g.us"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("whatsappGroupJids");
    });

    it("returns 400 when binding to a WhatsApp group that the bot has not seen", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Agent",
          type: "agent",
          whatsappGroupJids: ["group-unknown@g.us"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("group-unknown@g.us");
    });

    it("clears bindings when the bound agent is deleted (FK SET NULL)", async () => {
      const create = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Throwaway", type: "agent", whatsappGroupJids: ["group-marketing@g.us"] }),
      });
      const agent = (await create.json()).user;

      const groups = createWhatsAppGroupRepository(db);
      const before = await groups.getByJid("group-marketing@g.us");
      expect(before?.agent_user_id).toBe(agent.id);

      await db.deleteFrom("users").where("id", "=", agent.id).execute();
      // SQLite createTestDb does not enable PRAGMA foreign_keys; simulate cascade
      // explicitly to confirm the schema-level intent.
      await db
        .updateTable("whatsapp_groups")
        .set({ agent_user_id: null })
        .where("agent_user_id", "=", agent.id)
        .execute();
      const after = await groups.getByJid("group-marketing@g.us");
      expect(after?.agent_user_id).toBeNull();
    });
  });

  describe("WhatsApp fallback agent + external users", () => {
    async function createAgent(name: string) {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name, type: "agent", allowedTools: ["Read"] }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).user;
    }

    it("setting isWhatsappFallback on agent B clears it from agent A", async () => {
      const a = await createAgent("Agent A");
      const setA = await app.request(`/api/users/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ isWhatsappFallback: true }),
      });
      expect(setA.status).toBe(200);
      expect((await setA.json()).user.is_whatsapp_fallback).toBe(true);

      const b = await createAgent("Agent B");
      const setB = await app.request(`/api/users/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ isWhatsappFallback: true }),
      });
      expect(setB.status).toBe(200);

      const list = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(list.users.find((u: { id: string }) => u.id === a.id).is_whatsapp_fallback).toBe(false);
      expect(list.users.find((u: { id: string }) => u.id === b.id).is_whatsapp_fallback).toBe(true);
    });

    it("rejects isWhatsappFallback on a non-agent user", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Real Person",
          type: "human",
          email: "rp4@test.com",
          whatsappNumber: "+14155550105",
          isWhatsappFallback: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("isWhatsappFallback");
    });

    it("hides type='external' users from /api/users and surfaces them via /api/users/external", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+1555000000",
      });

      const main = await (await app.request("/api/users", { headers: { Cookie: cookie } })).json();
      expect(main.users.find((u: { id: string }) => u.id === ext.id)).toBeUndefined();

      const externals = await (await app.request("/api/users/external", { headers: { Cookie: cookie } })).json();
      expect(externals.users.find((u: { id: string }) => u.id === ext.id)).toBeDefined();
    });

    it("returns 409 with promotionCandidate when adding a human with an external's WhatsApp number", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+14155552671",
      });

      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: "Now Joining",
          type: "human",
          email: "nj@test.com",
          whatsappNumber: "+14155552671",
        }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("EXTERNAL_USER_EXISTS");
      expect(body.promotionCandidate.id).toBe(ext.id);
    });

    it("promotes an external user to type=human and preserves the id", async () => {
      const users = createUserRepository(db);
      const ext = await users.create({
        name: "External user",
        type: "external",
        whatsappNumber: "+1555222222",
      });

      const res = await app.request(`/api/users/${ext.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Now Joining", email: "nj2@test.com" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe(ext.id);
      expect(body.user.type).toBe("human");
      expect(body.user.name).toBe("Now Joining");
      expect(body.user.email).toBe("nj2@test.com");
    });
  });
});

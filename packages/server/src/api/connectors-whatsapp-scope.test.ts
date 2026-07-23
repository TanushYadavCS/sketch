import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";
const logger = createTestLogger();

async function seedAdmin(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  const hash = await hashPassword(PASSWORD);
  const admin = await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  return loginAs(app, ADMIN_EMAIL);
}

async function loginAs(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function seedGroup(db: Kysely<DB>, jid: string, name: string) {
  await createWhatsAppGroupRepository(db).upsert({
    jid,
    name,
    description: null,
    tool_progress: null,
    reasoning_text: null,
    updated_at: "2026-07-07T09:00:00.000Z",
  });
}

async function indexFlags(db: Kysely<DB>) {
  const rows = await db.selectFrom("whatsapp_groups").select(["jid", "index_enabled"]).orderBy("jid", "asc").execute();
  return Object.fromEntries(rows.map((row) => [row.jid, row.index_enabled]));
}

describe("WhatsApp connector scope API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db, createTestConfig(), { logger });
    adminId = await seedAdmin(db);
    cookie = await login(app);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("flips index_enabled through the generic connector scope endpoint idempotently", async () => {
    await seedGroup(db, "alpha@g.us", "Alpha");
    await seedGroup(db, "beta@g.us", "Beta");
    await seedGroup(db, "gamma@g.us", "Gamma");
    const connector = await createConnectorRepository(db).createConfig({
      connectorType: "whatsapp",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      scopeConfig: JSON.stringify({ groupJids: [] }),
      createdBy: adminId,
    });

    const first = await app.request(`/api/connectors/${connector.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { groupJids: ["alpha@g.us", "gamma@g.us", "missing@g.us"] } }),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      connector: { scopeConfig: { groupJids: ["alpha@g.us", "gamma@g.us"] } },
    });
    await expect(indexFlags(db)).resolves.toEqual({
      "alpha@g.us": 1,
      "beta@g.us": 0,
      "gamma@g.us": 1,
    });

    const second = await app.request(`/api/connectors/${connector.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { groupJids: ["alpha@g.us", "gamma@g.us"] } }),
    });
    expect(second.status).toBe(200);
    await expect(indexFlags(db)).resolves.toEqual({
      "alpha@g.us": 1,
      "beta@g.us": 0,
      "gamma@g.us": 1,
    });

    const third = await app.request(`/api/connectors/${connector.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { groupJids: ["beta@g.us"] } }),
    });
    expect(third.status).toBe(200);
    await expect(indexFlags(db)).resolves.toEqual({
      "alpha@g.us": 0,
      "beta@g.us": 1,
      "gamma@g.us": 0,
    });
  });

  it("requeues kept slices for groups newly enabled via the scope endpoint", async () => {
    await seedGroup(db, "delta@g.us", "Delta");
    const connector = await createConnectorRepository(db).createConfig({
      connectorType: "whatsapp",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      scopeConfig: JSON.stringify({ groupJids: [] }),
      createdBy: adminId,
    });
    const conversation = await db
      .insertInto("conversations")
      .values({ platform: "whatsapp", kind: "group", provider_conversation_id: "delta@g.us", display_name: "Delta" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("indexed_files")
      .values({
        id: "file-delta",
        connector_config_id: connector.id,
        provider_file_id: "slice-delta",
        file_name: "WhatsApp: Delta",
        file_type: "whatsapp_conversation_slice",
        content_category: "document",
        source: "whatsapp",
        synced_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("conversation_slices")
      .values({
        id: "slice-delta",
        conversation_id: conversation.id,
        first_message_id: 1,
        last_message_id: 1,
        started_at: "2026-07-01T00:00:00.000Z",
        ended_at: "2026-07-01T00:00:00.000Z",
        message_count: 1,
        flush_reason: "gap",
        roster_snapshot: "[]",
        salience_verdict: "kept",
        indexed_file_id: "file-delta",
      })
      .execute();

    const res = await app.request(`/api/connectors/${connector.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { groupJids: ["delta@g.us"] } }),
    });
    expect(res.status).toBe(200);

    const slice = await db
      .selectFrom("conversation_slices")
      .select("indexed_file_id")
      .where("id", "=", "slice-delta")
      .executeTakeFirstOrThrow();
    expect(slice.indexed_file_id).toBeNull();
  });

  it("gates generic WhatsApp browse to admins and derives system credentials server-side", async () => {
    await seedGroup(db, "alpha@g.us", "Alpha");
    const hash = await hashPassword(PASSWORD);
    await createUserRepository(db).create({
      name: "member",
      email: MEMBER_EMAIL,
      emailVerified: true,
      passwordHash: hash,
      authRole: "member",
    });
    const memberCookie = await loginAs(app, MEMBER_EMAIL);

    const denied = await app.request("/api/connectors/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ connectorType: "whatsapp", credentials: { type: "system" } }),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request("/api/connectors/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ connectorType: "whatsapp", credentials: { type: "api_key", api_key: "ignored" } }),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      type: "flat",
      items: [{ id: "alpha@g.us", name: "Alpha" }],
    });
  });

  it("rolls back WhatsApp group flags when connector scope persistence fails", async () => {
    await seedGroup(db, "alpha@g.us", "Alpha");
    await seedGroup(db, "beta@g.us", "Beta");
    const connector = await createConnectorRepository(db).createConfig({
      connectorType: "whatsapp",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      scopeConfig: JSON.stringify({ groupJids: [] }),
      createdBy: adminId,
    });
    await sql`
      CREATE TRIGGER fail_connector_scope_update
      BEFORE UPDATE OF scope_config ON connector_configs
      BEGIN
        SELECT RAISE(ABORT, 'scope update failed');
      END
    `.execute(db);

    let response: Response | undefined;
    let error: unknown;
    try {
      response = await app.request(`/api/connectors/${connector.id}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ scopeConfig: { groupJids: ["alpha@g.us"] } }),
      });
    } catch (err) {
      error = err;
    }

    expect(response?.status ?? 500).toBeGreaterThanOrEqual(500);
    if (error) expect(String(error)).toContain("scope update failed");
    await expect(indexFlags(db)).resolves.toEqual({
      "alpha@g.us": 0,
      "beta@g.us": 0,
    });
    const stored = await createConnectorRepository(db).findConfigById(connector.id);
    expect(stored?.scope_config).toBe(JSON.stringify({ groupJids: [] }));
  });
});

describe("WhatsApp group member labels API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db, createTestConfig(), { logger });
    await seedAdmin(db);
    cookie = await login(app);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("rejects label writes for groups that are not index-enabled", async () => {
    await seedGroup(db, "disabled@g.us", "Disabled");

    const res = await app.request("/api/channels/whatsapp/groups/disabled@g.us/member-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        labels: [{ phoneE164: "+15551234567", displayName: "Asha", companyName: "Acme" }],
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "GROUP_NOT_INDEX_ENABLED" } });
  });

  it("normalizes E.164 inputs and rejects invalid phones", async () => {
    await seedGroup(db, "enabled@g.us", "Enabled");
    await createWhatsAppGroupRepository(db).setIndexEnabled("enabled@g.us", true);

    const invalid = await app.request("/api/channels/whatsapp/groups/enabled@g.us/member-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        labels: [{ phoneE164: "12345", displayName: "Asha", companyName: null }],
      }),
    });
    expect(invalid.status).toBe(400);

    const valid = await app.request("/api/channels/whatsapp/groups/enabled@g.us/member-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        labels: [{ phoneE164: "+1 (555) 123-4567", displayName: "Asha Mehta", companyName: "Acme" }],
      }),
    });
    expect(valid.status).toBe(200);
    const validBody = (await valid.json()) as { labels: Array<Record<string, unknown>> };
    expect(validBody.labels).toEqual([
      { id: expect.any(String), maskedPhone: "**67", displayName: "Asha Mehta", companyName: "Acme" },
    ]);
    expect(validBody.labels[0]).not.toHaveProperty("phoneE164");

    const rows = await createWhatsAppGroupRepository(db).listMemberLabels("enabled@g.us");
    expect(rows).toEqual([
      expect.objectContaining({
        phone_e164: "+15551234567",
        display_name: "Asha Mehta",
        company_name: "Acme",
      }),
    ]);

    const listed = await app.request("/api/channels/whatsapp/groups/enabled@g.us/member-labels", {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { labels: Array<Record<string, unknown>> };
    expect(listedBody.labels).toEqual(validBody.labels);
    expect(listedBody.labels[0]).not.toHaveProperty("phoneE164");

    const updated = await app.request("/api/channels/whatsapp/groups/enabled@g.us/member-labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        labels: [{ id: validBody.labels[0]?.id, displayName: "Asha M", companyName: "Acme" }],
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { labels: Array<Record<string, unknown>> };
    expect(updatedBody.labels).toEqual([
      { id: validBody.labels[0]?.id, maskedPhone: "**67", displayName: "Asha M", companyName: "Acme" },
    ]);
    expect(updatedBody.labels[0]).not.toHaveProperty("phoneE164");
  });
});

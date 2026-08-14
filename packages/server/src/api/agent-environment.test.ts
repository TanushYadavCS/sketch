import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { SlackBot } from "../slack/bot";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { isUniqueConstraintError } from "./agent-environment";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const OTHER_EMAIL = "other@test.com";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db, ENCRYPTION_KEY);
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
  await users.create({
    name: "other",
    email: OTHER_EMAIL,
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

async function seedSlackChannel(db: Kysely<DB>, slackChannelId: string, name: string) {
  await db
    .insertInto("channels")
    .values({ id: randomUUID(), slack_channel_id: slackChannelId, name, type: "public_channel" })
    .execute();
}

async function seedWhatsAppGroup(db: Kysely<DB>, jid: string, name: string) {
  await db.insertInto("whatsapp_groups").values({ jid, name, description: null }).execute();
}

describe("Agent environment variables API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let otherUserId: string;
  let adminCookie: string;
  let memberCookie: string;
  let otherCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    const seededUsers = await db.selectFrom("users").select(["id", "email"]).execute();
    otherUserId = seededUsers.find((user) => user.email === OTHER_EMAIL)?.id ?? "";
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns non-secret values for copy and hides secret values", async () => {
    const nonSecret = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "TEST_REGION", value: "us-east-1", isSecret: false }),
    });
    expect(nonSecret.status).toBe(201);
    expect((await nonSecret.json()).variable).toMatchObject({
      name: "TEST_REGION",
      value: "us-east-1",
      isSecret: false,
    });

    const secret = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "TEST_SECRET", value: "secret-value", isSecret: true }),
    });
    expect(secret.status).toBe(201);
    expect((await secret.json()).variable).toMatchObject({ name: "TEST_SECRET", value: null, isSecret: true });

    const list = await app.request("/api/agent-environment-variables", {
      headers: { Cookie: memberCookie },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).variables).toEqual([
      expect.objectContaining({ name: "TEST_REGION", value: "us-east-1", isSecret: false }),
      expect.objectContaining({ name: "TEST_SECRET", value: null, isSecret: true }),
    ]);
  });

  it("encrypts values at rest", async () => {
    await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "BACKEND_API_URL", value: "https://api.test", isSecret: false }),
    });

    const row = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "BACKEND_API_URL")
      .executeTakeFirstOrThrow();
    expect(row.value.startsWith("enc:")).toBe(true);
  });

  it("returns conflict for duplicate variable names", async () => {
    const body = JSON.stringify({ name: "TEST_REGION", value: "us-east-1", isSecret: false });

    const first = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body,
    });
    expect(first.status).toBe(201);

    const duplicate = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body,
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("CONFLICT");
  });

  it("scopes variables to the authenticated user", async () => {
    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "TEST_REGION", value: "us-east-1", isSecret: false }),
    });
    const created = await create.json();

    const otherList = await app.request("/api/agent-environment-variables", {
      headers: { Cookie: otherCookie },
    });
    expect((await otherList.json()).variables).toEqual([]);

    const otherDelete = await app.request(`/api/agent-environment-variables/${created.variable.id}`, {
      method: "DELETE",
      headers: { Cookie: otherCookie },
    });
    expect(otherDelete.status).toBe(404);
  });

  it("creates and deletes user, Slack channel, and WhatsApp group shares for an owned variable", async () => {
    await seedSlackChannel(db, "C123", "eng");
    await seedWhatsAppGroup(db, "123@g.us", "Product Ops");
    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "API_TOKEN", value: "secret", isSecret: true }),
    });
    const created = await create.json();

    const share = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({
        targets: [
          { type: "user", id: otherUserId },
          { type: "slack_channel", id: "C123" },
          { type: "whatsapp_group", id: "123@g.us" },
        ],
      }),
    });

    expect(share.status).toBe(200);
    const shared = await share.json();
    expect(shared.variable.value).toBeNull();
    expect(shared.variable.shares).toEqual([
      expect.objectContaining({ targetType: "user", targetId: otherUserId, targetLabel: "other" }),
      expect.objectContaining({ targetType: "slack_channel", targetLabel: "#eng" }),
      expect.objectContaining({ targetType: "whatsapp_group", targetLabel: "Product Ops" }),
    ]);

    const remove = await app.request(
      `/api/agent-environment-variables/${created.variable.id}/shares/${shared.variable.shares[0].id}`,
      { method: "DELETE", headers: { Cookie: memberCookie } },
    );
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ success: true });

    const list = await app.request("/api/agent-environment-variables", { headers: { Cookie: memberCookie } });
    const listed = await list.json();
    expect(listed.variables[0].shares).toHaveLength(2);
  });

  it("resolves unpersisted Slack channels from the connected Slack bot before sharing", async () => {
    const getChannelInfo = vi.fn().mockResolvedValue({ name: "eng", type: "public_channel" });
    const slack = { getChannelInfo } as unknown as SlackBot;
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });
    memberCookie = await login(app, MEMBER_EMAIL);

    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "SLACK_TOKEN", value: "secret", isSecret: true }),
    });
    const created = await create.json();

    const share = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "CNEW" }] }),
    });

    expect(share.status).toBe(200);
    expect(getChannelInfo).toHaveBeenCalledWith("CNEW");
    const channel = await db
      .selectFrom("channels")
      .selectAll()
      .where("slack_channel_id", "=", "CNEW")
      .executeTakeFirst();
    expect(channel).toMatchObject({ name: "eng", type: "public_channel" });
    expect((await share.json()).variable.shares).toEqual([
      expect.objectContaining({ targetType: "slack_channel", targetId: "CNEW", targetLabel: "#eng" }),
    ]);
  });

  it("preserves share metadata in variable update responses", async () => {
    await seedSlackChannel(db, "C123", "eng");
    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "PATCH_TOKEN", value: "secret", isSecret: true }),
    });
    const created = await create.json();

    const share = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "C123" }] }),
    });
    expect(share.status).toBe(200);

    const update = await app.request(`/api/agent-environment-variables/${created.variable.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ value: "updated-secret" }),
    });

    expect(update.status).toBe(200);
    expect((await update.json()).variable.shares).toEqual([
      expect.objectContaining({ targetType: "slack_channel", targetId: "C123", targetLabel: "#eng" }),
    ]);
  });

  it("checks variable ownership before validating share targets", async () => {
    const getChannelInfo = vi.fn().mockResolvedValue({ name: "eng", type: "public_channel" });
    const slack = { getChannelInfo } as unknown as SlackBot;
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });
    memberCookie = await login(app, MEMBER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);

    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "OWNED_TOKEN", value: "secret", isSecret: true }),
    });
    const created = await create.json();

    const nonOwner = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "CNEW" }] }),
    });

    expect(nonOwner.status).toBe(404);
    expect(getChannelInfo).not.toHaveBeenCalled();
  });

  it("allows admins to create org-wide shares and rejects org-wide shares from members", async () => {
    const memberVariable = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "MEMBER_TOKEN", value: "member-secret", isSecret: true }),
    });
    const memberCreated = await memberVariable.json();

    const memberShare = await app.request(`/api/agent-environment-variables/${memberCreated.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ targets: [{ type: "org", id: "default" }] }),
    });
    expect(memberShare.status).toBe(403);

    const adminVariable = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "ORG_TOKEN", value: "org-secret", isSecret: true }),
    });
    const adminCreated = await adminVariable.json();

    const adminShare = await app.request(`/api/agent-environment-variables/${adminCreated.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ targets: [{ type: "org", id: "default" }] }),
    });

    expect(adminShare.status).toBe(200);
    expect((await adminShare.json()).variable.shares).toEqual([
      expect.objectContaining({ targetType: "org", targetLabel: "Entire org" }),
    ]);
  });

  it("validates share ownership, targets, and duplicate names", async () => {
    await seedSlackChannel(db, "C123", "eng");
    const create = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name: "API_TOKEN", value: "member-secret", isSecret: true }),
    });
    const created = await create.json();

    const nonOwner = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "C123" }] }),
    });
    expect(nonOwner.status).toBe(404);

    const missingTargets = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({
        targets: [
          { type: "user", id: "missing-user" },
          { type: "slack_channel", id: "C404" },
          { type: "whatsapp_group", id: "missing@g.us" },
        ],
      }),
    });
    expect(missingTargets.status).toBe(400);

    const firstShare = await app.request(`/api/agent-environment-variables/${created.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "C123" }] }),
    });
    expect(firstShare.status).toBe(200);

    const otherCreate = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ name: "API_TOKEN", value: "other-secret", isSecret: true }),
    });
    const otherCreated = await otherCreate.json();
    const conflict = await app.request(`/api/agent-environment-variables/${otherCreated.variable.id}/shares`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ targets: [{ type: "slack_channel", id: "C123" }] }),
    });

    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.message).toContain("API_TOKEN");
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CONFIG_DIR",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
  ])("rejects reserved name %s", async (name) => {
    const res = await app.request("/api/agent-environment-variables", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: memberCookie },
      body: JSON.stringify({ name, value: "reserved-value", isSecret: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("reserved");
  });
});

describe("isUniqueConstraintError", () => {
  it("detects SQLite and Postgres unique constraint errors", () => {
    const postgresError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    const wrappedPostgresError = Object.assign(new Error("wrapped error"), { cause: postgresError });

    expect(
      isUniqueConstraintError(
        new Error("UNIQUE constraint failed: agent_environment_variables.user_id, agent_environment_variables.name"),
      ),
    ).toBe(true);
    expect(isUniqueConstraintError(postgresError)).toBe(true);
    expect(isUniqueConstraintError(wrappedPostgresError)).toBe(true);
    expect(isUniqueConstraintError(new Error("other database error"))).toBe(false);
  });
});

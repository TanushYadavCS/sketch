import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
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

describe("Agent environment variables API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let memberCookie: string;
  let otherCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), { logger: createTestLogger() });
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
      body: JSON.stringify({ name: "GH_TOKEN", value: "ghp_secret", isSecret: true }),
    });
    expect(secret.status).toBe(201);
    expect((await secret.json()).variable).toMatchObject({ name: "GH_TOKEN", value: null, isSecret: true });

    const list = await app.request("/api/agent-environment-variables", {
      headers: { Cookie: memberCookie },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).variables).toEqual([
      expect.objectContaining({ name: "GH_TOKEN", value: null, isSecret: true }),
      expect.objectContaining({ name: "TEST_REGION", value: "us-east-1", isSecret: false }),
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

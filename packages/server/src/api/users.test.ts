/**
 * Coverage for the new agent fields on the /api/users endpoints:
 * agent instructions (longer description) and allowedTools.
 *
 * Existing serialization, verification, and reportsTo behaviour is exercised
 * indirectly by the rest of the test suite; this file targets only the
 * additions from SKE-51.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
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
        allowedTools: ["Read", "WebSearch", "mcp__sketch__Search"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.type).toBe("agent");
    expect(body.user.description).toBe("You are the marketing maven. Always cite source URLs.");
    expect(body.user.allowed_tools).toEqual(["Read", "WebSearch", "mcp__sketch__Search"]);
  });

  it("rejects allowedTools when creating a human user", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Real Person",
        type: "human",
        email: "person@test.com",
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
});

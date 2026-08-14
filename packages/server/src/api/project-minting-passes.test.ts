/**
 * `POST /passes` is the only route in this file that spends money — it calls a
 * reasoning model per run. So the tests here are about the three ways it could
 * be reached by someone or something that should not have reached it, checked
 * over HTTP because that is the only surface a browser can hit.
 */
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    id: "admin-user",
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    id: "member-user",
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

function startPass(app: ReturnType<typeof createApp>, cookie: string, companyEntityId: string) {
  return app.request("/api/project-minting/passes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ companyEntityId }),
  });
}

async function runCount(db: Kysely<DB>): Promise<number> {
  const rows = await db.selectFrom("graph_pass_runs").select("id").execute();
  return rows.length;
}

describe("project minting pass route", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
  });

  /**
   * Asserting on the reason, not just the 404: an unknown company also answers
   * 404, so a status-only assertion would pass with the gate deleted.
   */
  it("does not exist when dev tools are off", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const res = await startPass(app, await login(app, ADMIN_EMAIL), "company-1");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { message: "Project minting passes are not enabled" } });
    expect(await runCount(db)).toBe(0);
  });

  it("refuses a member even with dev tools on", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const res = await startPass(app, await login(app, MEMBER_EMAIL), "company-1");

    expect(res.status).toBe(403);
    expect(await runCount(db)).toBe(0);
  });

  /**
   * The pass filters by cluster name, so an id that matches no cluster must be
   * rejected before the run starts. Letting it through would run the pass with
   * a filter that matches nothing — a run row and a model client for no reason.
   */
  it("refuses a company that has no cluster, without opening a run", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const res = await startPass(app, await login(app, ADMIN_EMAIL), "not-a-company");

    expect(res.status).toBe(404);
    expect(await runCount(db)).toBe(0);
  });
});

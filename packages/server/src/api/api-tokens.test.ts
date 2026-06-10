import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../auth/api-token";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createApiTokenRepository } from "../db/repositories/api-tokens";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function setupSession(email: string) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  if (!(await settings.get())) {
    await settings.create();
  }
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const user = await users.create({
    name: email.split("@")[0] ?? "user",
    email,
    emailVerified: true,
    passwordHash: await hashPassword("testpassword123"),
    authRole: "member",
  });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("Missing jwt secret");
  return {
    user,
    cookie: `sketch_session=${await signJwt(user.id, "member", row.jwt_secret)}`,
  };
}

describe("API token routes", () => {
  it("creates and lists only the caller's own tokens", async () => {
    const { cookie } = await setupSession("alice@example.com");
    const app = createApp(db, createTestConfig({ BASE_URL: "https://sketch.test", EXPERIMENTAL_FLAG: false }), {
      logger: createTestLogger(),
    });

    const createRes = await app.request("/api/api-tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Laptop" }),
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { plaintext: string; token: { prefix: string }; mcpUrl: string };
    expect(created.plaintext).toMatch(/^skp_/);
    expect(created.token.prefix).toBe(getApiTokenDisplayPrefix(created.plaintext));
    expect(created.mcpUrl).toBe("https://sketch.test/mcp");

    const listRes = await app.request("/api/api-tokens", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { tokens: Array<{ name: string }>; mcpUrl: string };
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]?.name).toBe("Alice Laptop");
    expect(listed.mcpUrl).toBe("https://sketch.test/mcp");
  });

  it("does not let one user revoke another user's token", async () => {
    const alice = await setupSession("alice@example.com");
    const bob = await setupSession("bob@example.com");
    const plaintext = generateApiToken();
    const row = await createApiTokenRepository(db).create({
      userId: alice.user.id,
      name: "Alice Laptop",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });
    const app = createApp(db, createTestConfig({ EXPERIMENTAL_FLAG: true }), { logger: createTestLogger() });

    const res = await app.request(`/api/api-tokens/${row.id}`, {
      method: "DELETE",
      headers: { Cookie: bob.cookie },
    });

    expect(res.status).toBe(404);
    expect(await createApiTokenRepository(db).findByHash(hashApiToken(plaintext))).toBeDefined();
  });
});

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./auth/password";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import type { DB } from "./db/schema";
import { createApp } from "./http";
import { createTestConfig, createTestPgDb } from "./test-utils";

describe("magic link confirmation on Postgres", () => {
  let db: Kysely<DB>;

  /**
   * Magic link issuance opens its own Kysely transaction, so this integration
   * suite uses a fresh Postgres database instead of an outer rollback transaction.
   */
  beforeAll(async () => {
    db = await createTestPgDb();
    await createSettingsRepository(db).create();
    await createUserRepository(db).create({
      name: "Postgres Admin",
      email: "postgres-admin@test.com",
      emailVerified: true,
      passwordHash: await hashPassword("testpassword123"),
      authRole: "admin",
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("keeps GET non-consuming and consumes only an explicit POST", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const app = createApp(db, createTestConfig({ BASE_URL: "https://sketch.test", DB_TYPE: "postgres" }), {
      logger: logger as never,
    });

    const requestRes = await app.request("/api/auth/magic-link", {
      method: "POST",
      body: JSON.stringify({ email: "postgres-admin@test.com" }),
    });
    expect(requestRes.status).toBe(200);

    const magicLinkUrl = logger.info.mock.calls
      .map(([data]) => (data as { magicLinkUrl?: string }).magicLinkUrl)
      .find(Boolean);
    expect(magicLinkUrl).toBeDefined();
    const url = new URL(magicLinkUrl as string);

    const prefetchRes = await app.request(`${url.pathname}${url.search}`);
    expect(prefetchRes.status).toBe(200);

    const confirmationRes = await app.request(`${url.pathname}${url.search}`);
    expect(confirmationRes.status).toBe(200);
    const confirmation = (await confirmationRes.text()).match(/name="confirmation" value="([^"]+)"/)?.[1];
    const confirmationCookie = confirmationRes.headers.get("set-cookie")?.split(";", 1)[0];
    expect(confirmation).toBeDefined();
    expect(confirmationCookie).toContain("sketch_magic_link_confirmation=");

    const verifyRes = await app.request("/api/auth/magic-link/confirmation", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: confirmationCookie as string,
      },
      body: new URLSearchParams({
        token: url.searchParams.get("token") as string,
        confirmation: confirmation as string,
      }).toString(),
    });
    expect(verifyRes.status).toBe(302);
    expect(verifyRes.headers.get("location")).toBe("/");
    expect(verifyRes.headers.get("set-cookie")).toContain("sketch_session=");
  });
});

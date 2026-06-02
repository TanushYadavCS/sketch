import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../../auth/api-token";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createApiTokenRepository } from "./api-tokens";
import { createUserRepository } from "./users";

let db: Kysely<DB>;
let apiTokens: ReturnType<typeof createApiTokenRepository>;
let users: ReturnType<typeof createUserRepository>;

beforeEach(async () => {
  db = await createTestDb();
  apiTokens = createApiTokenRepository(db);
  users = createUserRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("api token repository", () => {
  it("stores only token hashes and finds active tokens by hash", async () => {
    const user = await users.create({ name: "Token User", email: "token@example.com", emailVerified: true });
    const plaintext = generateApiToken();
    const row = await apiTokens.create({
      userId: user.id,
      name: "Laptop",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });

    expect(row.token_hash).toBe(hashApiToken(plaintext));
    expect(row.token_hash).not.toBe(plaintext);
    expect(row.prefix).toBe("skp_".concat(plaintext.slice(4, 8)));

    const found = await apiTokens.findByHash(hashApiToken(plaintext));
    expect(found?.id).toBe(row.id);
  });

  it("does not find revoked tokens", async () => {
    const user = await users.create({ name: "Revoked User", email: "revoked@example.com", emailVerified: true });
    const plaintext = generateApiToken();
    const row = await apiTokens.create({
      userId: user.id,
      name: "Old Laptop",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });

    await apiTokens.revoke(user.id, row.id);

    const found = await apiTokens.findByHash(hashApiToken(plaintext));
    expect(found).toBeUndefined();
  });

  it("does not find expired tokens", async () => {
    const user = await users.create({ name: "Expired User", email: "expired@example.com", emailVerified: true });
    const plaintext = generateApiToken();
    const row = await apiTokens.create({
      userId: user.id,
      name: "Old CLI",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });

    await db
      .updateTable("api_tokens")
      .set({ expires_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", row.id)
      .execute();

    const found = await apiTokens.findByHash(hashApiToken(plaintext), new Date("2026-01-01T00:00:01.000Z"));
    expect(found).toBeUndefined();
  });

  it("throttles last_used_at updates", async () => {
    const user = await users.create({ name: "Touched User", email: "touched@example.com", emailVerified: true });
    const plaintext = generateApiToken();
    const row = await apiTokens.create({
      userId: user.id,
      name: "CLI",
      tokenHash: hashApiToken(plaintext),
      prefix: getApiTokenDisplayPrefix(plaintext),
    });

    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2026-01-01T00:00:30.000Z");
    const third = new Date("2026-01-01T00:01:01.000Z");

    expect(await apiTokens.touchLastUsed(row.id, first)).toBe(true);
    expect(await apiTokens.touchLastUsed(row.id, second)).toBe(false);
    expect(await apiTokens.touchLastUsed(row.id, third)).toBe(true);
  });
});

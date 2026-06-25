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

  it("lists PATs without internal OAuth tokens", async () => {
    const user = await users.create({ name: "Mixed User", email: "mixed@example.com", emailVerified: true });
    const pat = generateApiToken();
    await apiTokens.create({
      userId: user.id,
      name: "CLI",
      tokenHash: hashApiToken(pat),
      prefix: getApiTokenDisplayPrefix(pat),
    });
    await apiTokens.createOAuth({
      userId: user.id,
      name: "Claude",
      tokenHash: hashApiToken("sko_test"),
      prefix: "sko_test",
      clientId: "client",
      scopes: ["mcp:read"],
      refreshTokenHash: hashApiToken("skr_test"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const rows = await apiTokens.listForUser(user.id);
    expect(rows.map((row) => row.name)).toEqual(["CLI"]);
  });

  it("rejects OAuth refresh rotation when the presented refresh token is stale", async () => {
    const user = await users.create({ name: "OAuth User", email: "oauth@example.com", emailVerified: true });
    const row = await apiTokens.createOAuth({
      userId: user.id,
      name: "Claude",
      tokenHash: hashApiToken("sko_old"),
      prefix: "sko_old",
      clientId: "client",
      scopes: ["mcp:read"],
      refreshTokenHash: hashApiToken("skr_old"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const rotated = await apiTokens.rotateOAuthToken(row.id, {
      previousRefreshTokenHash: hashApiToken("skr_old"),
      tokenHash: hashApiToken("sko_new"),
      prefix: "sko_new",
      refreshTokenHash: hashApiToken("skr_new"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(rotated?.refresh_token_hash).toBe(hashApiToken("skr_new"));

    const staleRotation = await apiTokens.rotateOAuthToken(row.id, {
      previousRefreshTokenHash: hashApiToken("skr_old"),
      tokenHash: hashApiToken("sko_race"),
      prefix: "sko_race",
      refreshTokenHash: hashApiToken("skr_race"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(staleRotation).toBeUndefined();

    const stored = await apiTokens.findByRefreshHash(hashApiToken("skr_new"));
    expect(stored?.token_hash).toBe(hashApiToken("sko_new"));
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

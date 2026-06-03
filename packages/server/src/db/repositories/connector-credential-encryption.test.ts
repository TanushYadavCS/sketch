import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../../auth/encryption";
import { parseCredentials } from "../../connectors/sync-utils";
import { createTestDb, createTestLogger } from "../../test-utils";
import { backfillFilesConnectorCredentialEncryption } from "../credential-encryption-backfill";
import type { DB } from "../schema";
import { createConnectorRepository } from "./connectors";
import { createProviderIdentityRepository } from "./provider-identities";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function rawConnectorCredentials(db: Kysely<DB>, id: string): Promise<string> {
  const row = await db
    .selectFrom("connector_configs")
    .select("credentials")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.credentials;
}

async function seedUser(db: Kysely<DB>) {
  await db.insertInto("users").values({ id: "user-1", name: "Test User", email: "user@example.com" }).execute();
}

describe("Files connector credential encryption", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stores connector credentials encrypted and returns decrypted credentials", async () => {
    const repo = createConnectorRepository(db, TEST_KEY);
    const credentials = {
      type: "oauth",
      access_token: "access-token",
      refresh_token: "refresh-token",
      client_secret: "client-secret",
    };

    const created = await repo.createConfig({
      connectorType: "google_drive",
      authType: "oauth",
      credentials: JSON.stringify(credentials),
      createdBy: "user-1",
    });

    const raw = await rawConnectorCredentials(db, created.id);
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("refresh-token");
    expect(raw).not.toContain("client-secret");
    expect(parseCredentials(created.credentials)).toMatchObject(credentials);

    const fetched = await repo.findConfigById(created.id);
    expect(parseCredentials(fetched?.credentials ?? "{}")).toMatchObject(credentials);
  });

  it("reads legacy plaintext connector credentials and heals them on write", async () => {
    await db
      .insertInto("connector_configs")
      .values({
        id: "legacy-connector",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({ type: "oauth", refresh_token: "legacy-refresh" }),
        created_by: "user-1",
      })
      .execute();

    const repo = createConnectorRepository(db, TEST_KEY);
    const legacy = await repo.findConfigById("legacy-connector");
    expect(legacy?.credentials).toContain("legacy-refresh");

    await repo.updateConfig("legacy-connector", {
      credentials: JSON.stringify({ type: "oauth", refresh_token: "rotated-refresh" }),
    });

    const raw = await rawConnectorCredentials(db, "legacy-connector");
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("rotated-refresh");
  });

  it("preserves plaintext connector behavior when no key is configured", async () => {
    const repo = createConnectorRepository(db);
    const created = await repo.createConfig({
      connectorType: "fireflies",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "plain-api-key" }),
      createdBy: "user-1",
    });

    const raw = await rawConnectorCredentials(db, created.id);
    expect(raw).toContain("plain-api-key");

    const fetched = await repo.findConfigById(created.id);
    expect(fetched?.credentials).toContain("plain-api-key");
  });

  it("throws clearly when connector credentials are encrypted but no key is configured", async () => {
    await db
      .insertInto("connector_configs")
      .values({
        id: "encrypted-connector",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: encrypt(JSON.stringify({ type: "oauth", refresh_token: "secret" }), TEST_KEY),
        created_by: "user-1",
      })
      .execute();

    const repo = createConnectorRepository(db);
    await expect(repo.findConfigById("encrypted-connector")).rejects.toThrow("ENCRYPTION_KEY");
  });

  it("stores provider identity tokens encrypted and returns decrypted tokens", async () => {
    await seedUser(db);
    const repo = createProviderIdentityRepository(db, TEST_KEY);

    const identity = await repo.upsert({
      userId: "user-1",
      provider: "google_drive",
      providerUserId: "provider-user",
      providerEmail: "user@example.com",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2026-06-02T00:00:00.000Z",
    });

    const raw = await db
      .selectFrom("user_provider_identities")
      .select(["access_token", "refresh_token"])
      .where("id", "=", identity.id)
      .executeTakeFirstOrThrow();

    expect(raw.access_token?.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token?.startsWith("enc:")).toBe(true);
    expect(raw.access_token).not.toContain("access-token");
    expect(raw.refresh_token).not.toContain("refresh-token");
    expect(identity.access_token).toBe("access-token");
    expect(identity.refresh_token).toBe("refresh-token");

    const fetched = await repo.findByUserAndProvider("user-1", "google_drive");
    expect(fetched?.access_token).toBe("access-token");
    expect(fetched?.refresh_token).toBe("refresh-token");
  });

  it("backfills legacy plaintext connector and provider identity secrets", async () => {
    await seedUser(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "legacy-connector",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({ type: "oauth", refresh_token: "legacy-refresh" }),
        created_by: "user-1",
      })
      .execute();
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "legacy-identity",
        user_id: "user-1",
        provider: "google_drive",
        provider_user_id: "provider-user",
        provider_email: "user@example.com",
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
      })
      .execute();

    const result = await backfillFilesConnectorCredentialEncryption(db, TEST_KEY, createTestLogger());
    expect(result).toEqual({ connectorCredentials: 1, providerIdentityTokenFields: 2 });

    const rawConnector = await rawConnectorCredentials(db, "legacy-connector");
    const rawIdentity = await db
      .selectFrom("user_provider_identities")
      .select(["access_token", "refresh_token"])
      .where("id", "=", "legacy-identity")
      .executeTakeFirstOrThrow();

    expect(rawConnector.startsWith("enc:")).toBe(true);
    expect(rawIdentity.access_token?.startsWith("enc:")).toBe(true);
    expect(rawIdentity.refresh_token?.startsWith("enc:")).toBe(true);

    const connectorRepo = createConnectorRepository(db, TEST_KEY);
    const identityRepo = createProviderIdentityRepository(db, TEST_KEY);
    expect((await connectorRepo.findConfigById("legacy-connector"))?.credentials).toContain("legacy-refresh");
    expect((await identityRepo.findByUserAndProvider("user-1", "google_drive"))?.refresh_token).toBe("legacy-refresh");
  });
});

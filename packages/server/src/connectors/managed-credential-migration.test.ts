import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { migrateManagedConnectorCredentialsToCanvas } from "./managed-credential-migration";

let db: Kysely<DB>;

async function seedUser(overrides: Partial<{ id: string; name: string; email: string | null; authRole: string }> = {}) {
  await db
    .insertInto("users")
    .values({
      id: overrides.id ?? "user-1",
      name: overrides.name ?? "Test User",
      email: overrides.email === undefined ? "user@example.com" : overrides.email,
      auth_role: overrides.authRole ?? "member",
    })
    .execute();
}

async function seedConnector(
  overrides: Partial<{
    id: string;
    connectorType: string;
    authType: string;
    credentials: Record<string, unknown>;
    credentialSource: string;
    syncStatus: string;
    createdBy: string;
    errorMessage: string | null;
  }> = {},
) {
  await db
    .insertInto("connector_configs")
    .values({
      id: overrides.id ?? "connector-1",
      connector_type: overrides.connectorType ?? "gmail",
      auth_type: overrides.authType ?? "oauth",
      credentials: JSON.stringify(overrides.credentials ?? { type: "oauth", refresh_token: "local-refresh" }),
      credential_source: overrides.credentialSource ?? "local",
      sync_status: overrides.syncStatus ?? "active",
      error_message: overrides.errorMessage ?? null,
      created_by: overrides.createdBy ?? "user-1",
    })
    .execute();
}

async function seedIdentity(
  overrides: Partial<{
    id: string;
    userId: string;
    provider: string;
    providerUserId: string;
    providerEmail: string | null;
  }> = {},
) {
  await db
    .insertInto("user_provider_identities")
    .values({
      id: overrides.id ?? "identity-1",
      user_id: overrides.userId ?? "user-1",
      provider: overrides.provider ?? "gmail",
      provider_user_id: overrides.providerUserId ?? "provider-user-1",
      provider_email: overrides.providerEmail ?? "user@example.com",
      access_token: "identity-access",
      refresh_token: "identity-refresh",
      token_expires_at: "2026-01-01T00:00:00.000Z",
    })
    .execute();
}

describe("migrateManagedConnectorCredentialsToCanvas", () => {
  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does nothing outside Canvas credential mode", async () => {
    await seedUser();
    await seedConnector();
    await seedIdentity();

    const result = await migrateManagedConnectorCredentialsToCanvas({
      db,
      appConfig: { CONNECTOR_CREDENTIAL_SOURCE: "local" },
      logger: createTestLogger(),
      mintCredential: vi.fn(),
    });

    const connector = await db
      .selectFrom("connector_configs")
      .selectAll()
      .where("id", "=", "connector-1")
      .executeTakeFirstOrThrow();
    const identity = await db
      .selectFrom("user_provider_identities")
      .selectAll()
      .where("id", "=", "identity-1")
      .executeTakeFirstOrThrow();

    expect(result).toEqual({
      scannedConnectorRows: 0,
      convertedConnectorRows: 0,
      pausedConnectorRows: 0,
      scrubbedIdentityRows: 0,
    });
    expect(connector.credential_source).toBe("local");
    expect(connector.credentials).toContain("local-refresh");
    expect(identity.refresh_token).toBe("identity-refresh");
  });

  it("converts local managed OAuth connector rows when Canvas can mint", async () => {
    await seedUser({ name: "Admin User", authRole: "admin" });
    await seedConnector({ syncStatus: "error", errorMessage: "old refresh failed" });
    await seedConnector({
      id: "clickup-static",
      connectorType: "clickup",
      authType: "api_key",
      credentials: { type: "api_key", api_key: "clickup-key" },
    });
    await seedIdentity();

    const mintCredential = vi.fn(async () => ({
      type: "oauth" as const,
      access_token: "minted-access",
      refresh_token: "",
      client_id: "canvas",
      client_secret: "canvas",
    }));

    const result = await migrateManagedConnectorCredentialsToCanvas({
      db,
      appConfig: { CONNECTOR_CREDENTIAL_SOURCE: "canvas" },
      logger: createTestLogger(),
      mintCredential,
    });

    const connector = await db
      .selectFrom("connector_configs")
      .selectAll()
      .where("id", "=", "connector-1")
      .executeTakeFirstOrThrow();
    const staticConnector = await db
      .selectFrom("connector_configs")
      .selectAll()
      .where("id", "=", "clickup-static")
      .executeTakeFirstOrThrow();
    const identity = await db
      .selectFrom("user_provider_identities")
      .selectAll()
      .where("id", "=", "identity-1")
      .executeTakeFirstOrThrow();
    const storedCredentials = JSON.parse(connector.credentials);

    expect(result).toMatchObject({ scannedConnectorRows: 1, convertedConnectorRows: 1, pausedConnectorRows: 0 });
    expect(mintCredential).toHaveBeenCalledWith({
      connectorType: "gmail",
      userEmail: "user@example.com",
      userName: "Admin User",
      userOrgRole: "admin",
    });
    expect(connector.credential_source).toBe("canvas");
    expect(connector.sync_status).toBe("pending");
    expect(connector.error_message).toBeNull();
    expect(storedCredentials).toMatchObject({
      type: "oauth",
      access_token: "",
      refresh_token: "",
      client_id: "canvas",
      client_secret: "canvas",
    });
    expect(connector.credentials).not.toContain("local-refresh");
    expect(staticConnector.credential_source).toBe("local");
    expect(staticConnector.credentials).toContain("clickup-key");
    expect(identity.access_token).toBeNull();
    expect(identity.refresh_token).toBeNull();
    expect(identity.token_expires_at).toBeNull();
  });

  it("pauses local managed OAuth connector rows when Canvas cannot mint", async () => {
    await seedUser({ email: null });
    await seedConnector({ connectorType: "google_drive" });
    await seedIdentity({ provider: "google_drive" });

    const result = await migrateManagedConnectorCredentialsToCanvas({
      db,
      appConfig: { CONNECTOR_CREDENTIAL_SOURCE: "canvas" },
      logger: createTestLogger(),
      mintCredential: vi.fn(async () => {
        throw new Error("Canvas missing connection");
      }),
    });

    const connector = await db
      .selectFrom("connector_configs")
      .selectAll()
      .where("id", "=", "connector-1")
      .executeTakeFirstOrThrow();
    const identity = await db
      .selectFrom("user_provider_identities")
      .selectAll()
      .where("id", "=", "identity-1")
      .executeTakeFirstOrThrow();
    const storedCredentials = JSON.parse(connector.credentials);

    expect(result).toMatchObject({ scannedConnectorRows: 1, convertedConnectorRows: 0, pausedConnectorRows: 1 });
    expect(connector.credential_source).toBe("canvas");
    expect(connector.sync_status).toBe("paused");
    expect(connector.error_message).toBe("Reconnect this integration through Canvas to resume sync");
    expect(storedCredentials.refresh_token).toBe("");
    expect(connector.credentials).not.toContain("local-refresh");
    expect(identity.access_token).toBeNull();
    expect(identity.refresh_token).toBeNull();
  });

  it("scrubs managed provider identity tokens even when there is no connector row", async () => {
    await seedUser();
    await seedIdentity({ provider: "google_calendar" });
    await seedIdentity({ id: "microsoft-identity", provider: "microsoft" });

    const result = await migrateManagedConnectorCredentialsToCanvas({
      db,
      appConfig: { CONNECTOR_CREDENTIAL_SOURCE: "canvas" },
      logger: createTestLogger(),
      mintCredential: vi.fn(),
    });

    const identities = await db
      .selectFrom("user_provider_identities")
      .select(["provider", "access_token", "refresh_token"])
      .orderBy("provider")
      .execute();

    expect(result).toMatchObject({ scannedConnectorRows: 0, scrubbedIdentityRows: 2 });
    expect(identities).toEqual([
      { provider: "google_calendar", access_token: null, refresh_token: null },
      { provider: "microsoft", access_token: null, refresh_token: null },
    ]);
  });
});

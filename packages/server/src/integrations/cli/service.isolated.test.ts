import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentEnvironmentVariableRepository } from "../../db/repositories/agent-environment-variables";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { createCliIntegrationService } from "./service";

const { assertGithubCliAvailableMock, validateGithubTokenInputMock, verifyGithubTokenMock } = vi.hoisted(() => ({
  assertGithubCliAvailableMock: vi.fn(),
  validateGithubTokenInputMock: vi.fn(),
  verifyGithubTokenMock: vi.fn(),
}));

vi.mock("./github", () => ({
  assertGithubCliAvailable: assertGithubCliAvailableMock,
  validateGithubTokenInput: validateGithubTokenInputMock,
  verifyGithubToken: verifyGithubTokenMock,
}));

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("CLI integration service", () => {
  let db: Kysely<DB>;
  let service: ReturnType<typeof createCliIntegrationService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "owner", name: "Owner", email: "owner@example.com", type: "human" },
        { id: "recipient", name: "Recipient", email: "recipient@example.com", type: "human" },
        { id: "external", name: "External", email: "external@example.com", type: "external" },
      ])
      .execute();
    assertGithubCliAvailableMock.mockResolvedValue(undefined);
    verifyGithubTokenMock.mockResolvedValue({
      externalId: "123",
      login: "octocat",
      avatarUrl: "https://github.com/octocat.png",
      accountType: "User",
    });
    service = createCliIntegrationService({
      db,
      encryptionKey: ENCRYPTION_KEY,
      environmentVariables: createAgentEnvironmentVariableRepository(db, ENCRYPTION_KEY),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates an encrypted connection, resolves shares, and disconnects atomically", async () => {
    const connection = await service.connectGitHub("owner", "  ghp_old  ", [{ type: "user", id: "recipient" }]);

    expect(connection).toMatchObject({
      appId: "github",
      executionMode: "cli",
      accountLogin: "octocat",
      status: "active",
      shares: [{ type: "user", id: "recipient" }],
    });
    expect(JSON.stringify(connection)).not.toContain("ghp_old");

    const variable = await db
      .selectFrom("agent_environment_variables")
      .select(["id", "value"])
      .where("id", "=", connection.id)
      .executeTakeFirst();
    const linkedVariable = await db
      .selectFrom("agent_environment_variables")
      .select(["id", "value"])
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(variable).toBeUndefined();
    expect(linkedVariable.value.startsWith("enc:")).toBe(true);

    const recipientConnections = await service.listConnections("recipient");
    expect(recipientConnections[0]).toMatchObject({ isOwnedByViewer: false, canUse: true, canManage: false });

    const runtimeEnv = await service.filterRuntimeEnvironment(
      {
        currentUserId: "recipient",
        contextType: "dm",
        allowOrgSharedEnv: true,
      },
      { GH_TOKEN: "ghp_old" },
    );
    expect(runtimeEnv).toEqual({ GH_TOKEN: "ghp_old" });

    await service.disconnect("owner", connection.id);
    expect(await db.selectFrom("cli_integration_connections").selectAll().execute()).toEqual([]);
    expect(
      await db.selectFrom("agent_environment_variables").selectAll().where("name", "=", "GH_TOKEN").execute(),
    ).toEqual([]);
    expect(await db.selectFrom("agent_environment_variable_shares").selectAll().execute()).toEqual([]);
  });

  it("does not list shared connections to external viewers", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    await expect(service.listConnections("external")).resolves.toEqual([]);
    await service.disconnect("owner", connection.id);
  });

  it("resolves channel and group shares in their runtime contexts", async () => {
    const connection = await service.connectGitHub("owner", "ghp_shared", [
      { type: "slack_channel", id: "C123" },
      { type: "whatsapp_group", id: "group@g.us" },
    ]);

    await expect(
      service.listConnections("recipient", { platform: "slack", deliveryTarget: "C123" }),
    ).resolves.toHaveLength(1);
    await expect(
      service.listConnections("recipient", { platform: "whatsapp", deliveryTarget: "group@g.us" }),
    ).resolves.toHaveLength(1);
    await expect(
      service.filterRuntimeEnvironment(
        {
          currentUserId: "recipient",
          contextType: "channel_mention",
          allowOrgSharedEnv: true,
          taskContext: {
            platform: "slack",
            contextType: "channel",
            deliveryTarget: "C123",
            createdBy: "recipient",
          },
        },
        { GH_TOKEN: "stale" },
      ),
    ).resolves.toEqual({ GH_TOKEN: "ghp_shared" });
    await service.disconnect("owner", connection.id);
  });

  it("keeps an org-shared GitHub token available to internal recipients", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    const runtimeEnv = await service.filterRuntimeEnvironment(
      { currentUserId: "recipient", contextType: "dm", allowOrgSharedEnv: true },
      { GH_TOKEN: "stale-value" },
    );

    expect(runtimeEnv).toEqual({ GH_TOKEN: "ghp_org" });
    expect(await service.resolveAvailability({ currentUserId: "recipient", contextType: "dm" })).toMatchObject([
      { appId: "github", available: true, status: "active" },
    ]);
    await service.disconnect("owner", connection.id);
  });

  it("does not expose an org-shared GitHub token to external users", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    const runtimeEnv = await service.filterRuntimeEnvironment(
      { currentUserId: "external", contextType: "dm", allowOrgSharedEnv: true },
      { GH_TOKEN: "ghp_org" },
    );

    expect(runtimeEnv).toEqual({});
    expect(await service.resolveAvailability({ currentUserId: "external", contextType: "dm" })).toMatchObject([
      { appId: "github", available: false, status: "missing" },
    ]);
    await service.disconnect("owner", connection.id);
  });

  it("rejects duplicates and preserves the old token when replacement verification fails", async () => {
    const connection = await service.connectGitHub("owner", "ghp_old");
    await expect(service.connectGitHub("owner", "ghp_second")).rejects.toMatchObject({
      code: "ALREADY_CONNECTED",
      status: 409,
    });

    const before = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    verifyGithubTokenMock.mockRejectedValueOnce({ code: "INVALID_TOKEN" });

    await expect(service.updateGitHubToken("owner", connection.id, "ghp_bad")).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401,
    });

    const after = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(after.value).toBe(before.value);
  });
});

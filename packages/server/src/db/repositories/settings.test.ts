import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createSettingsRepository } from "./settings";

describe("Settings repository", () => {
  let db: Kysely<DB>;
  let settings: ReturnType<typeof createSettingsRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    settings = createSettingsRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("get() returns null when no settings exist", async () => {
    const result = await settings.get();
    expect(result).toBeNull();
  });

  it("create() inserts a row and get() returns it", async () => {
    await settings.create({ adminEmail: "admin@test.com", adminPasswordHash: "hash123" });
    const row = await settings.get();
    expect(row).not.toBeNull();
    expect(row?.admin_email).toBe("admin@test.com");
    expect(row?.admin_password_hash).toBe("hash123");
    expect(row?.bot_name).toBe("Sketch");
    expect(row?.org_name).toBeNull();
  });

  it("create() auto-generates a jwt_secret", async () => {
    const row = await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    expect(row.jwt_secret).toBeTruthy();
    expect(row.jwt_secret).toHaveLength(64); // 32 bytes hex
  });

  it("create() rejects duplicate settings row", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await expect(settings.create({ adminEmail: "c@d.com", adminPasswordHash: "hash2" })).rejects.toThrow();
  });

  it("update() changes specific columns", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({ orgName: "Acme Corp", botName: "Helper" });

    const row = await settings.get();
    expect(row?.org_name).toBe("Acme Corp");
    expect(row?.bot_name).toBe("Helper");
    expect(row?.admin_email).toBe("a@b.com");
  });

  it("update() with empty data is a no-op", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({});
    const row = await settings.get();
    expect(row?.admin_email).toBe("a@b.com");
  });

  it("update() persists Slack and LLM settings fields", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({
      slackBotToken: "xoxb-token",
      slackAppToken: "xapp-token",
      llmProvider: "bedrock",
      anthropicApiKey: null,
      awsAccessKeyId: "AKIA...",
      awsSecretAccessKey: "secret",
      awsRegion: "us-east-1",
    });

    const row = await settings.get();
    expect(row?.slack_bot_token).toBe("xoxb-token");
    expect(row?.slack_app_token).toBe("xapp-token");
    expect(row?.llm_provider).toBe("bedrock");
    expect(row?.anthropic_api_key).toBeNull();
    expect(row?.aws_access_key_id).toBe("AKIA...");
    expect(row?.aws_secret_access_key).toBe("secret");
    expect(row?.aws_region).toBe("us-east-1");
  });

  it("update() persists embedding provider selection", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({ embeddingProvider: "gemini" });

    expect((await settings.get())?.embedding_provider).toBe("gemini");

    await settings.update({ embeddingProvider: null });
    expect((await settings.get())?.embedding_provider).toBeNull();
  });

  it("update() round-trips admin_can_read_all_files and defaults to 0", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    const initial = await settings.get();
    expect(initial?.admin_can_read_all_files).toBe(0);

    await settings.update({ adminCanReadAllFiles: true });
    expect((await settings.get())?.admin_can_read_all_files).toBe(1);

    await settings.update({ adminCanReadAllFiles: false });
    expect((await settings.get())?.admin_can_read_all_files).toBe(0);
  });

  it("update() persists Microsoft OAuth client settings", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({
      microsoftOauthClientId: "client-id",
      microsoftOauthClientSecret: "client-secret",
      microsoftOauthTenant: "tenant-id",
    });

    const row = await settings.get();
    expect(row?.microsoft_oauth_client_id).toBe("client-id");
    expect(row?.microsoft_oauth_client_secret).toBe("client-secret");
    expect(row?.microsoft_oauth_tenant).toBe("tenant-id");
  });

  it("update() allows clearing Slack and LLM credentials with null values", async () => {
    await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
    await settings.update({
      slackBotToken: "xoxb-token",
      slackAppToken: "xapp-token",
      llmProvider: "anthropic",
      anthropicApiKey: "sk-ant-key",
    });
    await settings.update({
      slackBotToken: null,
      slackAppToken: null,
      llmProvider: null,
      anthropicApiKey: null,
      awsAccessKeyId: null,
      awsSecretAccessKey: null,
      awsRegion: null,
    });

    const row = await settings.get();
    expect(row?.slack_bot_token).toBeNull();
    expect(row?.slack_app_token).toBeNull();
    expect(row?.llm_provider).toBeNull();
    expect(row?.anthropic_api_key).toBeNull();
    expect(row?.aws_access_key_id).toBeNull();
    expect(row?.aws_secret_access_key).toBeNull();
    expect(row?.aws_region).toBeNull();
  });

  describe("get() cache", () => {
    it("serves the cached row until a repository write invalidates", async () => {
      await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
      expect((await settings.get())?.org_name).toBeNull();

      await db.updateTable("settings").set({ org_name: "Bypass" }).where("id", "=", "default").execute();
      expect((await settings.get())?.org_name).toBeNull();

      await settings.update({ orgName: "ViaRepo" });
      expect((await settings.get())?.org_name).toBe("ViaRepo");
    });

    it("invalidates a cached null after create()", async () => {
      expect(await settings.get()).toBeNull();

      await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
      const row = await settings.get();
      expect(row?.admin_email).toBe("a@b.com");
    });

    it("returns defensive copies so callers cannot poison the cache", async () => {
      await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
      const first = await settings.get();
      expect(first).not.toBeNull();
      if (!first) return;
      first.org_name = "mutated";

      expect((await settings.get())?.org_name).toBeNull();
    });

    it("refreshes after TTL without a repository write", async () => {
      let nowMs = 1_000;
      settings = createSettingsRepository(db, undefined, {
        cacheTtlMs: 100,
        now: () => nowMs,
      });

      await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
      expect((await settings.get())?.org_name).toBeNull();

      await db.updateTable("settings").set({ org_name: "AfterTtl" }).where("id", "=", "default").execute();
      expect((await settings.get())?.org_name).toBeNull();

      nowMs += 101;
      expect((await settings.get())?.org_name).toBe("AfterTtl");
    });

    it("update() with empty data does not invalidate", async () => {
      await settings.create({ adminEmail: "a@b.com", adminPasswordHash: "hash" });
      expect((await settings.get())?.org_name).toBeNull();

      await db.updateTable("settings").set({ org_name: "StillCached" }).where("id", "=", "default").execute();
      await settings.update({});
      expect((await settings.get())?.org_name).toBeNull();
    });

    it("ensure() returns fresh data and repopulates the cache", async () => {
      const ensured = await settings.ensure();
      expect(ensured.jwt_secret).toBeTruthy();

      await db.updateTable("settings").set({ org_name: "Bypass" }).where("id", "=", "default").execute();
      expect((await settings.get())?.org_name).toBeNull();
    });
  });
});

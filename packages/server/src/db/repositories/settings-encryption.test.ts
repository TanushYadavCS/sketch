import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createSettingsRepository } from "./settings";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const SEED = { adminEmail: "admin@test.com", adminPasswordHash: "hash" };

async function rawField(db: Kysely<DB>, field: keyof DB["settings"]): Promise<string | null | undefined> {
  const row = await db.selectFrom("settings").select(field).where("id", "=", "default").executeTakeFirst();
  return row?.[field] as string | null | undefined;
}

describe("Settings repository encryption", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("with encryption key", () => {
    it("stores slack_bot_token as enc:-prefixed ciphertext", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ slackBotToken: "xoxb-test-token" });

      const raw = await rawField(db, "slack_bot_token");
      expect(raw).toBeDefined();
      expect(typeof raw).toBe("string");
      expect((raw as string).startsWith("enc:")).toBe(true);
    });

    it("get() returns decrypted slack_bot_token", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ slackBotToken: "xoxb-test-token" });

      const row = await settings.get();
      expect(row?.slack_bot_token).toBe("xoxb-test-token");
    });

    it("stores slack_app_token encrypted and decrypts on get()", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ slackAppToken: "xapp-test-token" });

      const raw = await rawField(db, "slack_app_token");
      expect((raw as string).startsWith("enc:")).toBe(true);

      const row = await settings.get();
      expect(row?.slack_app_token).toBe("xapp-test-token");
    });

    it("stores anthropic_api_key encrypted and decrypts on get()", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ anthropicApiKey: "sk-ant-test-key" });

      const raw = await rawField(db, "anthropic_api_key");
      expect((raw as string).startsWith("enc:")).toBe(true);

      const row = await settings.get();
      expect(row?.anthropic_api_key).toBe("sk-ant-test-key");
    });

    it("stores aws_secret_access_key encrypted and decrypts on get()", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ awsSecretAccessKey: "aws-super-secret" });

      const raw = await rawField(db, "aws_secret_access_key");
      expect((raw as string).startsWith("enc:")).toBe(true);

      const row = await settings.get();
      expect(row?.aws_secret_access_key).toBe("aws-super-secret");
    });

    it("setting a sensitive field to null stores null (not encrypted null)", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ slackBotToken: "xoxb-token" });
      await settings.update({ slackBotToken: null });

      const raw = await rawField(db, "slack_bot_token");
      expect(raw).toBeNull();

      const row = await settings.get();
      expect(row?.slack_bot_token).toBeNull();
    });

    it("does NOT encrypt non-sensitive fields (org_name, bot_name)", async () => {
      const settings = createSettingsRepository(db, TEST_KEY);
      await settings.create(SEED);
      await settings.update({ orgName: "Acme Corp", botName: "Helper" });

      const orgRaw = await rawField(db, "org_name");
      const botRaw = await rawField(db, "bot_name");

      expect(orgRaw).toBe("Acme Corp");
      expect(botRaw).toBe("Helper");
    });
  });

  describe("without encryption key (plaintext behavior preserved)", () => {
    it("stores slack_bot_token as plaintext", async () => {
      const settings = createSettingsRepository(db);
      await settings.create(SEED);
      await settings.update({ slackBotToken: "xoxb-test-token" });

      const raw = await rawField(db, "slack_bot_token");
      expect(raw).toBe("xoxb-test-token");
    });

    it("get() returns slack_bot_token as plaintext", async () => {
      const settings = createSettingsRepository(db);
      await settings.create(SEED);
      await settings.update({ slackBotToken: "xoxb-test-token" });

      const row = await settings.get();
      expect(row?.slack_bot_token).toBe("xoxb-test-token");
    });
  });

  describe("error case", () => {
    it("get() throws a clear error if an enc:-prefixed value is present but no key is provided", async () => {
      // Write via the encrypted repo, then read with an unkeyed repo.
      const encryptedSettings = createSettingsRepository(db, TEST_KEY);
      await encryptedSettings.create(SEED);
      await encryptedSettings.update({ slackBotToken: "xoxb-test-token" });

      const plaintextSettings = createSettingsRepository(db);
      await expect(plaintextSettings.get()).rejects.toThrow();
    });
  });
});

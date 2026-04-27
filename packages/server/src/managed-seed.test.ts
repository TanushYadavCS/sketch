import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsRepository } from "./db/repositories/settings";
import { createUserRepository } from "./db/repositories/users";
import type { DB } from "./db/schema";
import { runManagedSeed } from "./managed-seed";
import { createTestConfig, createTestDb } from "./test-utils";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("runManagedSeed", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("seeds admin account when BOOTSTRAP env vars are set and no admin exists", async () => {
    const config = createTestConfig({
      BOOTSTRAP_ADMIN_EMAIL: "admin@test.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: "hashed-password",
    });
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);

    await runManagedSeed(config, settingsRepo, userRepo);

    const row = await settingsRepo.get();
    expect(row?.bot_name).toBe("Sketch");
    const admin = await userRepo.findByEmail("admin@test.com");
    expect(admin?.auth_role).toBe("admin");
    expect(admin?.password_hash).toBe("hashed-password");
  });

  it("is idempotent -- ignores bootstrap vars when admin already exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await settingsRepo.create();
    await userRepo.create({
      name: "existing",
      email: "existing@test.com",
      emailVerified: true,
      passwordHash: "existing-hash",
      authRole: "admin",
    });

    const config = createTestConfig({
      BOOTSTRAP_ADMIN_EMAIL: "intruder@test.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: "new-hash",
    });

    await runManagedSeed(config, settingsRepo, userRepo);

    const existing = await userRepo.findByEmail("existing@test.com");
    const intruder = await userRepo.findByEmail("intruder@test.com");
    expect(existing?.auth_role).toBe("admin");
    expect(intruder).toBeUndefined();
  });

  it("stores Slack bot token from BOOTSTRAP_SLACK_BOT_TOKEN", async () => {
    const config = createTestConfig({
      BOOTSTRAP_ADMIN_EMAIL: "admin@test.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: "hashed-password",
      BOOTSTRAP_SLACK_BOT_TOKEN: "xoxb-bootstrap-token",
    });
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);

    await runManagedSeed(config, settingsRepo, userRepo);

    const row = await settingsRepo.get();
    expect(row?.slack_bot_token).toBe("xoxb-bootstrap-token");
  });

  it("encrypts Slack bot token when ENCRYPTION_KEY is set", async () => {
    const config = createTestConfig({
      BOOTSTRAP_ADMIN_EMAIL: "admin@test.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: "hashed-password",
      BOOTSTRAP_SLACK_BOT_TOKEN: "xoxb-bootstrap-token",
      ENCRYPTION_KEY: TEST_KEY,
    });
    const settingsRepo = createSettingsRepository(db, config.ENCRYPTION_KEY);
    const userRepo = createUserRepository(db);

    await runManagedSeed(config, settingsRepo, userRepo);

    const rawRow = await db
      .selectFrom("settings")
      .select("slack_bot_token")
      .where("id", "=", "default")
      .executeTakeFirst();
    expect(rawRow?.slack_bot_token?.startsWith("enc:")).toBe(true);

    const decryptedRow = await settingsRepo.get();
    expect(decryptedRow?.slack_bot_token).toBe("xoxb-bootstrap-token");
  });

  it("does not seed when only BOOTSTRAP_ADMIN_EMAIL is set without password hash", async () => {
    const config = createTestConfig({
      BOOTSTRAP_ADMIN_EMAIL: "admin@test.com",
    });
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);

    await runManagedSeed(config, settingsRepo, userRepo);

    const row = await settingsRepo.get();
    expect(row).toBeNull();
  });

  it("does NOT store Slack token when admin already exists", async () => {
    const settingsRepo = createSettingsRepository(db);
    const userRepo = createUserRepository(db);
    await settingsRepo.create();
    await userRepo.create({
      name: "existing",
      email: "existing@test.com",
      emailVerified: true,
      passwordHash: "existing-hash",
      authRole: "admin",
    });

    const config = createTestConfig({
      BOOTSTRAP_SLACK_BOT_TOKEN: "xoxb-bootstrap-token",
    });

    await runManagedSeed(config, settingsRepo, userRepo);

    const row = await settingsRepo.get();
    expect(row?.slack_bot_token).toBeNull();
  });
});

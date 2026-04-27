import type { Config } from "./config";
import type { createSettingsRepository } from "./db/repositories/settings";
import type { createUserRepository } from "./db/repositories/users";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

/**
 * Seeds admin account and Slack bot token from BOOTSTRAP_* env vars on first boot.
 * Idempotent: if an admin account already exists, bootstrap vars are ignored.
 */
export async function runManagedSeed(config: Config, settingsRepo: SettingsRepo, userRepo?: UserRepo): Promise<void> {
  const existing = await settingsRepo.get();
  const existingAdmin = userRepo ? await userRepo.findFirstLocalAdmin() : null;

  if (config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_PASSWORD_HASH && !existing && !existingAdmin) {
    await settingsRepo.create();

    if (userRepo) {
      const email = config.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
      const existingUser = await userRepo.findByEmail(email);
      if (existingUser) {
        await userRepo.update(existingUser.id, {
          email,
          emailVerified: true,
          passwordHash: config.BOOTSTRAP_ADMIN_PASSWORD_HASH,
          authRole: "admin",
        });
      } else {
        await userRepo.create({
          name: email.split("@")[0],
          email,
          emailVerified: true,
          passwordHash: config.BOOTSTRAP_ADMIN_PASSWORD_HASH,
          authRole: "admin",
        });
      }
    } else {
      await settingsRepo.update({
        adminEmail: config.BOOTSTRAP_ADMIN_EMAIL,
        adminPasswordHash: config.BOOTSTRAP_ADMIN_PASSWORD_HASH,
      });
    }

    if (config.BOOTSTRAP_SLACK_BOT_TOKEN) {
      await settingsRepo.update({ slackBotToken: config.BOOTSTRAP_SLACK_BOT_TOKEN });
    }
  }
}

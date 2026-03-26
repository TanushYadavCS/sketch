import type { Config } from "./config";
import type { createSettingsRepository } from "./db/repositories/settings";

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

/**
 * Seeds admin account and Slack bot token from BOOTSTRAP_* env vars on first boot.
 * Idempotent: if an admin account already exists, bootstrap vars are ignored.
 */
export async function runManagedSeed(config: Config, settingsRepo: SettingsRepo): Promise<void> {
  const existing = await settingsRepo.get();

  if (config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_PASSWORD_HASH && !existing) {
    await settingsRepo.create({
      adminEmail: config.BOOTSTRAP_ADMIN_EMAIL,
      adminPasswordHash: config.BOOTSTRAP_ADMIN_PASSWORD_HASH,
    });

    if (config.BOOTSTRAP_SLACK_BOT_TOKEN) {
      await settingsRepo.update({ slackBotToken: config.BOOTSTRAP_SLACK_BOT_TOKEN });
    }
  }
}

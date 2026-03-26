import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { decrypt, encrypt } from "../../auth/encryption";
import type { DB } from "../schema";

const SENSITIVE_FIELDS = new Set<string>([
  "slack_bot_token",
  "slack_app_token",
  "anthropic_api_key",
  "aws_secret_access_key",
  "gemini_api_key",
  "smtp_password",
  "google_oauth_client_secret",
  "jwt_secret",
]);

export function createSettingsRepository(db: Kysely<DB>, encryptionKey?: string) {
  return {
    async get() {
      const row = await db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirst();
      if (!row) return null;
      for (const field of SENSITIVE_FIELDS) {
        const value = (row as Record<string, unknown>)[field];
        if (typeof value === "string" && value.startsWith("enc:")) {
          if (!encryptionKey) {
            throw new Error(`Encrypted value found for ${field} but ENCRYPTION_KEY is not set`);
          }
          (row as Record<string, unknown>)[field] = decrypt(value, encryptionKey);
        }
      }
      return row;
    },

    async create(data: { adminEmail: string; adminPasswordHash: string }) {
      const jwtSecret = randomBytes(32).toString("hex");
      await db
        .insertInto("settings")
        .values({
          id: "default",
          admin_email: data.adminEmail,
          admin_password_hash: data.adminPasswordHash,
          jwt_secret: encryptionKey ? encrypt(jwtSecret, encryptionKey) : jwtSecret,
        })
        .execute();

      return db.selectFrom("settings").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
    },

    async update(
      data: Partial<{
        adminEmail: string;
        adminPasswordHash: string;
        orgName: string;
        botName: string;
        onboardingCompletedAt: string;
        slackBotToken: string | null;
        slackAppToken: string | null;
        llmProvider: string | null;
        anthropicApiKey: string | null;
        awsAccessKeyId: string | null;
        awsSecretAccessKey: string | null;
        awsRegion: string | null;
        jwtSecret: string;
        smtpHost: string | null;
        smtpPort: number | null;
        smtpUser: string | null;
        smtpPassword: string | null;
        smtpFrom: string | null;
        smtpSecure: number | null;
        googleOauthClientId: string | null;
        googleOauthClientSecret: string | null;
        geminiApiKey: string | null;
        enrichmentEnabled: number | null;
      }>,
    ) {
      const updates: Record<string, string | number | null> = {};
      if (data.adminEmail !== undefined) updates.admin_email = data.adminEmail;
      if (data.adminPasswordHash !== undefined) updates.admin_password_hash = data.adminPasswordHash;
      if (data.jwtSecret !== undefined) updates.jwt_secret = data.jwtSecret;
      if (data.orgName !== undefined) updates.org_name = data.orgName;
      if (data.botName !== undefined) updates.bot_name = data.botName;
      if (data.onboardingCompletedAt !== undefined) updates.onboarding_completed_at = data.onboardingCompletedAt;
      if (data.slackBotToken !== undefined) updates.slack_bot_token = data.slackBotToken;
      if (data.slackAppToken !== undefined) updates.slack_app_token = data.slackAppToken;
      if (data.llmProvider !== undefined) updates.llm_provider = data.llmProvider;
      if (data.anthropicApiKey !== undefined) updates.anthropic_api_key = data.anthropicApiKey;
      if (data.awsAccessKeyId !== undefined) updates.aws_access_key_id = data.awsAccessKeyId;
      if (data.awsSecretAccessKey !== undefined) updates.aws_secret_access_key = data.awsSecretAccessKey;
      if (data.awsRegion !== undefined) updates.aws_region = data.awsRegion;
      if (data.smtpHost !== undefined) updates.smtp_host = data.smtpHost;
      if (data.smtpPort !== undefined) updates.smtp_port = data.smtpPort;
      if (data.smtpUser !== undefined) updates.smtp_user = data.smtpUser;
      if (data.smtpPassword !== undefined) updates.smtp_password = data.smtpPassword;
      if (data.smtpFrom !== undefined) updates.smtp_from = data.smtpFrom;
      if (data.smtpSecure !== undefined) updates.smtp_secure = data.smtpSecure;
      if (data.googleOauthClientId !== undefined) updates.google_oauth_client_id = data.googleOauthClientId;
      if (data.googleOauthClientSecret !== undefined) updates.google_oauth_client_secret = data.googleOauthClientSecret;
      if (data.geminiApiKey !== undefined) updates.gemini_api_key = data.geminiApiKey;
      if (data.enrichmentEnabled !== undefined) updates.enrichment_enabled = data.enrichmentEnabled;

      if (Object.keys(updates).length === 0) return;

      if (encryptionKey) {
        for (const field of SENSITIVE_FIELDS) {
          const value = updates[field];
          if (typeof value === "string") {
            updates[field] = encrypt(value, encryptionKey);
          }
        }
      }

      await db.updateTable("settings").set(updates).where("id", "=", "default").execute();
    },
  };
}

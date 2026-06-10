import { LLM_PROVIDERS } from "@sketch/shared";
import type { SettingsTable } from "../db/schema";
import type { Logger } from "../logger";

type LlmSettings = Pick<
  SettingsTable,
  "llm_provider" | "anthropic_api_key" | "aws_access_key_id" | "aws_secret_access_key" | "aws_region" | "model_id"
>;

function unsetEnv(...keys: string[]) {
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key);
  }
}

function clearProviderRoutingEnv() {
  unsetEnv(
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
  );
}

export function applyLlmEnvFromSettings(settings: LlmSettings | null, logger?: Logger): void {
  if (!settings || !settings.llm_provider) {
    logger?.warn("No LLM provider configured in settings; using existing environment-based LLM config");
    return;
  }

  if (settings.llm_provider === "anthropic") {
    if (!settings.anthropic_api_key) {
      logger?.warn(
        { llmProvider: settings.llm_provider, hasAnthropicKey: false },
        "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
      );
      return;
    }

    clearProviderRoutingEnv();
    unsetEnv("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION");
    process.env.ANTHROPIC_API_KEY = settings.anthropic_api_key;
    process.env.ANTHROPIC_MODEL = settings.model_id || "claude-sonnet-4-6";
    logger?.info({ llmProvider: "anthropic", source: "db" }, "Configured LLM provider from DB settings");
    return;
  }

  if (settings.llm_provider === "bedrock") {
    if (!settings.aws_access_key_id || !settings.aws_secret_access_key || !settings.aws_region) {
      logger?.warn(
        {
          llmProvider: settings.llm_provider,
          hasAwsAccessKeyId: Boolean(settings.aws_access_key_id),
          hasAwsSecretAccessKey: Boolean(settings.aws_secret_access_key),
          hasAwsRegion: Boolean(settings.aws_region),
        },
        "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
      );
      return;
    }

    clearProviderRoutingEnv();
    unsetEnv("ANTHROPIC_API_KEY");
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_ACCESS_KEY_ID = settings.aws_access_key_id;
    process.env.AWS_SECRET_ACCESS_KEY = settings.aws_secret_access_key;
    process.env.AWS_REGION = settings.aws_region;
    process.env.ANTHROPIC_MODEL = settings.model_id || "us.anthropic.claude-sonnet-4-6";
    logger?.info({ llmProvider: "bedrock", source: "db" }, "Configured LLM provider from DB settings");
    return;
  }

  if (settings.llm_provider === "openrouter") {
    if (!settings.anthropic_api_key || !settings.model_id) {
      logger?.warn(
        {
          llmProvider: settings.llm_provider,
          hasAnthropicKey: Boolean(settings.anthropic_api_key),
          hasModelId: Boolean(settings.model_id),
        },
        "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
      );
      return;
    }

    clearProviderRoutingEnv();
    unsetEnv("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION");
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_AUTH_TOKEN = settings.anthropic_api_key;
    process.env.ANTHROPIC_API_KEY = "";
    process.env.ANTHROPIC_MODEL = settings.model_id;
    logger?.info({ llmProvider: "openrouter", source: "db" }, "Configured LLM provider from DB settings");
    return;
  }

  logger?.warn(
    {
      llmProvider: settings.llm_provider,
      supportedProviders: LLM_PROVIDERS,
    },
    "Unsupported LLM provider in DB; preserving existing environment-based LLM config",
  );
}

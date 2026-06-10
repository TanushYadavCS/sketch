import { LLM_PROVIDERS } from "@sketch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLlmEnvFromSettings } from "./llm-env";

const ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
] as const;

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
      continue;
    }
    process.env[key] = value;
  }
}

describe("applyLlmEnvFromSettings", () => {
  const initialEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(initialEnv);
    vi.restoreAllMocks();
  });

  it("does nothing when settings are missing", () => {
    process.env.ANTHROPIC_API_KEY = "existing-key";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(null, logger as never);

    expect(process.env.ANTHROPIC_API_KEY).toBe("existing-key");
    expect(logger.warn).toHaveBeenCalledWith(
      "No LLM provider configured in settings; using existing environment-based LLM config",
    );
  });

  it("configures anthropic and clears bedrock routing env", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_ACCESS_KEY_ID = "aws-access";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.AWS_REGION = "us-east-1";
    process.env.ANTHROPIC_AUTH_TOKEN = "legacy";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "anthropic",
        anthropic_api_key: "sk-ant-live",
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: null,
      },
      logger as never,
    );

    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-live");
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      { llmProvider: "anthropic", source: "db" },
      "Configured LLM provider from DB settings",
    );
  });

  it("preserves env for incomplete anthropic settings", () => {
    process.env.ANTHROPIC_API_KEY = "existing-key";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "anthropic",
        anthropic_api_key: null,
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: null,
      },
      logger as never,
    );

    expect(process.env.ANTHROPIC_API_KEY).toBe("existing-key");
    expect(logger.warn).toHaveBeenCalledWith(
      { llmProvider: "anthropic", hasAnthropicKey: false },
      "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
    );
  });

  it("configures bedrock and clears anthropic env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-existing";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "bedrock",
        anthropic_api_key: null,
        aws_access_key_id: "AKIA...",
        aws_secret_access_key: "secret",
        aws_region: "us-west-2",
        model_id: null,
      },
      logger as never,
    );

    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("AKIA...");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    expect(process.env.AWS_REGION).toBe("us-west-2");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      { llmProvider: "bedrock", source: "db" },
      "Configured LLM provider from DB settings",
    );
  });

  it("preserves env for incomplete bedrock settings", () => {
    process.env.AWS_ACCESS_KEY_ID = "existing-access";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "bedrock",
        anthropic_api_key: null,
        aws_access_key_id: "",
        aws_secret_access_key: "secret",
        aws_region: "us-west-2",
        model_id: null,
      },
      logger as never,
    );

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("existing-access");
    expect(logger.warn).toHaveBeenCalledWith(
      {
        llmProvider: "bedrock",
        hasAwsAccessKeyId: false,
        hasAwsSecretAccessKey: true,
        hasAwsRegion: true,
      },
      "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
    );
  });

  it("configures openrouter and clears bedrock + anthropic env", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_ACCESS_KEY_ID = "aws-access";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.AWS_REGION = "us-east-1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-existing";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "openrouter",
        anthropic_api_key: "sk-or-v1-tenant-key",
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: "anthropic/claude-sonnet-4.6@preset/sketch-bedrock",
      },
      logger as never,
    );

    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-v1-tenant-key");
    expect(process.env.ANTHROPIC_API_KEY).toBe("");
    expect(process.env.ANTHROPIC_MODEL).toBe("anthropic/claude-sonnet-4.6@preset/sketch-bedrock");
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      { llmProvider: "openrouter", source: "db" },
      "Configured LLM provider from DB settings",
    );
  });

  it("preserves env for incomplete openrouter settings", () => {
    process.env.ANTHROPIC_API_KEY = "existing-key";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "openrouter",
        anthropic_api_key: null,
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: "anthropic/claude-sonnet-4.6@preset/sketch-bedrock",
      },
      logger as never,
    );

    expect(process.env.ANTHROPIC_API_KEY).toBe("existing-key");
    expect(logger.warn).toHaveBeenCalledWith(
      { llmProvider: "openrouter", hasAnthropicKey: false, hasModelId: true },
      "Incomplete LLM settings in DB; preserving existing environment-based LLM config",
    );
  });

  it("warns and leaves env untouched for unsupported providers", () => {
    process.env.ANTHROPIC_API_KEY = "existing-key";
    const logger = { warn: vi.fn(), info: vi.fn() };

    applyLlmEnvFromSettings(
      {
        llm_provider: "vertex",
        anthropic_api_key: null,
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: null,
      },
      logger as never,
    );

    expect(process.env.ANTHROPIC_API_KEY).toBe("existing-key");
    expect(logger.warn).toHaveBeenCalledWith(
      { llmProvider: "vertex", supportedProviders: LLM_PROVIDERS },
      "Unsupported LLM provider in DB; preserving existing environment-based LLM config",
    );
  });
});

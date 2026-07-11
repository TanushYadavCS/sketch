import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import { createAgentRuntimeProvider, resolveAgentRuntimeProviderConfigFromSettings } from "./provider";

describe("agent runtime provider factory", () => {
  it("constructs direct Anthropic models and anchors cache breakpoints on instructions and last message", () => {
    const provider = createAgentRuntimeProvider({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant-test",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });

    const prompt = provider.preparePrompt({
      systemPrompt: "format like Sketch",
      prompt: "summarize this",
      cacheBreakpoints: true,
    });

    expect(provider.provider).toBe("anthropic");
    expect(provider.modelId).toBe("claude-sonnet-4-6");
    expect(prompt.instructions).toMatchObject({
      role: "system",
      content: "format like Sketch",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(prompt.messages).toEqual([
      {
        role: "user",
        content: "summarize this",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("constructs Bedrock models and puts the cache point on the system instructions payload", () => {
    const provider = createAgentRuntimeProvider({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      region: "us-east-1",
      awsAccessKeyId: "AKIATEST",
      awsSecretAccessKey: "secret",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });

    const prompt = provider.preparePrompt({
      systemPrompt: "format like Sketch",
      prompt: "summarize this",
      cacheBreakpoints: true,
    });

    expect(provider.provider).toBe("bedrock");
    expect(provider.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(prompt.instructions).toMatchObject({
      role: "system",
      content: "format like Sketch",
      providerOptions: { bedrock: { cachePoint: { type: "default" } } },
    });
    expect(prompt.messages).toEqual([
      {
        role: "user",
        content: "summarize this",
        providerOptions: { bedrock: { cachePoint: { type: "default" } } },
      },
    ]);
  });

  it("constructs arbitrary OpenRouter models through the OpenAI-compatible provider without cache markers", () => {
    const provider = createAgentRuntimeProvider({
      provider: "openrouter",
      modelId: "vendor/non-claude-live-model",
      apiKey: "or-test",
      baseUrl: "https://openrouter.ai/api/v1",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });

    expect(provider.provider).toBe("openrouter");
    expect(provider.modelId).toBe("vendor/non-claude-live-model");
    expect(provider.preparePrompt({ systemPrompt: "sys", prompt: "user", cacheBreakpoints: true })).toEqual({
      instructions: "sys",
      messages: [{ role: "user", content: "user" }],
    });
  });

  it("constructs Vertex models from explicit project settings", () => {
    const provider = createAgentRuntimeProvider({
      provider: "vertex",
      modelId: "claude-sonnet-4-6",
      vertexProject: "sketch-prod",
      vertexLocation: "us-east5",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });

    expect(provider.provider).toBe("vertex");
    expect(provider.modelId).toBe("claude-sonnet-4-6");
  });

  it("derives provider config from settings without mutating Claude SDK env resolution", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(
      {
        llm_provider: "bedrock",
        anthropic_api_key: null,
        aws_access_key_id: "settings-key",
        aws_secret_access_key: "settings-secret",
        aws_region: "ap-south-1",
        model_id: "us.anthropic.claude-sonnet-4-6",
      },
      {},
    );

    expect(config).toMatchObject({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId: "settings-key",
      awsSecretAccessKey: "settings-secret",
      region: "ap-south-1",
    });
  });

  it("resolves settings Bedrock with ambient AWS credentials", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(
      {
        llm_provider: "bedrock",
        anthropic_api_key: null,
        aws_access_key_id: null,
        aws_secret_access_key: null,
        aws_region: null,
        model_id: "us.anthropic.claude-sonnet-4-6",
      },
      {},
    );

    expect(config).toMatchObject({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId: null,
      awsSecretAccessKey: null,
      region: null,
    });
  });

  it("resolves env Bedrock with ambient AWS credentials and optional region", () => {
    const withRegion = resolveAgentRuntimeProviderConfigFromSettings(null, {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    });
    const withoutRegion = resolveAgentRuntimeProviderConfigFromSettings(null, {
      CLAUDE_CODE_USE_BEDROCK: "1",
    });

    expect(withRegion).toMatchObject({
      provider: "bedrock",
      awsAccessKeyId: null,
      awsSecretAccessKey: null,
      region: "us-east-1",
    });
    expect(withoutRegion).toMatchObject({
      provider: "bedrock",
      awsAccessKeyId: null,
      awsSecretAccessKey: null,
      region: null,
    });
  });

  it("resolves env Bedrock with static AWS credentials when present", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "env-key",
      AWS_SECRET_ACCESS_KEY: "env-secret",
      AWS_SESSION_TOKEN: "env-session",
      AWS_DEFAULT_REGION: "us-west-2",
      ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-6",
    });

    expect(config).toMatchObject({
      provider: "bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      awsAccessKeyId: "env-key",
      awsSecretAccessKey: "env-secret",
      awsSessionToken: "env-session",
      region: "us-west-2",
    });
  });

  it("routes OpenRouter Anthropic base URLs through the OpenAI-compatible provider", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-auth",
      ANTHROPIC_MODEL: "vendor/openrouter-model",
    });

    expect(config).toMatchObject({
      provider: "openrouter",
      modelId: "vendor/openrouter-model",
      apiKey: "sk-or-auth",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("routes OpenRouter API keys with an OpenRouter base URL through the OpenRouter provider", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "sk-or-key",
      ANTHROPIC_MODEL: "vendor/openrouter-model",
    });

    expect(config).toMatchObject({
      provider: "openrouter",
      modelId: "vendor/openrouter-model",
      apiKey: "sk-or-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("routes non-OpenRouter custom Anthropic base URLs through the Anthropic provider", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      ANTHROPIC_BASE_URL: "https://my-anthropic-gateway.internal",
      ANTHROPIC_AUTH_TOKEN: "sk-gateway-auth",
      ANTHROPIC_MODEL: "claude-gateway-model",
    });

    expect(config).toMatchObject({
      provider: "anthropic",
      modelId: "claude-gateway-model",
      apiKey: "sk-gateway-auth",
      baseUrl: "https://my-anthropic-gateway.internal",
    });
  });

  it("keeps plain Anthropic API key env resolution on the default Anthropic provider", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      ANTHROPIC_API_KEY: "sk-ant-default",
    });

    expect(config).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant-default",
    });
    expect(config).not.toHaveProperty("baseUrl");
  });
});

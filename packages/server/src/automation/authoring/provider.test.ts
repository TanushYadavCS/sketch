import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../../agent/runtime/pricing";
import { AutomationAuthoringProviderError, createAutomationAuthoringProviderLoader } from "./provider";

const openRouterConfig = {
  provider: "openrouter" as const,
  modelId: "xiaomi/mimo-v2.5",
  apiKey: "sk-or-existing",
  baseUrl: "https://openrouter.ai/api/v1",
  headers: { "X-Title": "Sketch" },
  costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
};

describe("automation authoring provider", () => {
  it("reuses the configured OpenRouter connection and overrides only its model", async () => {
    const createProvider = vi.fn((config) => config);
    const load = createAutomationAuthoringProviderLoader(
      {
        modelId: "anthropic/claude-sonnet-4.6",
        loadProviderConfig: async () => openRouterConfig,
      },
      { createProvider },
    );

    await expect(load()).resolves.toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.6",
      apiKey: "sk-or-existing",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: { "X-Title": "Sketch" },
    });
    expect(createProvider).toHaveBeenCalledWith({
      ...openRouterConfig,
      modelId: "anthropic/claude-sonnet-4.6",
    });
  });

  it.each(["anthropic", "bedrock", "vertex", "openai-compatible"] as const)(
    "rejects the %s provider instead of silently using it",
    async (provider) => {
      const load = createAutomationAuthoringProviderLoader(
        {
          modelId: "anthropic/claude-sonnet-4.6",
          loadProviderConfig: async () => ({ ...openRouterConfig, provider }),
        },
        { createProvider: vi.fn() },
      );

      await expect(load()).rejects.toMatchObject({
        name: "AutomationAuthoringProviderError",
        code: "OPENROUTER_REQUIRED",
      });
    },
  );

  it("fails closed when the configured provider cannot be resolved", async () => {
    const load = createAutomationAuthoringProviderLoader(
      {
        modelId: "anthropic/claude-sonnet-4.6",
        loadProviderConfig: async () => null,
      },
      { createProvider: vi.fn() },
    );

    await expect(load()).rejects.toEqual(
      new AutomationAuthoringProviderError(
        "PROVIDER_UNAVAILABLE",
        "Automation authoring requires a complete OpenRouter provider configuration",
      ),
    );
  });

  it("does not mutate process-wide provider environment variables", async () => {
    const before = {
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    };
    const load = createAutomationAuthoringProviderLoader(
      {
        modelId: "anthropic/claude-sonnet-4.6",
        loadProviderConfig: async () => openRouterConfig,
      },
      { createProvider: (config) => config },
    );

    await load();

    expect({
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    }).toEqual(before);
  });
});

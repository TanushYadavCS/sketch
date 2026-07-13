import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE, computeRuntimeCost, findRuntimeModelPricing } from "./pricing";

describe("agent runtime pricing", () => {
  it("looks up current Anthropic and Bedrock Claude model pricing by exact provider model id", () => {
    expect(
      findRuntimeModelPricing({
        costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toMatchObject({
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      cacheReadUsdPerMillionTokens: 0.3,
      cacheWriteUsdPerMillionTokens: 3.75,
    });

    expect(
      findRuntimeModelPricing({
        costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
        provider: "bedrock",
        model: "us.anthropic.claude-sonnet-4-6",
      }),
    ).toMatchObject({
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      cacheReadUsdPerMillionTokens: 0.3,
      cacheWriteUsdPerMillionTokens: 3.75,
    });
  });

  it("computes per-model input, output, cache read, and cache write costs from the data table", () => {
    const cost = computeRuntimeCost({
      provider: "bedrock",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
      usage: {
        byModel: {
          "us.anthropic.claude-sonnet-4-6": {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 10_000,
          },
        },
        totalInputTokens: 1_000_000,
        totalOutputTokens: 100_000,
        totalCacheReadTokens: 2_000_000,
        totalCacheWriteTokens: 10_000,
      },
    });

    expect(cost.byModel["us.anthropic.claude-sonnet-4-6"]).toMatchObject({
      inputUsd: 3,
      outputUsd: 1.5,
      cacheReadUsd: 0.6,
      cacheWriteUsd: 0.0375,
    });
    expect(cost.byModel["us.anthropic.claude-sonnet-4-6"]?.totalUsd).toBeCloseTo(5.1375);
    expect(cost.totalUsd).toBeCloseTo(5.1375);
  });

  it("prices cached turns without charging cached tokens again as full input", () => {
    const cost = computeRuntimeCost({
      provider: "bedrock",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
      usage: {
        byModel: {
          "us.anthropic.claude-sonnet-4-6": {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadTokens: 13223,
            cacheWriteTokens: 12,
          },
        },
        totalInputTokens: 3,
        totalOutputTokens: 4,
        totalCacheReadTokens: 13223,
        totalCacheWriteTokens: 12,
      },
    });

    expect(cost.byModel["us.anthropic.claude-sonnet-4-6"]).toMatchObject({
      inputUsd: (3 * 3) / 1_000_000,
      outputUsd: (4 * 15) / 1_000_000,
      cacheReadUsd: (13223 * 0.3) / 1_000_000,
      cacheWriteUsd: (12 * 3.75) / 1_000_000,
    });
    expect(cost.totalUsd).toBeCloseTo((3 * 3 + 4 * 15 + 13223 * 0.3 + 12 * 3.75) / 1_000_000);
  });

  it("falls back to zero cost for unknown OpenRouter model ids", () => {
    const cost = computeRuntimeCost({
      provider: "openrouter",
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
      usage: {
        byModel: {
          "vendor/non-claude-live-model": {
            inputTokens: 100,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
          },
        },
        totalInputTokens: 100,
        totalOutputTokens: 25,
        totalCacheReadTokens: 10,
        totalCacheWriteTokens: 0,
      },
    });

    expect(cost.byModel["vendor/non-claude-live-model"]).toMatchObject({
      provider: "openrouter",
      model: "vendor/non-claude-live-model",
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      totalUsd: 0,
    });
    expect(cost.totalUsd).toBe(0);
  });
});

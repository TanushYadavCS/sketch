import { describe, expect, it } from "vitest";
import { extractRuntimeModelUsage, mergeRuntimeUsageByModel, usageForModel } from "./usage";

describe("agent runtime usage extraction", () => {
  it("reads non-cached input and cache writes from the captured Bedrock cache-write usage blob", () => {
    expect(
      extractRuntimeModelUsage({
        inputTokens: 13226,
        inputTokenDetails: {
          noCacheTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 13223,
        },
        outputTokens: 4,
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 13223,
    });
  });

  it("reads non-cached input and cache reads from the captured Bedrock cache-read usage blob", () => {
    expect(
      extractRuntimeModelUsage({
        inputTokens: 13238,
        inputTokenDetails: {
          noCacheTokens: 3,
          cacheReadTokens: 13223,
          cacheWriteTokens: 12,
        },
        outputTokens: 4,
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 13223,
      cacheWriteTokens: 12,
    });
  });

  it("falls back to raw nested provider usage shapes when standardized fields are absent", () => {
    expect(
      extractRuntimeModelUsage({
        inputTokens: { total: 90, cacheRead: 20, cacheWrite: 10 },
        outputTokens: { total: 7 },
      }),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 7,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });
  });

  it("subtracts OpenRouter cached prompt tokens from cache-inclusive prompt tokens", () => {
    expect(
      extractRuntimeModelUsage({
        prompt_tokens: 1000,
        completion_tokens: 45,
        prompt_tokens_details: {
          cached_tokens: 800,
        },
      }),
    ).toEqual({
      inputTokens: 200,
      outputTokens: 45,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });

  it("leaves no-cache usage input unchanged", () => {
    expect(
      extractRuntimeModelUsage({
        prompt_tokens: 123,
        completion_tokens: 45,
      }),
    ).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("merges usage across model ids without assuming a single active model", () => {
    const usage = mergeRuntimeUsageByModel([
      usageForModel("claude-sonnet-4-6", {
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      }),
      usageForModel("claude-sonnet-4-6", {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      }),
      usageForModel("claude-haiku-4-5", {
        inputTokens: 8,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ]);

    expect(usage).toEqual({
      byModel: {
        "claude-sonnet-4-6": {
          inputTokens: 15,
          outputTokens: 3,
          cacheReadTokens: 5,
          cacheWriteTokens: 7,
        },
        "claude-haiku-4-5": {
          inputTokens: 8,
          outputTokens: 9,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      totalInputTokens: 23,
      totalOutputTokens: 12,
      totalCacheReadTokens: 5,
      totalCacheWriteTokens: 7,
    });
  });
});

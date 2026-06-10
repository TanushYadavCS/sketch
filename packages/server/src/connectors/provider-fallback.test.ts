import { describe, expect, it } from "vitest";
import { GeminiHttpError } from "./gemini-control";
import { isRetryableProviderError, withProviderFallback } from "./provider-fallback";

describe("provider fallback", () => {
  it("falls back for Gemini quota failures", async () => {
    const result = await withProviderFallback({
      operation: "embedTexts",
      primary: async () => {
        throw new GeminiHttpError(429, "RESOURCE_EXHAUSTED");
      },
      fallback: async () => "ok",
    });

    expect(result).toBe("ok");
  });

  it("does not fall back for non-retryable failures", async () => {
    await expect(
      withProviderFallback({
        operation: "generateJSON",
        primary: async () => {
          throw new Error("failed to parse JSON response");
        },
        fallback: async () => "ok",
      }),
    ).rejects.toThrow("failed to parse JSON response");
  });

  it("classifies timeout-like errors as retryable", () => {
    expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableProviderError(new Error("prepayment credits are depleted"))).toBe(true);
    expect(isRetryableProviderError(new GeminiHttpError(500, "server error"))).toBe(true);
    expect(isRetryableProviderError(new GeminiHttpError(400, "API_KEY_INVALID"))).toBe(true);
    expect(isRetryableProviderError(new Error("invalid api key"))).toBe(true);
  });
});

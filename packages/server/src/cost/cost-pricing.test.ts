import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createPricingService } from "./cost-pricing";
import type { RunCostInput } from "./cost-pricing";
import type { ModelPrice, OpenRouterPriceMap } from "./openrouter-price-map";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function fakePriceMap(price: ModelPrice | null): OpenRouterPriceMap {
  return { lookup: vi.fn().mockResolvedValue(price) } as unknown as OpenRouterPriceMap;
}

const baseInput: RunCostInput = {
  provider: "openrouter",
  model: "xiaomi/mimo-v2.5-pro",
  inputTokens: 34_870_764,
  outputTokens: 121_746,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  sdkCostUsd: 110.24,
};

describe("createPricingService", () => {
  it("reprices an OpenRouter run from token counts and live per-token rates", async () => {
    const priceMap = fakePriceMap({
      prompt: 0.000000435,
      completion: 0.00000087,
      cacheRead: 0.0000000036,
      cacheWrite: 0,
    });
    const { costUsd, costSource } = await createPricingService(priceMap, logger).resolve(baseInput);

    expect(costSource).toBe("openrouter");
    expect(costUsd).toBeCloseTo(15.27, 1);
    expect(costUsd).toBeLessThan(baseInput.sdkCostUsd);
  });

  it("maps cache_read and cache_creation tokens onto their respective rates", async () => {
    const priceMap = fakePriceMap({ prompt: 1e-6, completion: 2e-6, cacheRead: 1e-7, cacheWrite: 5e-7 });
    const { costUsd } = await createPricingService(priceMap, logger).resolve({
      ...baseInput,
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 1000,
      cacheCreationTokens: 1000,
    });

    expect(costUsd).toBeCloseTo(0.0036, 6);
  });

  it("falls back to the SDK cost and flags it when the model is unknown", async () => {
    const { costUsd, costSource } = await createPricingService(fakePriceMap(null), logger).resolve(baseInput);

    expect(costUsd).toBe(110.24);
    expect(costSource).toBe("openrouter_unpriced_fallback");
  });

  it("leaves native Anthropic cost untouched and never consults the price map", async () => {
    const priceMap = fakePriceMap({ prompt: 1, completion: 1, cacheRead: 1, cacheWrite: 1 });
    const { costUsd, costSource } = await createPricingService(priceMap, logger).resolve({
      ...baseInput,
      provider: "anthropic",
    });

    expect(costUsd).toBe(110.24);
    expect(costSource).toBe("sdk");
    expect(priceMap.lookup).not.toHaveBeenCalled();
  });

  it("falls back when a price yields a non-finite cost", async () => {
    const priceMap = fakePriceMap({ prompt: Number.POSITIVE_INFINITY, completion: 0, cacheRead: 0, cacheWrite: 0 });
    const { costUsd, costSource } = await createPricingService(priceMap, logger).resolve(baseInput);

    expect(costUsd).toBe(110.24);
    expect(costSource).toBe("openrouter_unpriced_fallback");
  });

  it("falls back when the provider is openrouter but the model is null", async () => {
    const priceMap = fakePriceMap({ prompt: 1, completion: 1, cacheRead: 1, cacheWrite: 1 });
    const { costUsd, costSource } = await createPricingService(priceMap, logger).resolve({ ...baseInput, model: null });

    expect(costUsd).toBe(110.24);
    expect(costSource).toBe("openrouter_unpriced_fallback");
  });
});

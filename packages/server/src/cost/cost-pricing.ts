/**
 * Provider-aware cost resolution for agent runs.
 *
 * The Claude Agent SDK computes its `total_cost_usd` from a hardcoded
 * first-party Anthropic price table, so runs routed through OpenRouter are
 * mispriced (non-Anthropic slugs fall back to a default Anthropic rate). For
 * the "openrouter" provider we recompute cost from captured token counts times
 * live OpenRouter per-token prices; native Anthropic/Bedrock runs keep the
 * SDK's figure untouched.
 *
 * On an unknown slug, a non-finite result, or an unreachable price source we
 * fall back to the SDK figure (wrong-but-nonzero) rather than 0, and tag the
 * outcome via `costSource` so it is auditable downstream.
 */
import type { Logger } from "../logger";
import type { OpenRouterPriceMap } from "./openrouter-price-map";

export type CostSource = "sdk" | "openrouter" | "openrouter_unpriced_fallback";

/**
 * Inputs to cost resolution. `provider` is settings.llm_provider, `model` is
 * the slug actually used (preferring the response model), and `sdkCostUsd` is
 * the SDK's own total_cost_usd, used as the fallback.
 */
export interface RunCostInput {
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sdkCostUsd: number;
}

export interface RunCost {
  costUsd: number;
  costSource: CostSource;
}

export interface PricingService {
  resolve(input: RunCostInput): Promise<RunCost>;
}

export function createPricingService(priceMap: OpenRouterPriceMap, logger: Logger): PricingService {
  return {
    async resolve(input: RunCostInput): Promise<RunCost> {
      if (input.provider !== "openrouter") {
        return { costUsd: input.sdkCostUsd, costSource: "sdk" };
      }

      const price = input.model ? await priceMap.lookup(input.model) : null;
      if (!price) {
        logger.warn({ model: input.model }, "No OpenRouter price for model; falling back to SDK cost");
        return { costUsd: input.sdkCostUsd, costSource: "openrouter_unpriced_fallback" };
      }

      const costUsd =
        input.inputTokens * price.prompt +
        input.outputTokens * price.completion +
        input.cacheReadTokens * price.cacheRead +
        input.cacheCreationTokens * price.cacheWrite;

      if (!Number.isFinite(costUsd)) {
        logger.warn({ model: input.model }, "Computed OpenRouter cost was not finite; falling back to SDK cost");
        return { costUsd: input.sdkCostUsd, costSource: "openrouter_unpriced_fallback" };
      }

      return { costUsd, costSource: "openrouter" };
    },
  };
}

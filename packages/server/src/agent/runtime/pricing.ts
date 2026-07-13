import type {
  AgentRuntimeCostSummary,
  AgentRuntimeCostTable,
  AgentRuntimeModelCost,
  AgentRuntimeModelPricing,
  AgentRuntimeProviderKind,
  AgentRuntimeUsage,
} from "./contracts";

const HAIKU_45: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  cacheReadUsdPerMillionTokens: 0.1,
  cacheWriteUsdPerMillionTokens: 1.25,
};

const SONNET_5_PROMO: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10,
  cacheReadUsdPerMillionTokens: 0.2,
  cacheWriteUsdPerMillionTokens: 2.5,
};

const SONNET_46: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cacheReadUsdPerMillionTokens: 0.3,
  cacheWriteUsdPerMillionTokens: 3.75,
};

const OPUS_46_PLUS: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 25,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 6.25,
};

const OPUS_41: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 15,
  outputUsdPerMillionTokens: 75,
  cacheReadUsdPerMillionTokens: 1.5,
  cacheWriteUsdPerMillionTokens: 18.75,
};

const FABLE_MYTHOS_5: AgentRuntimeModelPricing = {
  inputUsdPerMillionTokens: 10,
  outputUsdPerMillionTokens: 50,
  cacheReadUsdPerMillionTokens: 1,
  cacheWriteUsdPerMillionTokens: 12.5,
};

function aliases(pricing: AgentRuntimeModelPricing, ids: readonly string[]): Record<string, AgentRuntimeModelPricing> {
  return Object.fromEntries(ids.map((id) => [id, pricing]));
}

export const DEFAULT_AGENT_RUNTIME_COST_TABLE: AgentRuntimeCostTable = {
  anthropic: {
    ...aliases(FABLE_MYTHOS_5, ["claude-fable-5", "claude-mythos-5", "claude-mythos-preview"]),
    ...aliases(OPUS_46_PLUS, ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"]),
    ...aliases(OPUS_41, ["claude-opus-4-1"]),
    ...aliases(SONNET_5_PROMO, ["claude-sonnet-5"]),
    ...aliases(SONNET_46, ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"]),
    ...aliases(HAIKU_45, ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]),
  },
  bedrock: {
    ...aliases(FABLE_MYTHOS_5, [
      "us.anthropic.claude-fable-5",
      "us.anthropic.claude-mythos-5",
      "us.anthropic.claude-mythos-preview",
    ]),
    ...aliases(OPUS_46_PLUS, [
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-4-7",
      "us.anthropic.claude-opus-4-6",
      "us.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-opus-4-6-v1:0",
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
      "us.anthropic.claude-opus-4-20250514-v1:0",
    ]),
    ...aliases(OPUS_41, ["us.anthropic.claude-opus-4-1-20250805-v1:0"]),
    ...aliases(SONNET_5_PROMO, ["us.anthropic.claude-sonnet-5"]),
    ...aliases(SONNET_46, [
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-6-v1",
      "us.anthropic.claude-sonnet-4-6-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
    ]),
    ...aliases(HAIKU_45, [
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    ]),
  },
  openrouter: {},
  vertex: {
    ...aliases(FABLE_MYTHOS_5, ["claude-fable-5", "claude-mythos-5", "claude-mythos-preview"]),
    ...aliases(OPUS_46_PLUS, ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"]),
    ...aliases(OPUS_41, ["claude-opus-4-1"]),
    ...aliases(SONNET_5_PROMO, ["claude-sonnet-5"]),
    ...aliases(SONNET_46, ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"]),
    ...aliases(HAIKU_45, ["claude-haiku-4-5", "claude-haiku-4-5@20251001", "claude-haiku-4-5-20251001"]),
  },
  "openai-compatible": {},
};

export function findRuntimeModelPricing(params: {
  costTable: AgentRuntimeCostTable;
  provider: AgentRuntimeProviderKind;
  model: string;
}): AgentRuntimeModelPricing | null {
  return params.costTable[params.provider]?.[params.model] ?? null;
}

export function computeRuntimeCost(params: {
  usage: AgentRuntimeUsage;
  provider: AgentRuntimeProviderKind;
  costTable: AgentRuntimeCostTable;
}): AgentRuntimeCostSummary {
  const byModel: Record<string, AgentRuntimeModelCost> = {};
  let totalUsd = 0;

  for (const [model, usage] of Object.entries(params.usage.byModel)) {
    const pricing = findRuntimeModelPricing({ costTable: params.costTable, provider: params.provider, model });
    const cost = pricing
      ? {
          provider: params.provider,
          model,
          inputUsd: (usage.inputTokens * pricing.inputUsdPerMillionTokens) / 1_000_000,
          outputUsd: (usage.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000,
          cacheReadUsd: (usage.cacheReadTokens * pricing.cacheReadUsdPerMillionTokens) / 1_000_000,
          cacheWriteUsd: (usage.cacheWriteTokens * pricing.cacheWriteUsdPerMillionTokens) / 1_000_000,
          totalUsd: 0,
        }
      : {
          provider: params.provider,
          model,
          inputUsd: 0,
          outputUsd: 0,
          cacheReadUsd: 0,
          cacheWriteUsd: 0,
          totalUsd: 0,
        };
    cost.totalUsd = cost.inputUsd + cost.outputUsd + cost.cacheReadUsd + cost.cacheWriteUsd;
    byModel[model] = cost;
    totalUsd += cost.totalUsd;
  }

  return { totalUsd, byModel, pricing: params.costTable };
}

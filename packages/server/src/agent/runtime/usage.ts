import type { LanguageModelUsage } from "ai";
import type { AgentRuntimeModelUsage, AgentRuntimeUsage } from "./contracts";

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(value: unknown, path: readonly string[]): number {
  return optionalNestedNumber(value, path) ?? 0;
}

function optionalNestedNumber(value: unknown, path: readonly string[]): number | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return optionalNumberFrom(current);
}

function firstNumber(values: readonly (number | null)[]): number {
  return values.find((value) => value !== null) ?? 0;
}

export function extractRuntimeModelUsage(usage: unknown): AgentRuntimeModelUsage {
  const rawInputTokens = firstNumber([
    optionalNumberFrom((usage as LanguageModelUsage | undefined)?.inputTokens),
    optionalNestedNumber(usage, ["inputTokens", "total"]),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.promptTokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.prompt_tokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.input_tokens),
  ]);
  const cacheReadTokens = firstNumber([
    optionalNestedNumber(usage, ["inputTokenDetails", "cacheReadTokens"]),
    optionalNestedNumber(usage, ["inputTokenDetails", "cachedTokens"]),
    optionalNestedNumber(usage, ["inputTokens", "cacheRead"]),
    optionalNestedNumber(usage, ["promptTokensDetails", "cachedTokens"]),
    optionalNestedNumber(usage, ["prompt_tokens_details", "cached_tokens"]),
    optionalNestedNumber(usage, ["input_tokens_details", "cached_tokens"]),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cachedInputTokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cacheReadInputTokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cache_read_input_tokens),
  ]);
  const cacheWriteTokens = firstNumber([
    optionalNestedNumber(usage, ["inputTokenDetails", "cacheWriteTokens"]),
    optionalNestedNumber(usage, ["inputTokens", "cacheWrite"]),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cacheCreationInputTokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cacheWriteInputTokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cache_creation_input_tokens),
    optionalNumberFrom((usage as Record<string, unknown> | undefined)?.cache_write_input_tokens),
  ]);
  const noCacheTokens = optionalNestedNumber(usage, ["inputTokenDetails", "noCacheTokens"]);

  return {
    inputTokens: noCacheTokens ?? Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens:
      numberFrom((usage as LanguageModelUsage | undefined)?.outputTokens) ||
      nestedNumber(usage, ["outputTokens", "total"]) ||
      numberFrom((usage as Record<string, unknown> | undefined)?.completionTokens) ||
      numberFrom((usage as Record<string, unknown> | undefined)?.completion_tokens) ||
      numberFrom((usage as Record<string, unknown> | undefined)?.output_tokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function emptyRuntimeUsage(modelId: string): AgentRuntimeUsage {
  return usageForModel(modelId, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

export function usageForModel(modelId: string, usage: AgentRuntimeModelUsage): AgentRuntimeUsage {
  return {
    byModel: { [modelId]: usage },
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    totalCacheReadTokens: usage.cacheReadTokens,
    totalCacheWriteTokens: usage.cacheWriteTokens,
  };
}

export function mergeRuntimeUsageByModel(usages: readonly AgentRuntimeUsage[]): AgentRuntimeUsage {
  const byModel: Record<string, AgentRuntimeModelUsage> = {};

  for (const usage of usages) {
    for (const [model, modelUsage] of Object.entries(usage.byModel)) {
      const current = byModel[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byModel[model] = {
        inputTokens: current.inputTokens + modelUsage.inputTokens,
        outputTokens: current.outputTokens + modelUsage.outputTokens,
        cacheReadTokens: current.cacheReadTokens + modelUsage.cacheReadTokens,
        cacheWriteTokens: current.cacheWriteTokens + modelUsage.cacheWriteTokens,
      };
    }
  }

  const totals = Object.values(byModel).reduce(
    (acc, usage) => ({
      totalInputTokens: acc.totalInputTokens + usage.inputTokens,
      totalOutputTokens: acc.totalOutputTokens + usage.outputTokens,
      totalCacheReadTokens: acc.totalCacheReadTokens + usage.cacheReadTokens,
      totalCacheWriteTokens: acc.totalCacheWriteTokens + usage.cacheWriteTokens,
    }),
    { totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 },
  );

  return { byModel, ...totals };
}

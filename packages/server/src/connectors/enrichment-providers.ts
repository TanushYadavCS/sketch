import type { Logger } from "pino";
import { type EmbeddingProvider, createEmbeddingProvider, createQueryEmbedder } from "./embeddings";
import { type GeminiGenerator, type GenerateOptions, createGeminiGenerator } from "./gemini-generate";
import { createOpenRouterGenerator } from "./openrouter-generate";
import { isRetryableProviderError, withProviderFallback } from "./provider-fallback";

export type EmbeddingProviderName = "openrouter" | "gemini";

export interface EnrichmentProviderConfig {
  geminiApiKey?: string | null;
  geminiMaxRpm?: number;
  geminiMaxRetries?: number;
  embeddingProvider?: string | null;
  openRouterApiKey?: string | null;
  openRouterModel?: string | null;
  logger?: Logger;
}

export function hasOpenRouterSettings(settings: { llm_provider?: string | null; anthropic_api_key?: string | null }) {
  return (
    (settings.llm_provider === "openrouter" || settings.llm_provider === "openrouter_bedrock") &&
    !!settings.anthropic_api_key?.trim()
  );
}

export function resolveOpenRouterEnrichmentConfig(
  settings: { llm_provider?: string | null; anthropic_api_key?: string | null; model_id?: string | null } | null,
  envApiKey?: string | null,
) {
  const useDbSettings = settings ? hasOpenRouterSettings(settings) : false;
  const dbKey = useDbSettings ? settings?.anthropic_api_key?.trim() : null;
  return {
    openRouterApiKey: dbKey || envApiKey?.trim() || null,
    openRouterModel: useDbSettings ? settings?.model_id?.trim() || null : null,
  };
}

export function resolveEmbeddingProviderName(provider?: string | null): EmbeddingProviderName | null {
  if (provider == null || provider.trim() === "") return "openrouter";
  if (provider === "openrouter" || provider === "gemini") return provider;
  return null;
}

export function createEnrichmentGenerator(config: EnrichmentProviderConfig): GeminiGenerator | null {
  const primary = config.geminiApiKey
    ? createGeminiGenerator(config.geminiApiKey, {
        maxRpm: config.geminiMaxRpm,
        maxRetries: config.geminiMaxRetries,
      })
    : null;
  const fallback = config.openRouterApiKey
    ? createOpenRouterGenerator(config.openRouterApiKey, { model: config.openRouterModel })
    : null;

  /**
   * A per-call model override can only be honored by the OpenRouter path — Gemini's client is
   * pinned to its own model. Returns the generator to route to, or null to use the normal path,
   * warning when an override was genuinely asked for and cannot be served.
   */
  function routeModelOverride(opts: GenerateOptions | undefined, operation: string): GeminiGenerator | null {
    const model = opts?.model?.trim();
    if (!model) return null;
    if (fallback) return fallback;
    config.logger?.warn(
      { model, operation },
      "Per-call model override needs an OpenRouter API key; using the configured enrichment provider",
    );
    return null;
  }

  if (!primary) return fallback;
  if (!fallback) {
    return {
      generate(prompt, opts) {
        routeModelOverride(opts, opts?.label ?? "generate");
        return primary.generate(prompt, opts);
      },
      generateJSON(prompt, opts) {
        routeModelOverride(opts, opts?.label ?? "generateJSON");
        return primary.generateJSON(prompt, opts);
      },
    };
  }

  let primaryDisabled = false;
  let fallbackFailures = 0;
  const maxFallbackFailures = 3;

  async function runWithCircuit<T>(operation: string, primaryCall: () => Promise<T>, fallbackCall: () => Promise<T>) {
    if (primaryDisabled) {
      if (fallbackFailures >= maxFallbackFailures) {
        throw new Error(`Enrichment providers circuit open for ${operation}`);
      }
      try {
        return await fallbackCall();
      } catch (err) {
        fallbackFailures++;
        throw err;
      }
    }

    try {
      return await primaryCall();
    } catch (err) {
      if (!isRetryableProviderError(err)) throw err;
      primaryDisabled = true;
      config.logger?.warn({ err, operation }, "Primary enrichment provider disabled for this run");
      try {
        return await fallbackCall();
      } catch (fallbackErr) {
        fallbackFailures++;
        throw fallbackErr;
      }
    }
  }

  return {
    generate(prompt, opts) {
      const operation = opts?.label ?? "generate";
      const override = routeModelOverride(opts, operation);
      if (override) return override.generate(prompt, opts);
      return runWithCircuit(
        operation,
        () => primary.generate(prompt, opts),
        () => fallback.generate(prompt, opts),
      );
    },
    generateJSON(prompt, opts) {
      const operation = opts?.label ?? "generateJSON";
      const override = routeModelOverride(opts, operation);
      if (override) return override.generateJSON(prompt, opts);
      return runWithCircuit(
        operation,
        () => primary.generateJSON(prompt, opts),
        () => fallback.generateJSON(prompt, opts),
      );
    },
  };
}

export function createEnrichmentEmbeddingProvider(config: EnrichmentProviderConfig): EmbeddingProvider | null {
  const provider = resolveEmbeddingProviderName(config.embeddingProvider);
  if (!provider) {
    config.logger?.warn({ embeddingProvider: config.embeddingProvider }, "Unsupported embedding provider configured");
    return null;
  }

  if (provider === "gemini") {
    if (!config.geminiApiKey?.trim()) {
      config.logger?.warn({ embeddingProvider: provider, reason: "missing_api_key" }, "Embedding provider disabled");
      return null;
    }
    return createEmbeddingProvider({
      provider,
      apiKey: config.geminiApiKey.trim(),
      maxRpm: config.geminiMaxRpm,
      maxRetries: config.geminiMaxRetries,
    });
  }

  if (!config.openRouterApiKey?.trim()) {
    config.logger?.warn({ embeddingProvider: provider, reason: "missing_api_key" }, "Embedding provider disabled");
    return null;
  }
  return createEmbeddingProvider({ provider, apiKey: config.openRouterApiKey.trim() });
}

export function createEnrichmentQueryEmbedder(
  config: EnrichmentProviderConfig,
): ((query: string) => Promise<number[]>) | null {
  const provider = resolveEmbeddingProviderName(config.embeddingProvider);
  if (!provider) {
    config.logger?.warn({ embeddingProvider: config.embeddingProvider }, "Unsupported embedding provider configured");
    return null;
  }

  if (provider === "gemini") {
    if (!config.geminiApiKey?.trim()) {
      config.logger?.warn({ embeddingProvider: provider, reason: "missing_api_key" }, "Embedding provider disabled");
      return null;
    }
    return createQueryEmbedder({
      provider,
      apiKey: config.geminiApiKey.trim(),
      maxRpm: config.geminiMaxRpm,
      maxRetries: config.geminiMaxRetries,
    });
  }

  if (!config.openRouterApiKey?.trim()) {
    config.logger?.warn({ embeddingProvider: provider, reason: "missing_api_key" }, "Embedding provider disabled");
    return null;
  }
  return createQueryEmbedder({ provider, apiKey: config.openRouterApiKey.trim() });
}

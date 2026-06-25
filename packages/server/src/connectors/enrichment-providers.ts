import type { Logger } from "pino";
import { type EmbeddingProvider, createEmbeddingProvider } from "./embeddings";
import { createGeminiQueryEmbedder } from "./embeddings/gemini";
import { createOpenRouterEmbeddingProvider } from "./embeddings/openrouter";
import { type GeminiGenerator, createGeminiGenerator } from "./gemini-generate";
import { createOpenRouterGenerator } from "./openrouter-generate";
import { isRetryableProviderError, withProviderFallback } from "./provider-fallback";

export interface EnrichmentProviderConfig {
  geminiApiKey?: string | null;
  geminiMaxRpm?: number;
  geminiMaxRetries?: number;
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

  if (!primary) return fallback;
  if (!fallback) return primary;

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
      return runWithCircuit(
        opts?.label ?? "generate",
        () => primary.generate(prompt, opts),
        () => fallback.generate(prompt, opts),
      );
    },
    generateJSON(prompt, opts) {
      return runWithCircuit(
        opts?.label ?? "generateJSON",
        () => primary.generateJSON(prompt, opts),
        () => fallback.generateJSON(prompt, opts),
      );
    },
  };
}

export function createEnrichmentEmbeddingProvider(config: EnrichmentProviderConfig): EmbeddingProvider | null {
  const primary = config.geminiApiKey
    ? createEmbeddingProvider({
        provider: "gemini",
        apiKey: config.geminiApiKey,
        maxRpm: config.geminiMaxRpm,
        maxRetries: config.geminiMaxRetries,
      })
    : null;
  const fallback = config.openRouterApiKey ? createOpenRouterEmbeddingProvider(config.openRouterApiKey) : null;

  if (!primary) return fallback;
  if (!fallback) return primary;

  const primaryEmbedImage = primary.embedImage;
  const fallbackEmbedImage = fallback.supportsImages ? fallback.embedImage : undefined;

  return {
    name: `${primary.name}+openrouter-fallback`,
    dimensions: primary.dimensions,
    supportsImages: primary.supportsImages,
    embedTexts(texts) {
      return withProviderFallback({
        operation: "embedTexts",
        primary: () => primary.embedTexts(texts),
        fallback: () => fallback.embedTexts(texts),
        logger: config.logger,
      });
    },
    embedImage: primaryEmbedImage
      ? (imageBuffer, mimeType) =>
          withProviderFallback({
            operation: "embedImage",
            primary: () => primaryEmbedImage(imageBuffer, mimeType),
            fallback: fallbackEmbedImage ? () => fallbackEmbedImage(imageBuffer, mimeType) : null,
            shouldFallback: (err) => fallback.supportsImages && isRetryableProviderError(err),
            logger: config.logger,
          })
      : undefined,
  };
}

export function createEnrichmentQueryEmbedder(
  config: EnrichmentProviderConfig,
): ((query: string) => Promise<number[]>) | null {
  const primary = config.geminiApiKey
    ? createGeminiQueryEmbedder(config.geminiApiKey, {
        maxRpm: config.geminiMaxRpm,
        maxRetries: config.geminiMaxRetries,
      })
    : null;
  const fallbackProvider = config.openRouterApiKey ? createOpenRouterEmbeddingProvider(config.openRouterApiKey) : null;
  const fallback = fallbackProvider
    ? async (query: string) => {
        const [embedding] = await fallbackProvider.embedTexts([query]);
        if (!embedding) throw new Error("OpenRouter did not return a query embedding");
        return embedding;
      }
    : null;

  if (!primary) return fallback;
  if (!fallback) return primary;

  return (query) => {
    return withProviderFallback({
      operation: "embedQuery",
      primary: () => primary(query),
      fallback: () => fallback(query),
      logger: config.logger,
    });
  };
}

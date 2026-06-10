import type { Logger } from "pino";
import { type EmbeddingProvider, createEmbeddingProvider } from "./embeddings";
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

  return {
    generate(prompt, opts) {
      return withProviderFallback({
        operation: opts?.label ?? "generate",
        primary: () => primary.generate(prompt, opts),
        fallback: () => fallback.generate(prompt, opts),
        logger: config.logger,
      });
    },
    generateJSON(prompt, opts) {
      return withProviderFallback({
        operation: opts?.label ?? "generateJSON",
        primary: () => primary.generateJSON(prompt, opts),
        fallback: () => fallback.generateJSON(prompt, opts),
        logger: config.logger,
      });
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

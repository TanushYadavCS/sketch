/**
 * Embedding provider factory.
 *
 * Creates the appropriate embedding provider based on configuration.
 * Currently supports Gemini Embedding 2 (multimodal).
 */
import { createGeminiEmbeddingProvider, createGeminiQueryEmbedder } from "./gemini";
import { createOpenRouterEmbeddingProvider } from "./openrouter";
import type { EmbeddingProvider, EmbeddingProviderConfig } from "./types";

export type { EmbeddingProvider, EmbeddingProviderConfig };

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case "gemini":
      return createGeminiEmbeddingProvider(config.apiKey, {
        maxRpm: config.maxRpm,
        maxRetries: config.maxRetries,
      });
    case "openrouter":
      return createOpenRouterEmbeddingProvider(config.apiKey);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

export function createQueryEmbedder(config: EmbeddingProviderConfig): (query: string) => Promise<number[]> {
  switch (config.provider) {
    case "gemini":
      return createGeminiQueryEmbedder(config.apiKey, {
        maxRpm: config.maxRpm,
        maxRetries: config.maxRetries,
      });
    case "openrouter": {
      const provider = createOpenRouterEmbeddingProvider(config.apiKey);
      return async (query) => {
        const [embedding] = await provider.embedTexts([query]);
        if (!embedding) throw new Error("OpenRouter did not return a query embedding");
        return embedding;
      };
    }
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

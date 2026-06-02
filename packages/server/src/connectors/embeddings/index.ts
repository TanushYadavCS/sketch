/**
 * Embedding provider factory.
 *
 * Creates the appropriate embedding provider based on configuration.
 * Currently supports Gemini Embedding 2 (multimodal).
 */
import { createGeminiEmbeddingProvider, createGeminiQueryEmbedder } from "./gemini";
import type { EmbeddingProvider, EmbeddingProviderConfig } from "./types";

export type { EmbeddingProvider, EmbeddingProviderConfig };

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case "gemini":
      return createGeminiEmbeddingProvider(config.apiKey, {
        maxRpm: config.maxRpm,
        maxRetries: config.maxRetries,
      });
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
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

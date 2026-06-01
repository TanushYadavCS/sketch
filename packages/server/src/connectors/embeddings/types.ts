/**
 * Embedding provider abstraction.
 *
 * Pluggable interface for text and image embeddings.
 * Implementations: Gemini Embedding 2 (multimodal), local fallback (text-only).
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly supportsImages: boolean;

  /** Embed one or more text strings. Returns one vector per input. */
  embedTexts(texts: string[]): Promise<number[][]>;

  /** Embed a single image. Only available when supportsImages is true. */
  embedImage?(imageBuffer: Buffer, mimeType: string): Promise<number[]>;
}

export interface EmbeddingProviderConfig {
  provider: "gemini";
  apiKey: string;
  maxRpm?: number;
  maxRetries?: number;
}

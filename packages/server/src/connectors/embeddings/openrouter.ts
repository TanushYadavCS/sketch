import type { EmbeddingProvider } from "./types";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "google/gemini-embedding-2-preview";
const DIMENSIONS = 3072;

interface OpenRouterEmbeddingOptions {
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
  error?: {
    message?: string;
  };
}

export function createOpenRouterEmbeddingProvider(
  apiKey: string,
  options: OpenRouterEmbeddingOptions = {},
): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DIMENSIONS;

  async function request(input: string | string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

    try {
      const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input, dimensions }),
      });

      const body = (await res.json().catch(() => ({}))) as OpenRouterEmbeddingResponse;
      if (!res.ok) {
        throw new Error(body.error?.message ?? `OpenRouter embedding failed with HTTP ${res.status}`);
      }

      const embeddings = body.data?.map((item) => item.embedding);
      if (!embeddings || embeddings.length === 0) {
        throw new Error("OpenRouter embedding response did not include embeddings");
      }

      return embeddings.map((embedding) => {
        if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
          throw new Error("OpenRouter embedding response contained a non-numeric vector");
        }
        if (embedding.length !== dimensions) {
          throw new Error(`OpenRouter embedding returned ${embedding.length} dimensions, expected ${dimensions}`);
        }
        return embedding;
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    name: "openrouter",
    dimensions,
    supportsImages: false,
    embedTexts: request,
  };
}

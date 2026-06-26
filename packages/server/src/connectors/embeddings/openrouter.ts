import type { EmbeddingProvider } from "./types";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "google/gemini-embedding-2";
const DIMENSIONS = 3072;
const BATCH_SIZE = 25;
const MAX_RETRIES = 2;

interface OpenRouterEmbeddingOptions {
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
  error?: {
    code?: string | number;
    message?: string;
  };
}

function openRouterErrorMessage(body: OpenRouterEmbeddingResponse, fallback: string): string {
  if (!body.error) return fallback;
  const message = body.error.message ?? fallback;
  return body.error.code == null ? message : `${message} (${body.error.code})`;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenRouterEmbeddingProvider(
  apiKey: string,
  options: OpenRouterEmbeddingOptions = {},
): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DIMENSIONS;

  async function requestBatch(input: string[]): Promise<number[][]> {
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
        throw new Error(`${openRouterErrorMessage(body, "OpenRouter embedding failed")} (HTTP ${res.status})`);
      }
      if (body.error) {
        throw new Error(openRouterErrorMessage(body, "OpenRouter embedding failed"));
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

  async function requestWithRetry(input: string[]): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await requestBatch(input);
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const statusMatch = message.match(/HTTP (\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        if (attempt >= MAX_RETRIES || status == null || !shouldRetryStatus(status)) {
          throw err;
        }
        await sleep(250 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async function request(input: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(input) ? input : [input];
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      allEmbeddings.push(...(await requestWithRetry(texts.slice(i, i + BATCH_SIZE))));
    }
    return allEmbeddings;
  }

  return {
    name: "openrouter",
    dimensions,
    supportsImages: false,
    embedTexts: request,
  };
}

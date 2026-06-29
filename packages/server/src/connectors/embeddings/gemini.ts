/**
 * Gemini Embedding 2 provider.
 *
 * Multimodal embeddings — text and images in the same vector space.
 * Uses the Gemini API directly (REST) to avoid adding a heavy SDK dependency.
 *
 * API reference: https://ai.google.dev/gemini-api/docs/embeddings
 */
import { type GeminiClientOptions, GeminiHttpError, runGeminiRequest } from "../gemini-control";
import type { EmbeddingProvider } from "./types";

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent";
const GEMINI_BATCH_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents";

/** Gemini embedding-2-preview outputs 3072 dimensions by default. */
const DIMENSIONS = 3072;

const BATCH_SIZE = 25;

export function createGeminiEmbeddingProvider(apiKey: string, options?: GeminiClientOptions): EmbeddingProvider {
  async function request(url: string, body: unknown): Promise<unknown> {
    return runGeminiRequest(
      apiKey,
      async () => {
        const res = await fetch(`${url}?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.ok) return res.json();

        const text = await res.text();
        throw new GeminiHttpError(res.status, text);
      },
      options,
    );
  }

  return {
    name: "gemini",
    dimensions: DIMENSIONS,
    supportsImages: true,

    async embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const allEmbeddings: number[][] = [];

      // Process in batches
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        if (batch.length === 1) {
          // Single text — use embedContent
          const result = (await request(GEMINI_EMBED_URL, {
            content: { parts: [{ text: batch[0] }] },
            taskType: "RETRIEVAL_DOCUMENT",
          })) as { embedding: { values: number[] } };

          allEmbeddings.push(result.embedding.values);
        } else {
          // Multiple texts — use batchEmbedContents
          const result = (await request(GEMINI_BATCH_URL, {
            requests: batch.map((text) => ({
              model: "models/gemini-embedding-2-preview",
              content: { parts: [{ text }] },
              taskType: "RETRIEVAL_DOCUMENT",
            })),
          })) as { embeddings: Array<{ values: number[] }> };

          for (const emb of result.embeddings) {
            allEmbeddings.push(emb.values);
          }
        }
      }

      return allEmbeddings;
    },

    async embedImage(imageBuffer: Buffer, mimeType: string): Promise<number[]> {
      const base64 = imageBuffer.toString("base64");

      const result = (await request(GEMINI_EMBED_URL, {
        content: {
          parts: [{ inlineData: { mimeType, data: base64 } }],
        },
        taskType: "RETRIEVAL_DOCUMENT",
      })) as { embedding: { values: number[] } };

      return result.embedding.values;
    },
  };
}

/**
 * Embed a search query (vs document embedding above which uses RETRIEVAL_DOCUMENT).
 * Separate function because task type differs for queries vs documents.
 */
export function createGeminiQueryEmbedder(apiKey: string, options?: GeminiClientOptions) {
  return async function embedQuery(query: string): Promise<number[]> {
    const result = (await requestQueryEmbedding(apiKey, query, options)) as { embedding: { values: number[] } };
    return result.embedding.values;
  };
}

async function requestQueryEmbedding(apiKey: string, query: string, options?: GeminiClientOptions): Promise<unknown> {
  return runGeminiRequest(
    apiKey,
    async () => {
      const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: query }] },
          taskType: "RETRIEVAL_QUERY",
        }),
      });

      if (res.ok) return res.json();

      const text = await res.text();
      throw new GeminiHttpError(res.status, text);
    },
    options,
  );
}

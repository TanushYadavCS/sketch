import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import {
  createEnrichmentEmbeddingProvider,
  createEnrichmentQueryEmbedder,
  resolveOpenRouterEnrichmentConfig,
} from "./enrichment-providers";

function vector(dimensions = 3072): number[] {
  return Array.from({ length: dimensions }, (_, i) => i / dimensions);
}

describe("enrichment providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses direct Gemini embeddings when the primary provider succeeds", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        embedding: { values: vector() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: "gemini-key",
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embeddings = await provider?.embedTexts(["hello"]);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;

    expect(embeddings?.[0]).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toContain("generativelanguage.googleapis.com");
  });

  it("falls back to OpenRouter embeddings when Gemini quota is exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ embedding: vector() }],
          model: "gemini-embedding-2-preview",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: "gemini-key",
      geminiMaxRetries: 0,
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embeddings = await provider?.embedTexts(["hello"]);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const openRouterBody = JSON.parse(calls[1][1]?.body as string) as {
      model: string;
      dimensions: number;
    };

    expect(embeddings?.[0]).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(calls[1][0])).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(openRouterBody).toMatchObject({
      model: "google/gemini-embedding-2-preview",
      dimensions: 3072,
    });
  });

  it("uses OpenRouter embeddings directly when Gemini is not configured", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ embedding: vector() }],
        model: "gemini-embedding-2-preview",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: null,
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embeddings = await provider?.embedTexts(["hello"]);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;

    expect(embeddings?.[0]).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toBe("https://openrouter.ai/api/v1/embeddings");
  });

  it("uses Gemini RETRIEVAL_QUERY for query embeddings when Gemini succeeds", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        embedding: { values: vector() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedQuery = createEnrichmentQueryEmbedder({
      geminiApiKey: "gemini-key",
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embedding = await embedQuery?.("hello");
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const geminiBody = JSON.parse(String(calls[0][1]?.body));

    expect(embedding).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toContain("generativelanguage.googleapis.com");
    expect(geminiBody).toMatchObject({
      content: { parts: [{ text: "hello" }] },
      taskType: "RETRIEVAL_QUERY",
    });
  });

  it("falls back to OpenRouter query embeddings when Gemini query embedding fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ embedding: vector() }],
          model: "gemini-embedding-2-preview",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const embedQuery = createEnrichmentQueryEmbedder({
      geminiApiKey: "gemini-key",
      geminiMaxRetries: 0,
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embedding = await embedQuery?.("hello");
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const openRouterBody = JSON.parse(String(calls[1][1]?.body));

    expect(embedding).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(calls[1][0])).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(openRouterBody).toMatchObject({
      model: "google/gemini-embedding-2-preview",
      input: ["hello"],
      dimensions: 3072,
    });
  });

  it("resolves OpenRouter enrichment config from DB settings before env", () => {
    expect(
      resolveOpenRouterEnrichmentConfig(
        { llm_provider: "openrouter", anthropic_api_key: " sk-db ", model_id: " model-db " },
        "sk-env",
      ),
    ).toEqual({
      openRouterApiKey: "sk-db",
      openRouterModel: "model-db",
    });
  });

  it("does not treat a non-OpenRouter DB LLM key as an OpenRouter key", () => {
    expect(
      resolveOpenRouterEnrichmentConfig(
        { llm_provider: "anthropic", anthropic_api_key: " sk-ant ", model_id: "claude-sonnet" },
        "sk-env",
      ),
    ).toEqual({
      openRouterApiKey: "sk-env",
      openRouterModel: null,
    });
  });
});

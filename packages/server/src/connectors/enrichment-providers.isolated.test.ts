import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import {
  createEnrichmentEmbeddingProvider,
  createEnrichmentQueryEmbedder,
  resolveEmbeddingProviderName,
  resolveOpenRouterEnrichmentConfig,
} from "./enrichment-providers";

function vector(dimensions = 3072): number[] {
  return Array.from({ length: dimensions }, (_, i) => i / dimensions);
}

describe("enrichment providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves null and unset embedding providers to OpenRouter", () => {
    expect(resolveEmbeddingProviderName(null)).toBe("openrouter");
    expect(resolveEmbeddingProviderName(undefined)).toBe("openrouter");
    expect(resolveEmbeddingProviderName("")).toBe("openrouter");
  });

  it("uses direct Gemini embeddings when Gemini is selected", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        embedding: { values: vector() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: "gemini-key",
      embeddingProvider: "gemini",
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embeddings = await provider?.embedTexts(["hello"]);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;

    expect(embeddings?.[0]).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toContain("generativelanguage.googleapis.com");
  });

  it("does not fall back to OpenRouter embeddings when selected Gemini fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: "gemini-key",
      embeddingProvider: "gemini",
      geminiMaxRetries: 0,
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    await expect(provider?.embedTexts(["hello"])).rejects.toThrow();
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toContain("generativelanguage.googleapis.com");
  });

  it("uses OpenRouter embeddings when OpenRouter is selected", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ embedding: vector() }],
        model: "gemini-embedding-2",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createEnrichmentEmbeddingProvider({
      geminiApiKey: "gemini-key",
      embeddingProvider: "openrouter",
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    const embeddings = await provider?.embedTexts(["hello"]);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const openRouterBody = JSON.parse(calls[0][1]?.body as string) as {
      model: string;
      dimensions: number;
    };

    expect(embeddings?.[0]).toHaveLength(3072);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(openRouterBody).toMatchObject({
      model: "google/gemini-embedding-2",
      dimensions: 3072,
    });
  });

  it("returns no embedding provider when the selected provider has no usable key", () => {
    expect(
      createEnrichmentEmbeddingProvider({
        geminiApiKey: "gemini-key",
        embeddingProvider: "openrouter",
        openRouterApiKey: " ",
        logger: createTestLogger(),
      }),
    ).toBeNull();
  });

  it("uses Gemini RETRIEVAL_QUERY for query embeddings when Gemini is selected", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        embedding: { values: vector() },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedQuery = createEnrichmentQueryEmbedder({
      geminiApiKey: "gemini-key",
      embeddingProvider: "gemini",
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

  it("does not fall back to OpenRouter query embeddings when selected Gemini fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const embedQuery = createEnrichmentQueryEmbedder({
      geminiApiKey: "gemini-key",
      embeddingProvider: "gemini",
      geminiMaxRetries: 0,
      openRouterApiKey: "openrouter-key",
      logger: createTestLogger(),
    });

    await expect(embedQuery?.("hello")).rejects.toThrow();
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(calls[0][0])).toContain("generativelanguage.googleapis.com");
  });

  it("returns no query embedder when the selected provider has no usable key", () => {
    expect(
      createEnrichmentQueryEmbedder({
        geminiApiKey: null,
        embeddingProvider: "gemini",
        openRouterApiKey: "openrouter-key",
        logger: createTestLogger(),
      }),
    ).toBeNull();
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

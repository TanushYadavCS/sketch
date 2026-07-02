import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterEmbeddingProvider } from "./openrouter";

function vector(dimensions = 3072): number[] {
  return Array.from({ length: dimensions }, (_, i) => i / dimensions);
}

describe("OpenRouter embedding provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces OpenRouter error bodies returned with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          error: { code: "bad_model", message: "model unavailable" },
        }),
      ),
    );

    const provider = createOpenRouterEmbeddingProvider("sk-or-test");

    await expect(provider.embedTexts(["hello"])).rejects.toThrow("model unavailable (bad_model)");
  });

  it("sends conservative text batches", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return Response.json({
        data: body.input.map(() => ({ embedding: vector() })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenRouterEmbeddingProvider("sk-or-test");
    const texts = Array.from({ length: 52 }, (_, i) => `chunk ${i}`);

    await provider.embedTexts(texts);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input.length)).toEqual([25, 25, 2]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterGenerator } from "./openrouter-generate";

describe("createOpenRouterGenerator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests OpenRouter JSON mode for generateJSON calls", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"mentions":[],"relations":[]}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "google/gemini-2.5-flash" });

    await expect(generator.generateJSON("Return entities")).resolves.toEqual({ mentions: [], relations: [] });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.model).toBe("google/gemini-2.5-flash");
  });

  it("does not request JSON mode for free-text generation", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "A short summary." } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test");

    await expect(generator.generate("Summarize this")).resolves.toBe("A short summary.");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.response_format).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it("uses per-call model, reasoning effort, and max tokens", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "configured-model" });

    await generator.generateJSON("Return JSON", {
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      maxTokens: 1500,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(1500);
  });
});

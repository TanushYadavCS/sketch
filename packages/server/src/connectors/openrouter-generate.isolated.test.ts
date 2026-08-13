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

  it("retries without temperature when a reasoning model rejects it, then omits it for later calls", async () => {
    const rejection = () =>
      Response.json(
        { error: { message: "No endpoints found that can handle the requested parameters." } },
        { status: 404 },
      );
    const success = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"tasks":[]}' } }] });

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      JSON.parse(String(init?.body)).temperature === undefined ? success() : rejection(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "openai/gpt-5.6-luna@preset/canvas" });

    await expect(generator.generateJSON("Mint tasks")).resolves.toEqual({ tasks: [] });
    await expect(generator.generateJSON("Mint more tasks")).resolves.toEqual({ tasks: [] });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(3);
    expect(bodies[0].temperature).toBe(0);
    expect(bodies[0].reasoning).toBeUndefined();
    expect(bodies[1].temperature).toBeUndefined();
    expect(bodies[1].reasoning).toEqual({ effort: "medium" });
    expect(bodies[2].temperature).toBeUndefined();
    expect(bodies[2].reasoning).toEqual({ effort: "medium" });
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].provider).toEqual({ require_parameters: true });
  });

  it("keeps the original error and stays unsticky when dropping temperature does not help", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { error: { message: "No endpoints found that can handle the requested parameters." } },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "openai/gpt-5.6-luna" });

    await expect(generator.generateJSON("Mint tasks")).rejects.toThrow(/No endpoints found/);
    await expect(generator.generateJSON("Mint tasks again")).rejects.toThrow(/No endpoints found/);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(4);
    expect(bodies[2].temperature).toBe(0);
    expect(bodies[2].reasoning).toBeUndefined();
  });

  it("does not retry a parameter rejection on free-text calls, which never send require_parameters", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { error: { message: "No endpoints found that can handle the requested parameters." } },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "openai/gpt-5.6-luna" });

    await expect(generator.generate("Summarize this")).rejects.toThrow(/No endpoints found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 404 that is not a parameter rejection", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { error: { message: "No allowed providers are available for the selected model." } },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "openai/gpt-5.6-luna" });

    await expect(generator.generate("Summarize this")).rejects.toThrow(/No allowed providers/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's reasoning effort and never sends temperature when one is configured", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"projects":[]}' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { reasoningEffort: "medium" });

    await expect(generator.generateJSON("Mint projects")).resolves.toEqual({ projects: [] });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "medium" });
  });
});

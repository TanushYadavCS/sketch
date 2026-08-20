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

describe("generateAgenticJSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function toolCallResponse(calls: Array<{ id: string; name: string; args: string }>, usage?: object) {
    return Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.args },
            })),
          },
        },
      ],
      ...(usage ? { usage } : {}),
    });
  }

  function finalResponse(json: string, usage?: object) {
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: json } }],
      ...(usage ? { usage } : {}),
    });
  }

  it("runs a tool round, feeds the result back, and parses the final JSON", async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call_1", name: "lookup_name", args: '{"name":"Atlas"}' }], {
          prompt_tokens: 100,
          completion_tokens: 20,
        }),
      )
      .mockResolvedValueOnce(finalResponse('{"verdict":"alias"}', { prompt_tokens: 150, completion_tokens: 30 }));
    vi.stubGlobal("fetch", fetchMock);

    const lookupRun = vi.fn(async (args: unknown) => JSON.stringify({ got: args }));
    const steps: string[] = [];
    const generator = createOpenRouterGenerator("sk-or-test", { model: "judge-model" });
    const outcome = await generator.generateAgenticJSON<{ verdict: string }>("Judge this", {
      tools: [{ name: "lookup_name", description: "look up a name", parameters: { type: "object" }, run: lookupRun }],
      maxToolRounds: 4,
      onToolStep: (step) => {
        steps.push(step.name);
      },
    });

    expect(outcome.value).toEqual({ verdict: "alias" });
    expect(outcome.rounds).toBe(2);
    expect(outcome.toolSteps).toHaveLength(1);
    expect(outcome.toolSteps[0]).toMatchObject({ name: "lookup_name", args: { name: "Atlas" }, cached: false });
    expect(outcome.meta.usage).toEqual({ promptTokens: 250, completionTokens: 50 });
    expect(steps).toEqual(["lookup_name"]);
    expect(lookupRun).toHaveBeenCalledWith({ name: "Atlas" });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.tools).toHaveLength(1);
    expect(firstBody.tool_choice).toBe("auto");
    expect(firstBody.provider).toEqual({ require_parameters: true });
    expect(firstBody.response_format).toBeUndefined();

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const assistantTurn = secondBody.messages.at(-2);
    const toolTurn = secondBody.messages.at(-1);
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.tool_calls[0].function.name).toBe("lookup_name");
    expect(toolTurn).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ got: { name: "Atlas" } }),
    });
  });

  it("answers unknown tools, malformed args, and throwing tools with error results instead of dying", async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "c1", name: "no_such_tool", args: "{}" },
          { id: "c2", name: "lookup_name", args: "{not json" },
          { id: "c3", name: "lookup_name", args: '{"name":"Boom"}' },
        ]),
      )
      .mockResolvedValueOnce(finalResponse('{"verdict":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    const generator = createOpenRouterGenerator("sk-or-test", { model: "judge-model" });
    const outcome = await generator.generateAgenticJSON<{ verdict: string }>("Judge this", {
      tools: [
        {
          name: "lookup_name",
          description: "look up a name",
          parameters: { type: "object" },
          run: async () => {
            throw new Error("db exploded");
          },
        },
      ],
      maxToolRounds: 4,
    });

    expect(outcome.value).toEqual({ verdict: "ok" });
    expect(outcome.toolSteps.map((step) => JSON.parse(step.result).error)).toEqual([
      "unknown tool: no_such_tool",
      "tool arguments were not valid JSON",
      "db exploded",
    ]);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const toolTurns = secondBody.messages.filter((message: { role: string }) => message.role === "tool");
    expect(toolTurns.map((turn: { tool_call_id: string }) => turn.tool_call_id)).toEqual(["c1", "c2", "c3"]);
  });

  it("forces a final round at the cap and rejects if the model still wants tools", async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "lookup_name", args: '{"name":"A"}' }], {
          prompt_tokens: 10,
          completion_tokens: 5,
        }),
      )
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c2", name: "lookup_name", args: '{"name":"B"}' }], {
          prompt_tokens: 20,
          completion_tokens: 5,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const observed: { usage?: { promptTokens: number; completionTokens: number } } = {};
    const generator = createOpenRouterGenerator("sk-or-test", { model: "judge-model" });
    await expect(
      generator.generateAgenticJSON("Judge this", {
        tools: [
          { name: "lookup_name", description: "look up", parameters: { type: "object" }, run: async () => "found" },
        ],
        maxToolRounds: 1,
        onMeta: (meta) => {
          observed.usage = meta.usage;
        },
      }),
    ).rejects.toThrow(/still requested tools after the forced final round/);

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.tool_choice).toBe("none");
    expect(observed.usage).toEqual({ promptTokens: 30, completionTokens: 10 });
  });
});

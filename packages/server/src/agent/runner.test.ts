import { describe, expect, it, vi } from "vitest";
import { extractAssistantText, runAgent } from "./runner";

// Mock the SDK so runAgent can be tested without spawning subprocesses
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation(() => {
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-test" };
      yield { type: "result", session_id: "sess-test", total_cost_usd: 0 };
    })();
  }),
}));

vi.mock("./sessions", () => ({
  getSessionId: vi.fn().mockResolvedValue(undefined),
  saveSessionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./sketch-tools", () => {
  class MockUploadCollector {
    drain() {
      return [];
    }
  }
  return {
    UploadCollector: MockUploadCollector,
    createSketchMcpServer: vi.fn().mockReturnValue({}),
  };
});

vi.mock("./permissions", () => ({
  createCanUseTool: vi.fn().mockReturnValue(() => ({ behavior: "allow" as const })),
}));

describe("extractAssistantText", () => {
  it("extracts text from a standard assistant message", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    };
    expect(extractAssistantText(message)).toBe("hello world");
  });

  it("returns null for non-assistant message types", () => {
    expect(extractAssistantText({ type: "system", subtype: "init", session_id: "abc" })).toBeNull();
    expect(extractAssistantText({ type: "result", session_id: "abc", total_cost_usd: 0 })).toBeNull();
    expect(extractAssistantText({ type: "user" })).toBeNull();
  });

  it("returns null when content is only tool_use blocks", () => {
    const message = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
    };
    expect(extractAssistantText(message)).toBeNull();
  });

  it("returns null when text is empty", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    };
    expect(extractAssistantText(message)).toBeNull();
  });

  it("returns null when text is only whitespace", () => {
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "   \n\t  " }] },
    };
    expect(extractAssistantText(message)).toBeNull();
  });

  it("extracts text from message with mixed text and tool_use blocks", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check that for you." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo" } },
        ],
      },
    };
    expect(extractAssistantText(message)).toBe("Let me check that for you.");
  });

  it("concatenates multiple text blocks with newlines", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      },
    };
    expect(extractAssistantText(message)).toBe("First part.\nSecond part.");
  });

  it("returns null for null/undefined/primitive inputs", () => {
    expect(extractAssistantText(null)).toBeNull();
    expect(extractAssistantText(undefined)).toBeNull();
    expect(extractAssistantText("string")).toBeNull();
    expect(extractAssistantText(42)).toBeNull();
  });

  it("returns null when message property is missing", () => {
    expect(extractAssistantText({ type: "assistant" })).toBeNull();
  });

  it("returns null when content is not an array", () => {
    const message = {
      type: "assistant",
      message: { content: "not an array" },
    };
    expect(extractAssistantText(message)).toBeNull();
  });
});

function makeMockLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
    typeof runAgent
  >[0]["logger"];
}

function makeBaseParams(overrides?: Partial<Parameters<typeof runAgent>[0]>): Parameters<typeof runAgent>[0] {
  return {
    db: {} as Parameters<typeof runAgent>[0]["db"],
    workspaceKey: "u-test",
    userMessage: "hello",
    workspaceDir: "/tmp/ws-test",
    userName: "TestUser",
    logger: makeMockLogger(),
    platform: "slack",
    onMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Helper to build a rich SDK result message with all telemetry fields */
function makeRichResultMessage(overrides?: Record<string, unknown>) {
  return {
    type: "result",
    session_id: "sess-rich",
    total_cost_usd: 0.0042,
    subtype: "success",
    duration_ms: 5200,
    duration_api_ms: 4800,
    num_turns: 3,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1500,
      output_tokens: 800,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 2,
      },
    },
    modelUsage: { "claude-sonnet-4-20250514": { input_tokens: 1500, output_tokens: 800 } },
    ...overrides,
  };
}

describe("runAgent", () => {
  it("forwards userPhone to buildSystemContext (phone appears in system prompt append)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const capturedOptions: unknown[] = [];
    vi.mocked(query).mockImplementation(((args: unknown) => {
      capturedOptions.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-phone-test" };
        yield { type: "result", session_id: "sess-phone-test", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        workspaceKey: "u-phone-test",
        workspaceDir: "/tmp/ws-phone-test",
        userName: "Alice",
        userEmail: "alice@example.com",
        userPhone: "+1234567890",
        platform: "whatsapp",
      }),
    );

    expect(capturedOptions.length).toBeGreaterThan(0);
    const callArgs = capturedOptions[capturedOptions.length - 1] as {
      options: { systemPrompt: { append: string } };
    };
    expect(callArgs.options.systemPrompt.append).toContain("Phone: +1234567890");
  });

  it("returns enriched AgentResult with SDK telemetry fields", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-rich" };
        yield makeRichResultMessage();
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.costUsd).toBe(0.0042);
    expect(result.durationMs).toBe(5200);
    expect(result.durationApiMs).toBe(4800);
    expect(result.numTurns).toBe(3);
    expect(result.stopReason).toBe("end_turn");
    expect(result.errorSubtype).toBeNull();
    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(800);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheCreationTokens).toBe(100);
    expect(result.webSearchRequests).toBe(1);
    expect(result.webFetchRequests).toBe(2);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.isResumedSession).toBe(false);
    expect(result.promptMode).toBe("text");
    expect(result.totalAttachments).toBe(0);
    expect(result.imageCount).toBe(0);
    expect(result.nonImageCount).toBe(0);
    expect(result.mimeTypes).toEqual([]);
    expect(result.fileSizes).toEqual([]);
    expect(result.toolCalls).toEqual([]);
  });

  it("captures errorSubtype for non-success results", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-err" };
        yield makeRichResultMessage({ subtype: "error_max_turns", stop_reason: null });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.errorSubtype).toBe("error_max_turns");
    expect(result.stopReason).toBeNull();
  });

  it("captures tool calls from assistant messages", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-tools" };
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t2", name: "Skill", input: { skill: "canvas" } }],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t3", name: "mcp__plugin_pipedream__action", input: { app: "slack" } }],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-tools" });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]).toEqual(expect.objectContaining({ toolName: "Bash", skillName: null }));
    expect(result.toolCalls[1]).toEqual(expect.objectContaining({ toolName: "Skill", skillName: "canvas" }));
    expect(result.toolCalls[2]).toEqual(
      expect.objectContaining({ toolName: "mcp__plugin_pipedream__action", skillName: null }),
    );
    for (const tc of result.toolCalls) {
      expect(tc.startedAt).toBeGreaterThan(0);
      expect(tc.endedAt).toBeGreaterThanOrEqual(tc.startedAt);
    }
  });

  it("sets skillName to null when Skill tool has no input.skill", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-noskill" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Skill", input: {} }],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-noskill" });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual(expect.objectContaining({ toolName: "Skill", skillName: null }));
  });

  it("does not capture tool calls from replayed user messages (EC-8)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-replay" };
        // Replayed messages have type "user", not "assistant"
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_use", id: "t-replay", name: "Bash", input: {} }],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-replay" });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.toolCalls).toHaveLength(0);
  });

  it("handles model=null when modelUsage is empty (EC-10)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-nomodel" };
        yield makeRichResultMessage({ modelUsage: {} });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());
    expect(result.model).toBeNull();
  });

  it("defaults telemetry to zero when SDK result has no usage fields", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-minimal" };
        yield { type: "result", session_id: "sess-minimal", total_cost_usd: 0, subtype: "success" };
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(result.durationMs).toBe(0);
    expect(result.durationApiMs).toBe(0);
    expect(result.numTurns).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.webSearchRequests).toBe(0);
    expect(result.webFetchRequests).toBe(0);
    expect(result.model).toBeNull();
  });
});

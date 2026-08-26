import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { extractAssistantText, extractAssistantTextDelta, runAgent } from "./runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./runtime/pricing";
import type { AgentRuntimeProvider } from "./runtime/provider";

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
  archiveSdkSessionId: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockResolvedValue(undefined),
  getSessionIdForRuntime: vi.fn().mockResolvedValue(undefined),
  isArchivedRuntimeSessionId: vi.fn().mockResolvedValue(false),
  saveSessionId: vi.fn().mockResolvedValue(undefined),
  saveSessionIdForRuntime: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./sketch-tools", () => {
  class MockUploadCollector {
    drain() {
      return [];
    }
  }
  class MockIntegrationConnectionCollector {
    private pending: unknown[] = [];

    collect(card: unknown) {
      this.pending.push(card);
    }

    drain() {
      const cards = [...this.pending];
      this.pending = [];
      return cards;
    }
  }
  class MockAutomationArtifactCollector {
    drain() {
      return [];
    }
  }
  class MockQuestionCollector {
    private pending: unknown | null = null;

    collect(question: unknown) {
      if (this.pending) throw new Error("Only one pending question is allowed per agent run.");
      this.pending = question;
    }

    hasPending() {
      return this.pending !== null;
    }

    drain() {
      const question = this.pending;
      this.pending = null;
      return question;
    }
  }
  return {
    AutomationArtifactCollector: MockAutomationArtifactCollector,
    IntegrationConnectionCollector: MockIntegrationConnectionCollector,
    QuestionCollector: MockQuestionCollector,
    UploadCollector: MockUploadCollector,
    createSketchMcpToolDefinitions: vi.fn().mockReturnValue([]),
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

describe("extractAssistantTextDelta", () => {
  it("extracts text deltas from SDK partial assistant stream events", () => {
    expect(
      extractAssistantTextDelta({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      }),
    ).toBe("Hel");
  });

  it("returns null for non-text partial events", () => {
    expect(
      extractAssistantTextDelta({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
      }),
    ).toBeNull();
    expect(extractAssistantTextDelta({ type: "assistant" })).toBeNull();
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
    claudeConfigDir: "/tmp/.claude",
    userName: "TestUser",
    logger: makeMockLogger(),
    platform: "slack",
    onProgressEvent: vi.fn().mockResolvedValue(undefined),
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

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function makeMockAgentRuntimeProvider(): AgentRuntimeProvider {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    model: new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "aisdk selected" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(10, 2),
            },
          ],
        }),
      },
    }),
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    preparePrompt: (input) => ({
      instructions: input.systemPrompt,
      messages: input.messages ?? [{ role: "user", content: input.prompt }],
    }),
  };
}

describe("runAgent", () => {
  it("keeps the Claude SDK runtime as the default selector", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockClear();

    const result = await runAgent(makeBaseParams({ sessionMode: "fresh", persistSession: false }));

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess-test");
  });

  it("selects the AI SDK runtime when requested", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const workspace = await mkdtemp(join(tmpdir(), "sketch-runner-selector-"));
    vi.mocked(query).mockClear();

    try {
      const result = await runAgent(
        makeBaseParams({
          agentRuntime: "aisdk",
          agentRuntimeProvider: makeMockAgentRuntimeProvider(),
          workspaceDir: workspace,
          claudeConfigDir: workspace,
          sessionMode: "fresh",
          persistSession: false,
        }),
      );

      expect(query).not.toHaveBeenCalled();
      expect(result.trace.finalText).toBe("aisdk selected");
      expect(result.rawUsage.promptMode).toBe("text");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("resumes an explicit session without saving it when persistSession is false", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const sessions = await import("./sessions");
    let capturedResume: string | undefined;
    vi.mocked(query).mockImplementation(((args: unknown) => {
      const callArgs = args as { options: { resume?: string } };
      capturedResume = callArgs.options.resume;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "external-session-1" };
        yield makeRichResultMessage({ session_id: "external-session-1" });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(
      makeBaseParams({
        resumeSessionId: "external-session-1",
        persistSession: false,
      }),
    );

    expect(capturedResume).toBe("external-session-1");
    expect(sessions.getSessionId).not.toHaveBeenCalled();
    expect(sessions.saveSessionId).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("external-session-1");
    expect(result.rawUsage.isResumedSession).toBe(true);
  });

  it("clears a stale resumed session and retries once fresh before producing output", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const sessions = await import("./sessions");
    const capturedResume: Array<string | undefined> = [];
    vi.mocked(sessions.getSessionId).mockResolvedValueOnce("sess-stale");
    vi.mocked(query)
      .mockImplementationOnce(((args: unknown) => {
        const callArgs = args as { options: { resume?: string } };
        capturedResume.push(callArgs.options.resume);
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-stale" };
          throw new Error("Claude Code process exited with code 1");
        })();
      }) as unknown as typeof query)
      .mockImplementationOnce(((args: unknown) => {
        const callArgs = args as { options: { resume?: string } };
        capturedResume.push(callArgs.options.resume);
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-fresh" };
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Recovered" }] },
          };
          yield makeRichResultMessage({ session_id: "sess-fresh" });
        })();
      }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams());

    expect(capturedResume).toEqual(["sess-stale", undefined]);
    expect(sessions.archiveSdkSessionId).toHaveBeenCalledWith(expect.anything(), "u-test", undefined);
    expect(sessions.saveSessionId).toHaveBeenCalledWith(expect.anything(), "u-test", "sess-fresh", undefined);
    expect(result.rawUsage.isResumedSession).toBe(false);
    expect(result.trace.finalText).toBe("Recovered");
  });

  it("passes user env vars through the SDK process env", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let capturedEnv: Record<string, string | undefined> = {};

    vi.mocked(query).mockImplementation(((args: unknown) => {
      const callArgs = args as {
        options: {
          env: Record<string, string | undefined>;
        };
      };
      capturedEnv = callArgs.options.env;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-bash-env" };
        yield { type: "result", session_id: "sess-bash-env", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        agentEnv: {
          TEST_REGION: "us-east-1",
          GH_TOKEN: "token'with-quote",
        },
      }),
    );

    expect(capturedEnv.TEST_REGION).toBe("us-east-1");
    expect(capturedEnv.GH_TOKEN).toBe("token'with-quote");
  });

  it("does not fail the run when session id notification delivery fails", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const logger = makeMockLogger();
    const onSessionId = vi.fn().mockRejectedValue(new Error("stream closed"));
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-test" };
        yield { type: "result", session_id: "sess-test", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams({ logger, onSessionId }));

    expect(result.sessionId).toBe("sess-test");
    expect(onSessionId).toHaveBeenCalledWith("sess-test");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to deliver session id notification",
    );
  });

  it("uses custom string systemPrompt (not preset) with no per-user content", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const capturedOptions: unknown[] = [];
    vi.mocked(query).mockImplementation(((args: unknown) => {
      capturedOptions.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-prompt-test" };
        yield { type: "result", session_id: "sess-prompt-test", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        workspaceKey: "u-prompt-test",
        workspaceDir: "/tmp/ws-prompt-test",
        userName: "Alice",
        userEmail: "alice@example.com",
        userPhone: "+1234567890",
        platform: "whatsapp",
      }),
    );

    expect(capturedOptions.length).toBeGreaterThan(0);
    const callArgs = capturedOptions[capturedOptions.length - 1] as {
      options: { systemPrompt: string };
    };
    expect(typeof callArgs.options.systemPrompt).toBe("string");
    expect(callArgs.options.systemPrompt).not.toContain("Phone:");
    expect(callArgs.options.systemPrompt).not.toContain("Alice");
  });

  it("describes brokered Canvas access in the Claude SDK prompt", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let capturedSystemPrompt = "";
    vi.mocked(query).mockImplementation(((args: unknown) => {
      capturedSystemPrompt = (args as { options: { systemPrompt: string } }).options.systemPrompt;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-canvas-prompt" };
        yield { type: "result", session_id: "sess-canvas-prompt", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        loadIntegrationProvider: vi.fn().mockResolvedValue({
          getBrokerSpec: vi.fn().mockReturnValue({
            cliPath: process.execPath,
            credentialEnv: {},
            launcherEnvName: "CANVAS_CLI",
          }),
        } as never),
      }),
    );

    expect(capturedSystemPrompt).toContain("Available managed skill integrations for this run: Canvas");
    expect(capturedSystemPrompt).not.toContain("Google Calendar");
    expect(capturedSystemPrompt).not.toContain("No managed skill integrations are available");
  });

  it("passes allowlisted WebSearch and WebFetch through to the Claude SDK runtime without a degradation note", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const capturedOptions: unknown[] = [];
    vi.mocked(query).mockImplementation(((args: unknown) => {
      capturedOptions.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-sdk-web-tools" };
        yield { type: "result", session_id: "sess-sdk-web-tools", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        agentAllowedTools: ["WebSearch", "WebFetch"],
      }),
    );

    const callArgs = capturedOptions[capturedOptions.length - 1] as {
      options: { systemPrompt: string; tools: string[] };
    };
    expect(callArgs.options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(callArgs.options.systemPrompt).not.toContain("Direct WebSearch and WebFetch tools are not available");
  });

  it("passes optional model and maxTurns overrides to the SDK query", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const capturedOptions: unknown[] = [];
    vi.mocked(query).mockImplementation(((args: unknown) => {
      capturedOptions.push(args);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-overrides" };
        yield { type: "result", session_id: "sess-overrides", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    await runAgent(
      makeBaseParams({
        model: "claude-test-model",
        maxTurns: 50,
      }),
    );

    const callArgs = capturedOptions[capturedOptions.length - 1] as {
      options: { model?: string; maxTurns?: number };
    };
    expect(callArgs.options.model).toBe("claude-test-model");
    expect(callArgs.options.maxTurns).toBe(50);
  });

  it("enables SDK partial messages and forwards assistant text deltas", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const onTextDelta = vi.fn().mockResolvedValue(undefined);
    let includePartialMessages: boolean | undefined;
    vi.mocked(query).mockImplementation(((args: unknown) => {
      const callArgs = args as { options: { includePartialMessages?: boolean } };
      includePartialMessages = callArgs.options.includePartialMessages;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-stream" };
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        };
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        };
        yield makeRichResultMessage({ session_id: "sess-stream" });
      })();
    }) as unknown as typeof query);

    const result = await runAgent(makeBaseParams({ onTextDelta }));

    expect(includePartialMessages).toBe(true);
    expect(onTextDelta).toHaveBeenNthCalledWith(1, "Hel");
    expect(onTextDelta).toHaveBeenNthCalledWith(2, "lo");
    expect(result.trace.finalText).toBe("Hello");
  });

  it("uses text attachment references for image prompts when the vision tool is configured", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createCanUseTool } = await import("./permissions");
    const tmpDir = await mkdtemp(join(tmpdir(), "sketch-runner-vision-"));
    const imagePath = join(tmpDir, "diagram.png");
    const backlogImagePath = join(tmpDir, "backlog.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(backlogImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let capturedPrompt: unknown;
    vi.mocked(createCanUseTool).mockClear();
    vi.mocked(query).mockImplementation(((args: unknown) => {
      const callArgs = args as { prompt: unknown };
      capturedPrompt = callArgs.prompt;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-vision-tool" };
        yield { type: "result", session_id: "sess-vision-tool", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    try {
      const result = await runAgent(
        makeBaseParams({
          workspaceDir: tmpDir,
          attachments: [
            {
              originalName: "diagram.png",
              mimeType: "image/png",
              localPath: imagePath,
              sizeBytes: 4,
            },
          ],
          visionConfig: {
            apiKey: "sk-or-vision",
            model: "xiaomi/mimo-v2.5",
            source: "env",
            providerMode: "env",
          },
          blockedReadPaths: [backlogImagePath],
        }),
      );

      expect(typeof capturedPrompt).toBe("string");
      expect(capturedPrompt).toContain("<attachments>");
      expect(capturedPrompt).toContain(`path="${imagePath}"`);
      expect(capturedPrompt).toContain(
        'hint="Use mcp__sketch__VisualAnalysis with this path to understand the image."',
      );
      expect(vi.mocked(createCanUseTool).mock.calls.at(-1)?.[3]).toMatchObject({
        blockedReadPaths: [imagePath, backlogImagePath],
        blockImageReads: true,
      });
      expect(result.rawUsage.promptMode).toBe("text");
      expect(result.rawUsage.imageCount).toBe(1);
      expect(result.rawUsage.nonImageCount).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not block image reads when VisualAnalysis is excluded by an agent allowlist", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { createCanUseTool } = await import("./permissions");
    const { createSketchMcpServer } = await import("./sketch-tools");
    const tmpDir = await mkdtemp(join(tmpdir(), "sketch-runner-vision-allowlist-"));
    const imagePath = join(tmpDir, "diagram.png");
    const backlogImagePath = join(tmpDir, "backlog.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(backlogImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let capturedPrompt: unknown;
    vi.mocked(createCanUseTool).mockClear();
    vi.mocked(createSketchMcpServer).mockClear();
    vi.mocked(query).mockImplementation(((args: unknown) => {
      const callArgs = args as { prompt: unknown };
      capturedPrompt = callArgs.prompt;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-vision-read" };
        yield { type: "result", session_id: "sess-vision-read", total_cost_usd: 0 };
      })();
    }) as unknown as typeof query);

    try {
      const result = await runAgent(
        makeBaseParams({
          workspaceDir: tmpDir,
          attachments: [
            {
              originalName: "diagram.png",
              mimeType: "image/png",
              localPath: imagePath,
              sizeBytes: 4,
            },
          ],
          visionConfig: {
            apiKey: "sk-or-vision",
            model: "xiaomi/mimo-v2.5",
            source: "env",
            providerMode: "env",
          },
          agentAllowedTools: ["Read"],
          blockedReadPaths: [backlogImagePath],
        }),
      );

      expect(typeof capturedPrompt).toBe("string");
      expect(capturedPrompt).toContain("<attachments>");
      expect(capturedPrompt).not.toContain("mcp__sketch__VisualAnalysis");
      expect(vi.mocked(createSketchMcpServer).mock.calls.at(-1)?.[0]).toMatchObject({
        visionAnalysisEnabled: false,
      });
      expect(vi.mocked(createCanUseTool).mock.calls.at(-1)?.[3]).toMatchObject({
        agentAllowedTools: ["Read"],
        blockImageReads: false,
      });
      expect(vi.mocked(createCanUseTool).mock.calls.at(-1)?.[3]?.blockedReadPaths).toBeUndefined();
      expect(result.rawUsage.promptMode).toBe("text");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves visual analysis config from OpenRouter DB settings", async () => {
    const { createSketchMcpServer } = await import("./sketch-tools");
    vi.stubEnv("VISION_ENABLED", "true");
    vi.stubEnv("VISION_MODEL", "xiaomi/mimo-v2.5");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-env");
    vi.mocked(createSketchMcpServer).mockClear();

    try {
      await runAgent(
        makeBaseParams({
          loadTranscriptionSettings: vi.fn().mockResolvedValue({
            llm_provider: "openrouter",
            anthropic_api_key: "sk-db",
          }),
        }),
      );

      expect(vi.mocked(createSketchMcpServer).mock.calls.at(-1)?.[0].visionConfig).toMatchObject({
        apiKey: "sk-db",
        model: "xiaomi/mimo-v2.5",
        source: "db",
        providerMode: "openrouter",
      });
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(result.rawUsage.durationApiMs).toBe(4800);
    expect(result.rawUsage.numTurns).toBe(3);
    expect(result.rawUsage.stopReason).toBe("end_turn");
    expect(result.rawUsage.errorSubtype).toBeNull();
    expect(result.rawUsage.inputTokens).toBe(1500);
    expect(result.rawUsage.outputTokens).toBe(800);
    expect(result.rawUsage.cacheReadTokens).toBe(200);
    expect(result.rawUsage.cacheCreationTokens).toBe(100);
    expect(result.rawUsage.webSearchRequests).toBe(1);
    expect(result.rawUsage.webFetchRequests).toBe(2);
    expect(result.rawUsage.model).toBe("claude-sonnet-4-20250514");
    expect(result.rawUsage.isResumedSession).toBe(false);
    expect(result.rawUsage.promptMode).toBe("text");
    expect(result.rawUsage.totalAttachments).toBe(0);
    expect(result.rawUsage.imageCount).toBe(0);
    expect(result.rawUsage.nonImageCount).toBe(0);
    expect(result.rawUsage.mimeTypes).toEqual([]);
    expect(result.rawUsage.fileSizes).toEqual([]);
    expect(result.rawUsage.toolCalls).toEqual([]);
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

    expect(result.rawUsage.errorSubtype).toBe("error_max_turns");
    expect(result.rawUsage.stopReason).toBeNull();
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

    expect(result.rawUsage.toolCalls).toHaveLength(3);
    expect(result.trace.progressEvents).toEqual([
      { kind: "intermediate_text", text: "Let me check." },
      { kind: "tool_use", toolName: "Bash", input: { command: "ls" } },
      { kind: "tool_use", toolName: "Skill", input: { skill: "canvas" } },
      { kind: "tool_use", toolName: "mcp__plugin_pipedream__action", input: { app: "slack" } },
    ]);
    expect(result.rawUsage.toolCalls[0]).toEqual(expect.objectContaining({ toolName: "Bash", skillName: null }));
    expect(result.rawUsage.toolCalls[1]).toEqual(expect.objectContaining({ toolName: "Skill", skillName: "canvas" }));
    expect(result.rawUsage.toolCalls[2]).toEqual(
      expect.objectContaining({ toolName: "mcp__plugin_pipedream__action", skillName: null }),
    );
    for (const tc of result.rawUsage.toolCalls) {
      expect(tc.startedAt).toBeGreaterThan(0);
      expect(tc.endedAt).toBeGreaterThanOrEqual(tc.startedAt);
    }
  });

  it("skips progress-derived integration cards for scheduled tasks", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-canvas-cli" };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: {
                  command: "$CANVAS_CLI direct-execute-action --component-key github-create-issue --output json",
                },
              },
            ],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-canvas-cli" });
      })();
    }) as unknown as typeof query);
    const provider = {
      getBrokerSpec: vi.fn().mockReturnValue(null),
      listConnections: vi.fn().mockRejectedValue(new Error("should not list connections")),
      listApps: vi.fn().mockRejectedValue(new Error("should not list apps")),
    };

    const result = await runAgent(
      makeBaseParams({
        responseSurface: "web",
        contextType: "scheduled_task",
        userEmail: "alice@example.com",
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
      }),
    );

    expect(provider.listConnections).not.toHaveBeenCalled();
    expect(provider.listApps).not.toHaveBeenCalled();
    expect(result.pendingIntegrationConnections).toEqual([]);
  });

  it("collects progress-derived missing integration cards for interactive runs", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-web-canvas-cli" };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: {
                  command: "$CANVAS_CLI direct-execute-action --component-key github-create-issue --output json",
                },
              },
            ],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-web-canvas-cli" });
      })();
    }) as unknown as typeof query);
    const provider = {
      getBrokerSpec: vi.fn().mockReturnValue(null),
      listConnections: vi.fn().mockResolvedValue([]),
      listApps: vi.fn().mockResolvedValue({
        apps: [{ id: "github", name: "GitHub", description: "Code hosting", icon: "https://cdn.example/github.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    };

    const result = await runAgent(
      makeBaseParams({
        responseSurface: "web",
        contextType: "dm",
        userEmail: "alice@example.com",
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
      }),
    );

    expect(provider.listConnections).toHaveBeenCalledWith("alice@example.com", "TestUser");
    expect(result.pendingIntegrationConnections).toMatchObject([
      { appId: "github", appName: "GitHub", state: "connect" },
    ]);
  });

  it("collects result-derived missing integration cards without minting direct URLs", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-result-card" };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "mcp__plugin_pipedream__slack_send_message",
                input: { app: "slack" },
              },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                is_error: true,
                content: [{ type: "text", text: "CONNECTION_NOT_CONNECTED" }],
              },
            ],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-result-card" });
      })();
    }) as unknown as typeof query);
    const provider = {
      getBrokerSpec: vi.fn().mockReturnValue(null),
      listConnections: vi.fn().mockResolvedValue([]),
      listApps: vi.fn().mockResolvedValue({
        apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
      initiateConnection: vi.fn().mockResolvedValue({
        redirectUrl: "https://canvas.example.com/connect/secrets?token=slack",
      }),
    };

    const result = await runAgent(
      makeBaseParams({
        contextType: "dm",
        userEmail: "alice@example.com",
        toolConfig: { BASE_URL: "https://sketch.example.com", PORT: 3000 },
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
      }),
    );

    expect(result.trace.progressEvents).toEqual([
      { kind: "tool_use", toolName: "mcp__plugin_pipedream__slack_send_message", input: { app: "slack" } },
    ]);
    expect(provider.initiateConnection).not.toHaveBeenCalled();
    expect(result.pendingIntegrationConnections).toMatchObject([
      {
        appId: "slack",
        appName: "Slack",
        state: "connect",
      },
    ]);
    expect(result.pendingIntegrationConnections?.[0]).not.toHaveProperty("connectUrl");
  });

  it("does not mint result-derived direct integration URLs for channel mentions", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-shared-card" };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "mcp__plugin_pipedream__slack_send_message",
                input: { app: "slack" },
              },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                is_error: true,
                content: [{ type: "text", text: "CONNECTION_NOT_CONNECTED" }],
              },
            ],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-shared-card" });
      })();
    }) as unknown as typeof query);
    const provider = {
      getBrokerSpec: vi.fn().mockReturnValue(null),
      listConnections: vi.fn().mockResolvedValue([]),
      listApps: vi.fn().mockResolvedValue({
        apps: [{ id: "slack", name: "Slack", description: "Team chat", icon: "https://cdn.example/slack.png" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
      initiateConnection: vi.fn().mockResolvedValue({
        redirectUrl: "https://canvas.example.com/connect/secrets?token=slack",
      }),
    };

    const result = await runAgent(
      makeBaseParams({
        contextType: "channel_mention",
        userEmail: "alice@example.com",
        toolConfig: { BASE_URL: "https://sketch.example.com", PORT: 3000 },
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
      }),
    );

    expect(provider.initiateConnection).not.toHaveBeenCalled();
    expect(result.pendingIntegrationConnections).toMatchObject([
      {
        appId: "slack",
        appName: "Slack",
        state: "connect",
      },
    ]);
    expect(result.pendingIntegrationConnections?.[0]).not.toHaveProperty("connectUrl");
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

    expect(result.rawUsage.toolCalls).toHaveLength(1);
    expect(result.rawUsage.toolCalls[0]).toEqual(expect.objectContaining({ toolName: "Skill", skillName: null }));
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

    expect(result.rawUsage.toolCalls).toHaveLength(0);
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
    expect(result.rawUsage.model).toBeNull();
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

    expect(result.rawUsage.durationApiMs).toBe(0);
    expect(result.rawUsage.numTurns).toBe(0);
    expect(result.rawUsage.inputTokens).toBe(0);
    expect(result.rawUsage.outputTokens).toBe(0);
    expect(result.rawUsage.cacheReadTokens).toBe(0);
    expect(result.rawUsage.cacheCreationTokens).toBe(0);
    expect(result.rawUsage.webSearchRequests).toBe(0);
    expect(result.rawUsage.webFetchRequests).toBe(0);
    expect(result.rawUsage.model).toBeNull();
  });

  it("keeps the trailing text-only suffix as finalText", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-final" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "config.json" } }],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I found the issue." }],
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I updated the config and parser." }],
          },
        };
        yield makeRichResultMessage({ session_id: "sess-final" });
      })();
    }) as unknown as typeof query);

    const onProgressEvent = vi.fn().mockResolvedValue(undefined);
    const result = await runAgent(makeBaseParams({ onProgressEvent }));

    expect(onProgressEvent).toHaveBeenCalledTimes(1);
    expect(result.trace.progressEvents).toEqual([
      { kind: "tool_use", toolName: "Read", input: { file_path: "config.json" } },
    ]);
    expect(result.trace.finalText).toBe("I found the issue.\n\nI updated the config and parser.");
    expect(result.messageSent).toBe(true);
  });
});

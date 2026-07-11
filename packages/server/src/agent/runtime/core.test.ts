import { type LanguageModel, type ModelMessage, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER } from "./compaction";
import { runAgentRuntimeCore } from "./core";
import { AgentRuntimeProviderError } from "./errors";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import type { AgentRuntimeProvider } from "./provider";

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens - cacheReadTokens - cacheWriteTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function mockProvider(model: LanguageModel, modelId = "claude-sonnet-4-6"): AgentRuntimeProvider {
  return {
    provider: "anthropic",
    modelId,
    model,
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    preparePrompt: (input) => ({
      instructions: input.systemPrompt,
      messages: [{ role: "user", content: input.prompt }] satisfies ModelMessage[],
    }),
  };
}

describe("agent runtime core", () => {
  it("streams text around a multi-step tool loop and emits ordered events", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "before " },
              { type: "text-end", id: "text-1" },
              { type: "tool-call", toolCallId: "tool-1", toolName: "Echo", input: '{"text":"hi"}' },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(10, 2, 3, 4),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "after" },
              { type: "text-end", id: "text-2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(20, 5),
              },
            ],
          }),
        },
      ],
    });
    const events: string[] = [];

    const result = await runAgentRuntimeCore({
      provider: mockProvider(model),
      prompt: "run the tool",
      systemPrompt: "system",
      maxTurns: 5,
      persistSession: false,
      tools: {
        Echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
      events: {
        onTextDelta: (text) => {
          events.push(`text:${text}`);
        },
        onToolStart: (event) => {
          events.push(`tool-start:${event.name}:${event.input.text}`);
        },
        onToolEnd: (event) => {
          events.push(`tool-end:${event.name}:${JSON.stringify(event.result)}`);
        },
      },
    });

    expect(result.finalText).toBe("before after");
    expect(result.stopReason).toBe("end_turn");
    expect(result.num_turns).toBe(2);
    expect(result.usage).toMatchObject({
      totalInputTokens: 23,
      totalOutputTokens: 7,
      totalCacheReadTokens: 3,
      totalCacheWriteTokens: 4,
    });
    expect(result.cost.totalUsd).toBeGreaterThan(0);
    expect(events).toEqual(["text:before ", "tool-start:Echo:hi", 'tool-end:Echo:{"echoed":"hi"}', "text:after"]);
  });

  it("returns partial text with stopReason aborted when the abort signal fires mid-stream", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 25,
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "partial" },
            { type: "text-delta", id: "text-1", delta: " ignored" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(1, 1),
            },
          ],
        }),
      }),
    });

    const result = await runAgentRuntimeCore({
      provider: mockProvider(model),
      prompt: "abort",
      systemPrompt: "system",
      maxTurns: 5,
      persistSession: false,
      abortSignal: controller.signal,
      events: {
        onTextDelta: () => controller.abort(),
      },
    });

    expect(result.stopReason).toBe("aborted");
    expect(result.finalText).toContain("partial");
  });

  it("enforces the configured turn cap", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "tool-1", toolName: "Echo", input: '{"text":"one"}' },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(10, 0),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "should not run" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 1),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgentRuntimeCore({
      provider: mockProvider(model),
      prompt: "cap",
      systemPrompt: "system",
      maxTurns: 1,
      persistSession: false,
      tools: {
        Echo: tool({
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    expect(result.num_turns).toBe(1);
    expect(result.stopReason).toBe("tool_use");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("wraps provider failures in a typed runtime provider error", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [{ type: "error", error: new Error("provider down") }],
        }),
      },
    });

    await expect(
      runAgentRuntimeCore({
        provider: mockProvider(model),
        prompt: "fail",
        systemPrompt: "system",
        maxTurns: 1,
        persistSession: false,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeProviderError);
  });

  it("falls back to reconstructed history when compaction fails", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "done" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(1, 1),
            },
          ],
        }),
      },
    });
    const captured: ModelMessage[][] = [];
    const provider: AgentRuntimeProvider = {
      ...mockProvider(model),
      preparePrompt: (input) => {
        const messages = input.messages ?? [{ role: "user", content: input.prompt }];
        captured.push(messages);
        return { instructions: input.systemPrompt, messages };
      },
    };
    const logger = { warn: vi.fn() };

    const result = await runAgentRuntimeCore({
      provider,
      prompt: "current",
      systemPrompt: "system",
      maxTurns: 1,
      persistSession: true,
      sessionId: "sess-compact-fail-open",
      sessionStore: {
        async load() {
          return [
            { seq: 1, role: "user", content: { role: "user", content: "old" } },
            {
              seq: 2,
              role: "user",
              content: {
                marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
                version: 1,
                trigger: "auto",
                summary: "Earlier decisions.",
                replacedPrefixStartSeq: 1,
                replacedPrefixEndSeq: 1,
                keepRecentTailStartSeq: 3,
              },
            },
            { seq: 3, role: "assistant", content: { role: "assistant", content: "tail" } },
          ];
        },
        async appendTransactional() {},
        async archive() {},
      },
      compaction: {
        async compact() {
          throw new Error("transient 429");
        },
      },
      logger,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.finalText).toBe("done");
    expect(captured[0]).toEqual([
      { role: "user", content: "[Prior conversation summary]\nEarlier decisions." },
      { role: "assistant", content: "tail" },
      { role: "user", content: "current" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), sessionId: "sess-compact-fail-open" }),
      "AI SDK runtime compaction failed; proceeding with un-compacted history",
    );
  });

  it("reports aborted when compaction fails because the run was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "should not stream" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(1, 1),
            },
          ],
        }),
      },
    });
    const abortError = new Error("aborted during compaction");
    abortError.name = "AbortError";
    const logger = { warn: vi.fn() };
    const preparePrompt = vi.fn(mockProvider(model).preparePrompt);

    const result = await runAgentRuntimeCore({
      provider: { ...mockProvider(model), preparePrompt },
      prompt: "current",
      systemPrompt: "system",
      maxTurns: 1,
      persistSession: true,
      sessionId: "sess-compact-abort",
      sessionStore: {
        async load() {
          return [{ seq: 1, role: "user", content: { role: "user", content: "old" } }];
        },
        async appendTransactional() {},
        async archive() {},
      },
      compaction: {
        async compact() {
          throw abortError;
        },
      },
      abortSignal: controller.signal,
      logger,
    });

    expect(result.stopReason).toBe("aborted");
    expect(result.finalText).toBe("");
    expect(model.doStreamCalls).toHaveLength(0);
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reconstructs compacted persisted history before preparing the prompt", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "done" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(1, 1),
            },
          ],
        }),
      },
    });
    const captured: ModelMessage[][] = [];
    const provider: AgentRuntimeProvider = {
      ...mockProvider(model),
      preparePrompt: (input) => {
        const messages = input.messages ?? [{ role: "user", content: input.prompt }];
        captured.push(messages);
        return { instructions: input.systemPrompt, messages };
      },
    };

    await runAgentRuntimeCore({
      provider,
      prompt: "current",
      systemPrompt: "system",
      maxTurns: 1,
      persistSession: true,
      sessionId: "sess-compact",
      sessionStore: {
        async load() {
          return [
            { seq: 1, role: "user", content: { role: "user", content: "old" } },
            {
              seq: 2,
              role: "user",
              content: {
                marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
                version: 1,
                trigger: "auto",
                summary: "Earlier decisions.",
                replacedPrefixStartSeq: 1,
                replacedPrefixEndSeq: 1,
                keepRecentTailStartSeq: 3,
              },
            },
            { seq: 3, role: "assistant", content: { role: "assistant", content: "tail" } },
          ];
        },
        async appendTransactional() {},
        async archive() {},
      },
    });

    expect(captured[0]).toEqual([
      { role: "user", content: "[Prior conversation summary]\nEarlier decisions." },
      { role: "assistant", content: "tail" },
      { role: "user", content: "current" },
    ]);
  });
});

import { type ModelMessage, type ToolSet, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
  EMPTY_COMPACTION_SUMMARY_PLACEHOLDER,
  computeAgentRuntimeKeepRecentTailBoundary,
  createAgentRuntimeCompactionTrigger,
  createDefaultAgentRuntimeCompactionProvider,
  reconstructCompactedHistory,
} from "./compaction";
import type { AgentRuntimeMessage, AgentRuntimeMessageAppend, AgentRuntimeSessionStore } from "./contracts";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import type { AgentRuntimeProvider } from "./provider";

function textMessage(seq: number, role: AgentRuntimeMessage["role"], content: string): AgentRuntimeMessage {
  return { seq, role, content: { role, content } };
}

function compactionMarker(params: {
  seq: number;
  summary: string;
  replacedPrefixStartSeq: number;
  replacedPrefixEndSeq: number;
  keepRecentTailStartSeq: number;
}): AgentRuntimeMessage {
  return {
    seq: params.seq,
    role: "user",
    content: {
      marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
      version: 1,
      trigger: "auto",
      summary: params.summary,
      replacedPrefixStartSeq: params.replacedPrefixStartSeq,
      replacedPrefixEndSeq: params.replacedPrefixEndSeq,
      keepRecentTailStartSeq: params.keepRecentTailStartSeq,
    },
  };
}

function toolCallMessage(seq: number, toolCallId = "tool-1"): AgentRuntimeMessage {
  return {
    seq,
    role: "assistant",
    content: {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "Read", input: { file_path: "notes.txt" } }],
    } satisfies ModelMessage,
  };
}

function toolResultMessage(seq: number, toolCallId = "tool-1"): AgentRuntimeMessage {
  return {
    seq,
    role: "tool",
    content: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "Read",
          output: { type: "text", value: "done" },
        },
      ],
    } satisfies ModelMessage,
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function summaryProvider(summary: string): AgentRuntimeProvider {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    model: new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doGenerate: {
        content: [{ type: "text", text: summary }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(10, 2),
        warnings: [],
      },
    }),
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    preparePrompt: (input) => ({
      instructions: input.systemPrompt,
      messages: input.messages ?? [{ role: "user", content: input.prompt }],
    }),
  };
}

function memoryStore(initialRows: readonly AgentRuntimeMessage[] = []): AgentRuntimeSessionStore & {
  appended: AgentRuntimeMessageAppend[];
} {
  let rows = [...initialRows];
  const appended: AgentRuntimeMessageAppend[] = [];

  return {
    appended,
    async load() {
      return rows;
    },
    async appendTransactional(_sessionId, messages) {
      const nextSeq = Math.max(0, ...rows.map((row) => row.seq)) + 1;
      appended.push(...messages);
      rows = [
        ...rows,
        ...messages.map((message, index) => ({
          seq: nextSeq + index,
          role: message.role,
          content: message.content,
        })),
      ];
    },
    async archive() {},
  };
}

describe("agent runtime compaction reconstruction", () => {
  it("returns rows unchanged when no marker is present", () => {
    const rows = [textMessage(1, "user", "one"), textMessage(2, "assistant", "two")];

    expect(reconstructCompactedHistory(rows)).toBe(rows);
  });

  it("drops the replaced prefix, injects the summary, and keeps the tail", () => {
    const rows = [
      textMessage(1, "user", "old"),
      textMessage(2, "assistant", "old response"),
      compactionMarker({
        seq: 3,
        summary: "Earlier context summary.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 2,
        keepRecentTailStartSeq: 3,
      }),
      textMessage(4, "user", "tail"),
    ];

    expect(reconstructCompactedHistory(rows)).toEqual([
      {
        seq: 3,
        role: "user",
        content: { role: "user", content: "[Prior conversation summary]\nEarlier context summary." },
      },
      textMessage(4, "user", "tail"),
    ]);
  });

  it("uses the last marker when multiple markers exist", () => {
    const rows = [
      textMessage(1, "user", "first"),
      compactionMarker({
        seq: 2,
        summary: "First summary.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 1,
        keepRecentTailStartSeq: 2,
      }),
      textMessage(3, "assistant", "middle"),
      compactionMarker({
        seq: 4,
        summary: "Second summary.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 3,
        keepRecentTailStartSeq: 4,
      }),
      textMessage(5, "user", "tail"),
    ];

    expect(reconstructCompactedHistory(rows).map((row) => row.content)).toEqual([
      { role: "user", content: "[Prior conversation summary]\nSecond summary." },
      { role: "user", content: "tail" },
    ]);
  });

  it("emits a placeholder summary message for an empty-summary marker", () => {
    const rows = [
      textMessage(1, "user", "old"),
      compactionMarker({
        seq: 2,
        summary: "",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 1,
        keepRecentTailStartSeq: 2,
      }),
      textMessage(3, "assistant", "tail"),
    ];

    expect(reconstructCompactedHistory(rows)[0]?.content).toEqual({
      role: "user",
      content: `[Prior conversation summary]\n${EMPTY_COMPACTION_SUMMARY_PLACEHOLDER}`,
    });
  });

  it("keeps a tail that starts with an exact tool-call/result pair", () => {
    const rows = [
      textMessage(1, "user", "old"),
      compactionMarker({
        seq: 2,
        summary: "Tool context summary.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 1,
        keepRecentTailStartSeq: 3,
      }),
      toolCallMessage(3),
      toolResultMessage(4),
    ];

    expect(reconstructCompactedHistory(rows).map((row) => row.seq)).toEqual([2, 3, 4]);
  });
});

describe("agent runtime compaction tail boundary", () => {
  it("moves the tail boundary earlier when it would split a tool-call/result pair", () => {
    const boundary = computeAgentRuntimeKeepRecentTailBoundary({
      messages: [
        textMessage(1, "user", "before"),
        toolCallMessage(2),
        toolResultMessage(3),
        textMessage(4, "assistant", "after"),
      ],
      targetTokens: 2,
      estimateTokens: () => 1,
    });

    expect(boundary).toEqual({
      startSeq: 2,
      checkedPairs: [{ toolUseId: "tool-1", toolCallSeq: 2, toolResultSeq: 3, mustKeepTogether: true }],
      splitsToolCallResultPair: false,
    });
  });

  it("prevents dangling tool results through cascading pair checks", () => {
    const boundary = computeAgentRuntimeKeepRecentTailBoundary({
      messages: [
        toolCallMessage(1, "tool-a"),
        toolCallMessage(2, "tool-b"),
        toolResultMessage(3, "tool-a"),
        toolResultMessage(4, "tool-b"),
        textMessage(5, "assistant", "after"),
      ],
      targetTokens: 2,
      estimateTokens: () => 1,
    });

    expect(boundary.startSeq).toBe(1);
    expect(boundary.checkedPairs.map((pair) => pair.toolUseId)).toEqual(["tool-a", "tool-b"]);
    expect(boundary.splitsToolCallResultPair).toBe(false);
  });
});

describe("agent runtime compaction trigger", () => {
  it("includes tool definitions when deciding whether to compact", () => {
    const input = {
      modelId: "claude-sonnet-4-6",
      systemPrompt: "system",
      history: [textMessage(1, "user", "short")],
      currentUserMessage: { role: "user" as const, content: "current" },
      contextWindowTokens: 120,
      thresholdFraction: 0.5,
    };
    const serializableTools = {
      Search: {
        description: "search indexed company knowledge",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search query with enough detail to identify relevant internal context, links, source notes, and references.",
            },
          },
          required: ["query"],
        },
      },
    } as unknown as ToolSet;

    const withoutTools = createAgentRuntimeCompactionTrigger(input);
    const withTools = createAgentRuntimeCompactionTrigger({ ...input, tools: serializableTools });

    expect(withoutTools.behavior).toBe("skip");
    expect(withTools.behavior).toBe("compact");
    expect(withTools.estimatedInputTokens).toBeGreaterThan(withoutTools.estimatedInputTokens);
  });

  it("uses the fixed fallback estimate for zod tool schemas", () => {
    const trigger = createAgentRuntimeCompactionTrigger({
      modelId: "claude-sonnet-4-6",
      systemPrompt: "",
      history: [],
      currentUserMessage: { role: "user", content: "" },
      contextWindowTokens: 400,
      thresholdFraction: 0.75,
      tools: {
        Lookup: tool({
          description: "",
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => query,
        }),
      },
    });

    expect(trigger.estimatedInputTokens).toBeGreaterThanOrEqual(300);
    expect(trigger.behavior).toBe("compact");
  });
});

describe("default agent runtime compaction provider", () => {
  it("skips compaction below the configured threshold", async () => {
    const store = memoryStore([textMessage(1, "user", "short")]);
    const compactor = createDefaultAgentRuntimeCompactionProvider({
      provider: summaryProvider("unused"),
      sessionStore: store,
      systemPrompt: "system",
      currentUserMessage: { role: "user", content: "hello" },
      contextWindowTokens: 10_000,
      thresholdFraction: 0.8,
      estimateTokens: () => 1,
    });

    const result = await compactor.compact({ sessionId: "sess", messages: await store.load("sess") });

    expect(result).toEqual([textMessage(1, "user", "short")]);
    expect(store.appended).toEqual([]);
  });

  it("compacts above the configured threshold and appends exactly one marker row", async () => {
    const store = memoryStore([
      textMessage(1, "user", "old one"),
      textMessage(2, "assistant", "old two"),
      textMessage(3, "user", "recent"),
    ]);
    const compactor = createDefaultAgentRuntimeCompactionProvider({
      provider: summaryProvider("Compacted decisions."),
      sessionStore: store,
      systemPrompt: "system",
      currentUserMessage: { role: "user", content: "hello" },
      contextWindowTokens: 10,
      thresholdFraction: 0.1,
      keepRecentTailFraction: 0.1,
      estimateTokens: () => 1,
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });

    const result = await compactor.compact({ sessionId: "sess", messages: await store.load("sess") });

    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toEqual({
      role: "user",
      content: {
        marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
        version: 1,
        trigger: "auto",
        summary: "Compacted decisions.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 2,
        keepRecentTailStartSeq: 3,
      },
    });
    expect(result.map((row) => row.content)).toEqual([
      { role: "user", content: "[Prior conversation summary]\nCompacted decisions." },
      { role: "user", content: "recent" },
    ]);
  });

  it("persists a marker when the provider returns blank summary text", async () => {
    const store = memoryStore([textMessage(1, "user", "old"), textMessage(2, "assistant", "recent")]);
    const compactor = createDefaultAgentRuntimeCompactionProvider({
      provider: summaryProvider("   "),
      sessionStore: store,
      systemPrompt: "system",
      currentUserMessage: { role: "user", content: "hello" },
      contextWindowTokens: 10,
      thresholdFraction: 0.1,
      keepRecentTailFraction: 0.1,
      estimateTokens: () => 1,
    });

    await expect(compactor.compact({ sessionId: "sess", messages: await store.load("sess") })).resolves.toHaveLength(2);
    expect(store.appended[0]?.content).toMatchObject({ summary: "" });
  });

  it("uses the configured provider model for summarization", async () => {
    const provider = summaryProvider("Provider summary.");
    const model = provider.model as MockLanguageModelV4;
    const store = memoryStore([textMessage(1, "user", "old"), textMessage(2, "assistant", "recent")]);
    const compactor = createDefaultAgentRuntimeCompactionProvider({
      provider,
      sessionStore: store,
      systemPrompt: "system",
      currentUserMessage: { role: "user", content: "hello" },
      contextWindowTokens: 10,
      thresholdFraction: 0.1,
      keepRecentTailFraction: 0.1,
      estimateTokens: () => 1,
    });

    await compactor.compact({ sessionId: "sess", messages: await store.load("sess") });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("old");
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  extractAssistantTextDelta,
  recordSdkAgentOutputToolStarts,
  replaySdkStreamMessages,
} from "./runner";

interface SdkStreamFixture {
  source: string;
  handAuthored: boolean;
  modelId: string;
  thrownError: { name: string; message: string } | null;
  messages: unknown[];
}

async function loadFixture(fileName: string): Promise<SdkStreamFixture> {
  const raw = await readFile(new URL(`./__fixtures__/${fileName}`, import.meta.url), "utf-8");
  return JSON.parse(raw) as SdkStreamFixture;
}

describe("Claude Agent SDK stream fixture mapping", () => {
  it("maps a real Bedrock SDK Write and Read stream to runner callbacks and usage", async () => {
    const fixture = await loadFixture("claude-agent-sdk-tool-stream.json");

    expect(fixture.source).toBe("real_claude_agent_sdk_bedrock");
    expect(fixture.handAuthored).toBe(false);
    expect(fixture.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(fixture.thrownError).toBeNull();
    expect(fixture.messages.map((message) => (message as { type?: string }).type)).toEqual([
      "system",
      "system",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "assistant",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "assistant",
      "stream_event",
      "stream_event",
      "stream_event",
      "user",
      "system",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "assistant",
      "stream_event",
      "stream_event",
      "stream_event",
      "user",
      "system",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "stream_event",
      "assistant",
      "stream_event",
      "stream_event",
      "stream_event",
      "result",
    ]);

    expect(extractAssistantText(fixture.messages[18])).toBe(
      "I'll do both operations simultaneously since the read depends on the write. Let me start with the write first, then read.",
    );
    const firstTextDeltaMessage = fixture.messages.find((message) => extractAssistantTextDelta(message) !== null);
    expect(extractAssistantTextDelta(firstTextDeltaMessage)).toBe("I'll do");

    const replay = replaySdkStreamMessages(fixture.messages);

    expect(replay.sessionIds).toEqual(["<SESSION_ID_1>"]);
    expect(replay.textDeltas).toEqual([
      "I'll do",
      " both",
      " operations",
      " simultaneously",
      " since",
      " the",
      " read",
      " depends",
      " on the write.",
      " Let me start with",
      " the write",
      " first",
      ",",
      " then read.",
      "Read",
      " back",
      ":",
      " fixture",
      "-ok.",
    ]);
    expect(replay.toolStarts).toEqual([
      {
        toolUseId: "<TOOL_USE_ID_1>",
        toolName: "Write",
        skillName: null,
        input: { file_path: "sdk-fixture.txt", content: "fixture-ok" },
        startedAt: 31,
      },
      {
        toolUseId: "<TOOL_USE_ID_2>",
        toolName: "Read",
        skillName: null,
        input: { file_path: "sdk-fixture.txt" },
        startedAt: 44,
      },
    ]);
    expect(replay.toolEnds).toEqual([
      {
        toolUseId: "<TOOL_USE_ID_1>",
        toolName: "Write",
        input: { file_path: "sdk-fixture.txt", content: "fixture-ok" },
        output: "File created successfully at: sdk-fixture.txt",
        isError: false,
        endedAt: 35,
      },
      {
        toolUseId: "<TOOL_USE_ID_2>",
        toolName: "Read",
        input: { file_path: "sdk-fixture.txt" },
        output: "1\tfixture-ok",
        isError: false,
        endedAt: 48,
      },
    ]);
    expect(replay.progressEvents).toEqual([
      {
        kind: "intermediate_text",
        text: "I'll do both operations simultaneously since the read depends on the write. Let me start with the write first, then read.",
      },
      { kind: "tool_use", toolName: "Write", input: { file_path: "sdk-fixture.txt", content: "fixture-ok" } },
      { kind: "tool_use", toolName: "Read", input: { file_path: "sdk-fixture.txt" } },
    ]);
    expect(replay.integrationProgressEvents).toEqual([
      { kind: "tool_use", toolName: "Write", input: { file_path: "sdk-fixture.txt", content: "fixture-ok" } },
      {
        kind: "tool_result",
        toolName: "Write",
        input: { file_path: "sdk-fixture.txt", content: "fixture-ok" },
        output: "File created successfully at: sdk-fixture.txt",
        isError: false,
      },
      { kind: "tool_use", toolName: "Read", input: { file_path: "sdk-fixture.txt" } },
      {
        kind: "tool_result",
        toolName: "Read",
        input: { file_path: "sdk-fixture.txt" },
        output: "1\tfixture-ok",
        isError: false,
      },
    ]);
    expect(replay.finalText).toBe("Read back: fixture-ok.");
    expect(replay.usage).toEqual({
      sessionId: "<SESSION_ID_1>",
      sdkCostUsd: 0.0262869,
      durationApiMs: 10379,
      numTurns: 3,
      stopReason: "end_turn",
      errorSubtype: null,
      inputTokens: 5,
      outputTokens: 169,
      cacheReadTokens: 65553,
      cacheCreationTokens: 728,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: "us.anthropic.claude-sonnet-4-6",
    });
    expect(replay.toolCalls).toEqual([
      { toolName: "Write", skillName: null, startedAt: 31, endedAt: 32, success: true },
      { toolName: "Read", skillName: null, startedAt: 44, endedAt: 45, success: true },
    ]);
  });

  it("maps the real SDK abort stream as partial output with no result usage", async () => {
    const fixture = await loadFixture("claude-agent-sdk-aborted-stream.json");

    expect(fixture.source).toBe("real_claude_agent_sdk_bedrock");
    expect(fixture.handAuthored).toBe(false);
    expect(fixture.thrownError).toEqual({ name: "Error", message: "Claude Code process aborted by user" });
    expect(fixture.messages.map((message) => (message as { type?: string }).type)).toEqual([
      "system",
      "system",
      "stream_event",
    ]);

    const replay = replaySdkStreamMessages(fixture.messages);

    expect(replay.sessionIds).toEqual(["<SESSION_ID_1>"]);
    expect(replay.textDeltas).toEqual([]);
    expect(replay.toolStarts).toEqual([]);
    expect(replay.toolEnds).toEqual([]);
    expect(replay.progressEvents).toEqual([]);
    expect(replay.finalText).toBeNull();
    expect(replay.usage?.stopReason ?? null).toBeNull();
    expect(replay.usage).toBeNull();
    expect(replay.toolCalls).toEqual([]);
  });

  it("attributes Skill tool uses to the invoked skill name", () => {
    const replay = replaySdkStreamMessages([
      { type: "system", subtype: "init", session_id: "<SESSION_ID_1>" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "<TOOL_USE_ID_1>", name: "Skill", input: { skill: "canvas" } }],
        },
      },
    ]);

    expect(replay.toolStarts).toEqual([
      {
        toolUseId: "<TOOL_USE_ID_1>",
        toolName: "Skill",
        skillName: "canvas",
        input: { skill: "canvas" },
        startedAt: 2,
      },
    ]);
    expect(replay.toolCalls).toEqual([{ toolName: "Skill", skillName: "canvas", startedAt: 2, endedAt: 3 }]);
  });

  it("records malformed WriteAgentOutput calls before MCP schema validation", () => {
    const replay = replaySdkStreamMessages([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "<TOOL_USE_ID_1>",
              name: "mcp__sketch__WriteAgentOutput",
              input: {
                outputDate: "2026-07-21",
                timezone: "UTC",
                masthead: { title: "", summary: "Summary" },
                items: [],
              },
            },
          ],
        },
      },
    ]);
    const recordRejectedAttempt = vi.fn();

    recordSdkAgentOutputToolStarts(
      { recordRejectedAttempt, write: vi.fn() },
      replay.toolStarts.map(({ toolName, input }) => ({ toolName, input })),
    );

    expect(recordRejectedAttempt).toHaveBeenCalledOnce();
    expect(recordRejectedAttempt.mock.calls[0]?.[0]).toMatchObject({
      issues: [expect.objectContaining({ path: ["masthead", "title"] })],
    });
  });
});

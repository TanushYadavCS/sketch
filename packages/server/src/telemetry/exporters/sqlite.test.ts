import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { SqliteSpanExporter } from "./sqlite";

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import("../../logger").Logger;
}

function makeMockRepo() {
  return {
    insertRun: vi.fn().mockResolvedValue("run-id"),
    insertToolCalls: vi.fn().mockResolvedValue(undefined),
  };
}

function makeToolEvent(toolName: string, skillName?: string): TimedEvent {
  const attrs: Record<string, unknown> = { "gen_ai.tool.name": toolName };
  if (skillName) attrs["sketch.skill.name"] = skillName;
  return { name: "tool_call", time: [0, 0], attributes: attrs, droppedAttributesCount: 0 } as TimedEvent;
}

function makeAgentRunSpan(overrides?: {
  traceId?: string;
  statusCode?: number;
  attrs?: Record<string, unknown>;
  events?: TimedEvent[];
  duration?: [number, number];
}): ReadableSpan {
  return {
    spanContext: () => ({
      traceId: overrides?.traceId ?? "trace-1",
      spanId: "span-1",
      traceFlags: 1,
    }),
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.response.model": "claude-sonnet-4-20250514",
      "sketch.run_id": "run-1",
      "sketch.platform": "slack",
      "sketch.context_type": "dm",
      "sketch.user_id": "user-1",
      "sketch.cost_usd": 0.005,
      ...overrides?.attrs,
    },
    duration: overrides?.duration ?? [2, 500000000],
    status: { code: overrides?.statusCode ?? 0 },
    events: overrides?.events ?? [],
    name: "invoke_agent sketch",
    kind: 0,
    startTime: [0, 0],
    endTime: [2, 500000000],
    ended: true,
    resource: { attributes: {} },
    instrumentationLibrary: { name: "test" },
    links: [],
    parentSpanId: undefined,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe("SqliteSpanExporter", () => {
  it("persists agent_run span with hot-path columns and attributes JSON", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const code = await new Promise<number>((resolve) => {
      exporter.export([makeAgentRunSpan()], (result) => resolve(result.code));
    });

    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(repo.insertRun).toHaveBeenCalledOnce();
    expect(repo.insertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        trace_id: "trace-1",
        span_id: "span-1",
        platform: "slack",
        context_type: "dm",
        cost_usd: 0.005,
        is_error: 0,
        duration_ms: 2500,
        attributes: expect.any(String),
      }),
    );

    // Verify attributes JSON contains all span attributes
    const callArgs = repo.insertRun.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.attributes);
    expect(parsed["gen_ai.response.model"]).toBe("claude-sonnet-4-20250514");
    expect(parsed["sketch.user_id"]).toBe("user-1");
  });

  it("reads tool calls from span events and calls insertToolCalls", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const span = makeAgentRunSpan({
      attrs: { "sketch.run_id": "run-2" },
      events: [makeToolEvent("Bash"), makeToolEvent("Skill", "canvas"), makeToolEvent("Read")],
    });

    await new Promise<void>((resolve) => {
      exporter.export([span], () => resolve());
    });

    expect(repo.insertRun).toHaveBeenCalledOnce();
    expect(repo.insertToolCalls).toHaveBeenCalledOnce();
    expect(repo.insertToolCalls).toHaveBeenCalledWith([
      expect.objectContaining({ agent_run_id: "run-2", tool_name: "Bash", skill_name: null }),
      expect.objectContaining({ agent_run_id: "run-2", tool_name: "Skill", skill_name: "canvas" }),
      expect.objectContaining({ agent_run_id: "run-2", tool_name: "Read", skill_name: null }),
    ]);
  });

  it("tool_calls include attributes JSON", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const span = makeAgentRunSpan({ events: [makeToolEvent("Skill", "canvas")] });

    await new Promise<void>((resolve) => {
      exporter.export([span], () => resolve());
    });

    const toolCallArgs = repo.insertToolCalls.mock.calls[0][0][0];
    const parsed = JSON.parse(toolCallArgs.attributes);
    expect(parsed["gen_ai.tool.name"]).toBe("Skill");
    expect(parsed["sketch.skill.name"]).toBe("canvas");
  });

  it("span with no tool events skips insertToolCalls", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    await new Promise<void>((resolve) => {
      exporter.export([makeAgentRunSpan({ events: [] })], () => resolve());
    });

    expect(repo.insertRun).toHaveBeenCalledOnce();
    expect(repo.insertToolCalls).not.toHaveBeenCalled();
  });

  it("handles error runs (status.code = 2)", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const span = makeAgentRunSpan({ statusCode: 2, attrs: { "sketch.run_id": "run-err" } });

    await new Promise<void>((resolve) => {
      exporter.export([span], () => resolve());
    });

    expect(repo.insertRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-err", is_error: 1 }));
  });

  it("error run attributes JSON has only params-derived fields", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    // Simulate error path: only params-derived attributes, no result fields
    const span = makeAgentRunSpan({
      statusCode: 2,
      attrs: {
        "sketch.run_id": "run-err-attrs",
        "sketch.platform": "slack",
        "sketch.context_type": "dm",
        "sketch.user_id": "user-1",
        "gen_ai.response.model": undefined, // not set on error
      },
    });

    await new Promise<void>((resolve) => {
      exporter.export([span], () => resolve());
    });

    const callArgs = repo.insertRun.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.attributes);
    expect(parsed["sketch.platform"]).toBe("slack");
    expect(parsed["gen_ai.response.model"]).toBeUndefined();
  });

  it("awaits DB writes before calling resultCallback", async () => {
    const repo = makeMockRepo();
    let insertRunResolved = false;
    repo.insertRun.mockImplementation(() => {
      return new Promise<string>((resolve) => {
        setTimeout(() => {
          insertRunResolved = true;
          resolve("run-id");
        }, 50);
      });
    });

    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const code = await new Promise<number>((resolve) => {
      exporter.export([makeAgentRunSpan()], (result) => resolve(result.code));
    });

    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(insertRunResolved).toBe(true);
  });

  it("reports FAILED when DB write throws", async () => {
    const repo = makeMockRepo();
    const logger = makeLogger();
    repo.insertRun.mockRejectedValueOnce(new Error("DB write failed"));

    const exporter = new SqliteSpanExporter(repo, logger);

    const code = await new Promise<number>((resolve) => {
      exporter.export([makeAgentRunSpan()], (result) => resolve(result.code));
    });

    expect(code).toBe(ExportResultCode.FAILED);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to persist agent run usage",
    );
  });

  it("calculates duration from span HrTime correctly", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const span = makeAgentRunSpan({ duration: [3, 250000000] });

    await new Promise<void>((resolve) => {
      exporter.export([span], () => resolve());
    });

    expect(repo.insertRun).toHaveBeenCalledWith(expect.objectContaining({ duration_ms: 3250 }));
  });

  it("ignores non-invoke_agent spans", async () => {
    const repo = makeMockRepo();
    const exporter = new SqliteSpanExporter(repo, makeLogger());

    const otherSpan = makeAgentRunSpan({ attrs: { "gen_ai.operation.name": "something_else" } });

    const code = await new Promise<number>((resolve) => {
      exporter.export([otherSpan], (result) => resolve(result.code));
    });

    expect(code).toBe(ExportResultCode.SUCCESS);
    expect(repo.insertRun).not.toHaveBeenCalled();
  });
});

import type { Span, Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import type { PricingService } from "../cost/cost-pricing";
import type { Logger } from "../logger";
import { instrumentAgentRun } from "./agent-run-telemetry";

function createTracer(): Tracer {
  const span = {
    setAttribute: vi.fn().mockReturnThis(),
    addEvent: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    end: vi.fn(),
  } as unknown as Span;
  return { startSpan: vi.fn(() => span) } as unknown as Tracer;
}

function createResult(): RunAgentResult {
  return {
    messageSent: false,
    sessionId: "sess",
    costUsd: 0,
    auxCostUsd: 0,
    pendingUploads: [],
    trace: { progressEvents: [], finalText: null, automationArtifacts: [] },
    rawUsage: {
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      durationApiMs: 0,
      numTurns: 0,
      stopReason: "end_turn",
      errorSubtype: null,
      isResumedSession: false,
      totalAttachments: 0,
      imageCount: 0,
      nonImageCount: 0,
      mimeTypes: [],
      fileSizes: [],
      promptMode: "text",
      toolCalls: [],
      auxLlmCalls: [],
      sdkCostUsd: 0,
    },
  } as RunAgentResult;
}

function createParams(logger: Logger, abortController?: AbortController): RunAgentParams {
  return {
    logger,
    workspaceKey: "workspace-1",
    platform: "slack",
    contextType: "scheduled_task",
    abortController,
  } as RunAgentParams;
}

function createPricing(): PricingService {
  return { resolve: vi.fn().mockResolvedValue({ costUsd: 0, costSource: "sdk" }) } as unknown as PricingService;
}

describe("instrumentAgentRun watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs once after the threshold and leaves the run running", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() } as unknown as Logger;
    const controller = new AbortController();
    let finishRun!: (result: RunAgentResult) => void;
    const run = instrumentAgentRun(
      createTracer(),
      createPricing(),
      { provider: "openrouter", modelId: "model" },
      createParams(logger, controller),
      () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
      1_000,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      {
        event: "agent_run_watchdog",
        runId: expect.any(String),
        workspaceKey: "workspace-1",
        platform: "slack",
        contextType: "scheduled_task",
        elapsedMs: 1_000,
      },
      "Agent run watchdog fired",
    );
    expect(controller.signal.aborted).toBe(false);

    finishRun(createResult());
    await expect(run).resolves.toEqual(expect.objectContaining({ costUsd: 0 }));
  });

  it("does not log when the run completes before the threshold", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() } as unknown as Logger;

    await instrumentAgentRun(
      createTracer(),
      createPricing(),
      { provider: "anthropic", modelId: null },
      createParams(logger),
      async () => createResult(),
      1_000,
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the run throws", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() } as unknown as Logger;
    const error = new Error("run failed");

    await expect(
      instrumentAgentRun(
        createTracer(),
        createPricing(),
        { provider: "anthropic", modelId: null },
        createParams(logger),
        async () => {
          throw error;
        },
        1_000,
      ),
    ).rejects.toBe(error);

    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the run aborts", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn() } as unknown as Logger;
    const controller = new AbortController();
    const run = instrumentAgentRun(
      createTracer(),
      createPricing(),
      { provider: "anthropic", modelId: null },
      createParams(logger, controller),
      () =>
        new Promise<RunAgentResult>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("run aborted")), { once: true });
        }),
      1_000,
    );

    controller.abort();
    await expect(run).rejects.toThrow("run aborted");

    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

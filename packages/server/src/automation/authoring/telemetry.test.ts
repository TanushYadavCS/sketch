import { describe, expect, it, vi } from "vitest";
import { createAutomationAuthoringTelemetry } from "./telemetry";

describe("automation authoring telemetry", () => {
  it("records provider, model, attempt, latency, usage, cost, and validation without content", async () => {
    const entries: Record<string, unknown>[] = [];
    const logger = {
      info: vi.fn((fields: Record<string, unknown>) => entries.push(fields)),
      warn: vi.fn(),
    };
    const pricing = {
      resolve: vi.fn().mockResolvedValue({ costUsd: 0.0123, costSource: "openrouter" }),
    };
    const telemetry = createAutomationAuthoringTelemetry({ logger: logger as never, pricing });

    await telemetry.recordAttempt({
      operation: "edit",
      provider: "openrouter",
      configuredModel: "anthropic/claude-sonnet-4.6",
      responseModel: "anthropic/claude-sonnet-4.6",
      attempt: 2,
      latencyMs: 1234,
      totalLatencyMs: 2345,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
      sdkCostUsd: 0,
      validationOutcome: "valid",
      validationIssueCodes: [],
    });

    expect(entries).toEqual([
      {
        operation: "edit",
        provider: "openrouter",
        configuredModel: "anthropic/claude-sonnet-4.6",
        responseModel: "anthropic/claude-sonnet-4.6",
        attempt: 2,
        latencyMs: 1234,
        totalLatencyMs: 2345,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsd: 0.0123,
        costSource: "openrouter",
        validationOutcome: "valid",
        validationIssueCodes: [],
      },
    ]);
    expect(Object.keys(entries[0] ?? {})).not.toEqual(
      expect.arrayContaining(["prompt", "request", "content", "script", "delivery", "credentials"]),
    );
    expect(pricing.resolve).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      sdkCostUsd: 0,
    });
  });

  it("does not fail authoring when cost telemetry cannot be resolved", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const telemetry = createAutomationAuthoringTelemetry({
      logger: logger as never,
      pricing: { resolve: vi.fn().mockRejectedValue(new Error("pricing unavailable")) },
    });

    await expect(
      telemetry.recordAttempt({
        operation: "create",
        provider: "openrouter",
        configuredModel: "anthropic/claude-sonnet-4.6",
        responseModel: null,
        attempt: 1,
        latencyMs: 10,
        totalLatencyMs: 10,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        sdkCostUsd: 0,
        validationOutcome: "provider_error",
        validationIssueCodes: [],
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

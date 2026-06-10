import type { Span, Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import type { RawRunUsage, RunAgentParams, RunAgentResult } from "../agent/runner";
import type { PricingService } from "../cost/cost-pricing";
import { createWorkflowStepRecorder, instrumentAgentRun } from "./agent-run-telemetry";

interface RecordingSpan {
  span: Span;
  attributes: Record<string, unknown>;
  events: { name: string; attrs?: Record<string, unknown> }[];
  status: { code: number } | undefined;
  ended: boolean;
}

function createRecordingSpan(): RecordingSpan {
  const rec: RecordingSpan = { attributes: {}, events: [], status: undefined, ended: false, span: {} as Span };
  rec.span = {
    setAttribute(key: string, value: unknown) {
      rec.attributes[key] = value;
      return rec.span;
    },
    addEvent(name: string, attrs?: Record<string, unknown>) {
      rec.events.push({ name, attrs });
      return rec.span;
    },
    setStatus(status: { code: number }) {
      rec.status = status;
      return rec.span;
    },
    end() {
      rec.ended = true;
    },
    spanContext: () => ({ traceId: "trace", spanId: "span", traceFlags: 1 }),
    isRecording: () => true,
    recordException() {},
    updateName() {
      return rec.span;
    },
    setAttributes() {
      return rec.span;
    },
    addLink() {
      return rec.span;
    },
    addLinks() {
      return rec.span;
    },
  } as unknown as Span;
  return rec;
}

function createFakeTracer(): { tracer: Tracer; spans: RecordingSpan[] } {
  const spans: RecordingSpan[] = [];
  const tracer = {
    startSpan: vi.fn(() => {
      const rec = createRecordingSpan();
      spans.push(rec);
      return rec.span;
    }),
  } as unknown as Tracer;
  return { tracer, spans };
}

const usage: RawRunUsage = {
  model: "xiaomi/mimo-v2.5-pro",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  webSearchRequests: 1,
  webFetchRequests: 2,
  durationApiMs: 900,
  numTurns: 2,
  stopReason: "end_turn",
  errorSubtype: null,
  isResumedSession: false,
  totalAttachments: 0,
  imageCount: 0,
  nonImageCount: 0,
  mimeTypes: [],
  fileSizes: [],
  promptMode: "text",
  toolCalls: [{ toolName: "Bash", skillName: null, startedAt: 1, endedAt: 2 }],
  auxLlmCalls: [],
  sdkCostUsd: 99,
};

const result: RunAgentResult = {
  messageSent: true,
  sessionId: "sess",
  costUsd: 99,
  auxCostUsd: 0,
  pendingUploads: [],
  trace: { progressEvents: [], finalText: "hi" },
  rawUsage: usage,
};

const params = { platform: "slack", workspaceKey: "ws" } as unknown as RunAgentParams;

describe("instrumentAgentRun", () => {
  it("writes the repriced cost to the span and onto the returned result", async () => {
    const { tracer, spans } = createFakeTracer();
    const pricing: PricingService = {
      resolve: vi.fn().mockResolvedValue({ costUsd: 1.23, costSource: "openrouter" }),
    };

    const returned = await instrumentAgentRun(
      tracer,
      pricing,
      { provider: "openrouter", modelId: "xiaomi/mimo-v2.5-pro" },
      params,
      async () => result,
    );

    const parent = spans[0];
    expect(parent.attributes["sketch.cost_usd"]).toBe(1.23);
    expect(parent.attributes.$ai_total_cost_usd).toBe(1.23);
    expect(parent.attributes["sketch.cost_source"]).toBe("openrouter");
    expect(returned.costUsd).toBe(1.23);
    expect(parent.ended).toBe(true);
  });

  it("records aux cost total and breakdown while keeping cost_usd agent-only", async () => {
    const { tracer, spans } = createFakeTracer();
    const pricing: PricingService = {
      resolve: vi.fn().mockResolvedValue({ costUsd: 1.23, costSource: "openrouter" }),
    };
    const auxResult: RunAgentResult = {
      ...result,
      auxCostUsd: 0.05,
      rawUsage: {
        ...usage,
        auxLlmCalls: [
          { op: "transcription", model: "whisper-large-v3-turbo", costUsd: 0.05, seconds: 12, source: "openrouter" },
        ],
      },
    };

    await instrumentAgentRun(tracer, pricing, { provider: "openrouter", modelId: null }, params, async () => auxResult);

    const a = spans[0].attributes;
    expect(a["sketch.cost_usd"]).toBe(1.23);
    expect(a["sketch.aux_cost_usd"]).toBe(0.05);
    expect(JSON.parse(a["sketch.aux_calls"] as string)).toEqual([
      expect.objectContaining({ op: "transcription", costUsd: 0.05 }),
    ]);
  });

  it("omits the aux_calls attribute when there were no aux calls", async () => {
    const { tracer, spans } = createFakeTracer();
    const pricing: PricingService = {
      resolve: vi.fn().mockResolvedValue({ costUsd: 1, costSource: "openrouter" }),
    };

    await instrumentAgentRun(tracer, pricing, { provider: "openrouter", modelId: null }, params, async () => result);

    expect(spans[0].attributes["sketch.aux_cost_usd"]).toBe(0);
    expect(spans[0].attributes["sketch.aux_calls"]).toBeUndefined();
  });

  it("preserves every usage attribute key the exporters depend on", async () => {
    const { tracer, spans } = createFakeTracer();
    const pricing: PricingService = {
      resolve: vi.fn().mockResolvedValue({ costUsd: 1.23, costSource: "openrouter" }),
    };

    await instrumentAgentRun(tracer, pricing, { provider: "openrouter", modelId: null }, params, async () => result);

    const a = spans[0].attributes;
    expect(a["gen_ai.response.model"]).toBe("xiaomi/mimo-v2.5-pro");
    expect(a["gen_ai.usage.input_tokens"]).toBe(100);
    expect(a["gen_ai.usage.output_tokens"]).toBe(50);
    expect(a["gen_ai.usage.cache_read_input_tokens"]).toBe(10);
    expect(a["gen_ai.usage.cache_creation_input_tokens"]).toBe(5);
    expect(a["sketch.web_search_requests"]).toBe(1);
    expect(a["sketch.web_fetch_requests"]).toBe(2);
    expect(a["sketch.message_sent"]).toBe(true);
    expect(a.$ai_tools_called).toEqual(["Bash"]);
    expect(spans[0].events.some((e) => e.name === "tool_call")).toBe(true);
  });

  it("passes the response model to the pricing service, falling back to the configured model id", async () => {
    const { tracer } = createFakeTracer();
    const resolve = vi.fn().mockResolvedValue({ costUsd: 1, costSource: "openrouter" });
    const pricing: PricingService = { resolve };

    await instrumentAgentRun(tracer, pricing, { provider: "openrouter", modelId: "configured" }, params, async () => ({
      ...result,
      rawUsage: { ...usage, model: null },
    }));

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter", model: "configured" }));
  });

  it("prefers the per-run model override over the configured model id when the response model is absent", async () => {
    const { tracer } = createFakeTracer();
    const resolve = vi.fn().mockResolvedValue({ costUsd: 1, costSource: "openrouter" });
    const pricing: PricingService = { resolve };
    const paramsWithOverride = {
      platform: "slack",
      workspaceKey: "ws",
      model: "per-run-slug",
    } as unknown as RunAgentParams;

    await instrumentAgentRun(
      tracer,
      pricing,
      { provider: "openrouter", modelId: "configured" },
      paramsWithOverride,
      async () => ({ ...result, rawUsage: { ...usage, model: null } }),
    );

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter", model: "per-run-slug" }));
  });

  it("marks the span as errored and rethrows when the run fails", async () => {
    const { tracer, spans } = createFakeTracer();
    const pricing: PricingService = { resolve: vi.fn() };
    const boom = new Error("run failed");

    await expect(
      instrumentAgentRun(tracer, pricing, { provider: "anthropic", modelId: null }, params, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(spans[0].status?.code).toBe(2);
    expect(spans[0].ended).toBe(true);
    expect(pricing.resolve).not.toHaveBeenCalled();
  });
});

describe("createWorkflowStepRecorder", () => {
  it("emits a chat span with provider-aware cost for a light workflow step", async () => {
    const { tracer, spans } = createFakeTracer();
    const resolve = vi.fn().mockResolvedValue({ costUsd: 0.7, costSource: "openrouter" });
    const pricing: PricingService = { resolve };

    const record = createWorkflowStepRecorder(tracer, pricing, () => ({
      provider: "openrouter",
      modelId: "configured",
    }));

    await record(
      { platform: "slack", contextType: "scheduled_task", userId: "u1", workspaceKey: "ws" },
      { model: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, sdkCostUsd: 9 },
    );

    const a = spans[0].attributes;
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["sketch.context_type"]).toBe("scheduled_task");
    expect(a["sketch.user_id"]).toBe("u1");
    expect(a["sketch.cost_usd"]).toBe(0.7);
    expect(a.$ai_total_cost_usd).toBe(0.7);
    expect(a["sketch.aux_cost_usd"]).toBe(0);
    expect(a["gen_ai.usage.input_tokens"]).toBe(10);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter", model: "configured", sdkCostUsd: 9 }),
    );
    expect(spans[0].ended).toBe(true);
  });

  it("reads the provider context lazily so settings changes are reflected", async () => {
    const { tracer } = createFakeTracer();
    const resolve = vi.fn().mockResolvedValue({ costUsd: 0, costSource: "sdk" });
    const pricing: PricingService = { resolve };
    let providerCtx = { provider: "anthropic", modelId: null as string | null };

    const record = createWorkflowStepRecorder(tracer, pricing, () => providerCtx);
    providerCtx = { provider: "openrouter", modelId: "xiaomi/mimo-v2.5-pro" };

    await record(
      { platform: "whatsapp", contextType: "scheduled_task", userId: null, workspaceKey: "ws" },
      { model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, sdkCostUsd: 1 },
    );

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter", model: "xiaomi/mimo-v2.5-pro" }),
    );
  });
});

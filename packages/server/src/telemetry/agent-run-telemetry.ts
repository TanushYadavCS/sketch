/**
 * Telemetry boundary for agent runs.
 *
 * Owns the OpenTelemetry span lifecycle for a single agent run and delegates
 * cost resolution to the pricing service, so neither the runner nor bootstrap
 * carries telemetry or pricing concerns. This is the only module that knows
 * both the runner's result shapes and OpenTelemetry.
 *
 * The resolved cost is written to the span (sketch.cost_usd / $ai_total_cost_usd)
 * and attached to the returned business result, so the persisted usage row and
 * the per-run web response share one number and cannot diverge.
 */
import { randomUUID } from "node:crypto";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import type { PricingService } from "../cost/cost-pricing";
import { createToolCallSpans, setAgentResultAttributes, setAgentRunAttributes } from "./instrument";

export interface ProviderContext {
  provider: string | null;
  modelId: string | null;
}

/** Raw usage captured from a light workflow step's SDK result message. */
export interface WorkflowStepUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sdkCostUsd: number;
}

export interface WorkflowStepContext {
  platform: string;
  contextType: string;
  userId: string | null;
  workspaceKey: string;
}

export type RecordWorkflowStep = (ctx: WorkflowStepContext, usage: WorkflowStepUsage) => Promise<void>;

/**
 * Builds the recorder for light workflow agent steps. Those run a raw SDK
 * `query()` outside `runAgent`/`instrumentAgentRun`, so without this their cost
 * would be invisible and (on OpenRouter) mispriced. Emits a `chat` span like the
 * main runner so the step lands in `agent_runs` with a provider-aware cost. The
 * provider context is read lazily so it tracks settings changes after boot.
 */
export function createWorkflowStepRecorder(
  tracer: Tracer,
  pricing: PricingService,
  getProviderCtx: () => ProviderContext,
): RecordWorkflowStep {
  return async (ctx, usage) => {
    const runId = randomUUID();
    const span = tracer.startSpan("chat sketch");
    setAgentRunAttributes(
      span,
      {
        platform: ctx.platform,
        contextType: ctx.contextType,
        currentUserId: ctx.userId,
        workspaceKey: ctx.workspaceKey,
        threadTs: null,
      },
      runId,
    );

    const providerCtx = getProviderCtx();
    const { costUsd, costSource } = await pricing.resolve({
      provider: providerCtx.provider,
      model: usage.model ?? providerCtx.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      sdkCostUsd: usage.sdkCostUsd,
    });

    span.setAttribute("gen_ai.response.model", usage.model ?? "");
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
    span.setAttribute("gen_ai.usage.cache_read_input_tokens", usage.cacheReadTokens);
    span.setAttribute("gen_ai.usage.cache_creation_input_tokens", usage.cacheCreationTokens);
    span.setAttribute("sketch.cost_usd", costUsd);
    span.setAttribute("$ai_total_cost_usd", costUsd);
    span.setAttribute("sketch.cost_source", costSource);
    span.setAttribute("sketch.aux_cost_usd", 0);
    span.end();
  };
}

export async function instrumentAgentRun(
  tracer: Tracer,
  pricing: PricingService,
  providerCtx: ProviderContext,
  params: RunAgentParams,
  exec: () => Promise<RunAgentResult>,
  watchdogMs = 900_000,
): Promise<RunAgentResult> {
  const runId = randomUUID();
  const span = tracer.startSpan("chat sketch");
  setAgentRunAttributes(
    span,
    {
      platform: params.platform,
      contextType: params.contextType,
      currentUserId: params.currentUserId,
      workspaceKey: params.workspaceKey,
      threadTs: params.threadTs,
    },
    runId,
  );
  const startedAt = Date.now();
  const watchdogTimer = setTimeout(() => {
    params.logger.error(
      {
        event: "agent_run_watchdog",
        runId,
        workspaceKey: params.workspaceKey,
        platform: params.platform,
        contextType: params.contextType ?? "unknown",
        elapsedMs: Date.now() - startedAt,
      },
      "Agent run watchdog fired",
    );
  }, watchdogMs);
  watchdogTimer.unref();

  try {
    const result = await exec();
    const usage = result.rawUsage;
    const { costUsd, costSource } = await pricing.resolve({
      provider: providerCtx.provider,
      model: usage.model ?? params.model ?? providerCtx.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      sdkCostUsd: usage.sdkCostUsd,
    });

    setAgentResultAttributes(span, usage, costUsd, costSource, {
      messageSent: result.messageSent,
      sessionId: result.sessionId,
      pendingUploads: result.pendingUploads.length,
      auxCostUsd: result.auxCostUsd,
    });
    createToolCallSpans(tracer, span, runId, usage.toolCalls);
    span.end();

    return { ...result, costUsd };
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    throw err;
  } finally {
    clearTimeout(watchdogTimer);
  }
}

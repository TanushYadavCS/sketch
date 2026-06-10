/**
 * Telemetry instrumentation — maps AgentResult fields to OTel span attributes.
 *
 * Separates telemetry concerns from business logic in bootstrap.ts.
 * Adding a new telemetry field = add one line here + one in runner.ts.
 *
 * Tool calls are recorded in two ways:
 * - Span events on the parent span (consumed by the SQLite exporter)
 * - Child spans with real timestamps (consumed by OTLP/Jaeger for waterfall views)
 *
 * PostHog-specific attributes:
 * - gen_ai.operation.name must be "chat" for PostHog to classify as $ai_generation
 * - posthog.distinct_id maps the span to a PostHog person (used with a server-side
 *   transformation that copies sketch.user_id → distinct_id)
 * - $ai_total_cost_usd overrides PostHog's auto-calculated cost which only prices
 *   input/output tokens and ignores Anthropic cache tokens
 * - $ai_tools_called populates the TOOLS column since PostHog can't auto-extract
 *   tool calls without $ai_output_choices (we don't send response content)
 */
import { type Span, type Tracer, context, trace } from "@opentelemetry/api";
import type { RawRunUsage } from "../agent/runner";
import type { ToolCallRecord } from "../agent/runner";
import type { CostSource } from "../cost/cost-pricing";

/**
 * Routing metadata telemetry records for a run. Deliberately a narrow slice of
 * the runner's input so this mapper never sees the prompt, message content, or
 * attachments — keeping the "never log message content" guarantee structural.
 */
export interface AgentRunContext {
  platform: string;
  contextType?: string | null;
  currentUserId?: string | null;
  workspaceKey: string;
  threadTs?: string | null;
}

export function setAgentRunAttributes(span: Span, ctx: AgentRunContext, runId: string): void {
  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.provider.name", "anthropic");
  span.setAttribute("sketch.run_id", runId);
  span.setAttribute("sketch.platform", ctx.platform);
  span.setAttribute("sketch.context_type", ctx.contextType ?? "dm");
  span.setAttribute("sketch.user_id", ctx.currentUserId ?? "");
  span.setAttribute("posthog.distinct_id", ctx.currentUserId ?? "");
  span.setAttribute("sketch.workspace_key", ctx.workspaceKey);
  span.setAttribute("sketch.thread_key", ctx.threadTs ?? "");
}

/**
 * Maps raw usage onto span attributes. Cost is supplied by the caller (the
 * telemetry boundary, via the pricing service) rather than read off the usage
 * payload, so `sketch.cost_usd`/`$ai_total_cost_usd` carry the provider-aware
 * value. `sketch.cost_source` records how that value was derived.
 *
 * `messageSent` and `pending_uploads` are derived at the boundary from the
 * business result and passed in alongside the usage payload.
 */
export function setAgentResultAttributes(
  span: Span,
  usage: RawRunUsage,
  costUsd: number,
  costSource: CostSource,
  business: { messageSent: boolean; sessionId: string; pendingUploads: number; auxCostUsd: number },
): void {
  span.setAttribute("gen_ai.response.model", usage.model ?? "");
  span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  span.setAttribute("gen_ai.usage.cache_read_input_tokens", usage.cacheReadTokens);
  span.setAttribute("gen_ai.usage.cache_creation_input_tokens", usage.cacheCreationTokens);
  span.setAttribute("gen_ai.response.finish_reasons", [usage.stopReason ?? "unknown"]);
  span.setAttribute("gen_ai.conversation.id", business.sessionId ?? "");
  span.setAttribute("sketch.cost_usd", costUsd);
  span.setAttribute("$ai_total_cost_usd", costUsd);
  span.setAttribute("sketch.cost_source", costSource);
  span.setAttribute("sketch.aux_cost_usd", business.auxCostUsd);
  if (usage.auxLlmCalls.length > 0) {
    span.setAttribute("sketch.aux_calls", JSON.stringify(usage.auxLlmCalls));
  }
  span.setAttribute("sketch.num_turns", usage.numTurns);
  span.setAttribute("sketch.duration_api_ms", usage.durationApiMs);
  span.setAttribute("sketch.error_subtype", usage.errorSubtype ?? "");
  span.setAttribute("sketch.is_resumed_session", usage.isResumedSession);
  span.setAttribute("sketch.message_sent", business.messageSent);
  span.setAttribute("sketch.web_search_requests", usage.webSearchRequests);
  span.setAttribute("sketch.web_fetch_requests", usage.webFetchRequests);
  span.setAttribute("sketch.total_attachments", usage.totalAttachments);
  span.setAttribute("sketch.image_count", usage.imageCount);
  span.setAttribute("sketch.non_image_count", usage.nonImageCount);
  span.setAttribute("sketch.mime_types", JSON.stringify(usage.mimeTypes));
  span.setAttribute("sketch.file_sizes", JSON.stringify(usage.fileSizes));
  span.setAttribute("sketch.prompt_mode", usage.promptMode);
  span.setAttribute("sketch.pending_uploads", business.pendingUploads);

  if (usage.toolCalls.length > 0) {
    span.setAttribute(
      "$ai_tools_called",
      usage.toolCalls.map((tc) => tc.toolName),
    );
  }

  for (const tc of usage.toolCalls) {
    span.addEvent("tool_call", {
      "gen_ai.tool.name": tc.toolName,
      "sketch.skill.name": tc.skillName ?? "",
    });
  }
}

/**
 * Creates child spans for each tool call with real timestamps from the message stream.
 * These appear as nested bars in Jaeger/OTLP waterfall views.
 * The SQLite exporter ignores these (it only handles chat spans).
 */
export function createToolCallSpans(
  tracer: Tracer,
  parentSpan: Span,
  runId: string,
  toolCalls: ToolCallRecord[],
): void {
  const parentCtx = trace.setSpan(context.active(), parentSpan);
  for (const tc of toolCalls) {
    const childSpan = tracer.startSpan(
      tc.skillName ? `tool_call ${tc.toolName} (${tc.skillName})` : `tool_call ${tc.toolName}`,
      { startTime: tc.startedAt },
      parentCtx,
    );
    childSpan.setAttribute("gen_ai.tool.name", tc.toolName);
    childSpan.setAttribute("sketch.skill.name", tc.skillName ?? "");
    childSpan.setAttribute("sketch.run_id", runId);
    childSpan.end(tc.endedAt);
  }
}

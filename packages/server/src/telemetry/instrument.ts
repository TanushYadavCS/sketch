/**
 * Telemetry instrumentation — maps AgentResult fields to OTel span attributes.
 *
 * Separates telemetry concerns from business logic in bootstrap.ts.
 * Adding a new telemetry field = add one line here + one in runner.ts.
 *
 * Tool calls are recorded in two ways:
 * - Span events on the parent span (consumed by the SQLite exporter)
 * - Child spans with real timestamps (consumed by OTLP/Jaeger for waterfall views)
 */
import { type Span, type Tracer, context, trace } from "@opentelemetry/api";
import type { AgentResult } from "../agent/runner";
import type { ToolCallRecord } from "../agent/runner";
import type { RunAgentParams } from "../agent/runner";

export function setAgentRunAttributes(span: Span, params: RunAgentParams, runId: string): void {
  span.setAttribute("gen_ai.operation.name", "invoke_agent");
  span.setAttribute("gen_ai.provider.name", "anthropic");
  span.setAttribute("sketch.run_id", runId);
  span.setAttribute("sketch.platform", params.platform);
  span.setAttribute("sketch.context_type", params.contextType ?? "dm");
  span.setAttribute("sketch.user_id", params.currentUserId ?? "");
  span.setAttribute("sketch.workspace_key", params.workspaceKey);
  span.setAttribute("sketch.thread_key", params.threadTs ?? "");
}

export function setAgentResultAttributes(span: Span, result: AgentResult): void {
  span.setAttribute("gen_ai.response.model", result.model ?? "");
  span.setAttribute("gen_ai.usage.input_tokens", result.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", result.outputTokens);
  span.setAttribute("gen_ai.usage.cache_read_input_tokens", result.cacheReadTokens);
  span.setAttribute("gen_ai.usage.cache_creation_input_tokens", result.cacheCreationTokens);
  span.setAttribute("gen_ai.response.finish_reasons", [result.stopReason ?? "unknown"]);
  span.setAttribute("gen_ai.conversation.id", result.sessionId ?? "");
  span.setAttribute("sketch.cost_usd", result.costUsd);
  span.setAttribute("sketch.num_turns", result.numTurns);
  span.setAttribute("sketch.duration_api_ms", result.durationApiMs);
  span.setAttribute("sketch.error_subtype", result.errorSubtype ?? "");
  span.setAttribute("sketch.is_resumed_session", result.isResumedSession);
  span.setAttribute("sketch.message_sent", result.messageSent);
  span.setAttribute("sketch.web_search_requests", result.webSearchRequests);
  span.setAttribute("sketch.web_fetch_requests", result.webFetchRequests);
  span.setAttribute("sketch.total_attachments", result.totalAttachments);
  span.setAttribute("sketch.image_count", result.imageCount);
  span.setAttribute("sketch.non_image_count", result.nonImageCount);
  span.setAttribute("sketch.mime_types", JSON.stringify(result.mimeTypes));
  span.setAttribute("sketch.file_sizes", JSON.stringify(result.fileSizes));
  span.setAttribute("sketch.prompt_mode", result.promptMode);
  span.setAttribute("sketch.pending_uploads", result.pendingUploads.length);

  // Tool calls as events on the parent span (for the SQLite exporter)
  for (const tc of result.toolCalls) {
    span.addEvent("tool_call", {
      "gen_ai.tool.name": tc.toolName,
      "sketch.skill.name": tc.skillName ?? "",
    });
  }
}

/**
 * Creates child spans for each tool call with real timestamps from the message stream.
 * These appear as nested bars in Jaeger/OTLP waterfall views.
 * The SQLite exporter ignores these (it only handles invoke_agent spans).
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

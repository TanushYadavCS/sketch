/**
 * SqliteSpanExporter — persists OTel spans to SQLite via the agent-runs repository.
 *
 * Hot-path columns (user_id, platform, context_type, cost_usd, is_error, duration_ms)
 * are extracted to indexed columns. Everything else lives in the `attributes` JSON blob.
 * Tool calls are read from span events (not child spans).
 *
 * IMPORTANT: export() awaits all DB writes before calling resultCallback, so that
 * BatchSpanProcessor.shutdown() correctly waits for pending writes to complete
 * before the DB connection is destroyed.
 */
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { createAgentRunsRepo } from "../../db/repositories/agent-runs";
import type { Logger } from "../../logger";

export class SqliteSpanExporter implements SpanExporter {
  private repo: ReturnType<typeof createAgentRunsRepo>;
  private logger: Logger;

  constructor(repo: ReturnType<typeof createAgentRunsRepo>, logger: Logger) {
    this.repo = repo;
    this.logger = logger;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const writePromises: Promise<void>[] = [];

    for (const span of spans) {
      if (span.attributes["gen_ai.operation.name"] === "invoke_agent") {
        writePromises.push(this.persistRun(span));
      }
    }

    if (writePromises.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
    } else {
      Promise.all(writePromises)
        .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
        .catch(() => resultCallback({ code: ExportResultCode.FAILED }));
    }
  }

  async shutdown(): Promise<void> {}

  private async persistRun(span: ReadableSpan): Promise<void> {
    const a = span.attributes;
    const runId = a["sketch.run_id"] as string;
    const durationMs = Math.round(span.duration[0] * 1000 + span.duration[1] / 1e6);

    try {
      await this.repo.insertRun({
        id: runId,
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        user_id: (a["sketch.user_id"] as string) || null,
        platform: a["sketch.platform"] as string,
        context_type: a["sketch.context_type"] as string,
        cost_usd: (a["sketch.cost_usd"] as number) ?? 0,
        is_error: span.status.code === 2 ? 1 : 0,
        duration_ms: durationMs,
        attributes: JSON.stringify(a),
      });

      const toolEvents = span.events.filter((e) => e.name === "tool_call");
      if (toolEvents.length > 0) {
        await this.repo.insertToolCalls(
          toolEvents.map((e) => ({
            agent_run_id: runId,
            tool_name: (e.attributes?.["gen_ai.tool.name"] as string) ?? "unknown",
            skill_name: (e.attributes?.["sketch.skill.name"] as string) || null,
            attributes: JSON.stringify(e.attributes ?? {}),
          })),
        );
      }

      this.logger.debug({ runId, toolCallCount: toolEvents.length }, "Telemetry: persisted agent_run");
    } catch (err) {
      this.logger.error({ err }, "Failed to persist agent run usage");
      throw err;
    }
  }
}

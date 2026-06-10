/**
 * OpenTelemetry initialization for Sketch.
 *
 * Creates a TracerProvider with BatchSpanProcessor and the SqliteSpanExporter.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, adds an OTLP exporter for external
 * backends (Jaeger, Grafana, Datadog, etc.) — zero changes to instrumentation code.
 * When POSTHOG_API_KEY is set, adds a PostHog exporter for LLM Analytics.
 */
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { PostHogTraceExporter } from "@posthog/ai/otel";
import type { Config } from "../config";
import type { createAgentRunsRepo } from "../db/repositories/agent-runs";
import type { Logger } from "../logger";
import { SqliteSpanExporter } from "./exporters/sqlite";

export function initTelemetry(repo: ReturnType<typeof createAgentRunsRepo>, logger: Logger, config: Config) {
  const sqliteExporter = new SqliteSpanExporter(repo, logger);
  const processors = [new BatchSpanProcessor(sqliteExporter)];
  const exporters = ["sqlite"];

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    const otlpExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
    processors.push(new BatchSpanProcessor(otlpExporter));
    exporters.push(`otlp(${otlpEndpoint})`);
  }

  if (config.POSTHOG_API_KEY) {
    const posthogExporter = new PostHogTraceExporter({
      apiKey: config.POSTHOG_API_KEY,
      host: config.POSTHOG_HOST,
    });
    processors.push(new BatchSpanProcessor(posthogExporter));
    exporters.push(`posthog(${config.POSTHOG_HOST})`);
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "sketch" }),
    spanProcessors: processors,
  });
  provider.register();

  logger.info({ exporters }, "Telemetry initialized (OpenTelemetry)");

  return {
    tracer: trace.getTracer("sketch"),
    shutdown: () => provider.shutdown(),
  };
}

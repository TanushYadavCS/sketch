import type { PricingService } from "../../cost/cost-pricing";
import type { Logger } from "../../logger";

export type AutomationAuthoringOperation = "create" | "edit";
export type AutomationAuthoringValidationOutcome = "valid" | "invalid" | "clarification" | "provider_error" | "timeout";

export interface AutomationAuthoringUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AutomationAuthoringAttemptTelemetry {
  operation: AutomationAuthoringOperation;
  provider: "openrouter";
  configuredModel: string;
  responseModel: string | null;
  attempt: number;
  latencyMs: number;
  totalLatencyMs: number;
  usage: AutomationAuthoringUsage;
  sdkCostUsd: number;
  validationOutcome: AutomationAuthoringValidationOutcome;
  validationIssueCodes: string[];
}

export interface AutomationAuthoringTelemetry {
  recordAttempt(event: AutomationAuthoringAttemptTelemetry): Promise<void>;
}

export function createAutomationAuthoringTelemetry(params: {
  logger: Pick<Logger, "info" | "warn">;
  pricing: PricingService;
}): AutomationAuthoringTelemetry {
  return {
    async recordAttempt(event) {
      try {
        const { costUsd, costSource } = await params.pricing.resolve({
          provider: event.provider,
          model: event.responseModel ?? event.configuredModel,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
          cacheCreationTokens: event.usage.cacheWriteTokens,
          sdkCostUsd: event.sdkCostUsd,
        });
        params.logger.info(
          {
            operation: event.operation,
            provider: event.provider,
            configuredModel: event.configuredModel,
            responseModel: event.responseModel,
            attempt: event.attempt,
            latencyMs: event.latencyMs,
            totalLatencyMs: event.totalLatencyMs,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
            cacheWriteTokens: event.usage.cacheWriteTokens,
            costUsd,
            costSource,
            validationOutcome: event.validationOutcome,
            validationIssueCodes: event.validationIssueCodes,
          },
          "Automation authoring generation completed",
        );
      } catch (error) {
        params.logger.warn(
          {
            err: error,
            operation: event.operation,
            provider: event.provider,
            configuredModel: event.configuredModel,
            responseModel: event.responseModel,
            attempt: event.attempt,
            latencyMs: event.latencyMs,
            totalLatencyMs: event.totalLatencyMs,
            validationOutcome: event.validationOutcome,
            validationIssueCodes: event.validationIssueCodes,
          },
          "Failed to record automation authoring cost telemetry",
        );
      }
    },
  };
}

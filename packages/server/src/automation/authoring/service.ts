import type {
  AutomationBuilderSaveRequest,
  AutomationDefinition,
  AutomationExecutionMode,
  WorkflowStep,
  WorkflowTriggerConfig,
} from "@sketch/shared";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { CurrentAutomation } from "../../scheduler/types";
import { AutomationValidationError, validateAutomationBuilderSaveRequest } from "../definition";
import {
  type AutomationAuthoringOutput,
  automationAuthoringOutputSchema,
  automationAuthoringTransportSchema,
  toAutomationBuilderSaveRequest,
} from "./schema";
import type {
  AutomationAuthoringOperation,
  AutomationAuthoringTelemetry,
  AutomationAuthoringUsage,
  AutomationAuthoringValidationOutcome,
} from "./telemetry";

const MAX_GENERATION_ATTEMPTS = 3;
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 8192;

export const AUTOMATION_AUTHORING_TRIGGER_TYPES = [
  "schedule",
  "webhook",
  "slack_channel_message",
] as const satisfies readonly WorkflowTriggerConfig["type"][];

export interface AutomationAuthoringProvider {
  provider: "openrouter";
  modelId: string;
  model: LanguageModel;
}

export interface StructuredAutomationAuthoringGeneration {
  output: unknown;
  model: string;
  usage: AutomationAuthoringUsage;
  sdkCostUsd: number;
}

export interface StructuredAutomationAuthoringGenerator {
  generate(params: {
    operation: AutomationAuthoringOperation;
    provider: AutomationAuthoringProvider;
    instructions: string;
    prompt: string;
    outputSchema: typeof automationAuthoringTransportSchema;
    attempt: number;
    maxRetries: 0;
    timeoutMs: number;
    maxOutputTokens: number;
  }): Promise<StructuredAutomationAuthoringGeneration>;
}

export class AutomationAuthoringGeneratedOutputError extends Error {
  readonly generation?: StructuredAutomationAuthoringGeneration;

  constructor(
    message = "The authoring model did not return schema-valid structured output",
    generation?: StructuredAutomationAuthoringGeneration,
  ) {
    super(message);
    this.name = "AutomationAuthoringGeneratedOutputError";
    this.generation = generation;
  }
}

export class AutomationAuthoringValidationError extends Error {
  constructor(cause: z.ZodError | AutomationValidationError | AutomationAuthoringGeneratedOutputError) {
    super("Automation authoring did not produce a valid definition", { cause });
    this.name = "AutomationAuthoringValidationError";
  }
}

export class AutomationAuthoringTimeoutError extends Error {
  constructor() {
    super("Automation authoring exceeded its time limit");
    this.name = "AutomationAuthoringTimeoutError";
  }
}

export interface AutomationAuthoringServerContext {
  taskId: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryDefaults: {
    platform: "slack" | "whatsapp";
    targetType: "dm" | "channel" | "group";
    targetId: string;
    threadTs: null;
    mode: "deliver";
  };
  timezone: string;
  currentTime: string;
}

export type AutomationAuthoringResult =
  | { kind: "clarification"; question: string }
  | { kind: "definition"; definition: AutomationBuilderSaveRequest };

export interface AutomationAuthoringService {
  create(input: {
    request: string;
    serverContext: AutomationAuthoringServerContext;
    brokerCapable: boolean;
  }): Promise<AutomationAuthoringResult>;
  edit(input: {
    request: string;
    existing: AutomationDefinition;
    brokerCapable: boolean;
    currentAutomation?: CurrentAutomation;
    expectedRevision?: number;
    timezone?: string;
    currentTime?: string;
  }): Promise<AutomationAuthoringResult>;
}

function validationSummary(error: z.ZodError | AutomationValidationError | AutomationAuthoringGeneratedOutputError) {
  if (error instanceof AutomationValidationError) {
    return error.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
  }
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`).join("; ");
  }
  return error.message;
}

function isValidationFailure(
  error: unknown,
): error is z.ZodError | AutomationValidationError | AutomationAuthoringGeneratedOutputError {
  return (
    error instanceof z.ZodError ||
    error instanceof AutomationValidationError ||
    error instanceof AutomationAuthoringGeneratedOutputError
  );
}

function isTimeoutFailure(error: unknown): boolean {
  return (
    error instanceof AutomationAuthoringTimeoutError ||
    (error instanceof Error &&
      (error.name.toLowerCase().includes("timeout") ||
        error.name.toLowerCase().includes("abort") ||
        error.message.toLowerCase().includes("timed out")))
  );
}

function isRetryableProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "AutomationAuthoringTimeoutError") return false;
  const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  if (error.name === "APICallError") return true;
  return /(?:fetch|network|socket|connection|reset|temporarily unavailable)/i.test(error.message);
}

function triggerIntentClarification(request: string): string | undefined {
  const normalized = request.toLowerCase();
  const mentionsEventSource = /\b(?:gmail|email|emails|inbox|outlook|slack|linear|clickup|notion)\b/.test(normalized);
  const mentionsEventObject =
    /\b(?:invoice|invoices|email|emails|message|messages|attachment|attachments|issue|issues)\b/.test(normalized);
  if (!mentionsEventSource || !mentionsEventObject) return undefined;

  const explicitlyPolling =
    /\b(?:poll(?:ing)?|schedule(?:d)?|cron|interval|daily|hourly|weekly)\b/.test(normalized) ||
    /\bevery\s+(?:\d+|one|two|three|four|five|ten|fifteen|thirty|few)\s+(?:second|seconds|minute|minutes|hour|hours|day|days)\b/.test(
      normalized,
    );
  if (explicitlyPolling) return undefined;

  const explicitlyTriggered =
    /\b(?:trigger|event|when(?:ever)?|as soon as|incoming)\b/.test(normalized) ||
    /\bnew\s+(?:invoice|invoices|email|emails|message|messages|attachment|attachments|issue|issues)\b/.test(normalized);
  if (!explicitlyTriggered) {
    return "Should this use polling on a schedule (for example, every five minutes) or a native event trigger?";
  }

  if (/\bslack\s+channel\b/.test(normalized) || /\bwebhook\b/.test(normalized)) return undefined;
  const source = normalized.match(/\b(?:gmail|outlook|linear|clickup|notion)\b/)?.[0] ?? "that app";
  return `${source[0].toUpperCase()}${source.slice(1)} event triggers are not available in this authoring path. Should I poll it on a schedule instead?`;
}

function authoringInstructions(
  operation: AutomationAuthoringOperation,
  supportedTriggerTypes: readonly WorkflowTriggerConfig["type"][],
): string {
  return `You design Sketch automations. Return a complete ${operation === "create" ? "new" : "replacement"} definition or one concise clarification question only when essential information is missing. Preserve every unspecified property and every stable step ID during edits. Do not invent operational status. Every complete definition includes executionMode: deterministic for a fixed recipe with no agent steps, hybrid for a recipe plus bounded AI steps, or agent-led for AI-led work with no code or action steps. Treat the mode as a user-visible recommendation: preserve an explicit mode request, otherwise choose the mode suggested by the generated step mix; never override a valid user-selected mode just because it is not the recommendation. Keep the returned top-level schedule fields identical to the returned trigger step configuration. Every non-trigger step needs matching step content, and the graph must be connected and acyclic. For edits, the existingDefinition and its persisted revision are authoritative; currentAutomation is alignment metadata only, and neither prompt history nor an older builder snapshot may override the reloaded definition. The current authoring capability set supports only these trigger types: ${supportedTriggerTypes.join(", ")}. Treat that list as authoritative. Never emit a Canvas-managed app trigger, invent a provider app, or invent a component key; an app event without an admitted capability must become a clarification question or be rejected. GitHub work must use a full Sketch agent step with agentMode: "sketch" and agentSkills: ["github"], never ctx.integrations.executeAction or a deterministic action step. If the request does not explicitly choose polling/cadence versus an event trigger, ask which one it means instead of guessing. Action steps may use creator-scoped, read-only Sketch capabilities. When an action needs internal search or teammate lookup, set actionCapabilities to { sketchTools: ["search", "searchEntities", "getEntityContext", or "findTeammate"], usesIntegrationActions: false } and call the corresponding ctx.tools method directly. The only valid Sketch capability namespace is ctx.tools; ctx.sketch and ctx.sketchTools are invalid, and do not shell out to a CLI or call MCP. Declare every ctx.tools capability used by a script in that action's actionCapabilities.sketchTools. When an action calls ctx.integrations.executeAction, set usesIntegrationActions to true; legacy action steps without actionCapabilities are integration-backed. Sketch-only actions do not require a Canvas broker. For Slack or WhatsApp message deliveries, the terminal step must return only a concise, human-readable message string. A terminal action script must return the message itself, for example return "Reminder: message Vedant on Slack."; never return { message: "..." }. Intermediate steps may pass structured JSON, but the delivered step must not return an object or array, JSON.stringify output, code-fenced JSON, raw tool payloads, schema fields, debug output, or stack traces. Use short headings and bullet lists, write links in the target platform's native format, and state plainly when no matching data exists. For requests to run when a message is posted in a Slack channel, use the native Slack channel message trigger: set the trigger config type to "slack_channel_message", include the stable Slack channel ID in channelId, set scheduleType to "external" and scheduleValue to "slack_channel_message", and pass the message text and attachments through trigger data to the workflow. Trigger files can include a server-authenticated localPath inside the automation workspace. When an integration action needs those bytes, call ctx.integrations.executeAction with localFiles entries containing path and configuredProp; do not read or base64-encode the file in a script, put file bytes in CLI arguments, or fetch Slack urlPrivate without authentication. Do not implement this as polling or a scheduled Slack history check. Use the automation's native delivery configuration for the reply rather than adding a Slack send-message action solely for delivery.`;
}

function createPrompt(input: {
  request: string;
  serverContext: AutomationAuthoringServerContext;
  brokerCapable: boolean;
  supportedTriggerTypes: readonly WorkflowTriggerConfig["type"][];
  repair?: string;
  priorDraft?: unknown;
}): string {
  return JSON.stringify({
    operation: "create",
    request: input.request,
    serverContext: input.serverContext,
    brokerCapable: input.brokerCapable,
    supportedTriggerTypes: input.supportedTriggerTypes,
    ...(input.priorDraft !== undefined ? { priorDraft: input.priorDraft } : {}),
    ...(input.repair ? { priorValidationFailure: input.repair } : {}),
  });
}

function editPrompt(input: {
  request: string;
  existing: AutomationDefinition;
  brokerCapable: boolean;
  currentAutomation?: CurrentAutomation;
  timezone?: string;
  currentTime?: string;
  supportedTriggerTypes: readonly WorkflowTriggerConfig["type"][];
  repair?: string;
  priorDraft?: unknown;
}): string {
  return JSON.stringify({
    operation: "edit",
    requestedChange: input.request,
    existingDefinition: input.existing,
    brokerCapable: input.brokerCapable,
    ...(input.currentAutomation ? { currentAutomation: input.currentAutomation } : {}),
    serverContext: {
      taskId: input.existing.id,
      persistedRevision: input.existing.revision,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.currentTime ? { currentTime: input.currentTime } : {}),
    },
    supportedTriggerTypes: input.supportedTriggerTypes,
    ...(input.priorDraft !== undefined ? { priorDraft: input.priorDraft } : {}),
    ...(input.repair ? { priorValidationFailure: input.repair } : {}),
  });
}

function preserveExistingAgentModels(
  steps: AutomationBuilderSaveRequest["steps"],
  existing: AutomationDefinition | undefined,
): WorkflowStep[] {
  if (!existing) return steps;
  const models = new Map(
    existing.steps.flatMap((step) => (step.agentModel ? [[step.id, step.agentModel] as const] : [])),
  );
  const generatedStepIds = new Set(steps.map((step) => step.id));
  const missingPinnedStepIds = [...models.keys()].filter((stepId) => !generatedStepIds.has(stepId));
  if (missingPinnedStepIds.length > 0) {
    throw new AutomationValidationError(
      missingPinnedStepIds.map((stepId) => ({
        code: "PINNED_STEP_ID_REQUIRED",
        path: `steps.${stepId}`,
        message: `Step ${stepId} has an explicit execution model and must retain its stable ID during chat editing`,
      })),
    );
  }
  return steps.map((step) => {
    const agentModel = models.get(step.id);
    return agentModel ? { ...step, agentModel } : step;
  });
}

function explicitlyRequestedExecutionMode(request: string): AutomationExecutionMode | undefined {
  const normalized = request.toLocaleLowerCase();
  if (/\b(?:fixed recipe|deterministic|fixed)\b/.test(normalized)) return "deterministic";
  if (/\b(?:agent[- ]led|ai[- ]led|ai[- ]only)\b/.test(normalized)) return "agent-led";
  if (/\bhybrid\b/.test(normalized)) return "hybrid";
  return undefined;
}

function preserveExistingExecutionMode(
  definition: AutomationBuilderSaveRequest,
  existing: AutomationDefinition | undefined,
  request: string,
): AutomationBuilderSaveRequest {
  if (!existing || explicitlyRequestedExecutionMode(request) !== undefined) return definition;
  return { ...definition, executionMode: existing.executionMode };
}

function emptyUsage(): AutomationAuthoringUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function createAutomationAuthoringService(deps: {
  loadProvider: () => Promise<AutomationAuthoringProvider>;
  generator: StructuredAutomationAuthoringGenerator;
  telemetry: AutomationAuthoringTelemetry;
  configuredModelId: string;
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][];
  now?: () => number;
}): AutomationAuthoringService {
  const now = deps.now ?? Date.now;
  const supportedTriggerTypes = deps.supportedTriggerTypes ?? AUTOMATION_AUTHORING_TRIGGER_TYPES;

  async function author(params: {
    operation: AutomationAuthoringOperation;
    request: string;
    taskId: string;
    expectedRevision?: number;
    existing?: AutomationDefinition;
    serverContext?: AutomationAuthoringServerContext;
    currentAutomation?: CurrentAutomation;
    timezone?: string;
    currentTime?: string;
    brokerCapable: boolean;
  }): Promise<AutomationAuthoringResult> {
    const operationStartedAt = now();
    const clarification = triggerIntentClarification(params.request);
    if (clarification) {
      await deps.telemetry.recordAttempt({
        operation: params.operation,
        provider: "openrouter",
        configuredModel: deps.configuredModelId,
        responseModel: null,
        attempt: 1,
        latencyMs: Math.max(0, now() - operationStartedAt),
        totalLatencyMs: Math.max(0, now() - operationStartedAt),
        usage: emptyUsage(),
        sdkCostUsd: 0,
        validationOutcome: "clarification",
        validationIssueCodes: ["TRIGGER_INTENT"],
      });
      return { kind: "clarification", question: clarification };
    }
    let provider: AutomationAuthoringProvider;
    try {
      provider = await deps.loadProvider();
    } catch (error) {
      await deps.telemetry.recordAttempt({
        operation: params.operation,
        provider: "openrouter",
        configuredModel: deps.configuredModelId,
        responseModel: null,
        attempt: 1,
        latencyMs: Math.max(0, now() - operationStartedAt),
        totalLatencyMs: Math.max(0, now() - operationStartedAt),
        usage: emptyUsage(),
        sdkCostUsd: 0,
        validationOutcome: "provider_error",
        validationIssueCodes: [],
      });
      throw error;
    }
    let repair: string | undefined;
    let priorDraft: unknown;
    let finalValidationError:
      | z.ZodError
      | AutomationValidationError
      | AutomationAuthoringGeneratedOutputError
      | undefined;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const startedAt = now();
      const remainingMs = GENERATION_TIMEOUT_MS - Math.max(0, startedAt - operationStartedAt);
      if (remainingMs <= 0) {
        await deps.telemetry.recordAttempt({
          operation: params.operation,
          provider: "openrouter",
          configuredModel: provider.modelId,
          responseModel: null,
          attempt,
          latencyMs: 0,
          totalLatencyMs: Math.max(0, startedAt - operationStartedAt),
          usage: emptyUsage(),
          sdkCostUsd: 0,
          validationOutcome: "timeout",
          validationIssueCodes: [],
        });
        throw new AutomationAuthoringTimeoutError();
      }
      let generation: StructuredAutomationAuthoringGeneration | undefined;
      let validationOutcome: AutomationAuthoringValidationOutcome = "provider_error";
      let validationIssueCodes: string[] = [];
      try {
        generation = await deps.generator.generate({
          operation: params.operation,
          provider,
          instructions: authoringInstructions(params.operation, supportedTriggerTypes),
          prompt:
            params.operation === "create"
              ? createPrompt({
                  request: params.request,
                  serverContext: params.serverContext as AutomationAuthoringServerContext,
                  brokerCapable: params.brokerCapable,
                  supportedTriggerTypes,
                  repair,
                  priorDraft,
                })
              : editPrompt({
                  request: params.request,
                  existing: params.existing as AutomationDefinition,
                  brokerCapable: params.brokerCapable,
                  currentAutomation: params.currentAutomation,
                  timezone: params.timezone,
                  currentTime: params.currentTime,
                  supportedTriggerTypes,
                  repair,
                  priorDraft,
                }),
          outputSchema: automationAuthoringTransportSchema,
          attempt,
          maxRetries: 0,
          timeoutMs: remainingMs,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        const output: AutomationAuthoringOutput = automationAuthoringOutputSchema.parse(generation.output);
        if (output.kind === "clarification") {
          validationOutcome = "clarification";
          return { kind: "clarification", question: output.question };
        }

        const definition = toAutomationBuilderSaveRequest(output.definition, {
          taskId: params.taskId,
          status: params.existing?.status ?? "active",
          expectedRevision: params.expectedRevision,
        });
        const definitionWithPinnedModels = {
          ...definition,
          steps: preserveExistingAgentModels(definition.steps, params.existing),
        };
        const finalDefinition = preserveExistingExecutionMode(
          definitionWithPinnedModels,
          params.existing,
          params.request,
        );
        validateAutomationBuilderSaveRequest({
          request: finalDefinition,
          brokerCapable: params.brokerCapable,
          supportedTriggerTypes,
        });
        validationOutcome = "valid";
        return { kind: "definition", definition: finalDefinition };
      } catch (error) {
        if (error instanceof AutomationAuthoringGeneratedOutputError && error.generation) {
          generation = error.generation;
        }
        if (isTimeoutFailure(error)) {
          validationOutcome = "timeout";
          throw new AutomationAuthoringTimeoutError();
        }
        if (!isValidationFailure(error)) {
          validationOutcome = "provider_error";
          if (attempt < MAX_GENERATION_ATTEMPTS && isRetryableProviderFailure(error)) continue;
          throw error;
        }
        validationOutcome = "invalid";
        validationIssueCodes =
          error instanceof AutomationValidationError
            ? error.issues.map((issue) => issue.code)
            : error instanceof z.ZodError
              ? ["STRUCTURED_OUTPUT_SCHEMA"]
              : ["STRUCTURED_OUTPUT_PARSE"];
        finalValidationError = error;
        repair = validationSummary(error);
        priorDraft = generation?.output;
        if (attempt === MAX_GENERATION_ATTEMPTS) {
          throw new AutomationAuthoringValidationError(error);
        }
      } finally {
        await deps.telemetry.recordAttempt({
          operation: params.operation,
          provider: "openrouter",
          configuredModel: provider.modelId,
          responseModel: generation?.model ?? null,
          attempt,
          latencyMs: Math.max(0, now() - startedAt),
          totalLatencyMs: Math.max(0, now() - operationStartedAt),
          usage: generation?.usage ?? emptyUsage(),
          sdkCostUsd: generation?.sdkCostUsd ?? 0,
          validationOutcome,
          validationIssueCodes,
        });
      }
    }

    throw new AutomationAuthoringValidationError(finalValidationError ?? new AutomationAuthoringGeneratedOutputError());
  }

  return {
    create(input) {
      return author({
        operation: "create",
        request: input.request,
        taskId: input.serverContext.taskId,
        serverContext: input.serverContext,
        brokerCapable: input.brokerCapable,
      });
    },
    edit(input) {
      return author({
        operation: "edit",
        request: input.request,
        taskId: input.existing.id,
        expectedRevision: input.expectedRevision ?? input.existing.revision,
        existing: input.existing,
        currentAutomation: input.currentAutomation,
        timezone: input.timezone,
        currentTime: input.currentTime,
        brokerCapable: input.brokerCapable,
      });
    },
  };
}

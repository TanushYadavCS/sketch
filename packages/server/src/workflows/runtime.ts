/**
 * Unified automation runtime.
 *
 * Every automation (simple or multi-step) is executed through this single code path.
 * The scheduler calls executeAutomation() for all tasks — no branching.
 *
 * Steps are executed in array order (edges are metadata for the UI, ignored in Phase 1).
 * Step content (prompts, scripts) is loaded from automation_step_content at execution time.
 * Credentials are resolved at execution time via loadIntegrationProvider (org-level) +
 * creator's email (user scoping).
 */
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  type AutomationExecutionMode,
  type AutomationRunMode,
  type AutomationSketchToolName,
  automationExecutionModeAllowsStep,
  automationExecutionModeSchema,
  cliIntegrationAppDefinition,
  cliIntegrationAppDefinitions,
  cliSkillRequiredEnv,
  workflowEdgeSchema,
  workflowStepSchema,
  workflowStepUsesIntegrationActions,
} from "@sketch/shared";
import type { Kysely } from "kysely";
import { createChildAbortController } from "../agent/active-runs";
import { removeReservedAgentEnv } from "../agent/environment";
import { buildAutomationMessageDeliveryLines, buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, RunAgentParams, runAgent } from "../agent/runner";
import type { AgentRuntimeProviderFactoryConfig } from "../agent/runtime/contracts";
import { runAgentRuntimeCore } from "../agent/runtime/core";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "../agent/runtime/path-guard";
import { createAgentRuntimeProvider } from "../agent/runtime/provider";
import { createAgentRuntimeWorkspaceTools } from "../agent/runtime/workspace-tools";
import { hasInvalidAutomationSketchToolNamespace, undeclaredAutomationSketchTools } from "../automation/action-script";
import {
  type AutomationCapabilityCallEvent,
  type AutomationCapabilityRegistry,
  type AutomationSketchTools,
  MAX_AUTOMATION_OUTPUT_BYTES,
  createAutomationCapabilityRegistry,
} from "../automation/capabilities";
import {
  AutomationValidationError,
  type ValidatedPersistedAutomationDefinition,
  validatePersistedAutomationDefinition,
} from "../automation/definition";
import type { AgentEnvironmentRuntimeContext } from "../db/repositories/agent-environment-variables";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { StepContentRow, createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { cleanupIntegrationAccess, startIntegrationAccess } from "../integrations/wrapper";
import type { Logger } from "../logger";
import type { RecordWorkflowStep, WorkflowStepUsage } from "../telemetry/agent-run-telemetry";
import { formatWorkflowMessageText, resolveWorkflowDelivery } from "./delivery";
import type { StepOutput, WorkflowEdge, WorkflowStep } from "./types";

export type { AutomationRunMode } from "@sketch/shared";

export interface ExecuteAutomationParams {
  task: ScheduledTaskRow;
  runId?: string;
  runMode?: AutomationRunMode;
  triggerData?: unknown;
  db: Kysely<DB>;
  logger: Logger;
  config: {
    DATA_DIR: string;
    BASE_URL?: string;
    PORT: number;
    CLAUDE_CONFIG_DIR: string;
    AGENT_RUNTIME?: "sdk" | "aisdk";
  };
  runsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  cliIntegrations?: RunAgentParams["cliIntegrations"];
  userRepo: NonNullable<RunAgentParams["userRepo"]>;
  runAgent?: typeof runAgent;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  getSlack?: RunAgentParams["getSlack"];
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: RunAgentParams["sendDm"];
  sendTargetMessage?: RunAgentParams["sendTargetMessage"];
  sendMessage?: (text: string) => Promise<void>;
  onEvent?: (event: AutomationExecutionEvent) => Promise<void>;
  recordWorkflowStep?: RecordWorkflowStep;
  limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
  loadAgentRuntimeProviderConfig?: () => Promise<AgentRuntimeProviderFactoryConfig | null>;
  trustedLocalFileRoot?: string;
  automationCapabilityRegistry?: AutomationCapabilityRegistry;
  recordAutomationCapabilityCall?: (event: AutomationCapabilityCallEvent) => void | Promise<void>;
  propagateParentAbort?: boolean;
  parentAbortSignal?: AbortSignal;
}

export type AutomationExecutionEvent =
  | { type: "run.started"; runId: string; workflowId: string }
  | { type: "step.started"; runId: string; workflowId: string; stepId: string; stepType: string; label: string }
  | {
      type: "step.completed";
      runId: string;
      workflowId: string;
      stepId: string;
      status: "completed";
      durationMs: number;
      outputSummary: string | null;
    }
  | {
      type: "step.failed";
      runId: string;
      workflowId: string;
      stepId: string;
      status: "failed";
      durationMs: number;
      error: { message: string };
    }
  | {
      type: "completed";
      runId: string;
      workflowId: string;
      status: "completed" | "failed";
      finalOutput: unknown;
      stepOutputs: Record<string, StepOutput>;
    };

export interface AutomationExecutionResult {
  runId: string;
  status: string;
  finalOutput: unknown;
  stepOutputs: Record<string, StepOutput>;
  aborted?: boolean;
}

export class AutomationRunAbortedError extends Error {
  constructor() {
    super("Automation run aborted by user");
    this.name = "AutomationRunAbortedError";
  }
}

export function automationRunDeepLink(
  config: { BASE_URL?: string; PORT: number },
  taskId: string,
  runId: string,
): string {
  const baseUrl = config.BASE_URL?.trim() || `http://localhost:${config.PORT}`;
  return `${baseUrl.replace(/\/$/, "")}/scheduled-tasks/${encodeURIComponent(taskId)}/edit?runId=${encodeURIComponent(runId)}`;
}

function automationTitle(task: Pick<ScheduledTaskRow, "title" | "prompt">): string {
  return task.title ?? task.prompt;
}

export function automationManualFailureNotification(
  config: { BASE_URL?: string; PORT: number },
  task: Pick<ScheduledTaskRow, "id" | "title" | "prompt">,
  runId: string,
): string {
  return `Automation “${automationTitle(task)}” failed. View run: ${automationRunDeepLink(config, task.id, runId)}`;
}

async function failAutomationRun(params: {
  runtime: ExecuteAutomationParams;
  runId: string;
  errorMessage: string;
  stepOutputs?: Record<string, StepOutput>;
  aborted?: boolean;
  productionNotification?: string;
}): Promise<void> {
  const { runtime, runId, errorMessage, stepOutputs, aborted = false } = params;
  try {
    await runtime.runsRepo.update(runId, {
      status: "failed",
      ...(stepOutputs === undefined ? {} : { stepOutputs }),
      completedAt: new Date().toISOString(),
      errorMessage,
    });
  } catch (err) {
    runtime.logger.error({ err, taskId: runtime.task.id, runId }, "Automation: failed to persist run failure");
  }

  if (aborted || runtime.runMode === "test" || runtime.task.output_mode === "silent" || !runtime.sendMessage) return;

  const notification =
    runtime.runMode === "manual"
      ? automationManualFailureNotification(runtime.config, runtime.task, runId)
      : (params.productionNotification ?? `Automation '${automationTitle(runtime.task)}' failed: ${errorMessage}`);
  try {
    await runtime.sendMessage(notification);
  } catch (err) {
    runtime.logger.warn({ err, taskId: runtime.task.id, runId }, "Automation: failure notification delivery failed");
  }
}

function resolveRuntimeExecutionMode(value: string | null | undefined): AutomationExecutionMode {
  if (value === null || value === undefined || value.trim() === "") return "hybrid";
  const parsed = automationExecutionModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Automation has unsupported execution mode "${value}"`);
}

export function validateRuntimeAutomationExecutionMode(
  mode: AutomationExecutionMode,
  steps: readonly WorkflowStep[],
): void {
  const invalidStep = steps.find((step) => !automationExecutionModeAllowsStep(mode, step.type));
  if (!invalidStep) return;
  const restriction = mode === "deterministic" ? "agent" : "code or action";
  throw new Error(`Automation mode "${mode}" cannot run ${restriction} step "${invalidStep.label}"`);
}

export async function executeAutomation(params: ExecuteAutomationParams): Promise<AutomationExecutionResult> {
  const runId =
    params.runId ?? (await params.runsRepo.create({ taskId: params.task.id, triggerData: params.triggerData }));
  try {
    return await executeAutomationInternal({ ...params, runId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof AutomationRunAbortedError;
    await failAutomationRun({
      runtime: params,
      runId,
      errorMessage: aborted ? "Automation run aborted" : detail,
      aborted,
    });
    params.logger.error({ err: error, taskId: params.task.id, runId }, "Automation: unhandled execution failure");
    return { runId, status: "failed", finalOutput: null, stepOutputs: {}, ...(aborted ? { aborted: true } : {}) };
  }
}

async function executeAutomationInternal(
  params: ExecuteAutomationParams & { runId: string },
): Promise<AutomationExecutionResult> {
  const { task, triggerData, logger, runsRepo, stepContentRepo, onEvent } = params;
  const sendMessage = params.runMode === "test" ? undefined : params.sendMessage;
  const runId = params.runId;

  const creatorId = task.created_by;
  let creator: Awaited<ReturnType<NonNullable<RunAgentParams["userRepo"]>["findById"]>> | undefined;
  let creatorEmail: string | null = null;
  try {
    if (creatorId) {
      creator = await params.userRepo.findById(creatorId);
      if (!creator) {
        logger.error({ taskId: task.id, creatorId }, "Automation: creator no longer exists");
        await failAutomationRun({
          runtime: params,
          runId,
          errorMessage: "Creator no longer exists",
          productionNotification: `Automation '${automationTitle(task)}' failed: Creator no longer exists`,
        });
        return { runId, status: "failed", finalOutput: null, stepOutputs: {} };
      }
      creatorEmail = creator.email;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, taskId: task.id, runId }, "Automation: creator lookup failed");
    const aborted = error instanceof AutomationRunAbortedError;
    await failAutomationRun({
      runtime: params,
      runId,
      errorMessage: aborted ? "Automation run aborted during creator lookup" : `Creator lookup failed: ${detail}`,
      aborted,
    });
    return { runId, status: "failed", finalOutput: null, stepOutputs: {}, ...(aborted ? { aborted: true } : {}) };
  }
  let persistedDefinition: ValidatedPersistedAutomationDefinition;
  let contentRows: StepContentRow[];
  try {
    contentRows = await stepContentRepo.getByTask(task.id);
    persistedDefinition = validatePersistedAutomationDefinition({ task, stepContentRows: contentRows });
  } catch (error) {
    const definitionError = new Error(
      error instanceof AutomationValidationError
        ? `${error.message}: ${error.issues.map((issue) => issue.message).join("; ")}`
        : `Automation definition could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    const aborted = error instanceof AutomationRunAbortedError;
    await failAutomationRun({
      runtime: params,
      runId,
      errorMessage: definitionError.message,
      stepOutputs: {},
      aborted,
      productionNotification: `Automation '${automationTitle(task)}' failed: ${definitionError.message}`,
    });
    logger.error({ err: error, taskId: task.id, runId }, "Automation: persisted definition validation failed");
    return { runId, status: "failed", finalOutput: null, stepOutputs: {}, ...(aborted ? { aborted: true } : {}) };
  }

  const { steps, edges } = persistedDefinition;
  const executionSteps = resolveExecutionOrder(steps, edges);
  const contentMap = new Map(contentRows.map((r) => [r.step_id, r]));
  const workspaceDir = resolveAutomationWorkspaceDir(params.config.DATA_DIR, task);
  try {
    await mkdir(workspaceDir, { recursive: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof AutomationRunAbortedError;
    await failAutomationRun({
      runtime: params,
      runId,
      errorMessage: `Automation workspace could not be prepared: ${detail}`,
      aborted,
    });
    logger.error({ err: error, taskId: task.id, runId }, "Automation: workspace preparation failed");
    return { runId, status: "failed", finalOutput: null, stepOutputs: {}, ...(aborted ? { aborted: true } : {}) };
  }
  const emitEvent = async (event: AutomationExecutionEvent) => {
    try {
      await onEvent?.(event);
    } catch (err) {
      logger.warn(
        { err, taskId: task.id, runId, eventType: event.type },
        "Automation: execution event delivery failed",
      );
    }
  };
  await emitEvent({ type: "run.started", runId, workflowId: task.id });

  let executionMode: AutomationExecutionMode = "hybrid";
  let executionModeError: Error | undefined;
  try {
    executionMode = resolveRuntimeExecutionMode(task.execution_mode);
    validateRuntimeAutomationExecutionMode(executionMode, steps);
  } catch (error) {
    executionModeError = error instanceof Error ? error : new Error(String(error));
  }

  if (executionModeError) {
    await failAutomationRun({
      runtime: params,
      runId,
      errorMessage: executionModeError.message,
      stepOutputs: {},
      productionNotification: `Automation '${automationTitle(task)}' failed: ${executionModeError.message}`,
    });
    logger.error({ err: executionModeError, taskId: task.id, runId }, "Automation: invalid execution mode");
    await emitEvent({
      type: "completed",
      runId,
      workflowId: task.id,
      status: "failed",
      finalOutput: null,
      stepOutputs: {},
    });
    return { runId, status: "failed", finalOutput: null, stepOutputs: {} };
  }

  logger.info(
    {
      taskId: task.id,
      runId,
      title: task.title,
      stepCount: steps.length,
    },
    "Automation: execution started",
  );

  const stepOutputs: Record<string, StepOutput> = {};
  let previousOutput: unknown = triggerData ?? null;
  let failed = false;
  const lastExecutionStepId = executionSteps[executionSteps.length - 1]?.id;
  let aborted = false;

  for (const step of executionSteps) {
    const content = contentMap.get(step.id);
    const startTime = Date.now();
    const isMessageDeliveryStep = task.output_mode !== "silent" && step.id === lastExecutionStepId;

    logger.info(
      { taskId: task.id, runId, stepId: step.id, stepType: step.type, stepLabel: step.label },
      "Automation: step starting",
    );
    await emitEvent({
      type: "step.started",
      runId,
      workflowId: task.id,
      stepId: step.id,
      stepType: step.type,
      label: step.label,
    });

    try {
      validateRuntimeAutomationExecutionMode(executionMode, [step]);
      const output = await executeWorkflowStep({
        params,
        step,
        content,
        input: previousOutput,
        task,
        runId,
        workspaceDir,
        creator,
        creatorId,
        creatorEmail,
        isMessageDeliveryStep,
      });

      const normalizedOutput = normalizeStepOutput(output);
      const outputForStep = isMessageDeliveryStep ? formatWorkflowMessageText(normalizedOutput) : normalizedOutput;
      const durationMs = Date.now() - startTime;
      stepOutputs[step.id] = { output: outputForStep, status: "completed", duration_ms: durationMs };
      previousOutput = outputForStep;

      logger.info({ taskId: task.id, runId, stepId: step.id, durationMs }, "Automation: step completed");

      await runsRepo.update(runId, { stepOutputs });
      await emitEvent({
        type: "step.completed",
        runId,
        workflowId: task.id,
        stepId: step.id,
        status: "completed",
        durationMs,
        outputSummary: summarizeOutput(outputForStep),
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));
      stepOutputs[step.id] = {
        output: null,
        status: "failed",
        duration_ms: durationMs,
        error: { message: error.message, stack: error.stack },
      };

      markSkippedAfterFailure({ failedStepId: step.id, executionSteps, edges, stepOutputs });

      const runErrorMessage =
        error instanceof AutomationRunAbortedError
          ? `Automation run aborted by user at step "${step.label}"`
          : `Step "${step.label}" failed: ${error.message}`;
      await failAutomationRun({
        runtime: params,
        runId,
        errorMessage: runErrorMessage,
        stepOutputs,
        aborted: error instanceof AutomationRunAbortedError,
        productionNotification: `Automation '${automationTitle(task)}' failed at step '${step.label}': ${error.message}`,
      });

      failed = true;
      aborted = error instanceof AutomationRunAbortedError;
      if (error instanceof AutomationRunAbortedError) {
        logger.info(
          { taskId: task.id, runId, stepId: step.id, stepLabel: step.label, durationMs },
          "Automation: execution stopped by user",
        );
      } else {
        logger.error(
          { err, taskId: task.id, runId, stepId: step.id, stepLabel: step.label, durationMs },
          "Automation: step failed",
        );
      }
      await emitEvent({
        type: "step.failed",
        runId,
        workflowId: task.id,
        stepId: step.id,
        status: "failed",
        durationMs,
        error: { message: error.message },
      });

      break;
    }
  }

  // 6. On success: deliver final output + write context file
  const lastStep = executionSteps[executionSteps.length - 1];
  const finalOutput = lastStep ? (stepOutputs[lastStep.id]?.output ?? null) : null;

  if (!failed) {
    try {
      await runsRepo.update(runId, {
        status: "completed",
        stepOutputs,
        completedAt: new Date().toISOString(),
      });

      if (sendMessage && task.output_mode !== "silent" && finalOutput != null) {
        const finalMessage = formatWorkflowMessageText(finalOutput);
        if (finalMessage !== null) await sendMessage(finalMessage);
      }
      logger.info({ taskId: task.id, runId }, "Automation: execution completed");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const completionAborted = error instanceof AutomationRunAbortedError;
      failed = true;
      aborted = completionAborted;
      await failAutomationRun({
        runtime: params,
        runId,
        errorMessage: completionAborted
          ? "Automation run aborted during completion"
          : `Automation completion failed: ${detail}`,
        stepOutputs,
        aborted: completionAborted,
        productionNotification: `Automation '${automationTitle(task)}' failed: ${detail}`,
      });
      logger.error({ err: error, taskId: task.id, runId }, "Automation: completion failed");
    }
  }

  await emitEvent({
    type: "completed",
    runId,
    workflowId: task.id,
    status: failed ? "failed" : "completed",
    finalOutput,
    stepOutputs,
  });

  // 7. Write context file
  await writeAutomationContext({
    workspaceDir,
    taskId: task.id,
    runId,
    title: task.title ?? task.prompt,
    triggerSummary: triggerData
      ? (summarizeOutput(triggerData) ?? "Manual/scheduled trigger")
      : "Manual/scheduled trigger",
    steps: steps
      .filter((s) => s.type !== "trigger")
      .map((s) => ({
        label: s.label,
        status: stepOutputs[s.id]?.status ?? "skipped",
        duration_ms: stepOutputs[s.id]?.duration_ms ?? 0,
        outputSummary: summarizeOutput(stepOutputs[s.id]?.output) ?? undefined,
      })),
    logger,
  });

  return {
    runId,
    status: failed ? "failed" : "completed",
    finalOutput,
    stepOutputs,
    ...(aborted ? { aborted: true } : {}),
  };
}

export async function testAutomationStep(
  params: ExecuteAutomationParams & {
    stepId: string;
    input?: unknown;
    useLatestUpstreamOutput?: boolean;
  },
): Promise<AutomationExecutionResult> {
  const { task, triggerData, logger, runsRepo, stepContentRepo, stepId } = params;
  const creatorId = task.created_by;
  let creator: Awaited<ReturnType<NonNullable<RunAgentParams["userRepo"]>["findById"]>> | undefined;
  let creatorEmail: string | null = null;
  if (creatorId) {
    creator = await params.userRepo.findById(creatorId);
    if (!creator) {
      const runId = await runsRepo.create({ taskId: task.id, triggerData: { type: "step_test", stepId } });
      await runsRepo.update(runId, {
        status: "failed",
        errorMessage: "Creator no longer exists",
        completedAt: new Date().toISOString(),
      });
      return { runId, status: "failed", finalOutput: null, stepOutputs: {} };
    }
    creatorEmail = creator.email;
  }

  const steps = parseWorkflowSteps(task);
  const edges = parseWorkflowEdges(task);
  const step = steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Step ${stepId} not found`);

  const runId = await runsRepo.create({ taskId: task.id, triggerData: { type: "step_test", stepId, triggerData } });
  const stepOutputs: Record<string, StepOutput> = {};
  const workspaceDir = resolveAutomationWorkspaceDir(params.config.DATA_DIR, task);
  await mkdir(workspaceDir, { recursive: true });

  let executionMode: AutomationExecutionMode = "hybrid";
  try {
    executionMode = resolveRuntimeExecutionMode(task.execution_mode);
    validateRuntimeAutomationExecutionMode(executionMode, steps);
  } catch (error) {
    const modeError = error instanceof Error ? error : new Error(String(error));
    await runsRepo.update(runId, {
      status: "failed",
      stepOutputs,
      completedAt: new Date().toISOString(),
      errorMessage: modeError.message,
    });
    logger.error(
      { err: modeError, taskId: task.id, runId, stepId },
      "Automation: invalid execution mode for step test",
    );
    return { runId, status: "failed", finalOutput: null, stepOutputs };
  }

  if (step.type === "trigger") {
    const output = buildTriggerSamplePayload(task, step);
    stepOutputs[step.id] = { output, status: "completed", duration_ms: 0 };
    await runsRepo.update(runId, {
      status: "completed",
      stepOutputs,
      completedAt: new Date().toISOString(),
    });
    return { runId, status: "completed", finalOutput: output, stepOutputs };
  }

  const contentRows = await stepContentRepo.getByTask(task.id);
  const contentMap = new Map(contentRows.map((r) => [r.step_id, r]));
  const content = contentMap.get(step.id);
  const startTime = Date.now();

  try {
    validateRuntimeAutomationExecutionMode(executionMode, [step]);
    const input = params.useLatestUpstreamOutput
      ? await resolveLatestUpstreamOutput({ params, stepId, edges, currentRunId: runId })
      : (params.input ?? null);
    const output = await executeWorkflowStep({
      params,
      step,
      content,
      input,
      task,
      runId,
      workspaceDir,
      creator,
      creatorId,
      creatorEmail,
    });
    const normalizedOutput = normalizeStepOutput(output);
    stepOutputs[step.id] = {
      output: normalizedOutput,
      status: "completed",
      duration_ms: Date.now() - startTime,
    };
    await runsRepo.update(runId, {
      status: "completed",
      stepOutputs,
      completedAt: new Date().toISOString(),
    });
    return { runId, status: "completed", finalOutput: normalizedOutput, stepOutputs };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    stepOutputs[step.id] = {
      output: null,
      status: "failed",
      duration_ms: Date.now() - startTime,
      error: { message: error.message, stack: error.stack },
    };
    await runsRepo.update(runId, {
      status: "failed",
      stepOutputs,
      completedAt: new Date().toISOString(),
      errorMessage: `Step "${step.label}" failed: ${error.message}`,
    });
    logger.error({ err, taskId: task.id, runId, stepId: step.id }, "Automation: step test failed");
    return { runId, status: "failed", finalOutput: null, stepOutputs };
  }
}

async function executeWorkflowStep(params: {
  params: ExecuteAutomationParams;
  step: WorkflowStep;
  content: Awaited<ReturnType<ReturnType<typeof createAutomationStepContentRepository>["getByStep"]>> | undefined;
  input: unknown;
  task: ScheduledTaskRow;
  runId: string;
  workspaceDir: string;
  creator: Awaited<ReturnType<NonNullable<RunAgentParams["userRepo"]>["findById"]>> | undefined;
  creatorId: string | null;
  creatorEmail: string | null;
  isMessageDeliveryStep?: boolean;
}): Promise<unknown> {
  const { step, content, input, task, runId, workspaceDir, creator, creatorId, creatorEmail } = params;
  const runtimeParams = params.params;

  if (step.type === "action") {
    if (!content || content.content_type !== "script") {
      throw new Error(`Action step "${step.label}" has no script`);
    }
    return executeActionStep({
      script: content.content,
      step,
      input,
      taskId: task.id,
      task,
      runId,
      logger: runtimeParams.logger,
      config: runtimeParams.config,
      creatorId,
      creatorEmail,
      workspaceDir,
      loadIntegrationProvider: runtimeParams.loadIntegrationProvider,
      listAgentEnvForRuntime: runtimeParams.listAgentEnvForRuntime,
      trustedLocalFileRoot: runtimeParams.trustedLocalFileRoot,
      db: runtimeParams.db,
      userRepo: runtimeParams.userRepo,
      automationCapabilityRegistry: runtimeParams.automationCapabilityRegistry,
      recordAutomationCapabilityCall: runtimeParams.recordAutomationCapabilityCall,
    });
  }

  if (step.type === "agent") {
    const prompt = content?.content ?? (!task.steps ? task.prompt : null);
    if (!prompt) {
      throw new Error(`Agent step "${step.label}" has no prompt`);
    }
    return executeAgentStep({
      prompt,
      step,
      input,
      task,
      db: runtimeParams.db,
      logger: runtimeParams.logger,
      config: runtimeParams.config,
      workspaceDir,
      creator,
      creatorEmail,
      runAgent: runtimeParams.runAgent,
      buildMcpServers: runtimeParams.buildMcpServers,
      getSlack: runtimeParams.getSlack,
      loadIntegrationProvider: runtimeParams.loadIntegrationProvider,
      listAgentEnvForRuntime: runtimeParams.listAgentEnvForRuntime,
      cliIntegrations: runtimeParams.cliIntegrations,
      userRepo: runtimeParams.userRepo,
      inboxMessagesRepo: runtimeParams.inboxMessagesRepo,
      sendDm: runtimeParams.sendDm,
      sendTargetMessage: runtimeParams.sendTargetMessage,
      outputPlatform: resolveWorkflowDelivery(task).platform,
      isMessageDeliveryStep: params.isMessageDeliveryStep ?? false,
      recordWorkflowStep: runtimeParams.recordWorkflowStep,
      limitAgentExecution: runtimeParams.limitAgentExecution,
      loadAgentRuntimeProviderConfig: runtimeParams.loadAgentRuntimeProviderConfig,
      propagateParentAbort: runtimeParams.propagateParentAbort,
      parentAbortSignal: runtimeParams.parentAbortSignal,
    });
  }

  return null;
}

function parseWorkflowSteps(task: ScheduledTaskRow): WorkflowStep[] {
  if (task.steps) {
    const parsed = workflowStepSchema.array().safeParse(JSON.parse(task.steps) as unknown);
    if (!parsed.success) throw new Error("Stored automation steps are invalid");
    return parsed.data;
  }
  return [
    { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
    {
      id: "step1",
      type: "agent",
      label: task.prompt,
      icon: "sketch-ai",
      position: { x: 0, y: 100 },
      agentMode: "sketch",
    },
  ];
}

function parseWorkflowEdges(task: ScheduledTaskRow): WorkflowEdge[] {
  if (!task.edges) return [];
  const parsed = JSON.parse(task.edges) as unknown;
  const result = workflowEdgeSchema.array().safeParse(parsed);
  if (!result.success) throw new Error("Stored automation edges are invalid");
  return result.data;
}

function resolveExecutionOrder(steps: WorkflowStep[], edges: WorkflowEdge[]): WorkflowStep[] {
  const executionSteps = steps.filter((step) => step.type !== "trigger");
  if (edges.length === 0) return executionSteps;

  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0);
  const ordered: WorkflowStep[] = [];
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) continue;
    ordered.push(step);
    for (const nextId of outgoing.get(step.id) ?? []) {
      const nextCount = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextCount);
      if (nextCount === 0) {
        const nextStep = byId.get(nextId);
        if (nextStep) queue.push(nextStep);
      }
    }
  }

  if (ordered.length !== steps.length) throw new Error("Automation graph contains a cycle");
  return ordered.filter((step) => step.type !== "trigger");
}

function markSkippedAfterFailure(params: {
  failedStepId: string;
  executionSteps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepOutputs: Record<string, StepOutput>;
}): void {
  if (params.edges.length === 0) {
    let foundFailed = false;
    for (const step of params.executionSteps) {
      if (step.id === params.failedStepId) {
        foundFailed = true;
        continue;
      }
      if (foundFailed && !params.stepOutputs[step.id]) {
        params.stepOutputs[step.id] = { output: null, status: "skipped", duration_ms: 0 };
      }
    }
    return;
  }

  const downstream = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of params.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const stack = [...(outgoing.get(params.failedStepId) ?? [])];
  while (stack.length > 0) {
    const stepId = stack.pop();
    if (!stepId || downstream.has(stepId)) continue;
    downstream.add(stepId);
    stack.push(...(outgoing.get(stepId) ?? []));
  }
  for (const step of params.executionSteps) {
    if (downstream.has(step.id) && !params.stepOutputs[step.id]) {
      params.stepOutputs[step.id] = { output: null, status: "skipped", duration_ms: 0 };
    }
  }
}

async function resolveLatestUpstreamOutput(params: {
  params: ExecuteAutomationParams;
  stepId: string;
  edges: WorkflowEdge[];
  currentRunId: string;
}): Promise<unknown> {
  const upstreamId = params.edges.find((edge) => edge.to === params.stepId)?.from;
  if (!upstreamId) return null;
  const runs = await params.params.runsRepo.list(params.params.task.id, 20);
  for (const run of runs) {
    if (run.id === params.currentRunId || run.status !== "completed" || !run.step_outputs) continue;
    try {
      const outputs = JSON.parse(run.step_outputs) as Record<string, StepOutput>;
      if (outputs[upstreamId]?.status === "completed") return outputs[upstreamId]?.output ?? null;
    } catch {}
  }
  return null;
}

function buildTriggerSamplePayload(task: ScheduledTaskRow, step: WorkflowStep): unknown {
  const config = step.triggerConfig;
  if (config?.type === "schedule") {
    return {
      type: "schedule",
      taskId: task.id,
      scheduledAt: new Date().toISOString(),
      scheduleType: config.scheduleType ?? task.schedule_type,
      scheduleValue: config.scheduleValue ?? task.schedule_value,
      timezone: config.timezone ?? task.timezone,
    };
  }
  if (config?.type === "canvas") {
    return {
      type: "canvas",
      taskId: task.id,
      app: config.app ?? null,
      eventDescription: config.eventDescription ?? null,
      receivedAt: new Date().toISOString(),
    };
  }
  if (config?.type === "slack_channel_message") {
    return {
      type: "slack_channel_message",
      taskId: task.id,
      channelId: config.channelId ?? null,
      messageTs: "1710000000.000000",
      text: "Example Slack channel message",
      userId: "U123456",
      botId: null,
      appId: null,
      subtype: null,
      files: [],
      capturedMessageId: null,
      conversationId: config.channelId ?? null,
    };
  }
  return { type: "webhook", taskId: task.id, receivedAt: new Date().toISOString() };
}

export function resolveAutomationWorkspaceDir(dataDir: string, task: ScheduledTaskRow): string {
  if (task.context_type === "channel") {
    return join(dataDir, "workspaces", `channel-${task.delivery_target}`);
  }
  if (task.context_type === "group") {
    const groupId = task.delivery_target.replace("@g.us", "");
    return join(dataDir, "workspaces", `wa-group-${groupId}`);
  }
  const userId = task.created_by ?? task.delivery_target;
  return join(dataDir, "workspaces", userId);
}

function resolveWorkspaceKey(task: ScheduledTaskRow): string {
  if (task.context_type === "channel") {
    return `channel-${task.delivery_target}`;
  }
  if (task.context_type === "group") {
    const groupId = task.delivery_target.replace("@g.us", "");
    return `wa-group-${groupId}`;
  }
  return task.created_by ?? task.delivery_target;
}

function buildAgentEnvironmentRuntimeContext(task: ScheduledTaskRow): AgentEnvironmentRuntimeContext {
  const platform = task.platform === "whatsapp" ? "whatsapp" : "slack";
  const contextType = task.context_type === "group" ? "group" : task.context_type === "channel" ? "channel" : "dm";
  return {
    currentUserId: task.created_by,
    contextType: "scheduled_task",
    allowOrgSharedEnv: true,
    taskContext: {
      platform,
      contextType,
      deliveryTarget: task.delivery_target,
      createdBy: task.created_by,
    },
  };
}

function buildRunAgentTaskContext(task: ScheduledTaskRow): RunAgentParams["taskContext"] | undefined {
  const runtimeContext = buildAgentEnvironmentRuntimeContext(task).taskContext;
  if (!runtimeContext) return undefined;
  return {
    ...runtimeContext,
    createdBy: task.created_by,
    ...(task.thread_ts ? { threadTs: task.thread_ts } : {}),
  };
}

// --- Action step: in-process script ---

type AsyncFunctionConstructor = (
  ...args: string[]
) => (input: unknown, ctx: ScriptContext, signal: AbortSignal) => Promise<unknown>;

/**
 * Action scripts currently execute in the server's Node.js realm. The exposed context is capability-scoped,
 * but AsyncFunction is not a security sandbox: a script can potentially reach process globals, built-in modules,
 * or network APIs. This slice keeps the existing first-party-authored-script trust boundary; isolating scripts in
 * a worker or subprocess with an explicit IPC protocol is a separate hardening project.
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFunctionConstructor;

export interface ScriptIntegrationFile {
  path: string;
  configuredProp: string;
}

export interface ScriptIntegrationActionRequest {
  componentKey: string;
  configuredProps: Record<string, unknown>;
  localFiles?: ScriptIntegrationFile[];
}

export interface ScriptContext {
  log: Logger;
  env: Readonly<Record<string, string>>;
  workspaceDir: string;
  tools: Readonly<AutomationSketchTools>;
  integrations: {
    executeAction(request: ScriptIntegrationActionRequest, signal?: AbortSignal): Promise<unknown>;
  };
}

interface ActionStepParams {
  script: string;
  step: WorkflowStep;
  input: unknown;
  taskId: string;
  task: ScheduledTaskRow;
  runId: string;
  logger: Logger;
  config: ExecuteAutomationParams["config"];
  creatorId: string | null;
  creatorEmail: string | null;
  workspaceDir: string;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  trustedLocalFileRoot?: string;
  db: Kysely<DB>;
  userRepo: NonNullable<RunAgentParams["userRepo"]>;
  automationCapabilityRegistry?: AutomationCapabilityRegistry;
  recordAutomationCapabilityCall?: (event: AutomationCapabilityCallEvent) => void | Promise<void>;
}

async function executeActionStep(params: ActionStepParams): Promise<unknown> {
  const { script, step, input, runId, logger, creatorId, creatorEmail, workspaceDir, loadIntegrationProvider } = params;
  const usesIntegrationActions = workflowStepUsesIntegrationActions(step);
  const sketchTools = step.actionCapabilities?.sketchTools ?? [];
  const cliIntegrationIds = step.actionCapabilities?.cliIntegrations ?? [];
  if (hasInvalidAutomationSketchToolNamespace(script)) {
    throw new Error(`Action step ${step.id} uses an invalid Sketch tool namespace; use ctx.tools.<capability>`);
  }
  const undeclaredSketchTools = undeclaredAutomationSketchTools(script, sketchTools as AutomationSketchToolName[]);
  if (undeclaredSketchTools.length > 0) {
    throw new Error(
      `Action step ${step.id} calls undeclared Sketch tool(s): ${undeclaredSketchTools.map((tool) => `ctx.tools.${tool}`).join(", ")}`,
    );
  }
  if (sketchTools.length > 0 && !creatorId) {
    throw new Error(`Action step ${step.id} requires an automation creator to use Sketch tools`);
  }
  const integrationProvider = usesIntegrationActions ? await loadIntegrationProvider() : null;
  const integrationAccess = usesIntegrationActions
    ? await startIntegrationAccess({
        userEmail: creatorEmail,
        claudeConfigDir: params.config.CLAUDE_CONFIG_DIR,
        workspaceDir,
        loadIntegrationProvider: async () => integrationProvider,
        logger,
      })
    : null;

  try {
    if (usesIntegrationActions && !integrationAccess?.envVars.CANVAS_CLI && !integrationProvider?.executeAction) {
      throw new Error(
        `Action step ${step.id} requires a broker-capable integration provider; none is currently configured. Reconfigure the integration in Settings → Integrations.`,
      );
    }

    const env = await buildScriptEnv({
      stepId: step.id,
      runtimeContext: buildAgentEnvironmentRuntimeContext(params.task),
      listAgentEnvForRuntime: params.listAgentEnvForRuntime,
      integrationEnv: integrationAccess?.envVars ?? {},
      cliIntegrationIds,
    });

    const timeoutMs = (step.timeout ?? 1800) * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(`Action step ${step.id} timed out after ${timeoutMs}ms`)),
        { once: true },
      );
    });
    let capabilityFailure: Error | null = null;

    const ctx = buildScriptContext({
      taskId: params.taskId,
      runId,
      stepId: step.id,
      logger,
      env,
      workspaceDir,
      tools:
        sketchTools.length > 0
          ? (params.automationCapabilityRegistry ?? createAutomationCapabilityRegistry()).createTools({
              context: {
                taskId: params.taskId,
                runId,
                stepId: step.id,
                creatorId: creatorId as string,
                creatorEmail,
                workspaceDir,
                db: params.db,
                userRepo: params.userRepo,
                logger,
                signal: controller.signal,
                recordCall: params.recordAutomationCapabilityCall,
                onFailure: (capability, error) => {
                  if (capabilityFailure) return;
                  const detail = error instanceof Error ? error.message : String(error);
                  capabilityFailure = new Error(`Sketch capability "${capability}" failed: ${detail}`);
                },
              },
              allowedTools: sketchTools as AutomationSketchToolName[],
            })
          : Object.freeze({}),
      executeIntegrationAction: async (request) => {
        if (!usesIntegrationActions || !integrationProvider?.executeAction || !creatorEmail) {
          throw new Error("The configured integration provider cannot execute server-owned actions");
        }
        const configuredProps = await materializeIntegrationActionFiles({
          request,
          workspaceDir,
          trustedLocalFileRoot: params.trustedLocalFileRoot,
        });
        const actionRequest = {
          userEmail: creatorEmail,
          componentKey: request.componentKey,
          configuredProps,
        };
        return integrationProvider.executeAction(actionRequest, controller.signal);
      },
    });

    try {
      const fn = AsyncFunction("input", "ctx", "signal", wrapActionScript(script));
      const output = await Promise.race([fn(input ?? null, ctx, controller.signal), timeoutPromise]);
      if (capabilityFailure) throw capabilityFailure;
      logger.info({ runId, stepId: step.id, timeoutMs }, "Automation action: script completed");
      return output ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (integrationAccess) await cleanupIntegrationAccess(integrationAccess);
  }
}

function wrapActionScript(script: string): string {
  return `"use strict";\n${normalizeActionScript(script)}\nif (typeof action === "function") {\n  return await action(input, ctx, signal);\n}`;
}

function normalizeActionScript(script: string): string {
  const trimmed = script.trimStart();
  return trimmed
    .replace(/^export\s+default\s+(async\s+function\s+action\b)/, "$1")
    .replace(/^export\s+default\s+(function\s+action\b)/, "$1")
    .replace(/^export\s+(async\s+function\s+action\b)/, "$1")
    .replace(/^export\s+(function\s+action\b)/, "$1")
    .replace(/^export\s+default\s+(async\s+function)\s*\(/, "const action = $1(")
    .replace(/^export\s+default\s+(function)\s*\(/, "const action = $1(");
}

async function buildScriptEnv(params: {
  stepId: string;
  runtimeContext: AgentEnvironmentRuntimeContext;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  integrationEnv: Record<string, string>;
  cliIntegrationIds: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  const runtimeEnv = params.listAgentEnvForRuntime
    ? removeReservedAgentEnv(await params.listAgentEnvForRuntime(params.runtimeContext))
    : {};
  const allCliEnvNames = new Set(
    Object.values(cliIntegrationAppDefinitions).flatMap((definition) =>
      definition.credentialFields.map((field) => field.envName),
    ),
  );
  const allowedCliEnvNames = new Set<string>();
  const missingCliIntegrations: string[] = [];
  for (const appId of params.cliIntegrationIds) {
    const definition = cliIntegrationAppDefinition(appId);
    if (!definition) {
      throw new Error(`Action step ${params.stepId} declares unsupported CLI integration "${appId}"`);
    }
    for (const field of definition.credentialFields) allowedCliEnvNames.add(field.envName);
    if (definition.credentialFields.some((field) => !runtimeEnv[field.envName])) {
      missingCliIntegrations.push(definition.name);
    }
  }
  if (missingCliIntegrations.length > 0) {
    throw new Error(
      `Action step ${params.stepId} requires an active managed CLI integration: ${missingCliIntegrations.join(", ")}. Connect or share the integration in Sketch Integrations.`,
    );
  }

  const filterCliEnv = (env: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(env).filter(([name]) => !allCliEnvNames.has(name) || allowedCliEnvNames.has(name)),
    );
  const userEnv = filterCliEnv(runtimeEnv);
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    NODE_NO_WARNINGS: "1",
    ...userEnv,
    ...filterCliEnv(params.integrationEnv),
  };
  if (env.CANVAS_CLI && !env.INTEGRATION_CLI) {
    env.INTEGRATION_CLI = env.CANVAS_CLI;
  }
  return Object.freeze(env);
}

const MAX_INTEGRATION_ACTION_FILES = 5;
const MAX_INTEGRATION_ACTION_FILE_BYTES = 25 * 1024 * 1024;

async function materializeIntegrationActionFiles(params: {
  request: ScriptIntegrationActionRequest;
  workspaceDir: string;
  trustedLocalFileRoot?: string;
}): Promise<Record<string, unknown>> {
  const files = params.request.localFiles ?? [];
  if (files.length > MAX_INTEGRATION_ACTION_FILES) {
    throw new Error(`Integration actions support at most ${MAX_INTEGRATION_ACTION_FILES} local files`);
  }
  const allowedRoots = [await realpath(params.workspaceDir)];
  if (params.trustedLocalFileRoot) allowedRoots.push(await realpath(params.trustedLocalFileRoot));
  const configuredProps = { ...params.request.configuredProps };
  let totalBytes = 0;
  for (const file of files) {
    const fileRealPath = await realpath(file.path);
    if (!allowedRoots.some((root) => fileRealPath.startsWith(`${root}${sep}`))) {
      throw new Error("Integration action file is outside the trusted automation file roots");
    }
    if (!file.configuredProp.trim()) throw new Error("Integration action file configuredProp is required");
    const content = await readFile(fileRealPath);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_INTEGRATION_ACTION_FILE_BYTES) {
      throw new Error("Integration action files exceed the 25 MiB limit");
    }
    configuredProps[file.configuredProp] = content.toString("base64");
  }
  return configuredProps;
}

function buildScriptContext(params: {
  taskId: string;
  runId: string;
  stepId: string;
  logger: Logger;
  env: Readonly<Record<string, string>>;
  workspaceDir: string;
  tools: Readonly<AutomationSketchTools>;
  executeIntegrationAction: (request: ScriptIntegrationActionRequest, signal?: AbortSignal) => Promise<unknown>;
}): ScriptContext {
  const log =
    params.logger.child?.({ taskId: params.taskId, runId: params.runId, stepId: params.stepId }) ?? params.logger;
  return Object.freeze({
    log,
    env: params.env,
    workspaceDir: params.workspaceDir,
    tools: params.tools,
    integrations: Object.freeze({ executeAction: params.executeIntegrationAction }),
  });
}

function normalizeStepOutput(output: unknown): unknown {
  if (output === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
    if (serialized === undefined) {
      throw new Error("Workflow step output is not JSON-serializable");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Workflow step output is not JSON-serializable: ${message}`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTOMATION_OUTPUT_BYTES) {
    throw new Error(`Workflow step output exceeds ${MAX_AUTOMATION_OUTPUT_BYTES} bytes`);
  }
  try {
    return JSON.parse(serialized);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Workflow step output is not JSON-serializable: ${message}`);
  }
}

function summarizeOutput(output: unknown, maxLength = 200): string | null {
  if (output == null) return null;
  try {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  } catch {
    return "[unserializable output]";
  }
}

// --- Agent step: light mode ---

interface AgentStepParams {
  prompt: string;
  step: WorkflowStep;
  input: unknown;
  task: ScheduledTaskRow;
  db: Kysely<DB>;
  logger: Logger;
  config: ExecuteAutomationParams["config"];
  workspaceDir: string;
  creator: Awaited<ReturnType<NonNullable<RunAgentParams["userRepo"]>["findById"]>> | undefined;
  creatorEmail: string | null;
  runAgent?: typeof runAgent;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  getSlack?: RunAgentParams["getSlack"];
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  cliIntegrations?: RunAgentParams["cliIntegrations"];
  userRepo: NonNullable<RunAgentParams["userRepo"]>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: RunAgentParams["sendDm"];
  sendTargetMessage?: RunAgentParams["sendTargetMessage"];
  outputPlatform: "slack" | "whatsapp";
  isMessageDeliveryStep: boolean;
  recordWorkflowStep?: RecordWorkflowStep;
  limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
  loadAgentRuntimeProviderConfig?: () => Promise<AgentRuntimeProviderFactoryConfig | null>;
  propagateParentAbort?: boolean;
  parentAbortSignal?: AbortSignal;
}

/**
 * Runs an agent workflow step. Non-"light" steps delegate to
 * executeSketchAgentStep; "light" steps run a non-interactive Claude Code
 * subprocess with bypassPermissions and empty settingSources (no user settings,
 * skills, or MCP servers loaded, and no permission prompts to block tool calls).
 */
async function executeAgentStep(params: AgentStepParams): Promise<unknown> {
  const { prompt, step, input, task, logger, workspaceDir, outputPlatform, recordWorkflowStep } = params;

  if (step.agentMode === "light" && step.agentSkills?.some((skill) => cliSkillRequiredEnv(skill).length > 0)) {
    throw new Error("GitHub integration skills require a full Sketch-mode workflow agent step.");
  }

  if (step.agentMode !== "light") {
    return executeSketchAgentStep(params);
  }

  if (params.config.AGENT_RUNTIME === "aisdk") {
    return executeAiSdkLightAgentStep(params);
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const userMessage = `${prompt}\n\nInput:\n${JSON.stringify(input, null, 2)}`;

  // Capture stderr from the spawned Claude Code subprocess so failures produce
  // an actionable error message instead of an opaque "exited with code 1".
  const stderrChunks: string[] = [];

  // Model: only override if the step explicitly specifies one. Otherwise let
  // the CLI fall back to ANTHROPIC_MODEL from the environment, which is set by
  // applyLlmEnvFromSettings at startup and carries the correct ID for whichever
  // backend (Anthropic / Bedrock / Vertex) is configured. Hardcoding an
  // Anthropic-format model ID here breaks every non-Anthropic backend.
  const modelOverride = step.agentModel;

  const systemPromptLines = [
    "You are a workflow step in an automation. Complete the task described below and return a concise result. Do not ask questions — work with what you have.",
    "",
    ...(params.isMessageDeliveryStep
      ? [
          "This is the final message delivery. Return only text that can be sent directly to the user's chat channel:",
          "",
          ...buildAutomationMessageDeliveryLines(outputPlatform),
        ]
      : ["This result is passed to a later workflow step. Structured JSON is allowed when useful."]),
  ];

  const limitAgentExecution = params.limitAgentExecution ?? (<T>(work: () => Promise<T>) => work());

  let lastText = "";
  let stepUsage: WorkflowStepUsage | null = null;
  try {
    await limitAgentExecution(async () => {
      const run = query({
        prompt: userMessage,
        options: {
          maxTurns: 10,
          ...(modelOverride ? { model: modelOverride } : {}),
          cwd: workspaceDir,
          systemPrompt: systemPromptLines.join("\n"),
          permissionMode: "bypassPermissions" as const,
          settingSources: [],
          stderr: (chunk: string) => {
            stderrChunks.push(chunk);
          },
        },
      });

      for await (const message of run) {
        if (!message || typeof message !== "object" || !("type" in message)) continue;
        if (message.type === "assistant" && "message" in message) {
          const msg = message.message as { content?: Array<{ type: string; text?: string }> };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                lastText = block.text;
              }
            }
          }
        } else if (message.type === "result") {
          const resultMsg = message as Record<string, unknown>;
          const u = resultMsg.usage as Record<string, unknown> | undefined;
          const modelKeys = Object.keys((resultMsg.modelUsage as Record<string, unknown>) ?? {});
          stepUsage = {
            model: modelKeys.length > 0 ? modelKeys[0] : (modelOverride ?? null),
            inputTokens: (u?.input_tokens as number) ?? 0,
            outputTokens: (u?.output_tokens as number) ?? 0,
            cacheReadTokens: (u?.cache_read_input_tokens as number) ?? 0,
            cacheCreationTokens: (u?.cache_creation_input_tokens as number) ?? 0,
            sdkCostUsd: (resultMsg.total_cost_usd as number) ?? 0,
          };
        }
      }
    });
  } catch (err) {
    const stderrText = stderrChunks.join("").slice(0, 2000);
    logger.error({ err, stepId: step.id, stderrText }, "Automation agent: step failed (Claude Code subprocess error)");
    const baseMsg = err instanceof Error ? err.message : String(err);
    throw new Error(stderrText ? `${baseMsg}\nstderr: ${stderrText}` : baseMsg);
  }

  if (stepUsage && recordWorkflowStep) {
    await recordWorkflowStep(
      {
        platform: outputPlatform,
        contextType: "scheduled_task",
        userId: task.created_by,
        workspaceKey: resolveWorkspaceKey(task),
      },
      stepUsage,
    );
  }

  logger.info(
    { stepId: step.id, responseLength: lastText.length, stderrLen: stderrChunks.join("").length },
    "Automation agent: step completed",
  );

  return lastText;
}

async function executeAiSdkLightAgentStep(params: AgentStepParams): Promise<unknown> {
  const { prompt, step, input, task, logger, workspaceDir, outputPlatform, recordWorkflowStep } = params;
  const providerConfig = await params.loadAgentRuntimeProviderConfig?.();
  if (!providerConfig) {
    throw new Error("AI SDK agent runtime is enabled but no LLM provider configuration is available");
  }

  const userMessage = `${prompt}\n\nInput:\n${JSON.stringify(input, null, 2)}`;
  const systemPromptLines = [
    "You are a workflow step in an automation. Complete the task described below and return a concise result. Do not ask questions — work with what you have.",
    "",
    ...(params.isMessageDeliveryStep
      ? [
          "This is the final message delivery. Return only text that can be sent directly to the user's chat channel:",
          "",
          ...buildAutomationMessageDeliveryLines(outputPlatform),
        ]
      : ["This result is passed to a later workflow step. Structured JSON is allowed when useful."]),
  ];
  const provider = createAgentRuntimeProvider({
    ...providerConfig,
    modelId: step.agentModel ?? providerConfig.modelId,
  });
  const scope = await createAgentRuntimeWorkspaceToolScopePolicy({
    workspaceRoot: workspaceDir,
    orgClaudeDir: params.config.CLAUDE_CONFIG_DIR,
  });
  const tools = createAgentRuntimeWorkspaceTools({ scope, logger });
  const limitAgentExecution = params.limitAgentExecution ?? (<T>(work: () => Promise<T>) => work());

  const result = await limitAgentExecution(() =>
    runAgentRuntimeCore({
      provider,
      prompt: userMessage,
      systemPrompt: systemPromptLines.join("\n"),
      tools,
      maxTurns: 10,
      persistSession: false,
    }),
  );

  if (recordWorkflowStep) {
    const firstModel = Object.keys(result.usage.byModel)[0] ?? provider.modelId;
    await recordWorkflowStep(
      {
        platform: outputPlatform,
        contextType: "scheduled_task",
        userId: task.created_by,
        workspaceKey: resolveWorkspaceKey(task),
      },
      {
        model: firstModel,
        inputTokens: result.usage.totalInputTokens,
        outputTokens: result.usage.totalOutputTokens,
        cacheReadTokens: result.usage.totalCacheReadTokens,
        cacheCreationTokens: result.usage.totalCacheWriteTokens,
        sdkCostUsd: result.cost.totalUsd,
      },
    );
  }

  logger.info(
    {
      stepId: step.id,
      responseLength: result.finalText.length,
      runtime: "aisdk",
      stopReason: result.stopReason,
      numTurns: result.num_turns,
    },
    "Automation agent: AI SDK light step completed",
  );

  return result.finalText;
}

async function executeSketchAgentStep(params: AgentStepParams): Promise<unknown> {
  const {
    prompt,
    step,
    input,
    task,
    logger,
    workspaceDir,
    outputPlatform,
    creator,
    creatorEmail,
    runAgent: runSketchAgent,
    buildMcpServers,
  } = params;

  if (!runSketchAgent) {
    throw new Error("Sketch-mode workflow agent is not available.");
  }

  if (step.agentSkills?.some((skill) => cliSkillRequiredEnv(skill).length > 0)) {
    const env = params.listAgentEnvForRuntime
      ? await params.listAgentEnvForRuntime({
          currentUserId: task.created_by,
          contextType: "scheduled_task",
          allowOrgSharedEnv: true,
          taskContext: buildRunAgentTaskContext(task),
        })
      : {};
    if (!env.GH_TOKEN) {
      throw new Error("GitHub connection required for this automation step. Reconnect GitHub in Sketch Integrations.");
    }
  }

  const userMessage = buildSketchContext({
    messages: [],
    currentUserName: creator?.name ?? "Automation creator",
    currentUserEmail: creatorEmail,
    currentMessage: [
      "You are executing one step of a scheduled workflow.",
      "Complete the step using the provided input and available tools.",
      ...(params.isMessageDeliveryStep
        ? [
            "This is the final Slack or WhatsApp message delivery. Return only a concise, human-readable message body.",
            ...buildAutomationMessageDeliveryLines(outputPlatform),
          ]
        : ["Do not ask follow-up questions. Return the result for the next workflow step or final delivery."]),
      "",
      `Step: ${step.label}`,
      "",
      "Step prompt:",
      prompt,
      "",
      "Input from previous step:",
      JSON.stringify(input ?? null, null, 2),
    ].join("\n"),
    workspaceDir,
    orgDir: params.config.CLAUDE_CONFIG_DIR,
    timezone: task.timezone,
    taskPrompt: task.title ?? task.prompt,
  });

  const integrationMcpServers = buildMcpServers ? await buildMcpServers(creatorEmail) : {};
  const inheritsParentAbort = params.propagateParentAbort !== false && params.parentAbortSignal !== undefined;
  const abortController = inheritsParentAbort ? createChildAbortController(params.parentAbortSignal) : undefined;
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runSketchAgent({
      db: params.db,
      workspaceKey: resolveWorkspaceKey(task),
      userMessage,
      workspaceDir,
      claudeConfigDir: params.config.CLAUDE_CONFIG_DIR,
      userName: creator?.name ?? "Automation",
      userEmail: creatorEmail,
      logger,
      platform: outputPlatform,
      onProgressEvent: async () => {},
      integrationMcpServers,
      getSlack: params.getSlack,
      loadIntegrationProvider: params.loadIntegrationProvider,
      cliIntegrations: params.cliIntegrations,
      agentEnv: params.listAgentEnvForRuntime
        ? await params.listAgentEnvForRuntime({
            currentUserId: task.created_by,
            contextType: "scheduled_task",
            allowOrgSharedEnv: true,
            taskContext: buildRunAgentTaskContext(task),
          })
        : undefined,
      sessionMode: "fresh",
      contextType: "scheduled_task",
      currentUserId: task.created_by,
      taskContext: buildRunAgentTaskContext(task),
      agentSkillIds: step.agentSkills ?? null,
      userRepo: params.userRepo,
      inboxMessagesRepo: params.inboxMessagesRepo,
      sendDm: params.sendDm,
      sendTargetMessage: params.sendTargetMessage,
      toolConfig: { BASE_URL: params.config.BASE_URL, PORT: params.config.PORT },
      model: step.agentModel,
      maxTurns: 50,
      ...(abortController ? { abortController } : {}),
    });
  } catch (err) {
    if (abortController?.signal.aborted) throw new AutomationRunAbortedError();
    throw err;
  }

  if (abortController?.signal.aborted || result.rawUsage.stopReason === "aborted") {
    throw new AutomationRunAbortedError();
  }

  if (result.pendingUploads.length > 0) {
    logger.warn(
      { stepId: step.id, pendingUploads: result.pendingUploads.length },
      "Automation agent: sketch-mode file uploads were produced but cannot be delivered from workflow steps",
    );
  }

  logger.info(
    {
      stepId: step.id,
      responseLength: result.trace.finalText?.length ?? 0,
      toolCalls: result.rawUsage.toolCalls.length,
    },
    "Automation agent: sketch-mode step completed",
  );

  return result.trace.finalText ?? "";
}

// --- Context file writer ---

async function writeAutomationContext(params: {
  workspaceDir: string;
  taskId: string;
  runId: string;
  title: string;
  triggerSummary: string;
  steps: Array<{ label: string; status: string; duration_ms: number; outputSummary?: string }>;
  logger: Logger;
}): Promise<void> {
  const contextDir = join(params.workspaceDir, ".workflow-context");
  try {
    await mkdir(contextDir, { recursive: true });
    const statusIcon = (s: string) => (s === "completed" ? "\u2713" : s === "failed" ? "\u2717" : "\u2014");

    const lines = [
      `# Automation: ${params.title}`,
      `**Run:** ${new Date().toISOString()}`,
      `**Trigger:** ${params.triggerSummary}`,
      "",
      "## Steps Executed",
    ];

    for (let i = 0; i < params.steps.length; i++) {
      const step = params.steps[i];
      const duration = (step.duration_ms / 1000).toFixed(1);
      lines.push(`${i + 1}. ${statusIcon(step.status)} ${step.label} (${duration}s)`);
      if (step.outputSummary) {
        lines.push(`   ${step.outputSummary}`);
      }
    }

    const fileName = `${params.taskId}-${params.runId}.md`;
    await writeFile(join(contextDir, fileName), lines.join("\n"), "utf-8");

    const files = await readdir(contextDir);
    const taskFiles = files.filter((f) => f.startsWith(params.taskId)).sort();
    if (taskFiles.length > 5) {
      const toDelete = taskFiles.slice(0, taskFiles.length - 5);
      for (const file of toDelete) {
        await rm(join(contextDir, file), { force: true }).catch(() => {});
      }
    }
  } catch (err) {
    params.logger.warn({ err, contextDir }, "Automation: context maintenance failed");
  }
}

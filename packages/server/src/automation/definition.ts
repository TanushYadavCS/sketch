import {
  type AutomationBuilderSaveRequest,
  type AutomationDefinition,
  type AutomationExecutionMode,
  type AutomationRun,
  type AutomationStepContent,
  type WorkflowEdge,
  type WorkflowStep,
  type WorkflowTriggerConfig,
  automationBuilderSaveRequestSchema,
  automationExecutionModeAllowsStep,
  automationExecutionModeSchema,
  recommendAutomationExecutionMode,
  stepOutputSchema,
  workflowEdgeSchema,
  workflowStepSchema,
  workflowStepUsesIntegrationActions,
} from "@sketch/shared";
import { Cron } from "croner";
import type { Selectable } from "kysely";
import type { AutomationRunRow } from "../db/repositories/automation-runs";
import type { StepContentRow } from "../db/repositories/automation-step-content";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { ScheduledTasksTable } from "../db/schema";
import { parseOnceSchedule } from "../scheduler/parse-once";
import { formatIntervalScheduleLabel, normalizeScheduleTriggerSteps } from "../scheduler/trigger-metadata";
import { resolveWorkflowDelivery } from "../workflows/delivery";
import { hasInvalidAutomationSketchToolNamespace, undeclaredAutomationSketchTools } from "./action-script";
import { addWebhookMetadata } from "./webhook";

export type BuilderValidationIssue = { code: string; message: string; path?: string };

export class AutomationValidationError extends Error {
  issues: BuilderValidationIssue[];

  constructor(issues: BuilderValidationIssue[]) {
    super("Automation definition is invalid");
    this.name = "AutomationValidationError";
    this.issues = issues;
  }
}

export function resolveStoredAutomationExecutionMode(value: string | null | undefined): AutomationExecutionMode {
  if (value === null || value === undefined || value.trim() === "") return "hybrid";
  const parsed = automationExecutionModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AutomationValidationError([
    {
      code: "EXECUTION_MODE_INVALID",
      message: `Unsupported automation execution mode "${value}"`,
      path: "executionMode",
    },
  ]);
}

const DEFAULT_SUPPORTED_TRIGGER_TYPES: readonly WorkflowTriggerConfig["type"][] = [
  "webhook",
  "schedule",
  "canvas",
  "slack_channel_message",
];

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeSteps(row: ScheduledTaskRow, normalizeScheduleTriggers = true): WorkflowStep[] {
  const parsed = parseJson<unknown>(row.steps, null);
  if (Array.isArray(parsed)) {
    const result = workflowStepSchema.array().safeParse(parsed);
    if (result.success && result.data.length > 0) {
      return normalizeScheduleTriggers ? normalizeTaskTriggerStep(row, result.data) : result.data;
    }
  }
  return [
    {
      id: "trigger",
      type: "trigger",
      label: "Schedule",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig:
        row.schedule_type === "external"
          ? { type: row.schedule_value === "canvas" ? "canvas" : "webhook" }
          : {
              type: "schedule",
              scheduleType: row.schedule_type as "cron" | "interval" | "once",
              scheduleValue: row.schedule_value,
              timezone: row.timezone,
            },
    },
    {
      id: "step1",
      type: "agent",
      label: row.title ?? row.prompt,
      icon: "sketch-ai",
      position: { x: 260, y: 0 },
      agentMode: "sketch",
    },
  ];
}

function normalizeTaskTriggerStep(row: ScheduledTaskRow, steps: WorkflowStep[]): WorkflowStep[] {
  if (row.schedule_type !== "cron" && row.schedule_type !== "interval" && row.schedule_type !== "once") return steps;
  const schedule = {
    scheduleType: row.schedule_type as "cron" | "interval" | "once",
    scheduleValue: row.schedule_value,
    timezone: row.timezone,
  } as const;
  const withLegacyTriggerConfig = steps.map((step) =>
    step.type === "trigger" && !step.triggerConfig
      ? { ...step, triggerConfig: { type: "schedule" as const, ...schedule } }
      : step,
  );
  return normalizeScheduleTriggerSteps(withLegacyTriggerConfig, schedule);
}

function safeEdges(row: ScheduledTaskRow, steps: WorkflowStep[]): WorkflowEdge[] {
  const parsed = parseJson<unknown>(row.edges, null);
  if (Array.isArray(parsed)) {
    const result = workflowEdgeSchema.array().safeParse(parsed);
    if (result.success && result.data.length > 0) return result.data;
  }
  return steps.slice(0, -1).map((step, index) => ({
    id: `${step.id}-${steps[index + 1].id}`,
    from: step.id,
    to: steps[index + 1].id,
  }));
}

function parseApps(value: string | null): string[] | null {
  const parsed = parseJson<unknown>(value, null);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function hasAutomationPlaceholderRowFields(row: ScheduledTaskRow): boolean {
  return (
    row.status === "paused" &&
    row.context_type === "dm" &&
    row.origin_platform === "web" &&
    Boolean(row.origin_conversation_id) &&
    row.origin_provider_thread_id === null &&
    row.origin_message_id === null &&
    row.title === "New automation" &&
    row.prompt === "Describe the automation." &&
    row.description === null &&
    automationExecutionModeSchema.safeParse(row.execution_mode ?? "hybrid").success &&
    row.schedule_type === "interval" &&
    row.schedule_value === "3600" &&
    row.next_run_at === null &&
    row.last_run_at === null &&
    row.session_mode === "fresh" &&
    row.output_target === row.delivery_target &&
    row.output_platform === row.platform &&
    row.output_thread_ts === row.thread_ts &&
    row.output_mode === "deliver" &&
    row.created_by !== null &&
    row.last_edited_by === row.created_by
  );
}

function compatibilityPlaceholderSteps(row: ScheduledTaskRow): WorkflowStep[] {
  return [
    {
      id: "trigger",
      type: "trigger",
      label: "Schedule",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig: {
        type: "schedule",
        scheduleType: "interval",
        scheduleValue: row.schedule_value,
        timezone: row.timezone,
      },
    },
    {
      id: "step1",
      type: "agent",
      label: "New automation",
      icon: "sketch-ai",
      position: { x: 260, y: 0 },
      agentMode: "sketch",
    },
  ];
}

export function isStrictAutomationPlaceholderRow(row: ScheduledTaskRow): boolean {
  return hasAutomationPlaceholderRowFields(row) && row.steps === null && row.edges === null && row.revision === 0;
}

export function isLegacyMaterializedAutomationPlaceholderRow(row: ScheduledTaskRow): boolean {
  if (!hasAutomationPlaceholderRowFields(row) || row.revision !== 1 || !row.steps || !row.edges) return false;
  const steps = workflowStepSchema.array().safeParse(parseJson<unknown>(row.steps, null));
  const edges = workflowEdgeSchema.array().safeParse(parseJson<unknown>(row.edges, null));
  if (!steps.success || !edges.success) return false;
  const expectedSteps = compatibilityPlaceholderSteps(row);
  const expectedEdges: WorkflowEdge[] = [{ id: "trigger-step1", from: "trigger", to: "step1" }];
  return (
    JSON.stringify(steps.data) === JSON.stringify(expectedSteps) &&
    JSON.stringify(edges.data) === JSON.stringify(expectedEdges)
  );
}

export function isAutomationPlaceholderDraft(params: {
  row: ScheduledTaskRow;
  stepContentRows: readonly StepContentRow[];
  runRows?: readonly AutomationRunRow[];
}): boolean {
  const { row, stepContentRows, runRows = [] } = params;
  return (
    (isStrictAutomationPlaceholderRow(row) || isLegacyMaterializedAutomationPlaceholderRow(row)) &&
    stepContentRows.length === 0 &&
    runRows.length === 0
  );
}

function contentFromRows(row: ScheduledTaskRow, steps: WorkflowStep[], rows: StepContentRow[]) {
  const byStepId: Record<string, AutomationStepContent> = {};
  for (const content of rows) {
    byStepId[content.step_id] = {
      taskId: content.task_id,
      stepId: content.step_id,
      contentType: content.content_type === "script" ? "script" : "prompt",
      content: content.content,
      apps: parseApps(content.apps),
      updatedAt: content.updated_at,
    };
  }
  if (!row.steps) {
    const agentStep = steps.find((step) => step.type === "agent");
    if (agentStep && !byStepId[agentStep.id]) {
      byStepId[agentStep.id] = {
        taskId: row.id,
        stepId: agentStep.id,
        contentType: "prompt",
        content: row.prompt,
        apps: null,
        updatedAt: row.updated_at,
      };
    }
  }
  return byStepId;
}

function parseRun(row: AutomationRunRow): AutomationRun {
  const rawOutputs = parseJson<Record<string, unknown>>(row.step_outputs, {});
  const stepOutputs: AutomationRun["stepOutputs"] = {};
  for (const [stepId, value] of Object.entries(rawOutputs)) {
    const parsed = stepOutputSchema.safeParse(value);
    if (parsed.success) stepOutputs[stepId] = parsed.data;
  }
  return {
    id: row.id,
    taskId: row.task_id,
    triggerData: parseJson<unknown>(row.trigger_data, null),
    status: row.status === "completed" || row.status === "failed" ? row.status : "running",
    stepOutputs,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function buildAutomationDefinition(params: {
  row: ScheduledTaskRow;
  stepContentRows: StepContentRow[];
  runRows: AutomationRunRow[];
  normalizeScheduleTriggers?: boolean;
  createdByName?: string | null;
  lastEditedByName?: string | null;
  webhookBaseUrl?: string | null;
  webhookPort?: number;
}): AutomationDefinition {
  const steps = safeSteps(params.row, params.normalizeScheduleTriggers).map((step) => {
    if (step.type !== "trigger" || !step.triggerConfig || params.webhookBaseUrl === undefined) return step;
    return {
      ...step,
      triggerConfig: addWebhookMetadata(step.triggerConfig, params.row.id, {
        baseUrl: params.webhookBaseUrl,
        port: params.webhookPort,
      }),
    };
  });
  const edges = safeEdges(params.row, steps);
  const delivery = resolveWorkflowDelivery(params.row);
  const executionMode = resolveStoredAutomationExecutionMode(params.row.execution_mode);
  const recentRuns = params.runRows.map(parseRun);
  const isPlaceholderDraft = isAutomationPlaceholderDraft({
    row: params.row,
    stepContentRows: params.stepContentRows,
    runRows: params.runRows,
  });
  return {
    id: params.row.id,
    platform: params.row.platform === "whatsapp" ? "whatsapp" : "slack",
    contextType:
      params.row.context_type === "group" ? "group" : params.row.context_type === "channel" ? "channel" : "dm",
    deliveryTarget: params.row.delivery_target,
    threadTs: params.row.thread_ts,
    prompt: params.row.prompt,
    executionMode,
    executionModeRecommendation: recommendAutomationExecutionMode(steps, { legacy: !params.row.steps }),
    scheduleType:
      params.row.schedule_type === "interval" ||
      params.row.schedule_type === "once" ||
      params.row.schedule_type === "external"
        ? params.row.schedule_type
        : "cron",
    scheduleValue: params.row.schedule_value,
    timezone: params.row.timezone,
    sessionMode: "fresh",
    nextRunAt: params.row.next_run_at,
    lastRunAt: params.row.last_run_at,
    status:
      params.row.status === "paused" || params.row.status === "completed" || params.row.status === "active"
        ? params.row.status
        : "paused",
    isPlaceholderDraft,
    createdBy: params.row.created_by,
    createdByName: params.createdByName ?? null,
    createdAt: params.row.created_at,
    updatedAt: params.row.updated_at,
    revision: params.row.revision,
    lastEditedBy: params.row.last_edited_by,
    lastEditedByName: params.lastEditedByName ?? null,
    title: params.row.title,
    description: params.row.description,
    originChat:
      params.row.origin_conversation_id &&
      (params.row.origin_platform === "web" ||
        params.row.origin_platform === "slack" ||
        params.row.origin_platform === "whatsapp")
        ? {
            platform: params.row.origin_platform,
            conversationId: params.row.origin_conversation_id,
            providerThreadId: params.row.origin_provider_thread_id,
            currentMessageId: params.row.origin_message_id,
          }
        : null,
    delivery,
    steps,
    edges,
    stepContent: contentFromRows(params.row, steps, params.stepContentRows),
    latestRun: recentRuns[0] ?? null,
    recentRuns,
  };
}

export function formatAutomationScheduleLabel(
  definition: Pick<AutomationDefinition, "scheduleType" | "scheduleValue" | "timezone" | "steps">,
): string {
  if (definition.scheduleType === "external") {
    const trigger = definition.steps.find((step) => step.type === "trigger")?.triggerConfig;
    if (trigger?.type === "slack_channel_message") {
      return `Slack channel message${trigger.channelId ? ` - ${trigger.channelId}` : ""}`;
    }
    if (trigger?.type === "canvas") {
      const parts = ["Canvas"];
      if (trigger.app) parts.push(trigger.app);
      if (trigger.eventDescription) parts.push(trigger.eventDescription);
      return parts.join(" - ");
    }
    return "External trigger";
  }
  if (definition.scheduleType === "interval") return formatIntervalScheduleLabel(definition.scheduleValue);
  if (definition.scheduleType === "once") return `Once: ${definition.scheduleValue} (${definition.timezone})`;
  return `Cron: ${definition.scheduleValue} (${definition.timezone})`;
}

export function parseAutomationBuilderSaveRequest(value: unknown): AutomationBuilderSaveRequest {
  return automationBuilderSaveRequestSchema.parse(value);
}

function parsePersistedSteps(row: ScheduledTaskRow, issues: BuilderValidationIssue[]): WorkflowStep[] {
  if (row.steps === null) return safeSteps(row);

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.steps) as unknown;
  } catch {
    addIssue(issues, "PERSISTED_STEPS_INVALID", "Stored automation steps are not valid JSON", "steps");
    return [];
  }

  const result = workflowStepSchema.array().safeParse(parsed);
  if (!result.success) {
    addIssue(
      issues,
      "PERSISTED_STEPS_INVALID",
      `Stored automation steps are invalid: ${result.error.issues[0]?.message ?? "invalid step"}`,
      "steps",
    );
    return [];
  }
  return normalizeTaskTriggerStep(row, result.data);
}

function parsePersistedEdges(
  row: ScheduledTaskRow,
  steps: WorkflowStep[],
  issues: BuilderValidationIssue[],
): WorkflowEdge[] {
  if (row.edges === null) return safeEdges(row, steps);

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.edges) as unknown;
  } catch {
    addIssue(issues, "PERSISTED_EDGES_INVALID", "Stored automation edges are not valid JSON", "edges");
    return [];
  }

  const result = workflowEdgeSchema.array().safeParse(parsed);
  if (!result.success) {
    addIssue(
      issues,
      "PERSISTED_EDGES_INVALID",
      `Stored automation edges are invalid: ${result.error.issues[0]?.message ?? "invalid edge"}`,
      "edges",
    );
    return [];
  }
  return result.data;
}

export interface ValidatedPersistedAutomationDefinition {
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
}

export function validatePersistedAutomationDefinition(params: {
  task: ScheduledTaskRow;
  stepContentRows: StepContentRow[];
}): ValidatedPersistedAutomationDefinition {
  const { task, stepContentRows } = params;
  const issues: BuilderValidationIssue[] = [];
  const steps = parsePersistedSteps(task, issues);
  const edges = parsePersistedEdges(task, steps, issues);
  const stepContent = contentFromRows(task, steps, stepContentRows);

  for (const row of stepContentRows) {
    if (row.content_type !== "prompt" && row.content_type !== "script") {
      addIssue(
        issues,
        "PERSISTED_CONTENT_INVALID",
        `Stored content for step "${row.step_id}" has an unsupported content type`,
        `stepContent.${row.step_id}`,
      );
    }
  }

  const storedExecutionModeValue = (task as ScheduledTaskRow & { execution_mode?: unknown }).execution_mode;
  const storedExecutionMode =
    typeof storedExecutionModeValue === "string" && storedExecutionModeValue.trim().length > 0
      ? { executionMode: storedExecutionModeValue }
      : {};

  const parsedRequest = automationBuilderSaveRequestSchema.safeParse({
    title: task.title,
    description: task.description,
    prompt: task.prompt,
    ...storedExecutionMode,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    timezone: task.timezone,
    status: task.status,
    delivery: resolveWorkflowDelivery(task),
    steps,
    edges,
    stepContent,
  });

  if (!parsedRequest.success) {
    for (const issue of parsedRequest.error.issues) {
      addIssue(
        issues,
        "PERSISTED_DEFINITION_INVALID",
        issue.message,
        issue.path.length > 0 ? issue.path.map(String).join(".") : undefined,
      );
    }
  } else {
    try {
      validateAutomationBuilderSaveRequest({ request: parsedRequest.data, brokerCapable: true });
    } catch (error) {
      if (error instanceof AutomationValidationError) {
        for (const issue of error.issues) addIssue(issues, issue.code, issue.message, issue.path);
      } else {
        throw error;
      }
    }
  }

  if (issues.length > 0) throw new AutomationValidationError(issues);
  return {
    steps: parsedRequest.success ? parsedRequest.data.steps : steps,
    edges: parsedRequest.success ? parsedRequest.data.edges : edges,
  };
}

function addIssue(issues: BuilderValidationIssue[], code: string, message: string, path?: string): void {
  const issue = path ? { code, message, path } : { code, message };
  if (issues.some((existing) => existing.code === code && existing.message === message && existing.path === path)) {
    return;
  }
  issues.push(issue);
}

export function validateAutomationBuilderSaveRequest(params: {
  request: AutomationBuilderSaveRequest;
  brokerCapable: boolean;
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][];
}): void {
  const { request } = params;
  const issues = validateWorkflowGraph(request.steps, request.edges);
  if (request.status !== "paused") {
    for (const issue of validateAutomationExecutionMode(request.executionMode, request.steps)) {
      addIssue(issues, issue.code, issue.message, issue.path);
    }
  }

  const terminalStepIds = new Set(request.steps.map((step) => step.id));
  for (const edge of request.edges) terminalStepIds.delete(edge.from);

  for (const step of request.steps) {
    const content = request.stepContent[step.id];
    const isEmptyPausedAgentPlaceholder =
      request.status === "paused" &&
      step.type === "agent" &&
      step.id === "step1" &&
      step.label === (request.title ?? request.prompt) &&
      !content;
    if (
      step.type === "agent" &&
      !isEmptyPausedAgentPlaceholder &&
      (!content || content.contentType !== "prompt" || !content.content.trim())
    ) {
      addIssue(
        issues,
        "AGENT_PROMPT_REQUIRED",
        `Agent step "${step.label}" requires prompt content`,
        `stepContent.${step.id}`,
      );
    }
    if (step.type === "action") {
      if (!content || content.contentType !== "script" || !content.content.trim()) {
        addIssue(
          issues,
          "ACTION_SCRIPT_REQUIRED",
          `Action step "${step.label}" requires script content`,
          `stepContent.${step.id}`,
        );
      }
      if (content?.contentType === "script") {
        if (
          request.delivery.mode === "deliver" &&
          terminalStepIds.has(step.id) &&
          /\breturn\s*(?:\(\s*)?\{/.test(content.content)
        ) {
          addIssue(
            issues,
            "DELIVERY_MESSAGE_STRING_REQUIRED",
            `Final delivery action step "${step.label}" must return a non-empty human-readable string, not an object`,
            `stepContent.${step.id}`,
          );
        }
        if (hasInvalidAutomationSketchToolNamespace(content.content)) {
          addIssue(
            issues,
            "SKETCH_TOOL_NAMESPACE_INVALID",
            `Action step "${step.label}" must call Sketch tools through ctx.tools, not ctx.sketch or ctx.sketchTools`,
            `stepContent.${step.id}`,
          );
        }
        for (const tool of undeclaredAutomationSketchTools(
          content.content,
          step.actionCapabilities?.sketchTools ?? [],
        )) {
          addIssue(
            issues,
            "SKETCH_TOOL_NOT_DECLARED",
            `Action step "${step.label}" calls ctx.tools.${tool} but does not declare that capability`,
            `stepContent.${step.id}`,
          );
        }
      }
      if (step.actionCapabilities) {
        if (!step.actionCapabilities.usesIntegrationActions && step.actionCapabilities.sketchTools.length === 0) {
          addIssue(
            issues,
            "ACTION_CAPABILITIES_REQUIRED",
            `Action step "${step.label}" must declare a Sketch tool or integration action capability`,
            `steps.${step.id}.actionCapabilities`,
          );
        }
        const duplicateTools = [
          ...new Set(step.actionCapabilities.sketchTools.filter((tool, index, tools) => tools.indexOf(tool) !== index)),
        ];
        if (duplicateTools.length > 0) {
          addIssue(
            issues,
            "DUPLICATE_SKETCH_TOOL",
            `Action step "${step.label}" declares the Sketch tool "${duplicateTools[0]}" more than once`,
            `steps.${step.id}.actionCapabilities.sketchTools`,
          );
        }
      }
      if (!params.brokerCapable && workflowStepUsesIntegrationActions(step)) {
        addIssue(
          issues,
          "BROKER_REQUIRED",
          `Action step "${step.label}" requires a broker-capable integration provider`,
          `steps.${step.id}`,
        );
      }
    }
    if (step.type !== "action" && step.actionCapabilities) {
      addIssue(
        issues,
        "ACTION_CAPABILITIES_ACTION_ONLY",
        `Step "${step.label}" can only declare action capabilities when it is an action step`,
        `steps.${step.id}.actionCapabilities`,
      );
    }
  }

  validateTriggerCapability(
    request.steps.find((step) => step.type === "trigger"),
    params.supportedTriggerTypes ?? DEFAULT_SUPPORTED_TRIGGER_TYPES,
    issues,
  );

  validateTriggerSchedule(
    request,
    request.steps.find((step) => step.type === "trigger"),
    issues,
  );
  validateScheduleValue(request, issues);

  if (issues.length > 0) throw new AutomationValidationError(issues);
}

export function validateAutomationExecutionMode(
  mode: AutomationExecutionMode,
  steps: readonly Pick<WorkflowStep, "id" | "type" | "label">[],
): BuilderValidationIssue[] {
  const issues: BuilderValidationIssue[] = [];
  for (const step of steps) {
    if (automationExecutionModeAllowsStep(mode, step.type)) continue;
    if (mode === "deterministic" && step.type === "agent") {
      addIssue(
        issues,
        "DETERMINISTIC_MODE_AGENT_STEP",
        `Fixed recipe mode cannot include agent step "${step.label}"`,
        `steps.${step.id}`,
      );
    } else if (mode === "agent-led" && step.type === "action") {
      addIssue(
        issues,
        "AGENT_LED_MODE_ACTION_STEP",
        `Agent-led mode cannot include code or action step "${step.label}"`,
        `steps.${step.id}`,
      );
    }
  }
  return issues;
}

function validateTriggerCapability(
  trigger: WorkflowStep | undefined,
  supportedTriggerTypes: readonly WorkflowTriggerConfig["type"][],
  issues: BuilderValidationIssue[],
): void {
  const type = trigger?.triggerConfig?.type;
  if (!type || supportedTriggerTypes.includes(type)) return;
  addIssue(
    issues,
    "UNSUPPORTED_TRIGGER",
    `Trigger type "${type}" is not supported by the current automation capability set`,
    `steps.${trigger?.id ?? "trigger"}.triggerConfig.type`,
  );
}

export function validateWorkflowGraph(steps: WorkflowStep[], edges: WorkflowEdge[]): BuilderValidationIssue[] {
  const issues: BuilderValidationIssue[] = [];
  const stepIds = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();

  for (const step of steps) {
    if (stepIds.has(step.id)) addIssue(issues, "DUPLICATE_STEP_ID", `Duplicate step id "${step.id}"`, "steps");
    stepIds.add(step.id);
  }

  const triggers = steps.filter((step) => step.type === "trigger");
  if (triggers.length !== 1)
    addIssue(issues, "TRIGGER_COUNT", "Automation must have exactly one trigger step", "steps");
  if (steps.every((step) => step.type === "trigger")) {
    addIssue(issues, "MISSING_EXECUTION_STEP", "Automation must have at least one non-trigger step", "steps");
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!stepIds.has(edge.from))
      addIssue(issues, "EDGE_SOURCE_MISSING", `Edge source "${edge.from}" does not exist`, "edges");
    if (!stepIds.has(edge.to))
      addIssue(issues, "EDGE_TARGET_MISSING", `Edge target "${edge.to}" does not exist`, "edges");
    if (edge.from === edge.to) addIssue(issues, "SELF_EDGE", "Edges cannot connect a step to itself", "edges");
    const edgeKey = `${edge.from}:${edge.to}`;
    if (edgeKeys.has(edgeKey)) addIssue(issues, "DUPLICATE_EDGE", `Duplicate edge "${edgeKey}"`, "edges");
    edgeKeys.add(edgeKey);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  if (edges.length === 0) addIssue(issues, "MISSING_EDGES", "Automation graph must include edges", "edges");
  for (const [stepId, count] of outgoing.entries()) {
    if (count > 1) addIssue(issues, "FAN_OUT_UNSUPPORTED", `Step "${stepId}" has multiple outgoing edges`, "edges");
  }

  const trigger = triggers[0];
  if (trigger) {
    for (const step of steps) {
      const incomingCount = incoming.get(step.id) ?? 0;
      if (step.id === trigger.id && incomingCount > 0) {
        addIssue(issues, "TRIGGER_INCOMING_EDGE", "Trigger step cannot have incoming edges", "edges");
      }
      if (step.id !== trigger.id && incomingCount === 0) {
        addIssue(issues, "ROOT_NOT_TRIGGER", `Step "${step.id}" has no incoming edge`, "edges");
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    for (const next of adjacency.get(stepId) ?? []) {
      if (!visit(next)) return false;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  };

  for (const step of steps) {
    if (!visit(step.id)) {
      addIssue(issues, "CYCLE", "Automation graph must be acyclic", "edges");
      break;
    }
  }

  if (trigger) {
    const reachable = new Set<string>();
    const stack = [trigger.id];
    while (stack.length > 0) {
      const stepId = stack.pop();
      if (!stepId || reachable.has(stepId)) continue;
      reachable.add(stepId);
      stack.push(...(adjacency.get(stepId) ?? []));
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) {
        addIssue(issues, "UNREACHABLE_STEP", `Step "${step.id}" is not reachable from the trigger`, "edges");
      }
    }
  }

  return issues;
}

function validateTriggerSchedule(
  request: AutomationBuilderSaveRequest,
  trigger: WorkflowStep | undefined,
  issues: BuilderValidationIssue[],
): void {
  const config = trigger?.triggerConfig;
  if (!config) {
    addIssue(issues, "TRIGGER_CONFIG_REQUIRED", "Trigger step requires trigger config", "steps");
    return;
  }
  if (request.scheduleType === "external") {
    if (config.type !== "webhook" && config.type !== "canvas" && config.type !== "slack_channel_message") {
      addIssue(
        issues,
        "TRIGGER_CONFIG_MISMATCH",
        "External automations require webhook, canvas, or Slack channel message trigger config",
        "steps",
      );
    }
    if (config.type === "slack_channel_message") {
      if (request.scheduleValue !== "slack_channel_message") {
        addIssue(
          issues,
          "TRIGGER_CONFIG_MISMATCH",
          "Slack channel message triggers require schedule value slack_channel_message",
          "scheduleValue",
        );
      }
      if (!config.channelId) {
        addIssue(issues, "TRIGGER_CONFIG_REQUIRED", "Slack channel message trigger requires channelId", "steps");
      }
    }
    return;
  }
  if (config.type !== "schedule") {
    addIssue(issues, "TRIGGER_CONFIG_MISMATCH", "Scheduled automations require schedule trigger config", "steps");
    return;
  }
  if (
    config.scheduleType !== request.scheduleType ||
    config.scheduleValue !== request.scheduleValue ||
    config.timezone !== request.timezone
  ) {
    addIssue(issues, "SCHEDULE_TRIGGER_MISMATCH", "Trigger schedule config must match schedule fields", "steps");
  }
}

function validateScheduleValue(request: AutomationBuilderSaveRequest, issues: BuilderValidationIssue[]): void {
  if (request.scheduleType === "external") return;
  if (request.scheduleType === "interval") {
    const seconds = Number(request.scheduleValue);
    if (!Number.isFinite(seconds) || seconds < 60) {
      addIssue(issues, "INVALID_INTERVAL", "Interval schedule value must be at least 60 seconds", "scheduleValue");
    }
    if (seconds > 86400) {
      addIssue(
        issues,
        "INVALID_INTERVAL",
        "Interval schedule value must be seconds, not milliseconds",
        "scheduleValue",
      );
    }
  }
  if (request.scheduleType === "cron") {
    try {
      new Cron(request.scheduleValue, { timezone: request.timezone });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addIssue(issues, "INVALID_CRON", `Invalid cron expression: ${message}`, "scheduleValue");
    }
  }
  if (request.scheduleType === "once") {
    const runAt = parseOnceSchedule(request.scheduleValue, request.timezone);
    if (Number.isNaN(runAt.getTime())) {
      addIssue(issues, "INVALID_ONCE", "Once schedule value must be a valid ISO 8601 datetime", "scheduleValue");
    } else if (runAt.getTime() <= Date.now()) {
      addIssue(issues, "INVALID_ONCE", "Once schedule value must be in the future", "scheduleValue");
    }
  }
}

export function scheduledTaskFieldsFromSaveRequest(
  request: AutomationBuilderSaveRequest,
): Partial<Selectable<ScheduledTasksTable>> {
  const trigger = request.steps.find((step) => step.type === "trigger")?.triggerConfig;
  const isSlackChannelMessage = trigger?.type === "slack_channel_message";
  return {
    prompt: request.prompt,
    execution_mode: request.executionMode,
    schedule_type: isSlackChannelMessage ? "external" : request.scheduleType,
    schedule_value: isSlackChannelMessage ? "slack_channel_message" : request.scheduleValue,
    timezone: request.timezone,
    status: request.status,
    title: request.title,
    description: request.description,
    steps: JSON.stringify(request.steps),
    edges: JSON.stringify(request.edges),
    output_target: request.delivery.targetId,
    output_platform: request.delivery.platform,
    output_thread_ts: request.delivery.threadTs,
    output_mode: request.delivery.mode,
  };
}

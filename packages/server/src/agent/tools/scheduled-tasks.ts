import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { createAutomationRunsRepository } from "../../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../../db/repositories/automation-step-content";
import type { IntegrationProvider } from "../../integrations/types";
import { parseOnceSchedule } from "../../scheduler/parse-once";
import { getActiveTaskContextQueueKey, getScheduledTaskQueueKey } from "../../scheduler/queue-key";
import type { TaskScheduler } from "../../scheduler/service";
import {
  formatIntervalScheduleLabel,
  normalizeScheduleTriggerSteps,
  normalizeScheduleTriggerStepsJson,
} from "../../scheduler/trigger-metadata";
import type { ScheduledTask, TaskContext } from "../../scheduler/types";
import type { WorkflowStep } from "../../workflows/types";
import type { AutomationArtifactCollector, SearchableUserRepo } from "./types";

const workflowStepSchema = z.object({
  id: z.string(),
  type: z.enum(["trigger", "action", "agent"]),
  label: z.string(),
  icon: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  script: z
    .string()
    .optional()
    .describe("Script content for action steps. Stored in automation_step_content, not in steps JSON."),
  agentPrompt: z
    .string()
    .optional()
    .describe("Prompt content for agent steps. Stored in automation_step_content, not in steps JSON."),
  apps: z.array(z.string()).optional().describe("MCP server slugs this step uses (e.g. ['clickup', 'slack'])."),
  agentMode: z.enum(["light", "sketch"]).optional(),
  agentSkills: z.array(z.string()).optional(),
  agentModel: z.string().optional(),
  agentMcpServers: z.array(z.string()).optional(),
  timeout: z.number().optional().describe("Step timeout in seconds. Default: 1800 (30 min)."),
  triggerConfig: z
    .object({
      type: z.enum(["webhook", "schedule", "canvas"]),
      scheduleType: z.enum(["cron", "interval", "once"]).optional(),
      scheduleValue: z.string().optional(),
      timezone: z.string().optional(),
      app: z.string().optional().describe("Source app for Canvas-managed triggers, e.g. 'clickup' or 'linear'."),
      eventDescription: z.string().optional().describe("Human-readable event description, e.g. 'new issue created'."),
      componentKey: z.string().optional().describe("Canvas trigger component ID/key found through search_components."),
      configuredProps: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(["pending_canvas_setup", "active", "error"]).optional(),
      canvasWorkflowId: z.string().optional(),
      canvasTriggerNodeId: z.string().optional(),
      canvasActionNodeId: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .describe(
      "Use type 'canvas' for Canvas-managed external triggers. Use it only when a Canvas skill/MCP has selected a trigger component via search_components; otherwise create a normal schedule trigger fallback.",
    )
    .optional(),
});

const deliverySchema = z.object({
  platform: z.enum(["slack", "whatsapp"]).optional(),
  targetType: z.enum(["dm", "channel", "group", "thread"]).optional(),
  targetId: z.string().min(1).optional(),
  threadTs: z.string().min(1).nullable().optional(),
  mode: z.enum(["deliver", "silent"]).optional(),
});

const manageScheduledTasksSchema = {
  action: z.enum(["list", "add", "update", "remove", "pause", "resume", "run", "getRun", "updateStepContent"]).describe(
    `Action to perform.
- 'add': create an automation (simple: prompt + schedule_type + schedule_value; multi-step: title + steps)
- 'list': list automations in this context
- 'update': modify an automation (requires task_id)
- 'remove': delete an automation (requires task_id)
- 'pause': pause an automation (requires task_id)
- 'resume': resume a paused automation (requires task_id)
- 'run': manually trigger an automation (requires task_id)
- 'getRun': inspect run results (requires task_id, optional run_id for specific run)
- 'updateStepContent': update a single step's prompt or script (requires task_id, step_id, step_content)`,
  ),
  prompt: z
    .string()
    .optional()
    .describe("The instruction the agent executes each run. For simple automations (no steps array)."),
  schedule_type: z
    .enum(["cron", "interval", "once"])
    .optional()
    .describe("'cron' for cron expressions, 'interval' for fixed second intervals, 'once' for a one-time run."),
  schedule_value: z
    .string()
    .optional()
    .describe(
      `For cron: standard 5-field expression (minute hour day-of-month month day-of-week). Always use 5-field, never 6-field. Examples: '*/2 * * * *' (every 2 min), '0 9 * * 1-5' (weekdays 9am), '0 */6 * * *' (every 6 hours).
For interval: number of seconds as a plain string, minimum 60. Examples: '120' (every 2 min), '3600' (every hour). Do not use duration strings like '2m' or '1h'.
For once: ISO 8601 datetime string. A naked local time (e.g. '2026-03-14T15:00:00') is interpreted in the resolved timezone (the user's tz unless 'timezone' is set explicitly). To pin an absolute instant regardless of timezone, include a Z suffix or numeric offset (e.g. '2026-03-14T15:00:00Z' or '2026-03-14T15:00:00+05:30'). The task runs once at this time then auto-completes.`,
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone (e.g. 'America/New_York', 'Asia/Kolkata'). Leave empty in the common case — the user's timezone (shown in <time>) is used automatically. Only set this when the user explicitly names a different timezone for the task.",
    ),
  session_mode: z
    .enum(["fresh"])
    .optional()
    .describe("Scheduled automations currently support only 'fresh': no memory, each run starts clean."),
  task_id: z.string().optional().describe("ID of the task. Required for update/remove/pause/resume/run/getRun."),
  title: z.string().optional().describe("Human-readable name. Required for multi-step automations."),
  description: z.string().optional().describe("Description of what this automation does."),
  steps: z
    .array(workflowStepSchema)
    .optional()
    .describe("Workflow steps. When provided, creates a multi-step automation."),
  edges: z
    .array(z.object({ id: z.string(), from: z.string(), to: z.string() }))
    .optional()
    .describe("Connections between workflow steps (optional in Phase 1)."),
  output_target: z.string().optional().describe("Channel/DM to send final output to."),
  output_platform: z.enum(["slack", "whatsapp"]).optional(),
  output_thread_ts: z
    .string()
    .nullable()
    .optional()
    .describe("Slack thread timestamp for final output. Use null to deliver top-level in the target channel."),
  output_mode: z
    .enum(["deliver", "silent"])
    .optional()
    .describe("Use 'silent' to record successful runs without sending final output to Slack or WhatsApp."),
  delivery: deliverySchema.optional().describe("Canonical final-output delivery destination for the workflow."),
  run_id: z.string().optional().describe("Run ID for getRun action. Omit for latest run."),
  step_id: z.string().optional().describe("Step ID for updateStepContent action."),
  step_content: z.string().optional().describe("New prompt or script content for updateStepContent action."),
  step_apps: z.array(z.string()).optional().describe("Updated MCP server slugs for updateStepContent action."),
};

type WorkflowStepInput = z.infer<typeof workflowStepSchema>;

type ManageScheduledTasksParams = {
  action: "list" | "add" | "update" | "remove" | "pause" | "resume" | "run" | "getRun" | "updateStepContent";
  prompt?: string;
  schedule_type?: "cron" | "interval" | "once" | "external";
  schedule_value?: string;
  timezone?: string;
  session_mode?: "fresh" | "persistent" | "chat";
  task_id?: string;
  title?: string;
  description?: string;
  steps?: WorkflowStepInput[];
  edges?: { id: string; from: string; to: string }[];
  output_target?: string;
  output_platform?: "slack" | "whatsapp";
  output_thread_ts?: string | null;
  output_mode?: "deliver" | "silent";
  delivery?: {
    platform?: "slack" | "whatsapp";
    targetType?: "dm" | "channel" | "group" | "thread";
    targetId?: string;
    threadTs?: string | null;
    mode?: "deliver" | "silent";
  };
  run_id?: string;
  step_id?: string;
  step_content?: string;
  step_apps?: string[];
};

export interface ManageScheduledTasksDeps {
  scheduler: TaskScheduler;
  taskContext: TaskContext;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  userRepo?: SearchableUserRepo;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  activeQueueKey?: string;
  config?: { BASE_URL?: string; PORT: number };
  automationArtifactCollector?: AutomationArtifactCollector;
}

function stripContentFromSteps(steps: WorkflowStepInput[]): WorkflowStep[] {
  return steps.map(({ script: _s, agentPrompt: _a, apps: _apps, ...step }) => step as WorkflowStep);
}

function isLocalScheduleType(value: unknown): value is "cron" | "interval" | "once" {
  return value === "cron" || value === "interval" || value === "once";
}

/**
 * Resolve the timezone for a scheduled task, in priority order:
 *   1. explicit `params.timezone`
 *   2. ambient `creatorTimezone` from the message context
 *   3. UTC fallback
 *
 * Empty / whitespace-only strings are treated as missing — nullish coalescing
 * alone would let `""` through and overwrite the creator's tz with an invalid
 * value (croner rejects it on cron, and non-cron tasks would silently land
 * with a blank timezone in the DB).
 */
function resolveScheduleTimezone(paramTz: string | undefined, ctxTz: string | null | undefined): string {
  const fromParam = paramTz?.trim();
  if (fromParam && fromParam.length > 0) return fromParam;
  const fromCtx = ctxTz?.trim();
  if (fromCtx && fromCtx.length > 0) return fromCtx;
  return "UTC";
}

function hasOwn<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function titleCaseWords(value: string): string {
  return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function formatDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^[a-z]+(?:[ ._-][a-z]+)*$/.test(trimmed)) {
    return titleCaseWords(trimmed.replace(/[._-]+/g, " "));
  }
  return trimmed;
}

function taskDisplayName(task: ScheduledTask): string {
  return task.title?.trim() || task.prompt.trim() || "this automation";
}

function guardedActionLabel(action: ManageScheduledTasksParams["action"]): string {
  if (action === "remove") return "delete";
  if (action === "resume") return "resume";
  if (action === "pause") return "pause";
  if (action === "run") return "run";
  if (action === "getRun") return "inspect";
  return "update";
}

async function resolveTaskOwnerName(task: ScheduledTask, userRepo: SearchableUserRepo | undefined): Promise<string> {
  if (!task.createdBy || !userRepo) return "another user";
  const owner = await userRepo.findById(task.createdBy).catch(() => undefined);
  return (
    formatDisplayName(owner?.name) ??
    formatDisplayName(owner?.email?.split("@")[0]) ??
    formatDisplayName(owner?.email) ??
    "another user"
  );
}

async function taskPermissionError(
  task: ScheduledTask,
  action: ManageScheduledTasksParams["action"],
  userRepo: SearchableUserRepo | undefined,
): Promise<string> {
  const ownerName = await resolveTaskOwnerName(task, userRepo);
  return `Error: You can't ${guardedActionLabel(action)} "${taskDisplayName(task)}" because it was created by ${ownerName}.`;
}

function buildDeliveryFields(params: ManageScheduledTasksParams, ctx: TaskContext) {
  const delivery = params.delivery;
  let outputPlatform = delivery?.platform ?? params.output_platform;
  let outputTarget = delivery?.targetId ?? params.output_target;
  const outputMode = delivery?.mode ?? params.output_mode;
  let outputThreadTs = params.output_thread_ts;
  const hasDeliveryTarget = delivery && (delivery.targetId !== undefined || delivery.targetType !== undefined);

  if (delivery && hasOwn(delivery, "threadTs")) {
    outputThreadTs = delivery.threadTs ?? null;
  } else if (delivery?.targetType === "thread") {
    outputTarget ??= ctx.deliveryTarget;
    outputPlatform ??= ctx.platform;
    outputThreadTs = ctx.threadTs ?? null;
  } else if (hasDeliveryTarget) {
    outputThreadTs = null;
  }

  return {
    outputTarget,
    outputPlatform,
    outputThreadTs,
    outputMode,
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }
  return result;
}

function displayPlatform(value: string): string {
  return value === "whatsapp" ? "WhatsApp" : "Slack";
}

function buildBuilderUrl(taskId: string, config: ManageScheduledTasksDeps["config"]): string {
  const path = `/scheduled-tasks/${encodeURIComponent(taskId)}/edit`;
  const base = config?.BASE_URL?.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function buildArtifactTags(params: {
  steps: WorkflowStepInput[];
  scheduleType: string;
  deliveryPlatform: string;
}): string[] {
  const trigger = params.steps.find((step) => step.type === "trigger");
  const apps = params.steps.flatMap((step) => step.apps ?? []);
  return uniqueStrings([
    trigger?.triggerConfig?.app,
    ...apps,
    displayPlatform(params.deliveryPlatform),
    params.scheduleType === "external" ? "Triggered" : "Scheduled",
  ]).slice(0, 5);
}

function buildArtifactScheduleLabel(params: {
  scheduleType: string;
  scheduleValue: string;
  timezone: string;
  steps: WorkflowStepInput[];
}): string {
  if (params.scheduleType === "external") {
    const trigger = params.steps.find((step) => step.type === "trigger")?.triggerConfig;
    if (trigger?.type === "canvas") {
      return uniqueStrings(["Canvas", trigger.app, trigger.eventDescription]).join(" - ") || "Canvas trigger";
    }
    return "External trigger";
  }
  if (params.scheduleType === "interval") return formatIntervalScheduleLabel(params.scheduleValue);
  if (params.scheduleType === "once") return `Once: ${params.scheduleValue} (${params.timezone})`;
  return `Cron: ${params.scheduleValue} (${params.timezone})`;
}

function collectAutomationArtifact(params: {
  deps: ManageScheduledTasksDeps;
  task: ScheduledTask;
  steps: WorkflowStepInput[];
  scheduleType: string;
  scheduleValue: string;
  timezone: string;
}): string {
  const builderUrl = buildBuilderUrl(params.task.id, params.deps.config);
  const delivery = params.task.delivery;
  const deliveryLabel =
    delivery.mode === "silent"
      ? "Silent"
      : `${displayPlatform(delivery.platform)} ${delivery.targetType === "thread" ? "thread" : delivery.targetType}`;

  params.deps.automationArtifactCollector?.collect({
    taskId: params.task.id,
    kind: "New automation",
    title: params.task.title ?? params.task.prompt,
    description: params.task.description ?? `${buildArtifactScheduleLabel(params)}. Delivery: ${deliveryLabel}.`,
    tags: buildArtifactTags({
      steps: params.steps,
      scheduleType: params.scheduleType,
      deliveryPlatform: delivery.platform,
    }),
    scheduleLabel: buildArtifactScheduleLabel(params),
    deliveryLabel,
    builderUrl,
    status: params.task.status,
  });
  return builderUrl;
}

export async function handleManageScheduledTasks(
  params: ManageScheduledTasksParams,
  deps: ManageScheduledTasksDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { action, task_id } = params;
  const ctx = deps.taskContext;

  const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }] });

  const BROKER_REQUIRED_MSG =
    "Error: Action steps require a broker-capable integration provider (e.g. Canvas MCP in skill mode). Configure one in Settings → Integrations, or use agent-only automations.";
  const FRESH_SESSION_ONLY_MSG =
    "Error: scheduled automations currently support only 'fresh' session_mode. Omit session_mode or set it to 'fresh'.";

  /** Returns an error response if any action step is present but no broker-capable
   *  provider is configured. Returns null when validation passes (no action steps,
   *  or a broker-capable provider exists). */
  const ensureBrokerForActionSteps = async (
    candidateSteps: WorkflowStepInput[] | undefined,
  ): Promise<ReturnType<typeof text> | null> => {
    if (!candidateSteps?.some((s) => s.type === "action")) return null;
    if (!deps.loadIntegrationProvider) return text(BROKER_REQUIRED_MSG);
    const provider = await deps.loadIntegrationProvider();
    if (!provider || !provider.isBrokerCapable()) return text(BROKER_REQUIRED_MSG);
    return null;
  };

  const OWNERSHIP_GUARDED_ACTIONS = ["update", "remove", "pause", "resume", "run", "getRun", "updateStepContent"];
  let guardedTask: ScheduledTask | null = null;
  if (task_id && OWNERSHIP_GUARDED_ACTIONS.includes(action)) {
    const task = await deps.scheduler.getTaskById(task_id);
    if (!ctx.createdBy || !task) {
      return text("Error: task not found.");
    }
    if (task.createdBy !== ctx.createdBy) {
      return text(await taskPermissionError(task, action, deps.userRepo));
    }
    guardedTask = task;
  }

  if (params.session_mode !== undefined && params.session_mode !== "fresh") {
    return text(FRESH_SESSION_ONLY_MSG);
  }

  switch (action) {
    case "list": {
      if (ctx.contextType === "dm") {
        if (!ctx.createdBy) {
          return text("Error: scheduled task creator is not available in this context.");
        }
        const tasks = await deps.scheduler.listTasks({ createdBy: ctx.createdBy });
        return text(JSON.stringify(tasks, null, 2));
      }
      const tasks = await deps.scheduler.listTasks({ deliveryTarget: ctx.deliveryTarget });
      return text(JSON.stringify(tasks, null, 2));
    }

    case "add": {
      // Multi-step: explicit steps array
      if (params.steps) {
        if (!params.title) {
          return text("Error: title is required when creating a multi-step automation.");
        }
        const triggerStep = params.steps.find((step) => step.type === "trigger");
        const isCanvasManagedTrigger = triggerStep?.triggerConfig?.type === "canvas";
        if (!isCanvasManagedTrigger && (!params.schedule_type || !params.schedule_value)) {
          return text("Error: schedule_type and schedule_value are required for add action.");
        }
        if (triggerStep?.triggerConfig?.type === "canvas") {
          params.schedule_type = "external";
          params.schedule_value = "canvas";
          triggerStep.triggerConfig = {
            ...triggerStep.triggerConfig,
            status: triggerStep.triggerConfig.status ?? "pending_canvas_setup",
          };
        }

        const brokerError = await ensureBrokerForActionSteps(params.steps);
        if (brokerError) return brokerError;
      } else if (params.prompt) {
        // Sugar: expand simple prompt into a single-step workflow
        if (!params.schedule_type || !params.schedule_value) {
          return text("Error: prompt, schedule_type, and schedule_value are required for add action.");
        }
        params.title = params.title ?? params.prompt;
        params.steps = [
          {
            id: "trigger",
            type: "trigger",
            label: "Schedule",
            icon: "clock",
            triggerConfig: { type: "schedule" },
            position: { x: 0, y: 0 },
          },
          {
            id: "step1",
            type: "agent",
            label: params.prompt.slice(0, 80),
            icon: "sketch-ai",
            agentMode: "sketch",
            agentPrompt: params.prompt,
            position: { x: 0, y: 100 },
          },
        ];
      } else {
        return text("Error: prompt or steps are required for add action.");
      }

      // Step structure validation
      {
        const stepIds = new Set<string>();
        for (const step of params.steps) {
          if (stepIds.has(step.id)) {
            return text(`Error: duplicate step ID '${step.id}'.`);
          }
          stepIds.add(step.id);
        }

        const executionSteps = params.steps.filter((s) => s.type !== "trigger");
        if (executionSteps.length === 0) {
          return text("Error: workflow must have at least one non-trigger step.");
        }

        for (const step of executionSteps) {
          if (step.type === "action" && !step.script) {
            return text(`Error: action step '${step.label}' requires a script.`);
          }
          if (step.type === "agent" && !step.agentPrompt) {
            return text(`Error: agent step '${step.label}' requires an agentPrompt.`);
          }
        }
      }

      // Schedule validation
      if (params.schedule_type === "interval") {
        const seconds = Number(params.schedule_value);
        if (!Number.isFinite(seconds) || seconds < 60) {
          return text(
            "Error: interval schedule_value must be a number of seconds (at least 60). Example: '120' for every 2 minutes.",
          );
        }
        if (seconds > 86400) {
          return text(
            "Error: interval schedule_value must be in seconds, not milliseconds. For 1 hour use '3600', not '3600000'.",
          );
        }
      }

      const resolvedTimezone = resolveScheduleTimezone(params.timezone, ctx.creatorTimezone);

      if (params.schedule_type === "cron") {
        try {
          const { Cron } = await import("croner");
          new Cron(params.schedule_value as string, { timezone: resolvedTimezone });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return text(`Error: invalid cron expression '${params.schedule_value}': ${msg}`);
        }
      }

      if (params.schedule_type === "once" && params.schedule_value) {
        const runAt = parseOnceSchedule(params.schedule_value, resolvedTimezone);
        if (Number.isNaN(runAt.getTime())) {
          return text(
            "Error: once schedule_value must be a valid ISO 8601 datetime string (e.g. '2026-03-14T15:00:00').",
          );
        }
        if (runAt.getTime() <= Date.now()) {
          return text("Error: once schedule_value must be a future datetime. The provided time is in the past.");
        }
      }

      const sessionMode = "fresh";
      const deliveryFields = buildDeliveryFields(params, ctx);

      // Strip content from steps (stored separately in automation_step_content)
      const steps = params.steps as NonNullable<typeof params.steps>;
      const title = params.title as string;
      const scheduleType = params.schedule_type as NonNullable<typeof params.schedule_type>;
      const scheduleValue = params.schedule_value as string;
      let stepsForDb = stripContentFromSteps(steps);
      if (isLocalScheduleType(scheduleType)) {
        stepsForDb = normalizeScheduleTriggerSteps(stepsForDb, {
          scheduleType,
          scheduleValue,
          timezone: resolvedTimezone,
        });
      }

      // Guard against silently dropping step content if the repo wasn't plumbed
      // through. Runs after input validation so user-input errors surface first.
      // Without this guard, prompts/scripts vanish at creation time and the
      // workflow fails at first run with 'has no prompt'.
      if (!deps.stepContentRepo && steps.some((s) => s.agentPrompt || s.script)) {
        return text(
          "Error: step content storage is not available in this context. Multi-step automations with prompts or scripts cannot be created.",
        );
      }

      const task = await deps.scheduler.addTask({
        platform: ctx.platform,
        contextType: ctx.contextType,
        deliveryTarget: ctx.deliveryTarget,
        threadTs: ctx.threadTs ?? null,
        prompt: title,
        scheduleType,
        scheduleValue,
        timezone: resolvedTimezone,
        sessionMode,
        createdBy: ctx.createdBy,
        title: params.title,
        description: params.description,
        steps: JSON.stringify(stepsForDb),
        edges: params.edges ? JSON.stringify(params.edges) : null,
        outputTarget: deliveryFields.outputTarget,
        outputPlatform: deliveryFields.outputPlatform,
        outputThreadTs: deliveryFields.outputThreadTs,
        outputMode: deliveryFields.outputMode,
      });

      // Store step content
      if (deps.stepContentRepo) {
        for (const step of steps) {
          if (step.agentPrompt) {
            await deps.stepContentRepo.upsert({
              taskId: task.id,
              stepId: step.id,
              contentType: "prompt",
              content: step.agentPrompt,
              apps: step.apps,
            });
          } else if (step.script) {
            await deps.stepContentRepo.upsert({
              taskId: task.id,
              stepId: step.id,
              contentType: "script",
              content: step.script,
              apps: step.apps,
            });
          }
        }
      }

      // Build webhook URL for webhook triggers
      const triggerStep = steps.find((s) => s.triggerConfig?.type === "webhook");
      let webhookUrl: string | undefined;
      if (triggerStep && deps.config) {
        const baseUrl = deps.config.BASE_URL ?? `http://localhost:${deps.config.PORT}`;
        webhookUrl = `${baseUrl}/api/webhooks/wf/${task.id}`;
      }

      collectAutomationArtifact({
        deps,
        task,
        steps,
        scheduleType,
        scheduleValue,
        timezone: resolvedTimezone,
      });

      const response: Record<string, unknown> = { ...task };
      if (webhookUrl) response.webhookUrl = webhookUrl;
      return text(`Automation created:\n${JSON.stringify(response, null, 2)}`);
    }

    case "update": {
      if (!task_id) {
        return text("Error: task_id is required for update action.");
      }

      // Build update fields for the scheduler
      const updateFields: Record<string, string | null | undefined> = {};
      if (params.prompt !== undefined) updateFields.prompt = params.prompt;
      if (params.schedule_type !== undefined) updateFields.scheduleType = params.schedule_type;
      if (params.schedule_value !== undefined) updateFields.scheduleValue = params.schedule_value;
      if (params.timezone !== undefined) updateFields.timezone = params.timezone;
      if (params.session_mode !== undefined) updateFields.sessionMode = params.session_mode;
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.description !== undefined) updateFields.description = params.description;
      if (params.output_target !== undefined) updateFields.outputTarget = params.output_target;
      if (params.output_platform !== undefined) updateFields.outputPlatform = params.output_platform;
      if (params.output_thread_ts !== undefined) updateFields.outputThreadTs = params.output_thread_ts;
      if (params.output_mode !== undefined) updateFields.outputMode = params.output_mode;
      if (params.delivery) {
        const deliveryFields = buildDeliveryFields(params, ctx);
        if (deliveryFields.outputTarget !== undefined) updateFields.outputTarget = deliveryFields.outputTarget;
        if (deliveryFields.outputPlatform !== undefined) updateFields.outputPlatform = deliveryFields.outputPlatform;
        if (deliveryFields.outputThreadTs !== undefined) updateFields.outputThreadTs = deliveryFields.outputThreadTs;
        if (deliveryFields.outputMode !== undefined) updateFields.outputMode = deliveryFields.outputMode;
      }

      // Handle steps update
      if (params.steps) {
        const brokerError = await ensureBrokerForActionSteps(params.steps);
        if (brokerError) return brokerError;

        if (!deps.stepContentRepo && params.steps.some((s) => s.agentPrompt || s.script)) {
          return text(
            "Error: step content storage is not available in this context. Multi-step automations with prompts or scripts cannot be updated.",
          );
        }

        const triggerStep = params.steps.find((step) => step.type === "trigger");
        if (triggerStep?.triggerConfig?.type === "canvas") {
          updateFields.scheduleType = "external";
          updateFields.scheduleValue = "canvas";
          triggerStep.triggerConfig = {
            ...triggerStep.triggerConfig,
            status: triggerStep.triggerConfig.status ?? "pending_canvas_setup",
          };
        }
        let stepsForDb = stripContentFromSteps(params.steps);
        if (triggerStep?.triggerConfig?.type !== "canvas") {
          const scheduleType = updateFields.scheduleType ?? guardedTask?.scheduleType;
          const scheduleValue = updateFields.scheduleValue ?? guardedTask?.scheduleValue;
          const timezone = updateFields.timezone ?? guardedTask?.timezone;
          if (isLocalScheduleType(scheduleType) && scheduleValue && timezone) {
            stepsForDb = normalizeScheduleTriggerSteps(stepsForDb, { scheduleType, scheduleValue, timezone });
          }
        }
        updateFields.steps = JSON.stringify(stepsForDb);

        // Sync step content
        if (deps.stepContentRepo) {
          const keepStepIds = params.steps.filter((s) => s.agentPrompt || s.script).map((s) => s.id);
          await deps.stepContentRepo.deleteOrphanedSteps(task_id, keepStepIds);

          for (const step of params.steps) {
            if (step.agentPrompt) {
              await deps.stepContentRepo.upsert({
                taskId: task_id,
                stepId: step.id,
                contentType: "prompt",
                content: step.agentPrompt,
                apps: step.apps,
              });
            } else if (step.script) {
              await deps.stepContentRepo.upsert({
                taskId: task_id,
                stepId: step.id,
                contentType: "script",
                content: step.script,
                apps: step.apps,
              });
            }
          }
        }
      }

      if (params.edges !== undefined) updateFields.edges = JSON.stringify(params.edges);

      const scheduleChanged =
        params.schedule_type !== undefined || params.schedule_value !== undefined || params.timezone !== undefined;
      if (!params.steps && scheduleChanged && guardedTask?.steps) {
        const scheduleType = updateFields.scheduleType ?? guardedTask.scheduleType;
        const scheduleValue = updateFields.scheduleValue ?? guardedTask.scheduleValue;
        const timezone = updateFields.timezone ?? guardedTask.timezone;
        if (isLocalScheduleType(scheduleType) && scheduleValue && timezone) {
          updateFields.steps = normalizeScheduleTriggerStepsJson(guardedTask.steps, {
            scheduleType,
            scheduleValue,
            timezone,
          });
        }
      }

      const updated = await deps.scheduler.updateTask(task_id, updateFields);
      if (!updated) {
        return text(`Error: task ${task_id} not found.`);
      }
      return text(`Automation updated:\n${JSON.stringify(updated, null, 2)}`);
    }

    case "remove": {
      if (!task_id) {
        return text("Error: task_id is required for remove action.");
      }
      // Cascade delete step content and runs
      if (deps.stepContentRepo) await deps.stepContentRepo.deleteByTaskId(task_id);
      if (deps.automationRunsRepo) await deps.automationRunsRepo.deleteByTaskId(task_id);

      const removed = await deps.scheduler.removeTask(task_id);
      if (!removed) {
        return text(`Error: task ${task_id} not found.`);
      }
      return text(`Automation ${task_id} removed.`);
    }

    case "pause": {
      if (!task_id) {
        return text("Error: task_id is required for pause action.");
      }
      await deps.scheduler.pauseTask(task_id);
      return text(`Automation ${task_id} paused.`);
    }

    case "resume": {
      if (!task_id) {
        return text("Error: task_id is required for resume action.");
      }
      await deps.scheduler.resumeTask(task_id);
      return text(`Automation ${task_id} resumed.`);
    }

    case "run": {
      if (!task_id) {
        return text("Error: task_id is required for run action.");
      }
      try {
        const activeQueueKey = deps.activeQueueKey ?? getActiveTaskContextQueueKey(ctx);
        if (
          guardedTask?.status === "active" &&
          activeQueueKey &&
          getScheduledTaskQueueKey(guardedTask) === activeQueueKey
        ) {
          await deps.scheduler.enqueueTaskById(task_id);
          return text(`Automation ${task_id} test run queued and will post back here shortly.`);
        }

        const result = await deps.scheduler.executeTaskById(task_id);
        if (!result) {
          const latestRun = deps.automationRunsRepo ? await deps.automationRunsRepo.getLatest(task_id) : undefined;
          return text(
            latestRun
              ? `Automation ${task_id} is already completed. Latest run:\n${JSON.stringify(latestRun, null, 2)}`
              : `Automation ${task_id} is already completed and has no run history.`,
          );
        }
        return text(`Automation ${task_id} completed:\n${JSON.stringify(result, null, 2)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return text(`Error: ${message}`);
      }
    }

    case "getRun": {
      if (!task_id) {
        return text("Error: task_id is required for getRun action.");
      }
      if (!deps.automationRunsRepo) {
        return text("Error: run history is not available in this context.");
      }
      const run = params.run_id
        ? await deps.automationRunsRepo.getById(params.run_id)
        : await deps.automationRunsRepo.getLatest(task_id);
      if (!run) {
        return text(params.run_id ? `Error: run ${params.run_id} not found.` : "No runs found for this automation.");
      }
      return text(JSON.stringify(run, null, 2));
    }

    case "updateStepContent": {
      if (!task_id) {
        return text("Error: task_id is required for updateStepContent action.");
      }
      if (!params.step_id || !params.step_content) {
        return text("Error: step_id and step_content are required for updateStepContent action.");
      }
      if (!deps.stepContentRepo) {
        return text("Error: step content updates are not available in this context.");
      }

      const existing = await deps.stepContentRepo.getByStep(task_id, params.step_id);
      if (!existing) {
        return text(`Error: step ${params.step_id} not found for task ${task_id}.`);
      }

      await deps.stepContentRepo.upsert({
        taskId: task_id,
        stepId: params.step_id,
        contentType: existing.content_type as "prompt" | "script",
        content: params.step_content,
        apps: params.step_apps ?? (existing.apps ? JSON.parse(existing.apps) : null),
      });

      return text(`Step ${params.step_id} content updated.`);
    }
  }
}

export function createManageScheduledTasksTool(deps: Partial<ManageScheduledTasksDeps>) {
  return tool(
    "ManageScheduledTasks",
    "Manage scheduled tasks that run automatically. Platform, delivery target, and creator are filled in automatically from context. Do not ask the user for these.",
    manageScheduledTasksSchema,
    async (params) => {
      if (!deps.scheduler || !deps.taskContext) {
        return { content: [{ type: "text" as const, text: "Scheduled tasks are not available in this context." }] };
      }
      return handleManageScheduledTasks(params, {
        scheduler: deps.scheduler,
        taskContext: deps.taskContext,
        stepContentRepo: deps.stepContentRepo,
        automationRunsRepo: deps.automationRunsRepo,
        userRepo: deps.userRepo,
        loadIntegrationProvider: deps.loadIntegrationProvider,
        queueManager: deps.queueManager,
        activeQueueKey: deps.activeQueueKey,
        config: deps.config,
      });
    },
  );
}

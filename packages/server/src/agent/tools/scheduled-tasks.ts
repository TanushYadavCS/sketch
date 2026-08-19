import { createHash } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  type AutomationBuilderSaveRequest,
  type AutomationExecutionMode,
  automationActionCapabilitiesSchema,
  automationExecutionModeSchema,
  canvasWebhookEndpointSchema,
  workflowStepUsesIntegrationActions,
} from "@sketch/shared";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { authorizedTargets } from "../../access/membership";
import { resolveViewerPrincipals } from "../../access/principals";
import { AutomationAuthoringValidationError } from "../../automation/authoring/service";
import type { ChatAutomationAuthoring, ChatAutomationAuthoringResult } from "../../automation/chat-authoring";
import {
  AutomationValidationError,
  addWebhookEndpointMetadata,
  isCanvasWebhookTrigger,
} from "../../automation/definition";
import {
  type LockHolderFields,
  acquireOrRenewLock,
  releaseLock,
  renewLock,
  requestSteal,
} from "../../automation/lock-service";
import {
  type AutomationDefinitionPatch,
  createAutomationDefinition,
  deleteAutomation,
  getAutomationDefinition,
  updateAutomationDefinition,
} from "../../automation/persistence";
import { webChatTaskConversationAssociation } from "../../automation/task-conversations";
import { createAutomationLocksRepository } from "../../db/repositories/automation-locks";
import type { createAutomationRunsRepository } from "../../db/repositories/automation-runs";
import { createAutomationSharesRepository } from "../../db/repositories/automation-shares";
import type { createAutomationStepContentRepository } from "../../db/repositories/automation-step-content";
import { createScheduledTaskConversationRepository } from "../../db/repositories/scheduled-task-conversations";
import { createWebhookEndpointRepository } from "../../db/repositories/webhook-endpoints";
import type { DB } from "../../db/schema";
import type { IntegrationProvider } from "../../integrations/types";
import { parseOnceSchedule } from "../../scheduler/parse-once";
import type { TaskScheduler } from "../../scheduler/service";
import { formatIntervalScheduleLabel, normalizeScheduleTriggerSteps } from "../../scheduler/trigger-metadata";
import type { CurrentAutomation, ScheduledTask, TaskContext } from "../../scheduler/types";
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
    .describe(
      "Script content for deterministic action steps. Use for fixed mapping, filtering, normalization, calculations, bounded JSON transformations, routing, or known integration operations. Action scripts use the existing action executor, receive (input, ctx, signal), and must return JSON-serializable output. Stored in automation_step_content, not in steps JSON.",
    ),
  agentPrompt: z
    .string()
    .optional()
    .describe(
      "Prompt content for explicit agent steps. Use only when the workflow needs interpretation, classification, planning, summarization, or natural-language generation. Stored in automation_step_content, not in steps JSON.",
    ),
  apps: z
    .array(z.string())
    .optional()
    .describe(
      "MCP server slugs associated with this step (for example, ['clickup', 'slack']). This does not turn an action step into an agent step; action scripts use ctx.integrations.executeAction for known integration operations.",
    ),
  agentMode: z
    .enum(["light", "sketch"])
    .optional()
    .describe("Execution mode for agent steps. Not used by action steps."),
  agentSkills: z.array(z.string()).optional().describe("Skills available to an agent step. Not used by action steps."),
  agentModel: z.string().optional().describe("Model override for an agent step. Not used by action steps."),
  agentMcpServers: z
    .array(z.string())
    .optional()
    .describe("MCP servers available to an agent step. Not used by action steps."),
  actionCapabilities: automationActionCapabilitiesSchema
    .describe(
      "Capabilities available to action scripts. Sketch tools are creator-scoped and read-only. For managed GitHub CLI access, declare cliIntegrations: ['github'] with usesIntegrationActions: false; any gh subcommand, including write operations, is allowed once declared.",
    )
    .optional(),
  timeout: z.number().optional().describe("Step timeout in seconds. Default: 1800 (30 min)."),
  triggerConfig: z
    .object({
      type: z.enum(["webhook", "schedule", "canvas", "slack_channel_message"]),
      channelId: z.string().trim().min(1).optional(),
      scheduleType: z.enum(["cron", "interval", "once"]).optional(),
      scheduleValue: z.string().optional(),
      timezone: z.string().optional(),
      app: z.string().optional().describe("Source app for Canvas-managed triggers, e.g. 'clickup'."),
      eventDescription: z.string().optional().describe("Human-readable event description, e.g. 'new issue created'."),
      componentKey: z.string().optional().describe("Canvas trigger component ID/key found through search_components."),
      configuredProps: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(["pending_canvas_setup", "active", "error"]).optional(),
      canvasWorkflowId: z.string().optional(),
      canvasTriggerNodeId: z.string().optional(),
      canvasActionNodeId: z.string().optional(),
      canvasEndpoint: canvasWebhookEndpointSchema.optional(),
      errorMessage: z.string().optional(),
    })
    .describe(
      "Use type 'webhook' for generic inbound webhooks; this is the Sketch-native trigger and requires schedule_type='external' with schedule_value='webhook'. Canvas-managed webhook triggers are unsupported. Use type 'canvas' only for explicitly requested provider events after Canvas search_components selects a non-webhook trigger component.",
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
  action: z
    .enum([
      "list",
      "add",
      "update",
      "remove",
      "pause",
      "resume",
      "run",
      "get",
      "getRun",
      "open",
      "share",
      "updateStepContent",
      "lockStatus",
      "steal",
    ])
    .describe(
      `Action to perform.
- 'add': create an automation (legacy agent form: prompt + schedule_type + schedule_value; deterministic form: title + steps with action scripts). Successful add emits the builder-opening artifact.
- 'list': list automations in this context. Always use this before editing by name; inspect each returned task ID and title. Never ask setup questions or invoke create-automation before resolving the task ID.
- 'update': modify an automation (requires task_id unless the current builder automation is implicit). Successful update emits the builder-opening artifact.
- 'open': open an existing automation in its builder (requires task_id). This is a read-only routing action; it does not change the automation.
- 'get': inspect one complete automation definition, including step content and run history (requires task_id)
- 'remove': delete an automation (requires task_id)
- 'pause': pause an automation (requires task_id)
- 'resume': resume a paused automation (requires task_id)
- 'run': manually trigger an automation (requires task_id)
- 'getRun': inspect run results (requires task_id, optional run_id for specific run)
- 'share': return the canonical URL for an automation (requires task_id)
- 'updateStepContent': update a single step's prompt or script (requires task_id, step_id, step_content)
- 'lockStatus': report who currently holds the edit lock on an automation and when it expires (requires task_id)
- 'steal': request the edit lock on an automation another editor is holding (requires task_id)`,
    ),
  prompt: z
    .string()
    .optional()
    .describe(
      "Legacy/simple automation prompt. When used without steps, Sketch expands it to one Sketch-mode agent step. Keep it for agent-driven or legacy automations; for deterministic work, pass an explicit steps array with action script content.",
    ),
  execution_mode: automationExecutionModeSchema
    .optional()
    .describe(
      "How the automation runs: 'Deterministic' is code-only with no agent; 'Hybrid' combines code and agent steps; 'Agent' is agent-only, Sketch handles the work, and it has no code steps. This is a user choice, not a forced recommendation.",
    ),
  schedule_type: z
    .enum(["cron", "interval", "once", "external"])
    .optional()
    .describe(
      "'external' for event-driven automations: use schedule_value='webhook' for a Sketch-native webhook or 'slack_channel_message' for a native Slack channel trigger. Otherwise use 'cron', 'interval', or 'once'.",
    ),
  schedule_value: z
    .string()
    .optional()
    .describe(
      `For cron: standard 5-field expression (minute hour day-of-month month day-of-week). Always use 5-field, never 6-field. Examples: '*/2 * * * *' (every 2 min), '0 9 * * 1-5' (weekdays 9am), '0 */6 * * *' (every 6 hours).
For interval: number of seconds as a plain string, minimum 60. Examples: '120' (every 2 min), '3600' (every hour). Do not use duration strings like '2m' or '1h'.
For once: ISO 8601 datetime string. A naked local time (e.g. '2026-03-14T15:00:00') is interpreted in the resolved timezone (the user's tz unless 'timezone' is set explicitly). To pin an absolute instant regardless of timezone, include a Z suffix or numeric offset (e.g. '2026-03-14T15:00:00Z' or '2026-03-14T15:00:00+05:30'). The task runs once at this time then auto-completes.
For external: use 'webhook' or 'slack_channel_message' as described above.`,
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
  task_id: z
    .string()
    .optional()
    .describe(
      "ID of the task. Required for update unless the current builder automation is implicit; required for get/remove/pause/resume/run/getRun/share/updateStepContent.",
    ),
  title: z.string().optional().describe("Human-readable name. Required for multi-step automations."),
  description: z.string().optional().describe("Description of what this automation does."),
  steps: z
    .array(workflowStepSchema)
    .optional()
    .describe(
      "Explicit workflow steps. Use this for deterministic work: include a trigger step and one or more action steps with script content. Use agent steps only when semantic judgment is needed. Legacy prompt-only automations remain supported.",
    ),
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
  status: z
    .enum(["active", "paused", "completed"])
    .optional()
    .describe("Lifecycle status for a full definition update."),
  expected_revision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Expected persisted revision for compare-and-swap writes. Stale revisions are rejected."),
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Alias for expected_revision when the caller uses the canonical camelCase field."),
  run_id: z.string().optional().describe("Run ID for getRun action. Omit for latest run."),
  step_id: z.string().optional().describe("Step ID for updateStepContent action."),
  step_content: z
    .string()
    .optional()
    .describe(
      "New content for updateStepContent: use script content for action steps and prompt content for agent steps.",
    ),
  step_apps: z.array(z.string()).optional().describe("Updated MCP server slugs for updateStepContent action."),
};

const authoredScheduledTasksSchema = {
  action: z
    .enum([
      "list",
      "add",
      "update",
      "remove",
      "pause",
      "resume",
      "run",
      "get",
      "getRun",
      "open",
      "share",
      "lockStatus",
      "steal",
    ])
    .describe(
      `Action to perform.
- 'add': create an automation from the user's natural-language request
- 'update': edit an automation from the user's natural-language request (requires task_id)
- 'open': open an existing automation in its builder (requires task_id); this does not change the automation
- 'get': inspect one complete automation definition, including step content and run history (requires task_id)
- 'list': list automations in this context
- 'remove': delete an automation (requires task_id)
- 'pause': pause an automation (requires task_id)
- 'resume': resume a paused automation (requires task_id)
- 'run': manually trigger an automation (requires task_id)
- 'getRun': inspect run results (requires task_id, optional run_id for specific run)
- 'share': return the canonical URL for an automation (requires task_id)
- 'lockStatus': report who currently holds the edit lock on an automation and when it expires (requires task_id)
- 'steal': request the edit lock on an automation another editor is holding (requires task_id)`,
    ),
  request: z
    .string()
    .optional()
    .describe(
      "The user's natural-language automation request. Required for add and update; preserve their intent verbatim.",
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      "ID of the task. Required for update unless the current builder automation is implicit; required for get/remove/pause/resume/run/getRun/share.",
    ),
  run_id: z.string().optional().describe("Run ID for getRun action. Omit for latest run."),
};

export type WorkflowStepInput = z.infer<typeof workflowStepSchema>;

type ManageScheduledTasksParams = {
  action:
    | "list"
    | "add"
    | "update"
    | "remove"
    | "pause"
    | "resume"
    | "run"
    | "get"
    | "getRun"
    | "open"
    | "share"
    | "updateStepContent"
    | "lockStatus"
    | "steal";
  request?: string;
  prompt?: string;
  execution_mode?: AutomationExecutionMode;
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
  status?: "active" | "paused" | "completed";
  expected_revision?: number;
  expectedRevision?: number;
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
  validateAgentSkills?: (
    ownerUserId: string,
    skillIds: string[],
    taskContext?: Pick<TaskContext, "platform" | "contextType" | "deliveryTarget" | "createdBy">,
  ) => Promise<string[]>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  activeQueueKey?: string;
  config?: { BASE_URL?: string; PORT: number };
  encryptionKey?: string;
  automationArtifactCollector?: AutomationArtifactCollector;
  chatAuthoring?: ChatAutomationAuthoring;
  currentAutomation?: CurrentAutomation;
  db?: Kysely<DB>;
  notifyStealRequest?: (taskId: string) => Promise<void>;
}

async function lockedAutomationMessage(
  deps: Pick<ManageScheduledTasksDeps, "userRepo">,
  lock: { holder_user_id: string },
): Promise<string> {
  const holderName = (await deps.userRepo?.findById(lock.holder_user_id))?.name ?? null;
  const holder = holderName ?? lock.holder_user_id;
  return `Error: ${holder} is editing this automation right now. Reply "take over" to request the edit lock.`;
}

/** Lock holder identity for chat-driven lock acquire/steal calls. */
function lockHolderFor(ctx: TaskContext): LockHolderFields {
  return {
    userId: ctx.createdBy as string,
    sessionId: agentLockSessionIdFor(ctx),
    platform: ctx.origin?.platform === "web" ? "web" : ctx.platform,
    surface: ctx.origin?.platform === "web" ? "builder" : "chat",
    conversationId: lockHolderConversationId(ctx),
  };
}

/**
 * Agent turns do not have a browser tab UUID. Derive one from the authenticated
 * conversation surface instead so consecutive turns on the same chat renew the
 * same lease while a browser session for that user remains a distinct holder.
 */
export function agentLockSessionIdFor(ctx: TaskContext): string {
  const holderPlatform = ctx.origin?.platform === "web" ? "web" : ctx.platform;
  const holderSurface = ctx.origin?.platform === "web" ? "builder" : "chat";
  const conversationId = lockHolderConversationId(ctx) ?? "";
  const identity = [
    ctx.createdBy ?? "anonymous",
    holderPlatform,
    holderSurface,
    ctx.contextType,
    conversationId,
    ctx.threadTs ?? "",
    ctx.origin?.providerThreadId ?? "",
  ].join("\u0000");
  return `agent:${createHash("sha256").update(identity).digest("hex")}`;
}

type AgentLease = { sessionId: string; generation: number; releaseAfterMutation: boolean };

async function acquireAgentLease(
  db: Kysely<DB>,
  taskId: string,
  ctx: TaskContext,
): Promise<
  | { kind: "held"; lease: AgentLease }
  | { kind: "locked"; lock: Awaited<ReturnType<typeof acquireOrRenewLock>>["lock"] }
  | { kind: "stale" }
> {
  if (ctx.authoringLease && ctx.createdBy) {
    const renewed = await renewLock(db, {
      taskId,
      userId: ctx.createdBy,
      sessionId: ctx.authoringLease.sessionId,
      generation: ctx.authoringLease.generation,
    });
    if (renewed.kind === "renewed") {
      return { kind: "held", lease: { ...ctx.authoringLease, releaseAfterMutation: false } };
    }
    const lock = await createAutomationLocksRepository(db).getByTaskId(taskId);
    if (lock) return { kind: "locked", lock };
    return { kind: "stale" };
  }
  const acquired = await acquireOrRenewLock(db, { taskId, holder: lockHolderFor(ctx) });
  if (acquired.kind === "locked") return acquired;
  return {
    kind: "held",
    lease: {
      sessionId: acquired.lock.holder_session_id,
      generation: acquired.lock.generation,
      releaseAfterMutation: true,
    },
  };
}

function agentMutationActor(ctx: TaskContext, lease?: AgentLease) {
  return {
    userId: ctx.createdBy,
    role: ctx.canManageAnyTask ? ("admin" as const) : undefined,
    source: "agent" as const,
    ...(lease ? { lease: { sessionId: lease.sessionId, generation: lease.generation } } : {}),
  };
}

/**
 * Deliverable conversation surface for the lock holder row. Chat contexts use
 * the delivery target (Slack DM/channel id, WhatsApp group jid) so steal
 * notifications can reach the holder; web-chat contexts carry the origin
 * conversation id as attribution for the web UI, with the web platform
 * keeping steal-notification delivery a deliberate no-op (the web builder's
 * polling owns web approval).
 */
function lockHolderConversationId(ctx: TaskContext): string | null {
  if (ctx.origin?.platform === "web") return ctx.origin.conversationId || null;
  return ctx.deliveryTarget || null;
}

/** Resolves a holder user id to a display name, falling back to the raw id. */
async function holderDisplayName(
  deps: Pick<ManageScheduledTasksDeps, "userRepo">,
  holderUserId: string,
): Promise<string> {
  const holderName = (await deps.userRepo?.findById(holderUserId))?.name ?? null;
  return holderName ?? holderUserId;
}

function stripContentFromSteps(steps: WorkflowStepInput[]): WorkflowStep[] {
  return steps.map(({ script: _s, agentPrompt: _a, apps: _apps, ...step }) => step as WorkflowStep);
}

function defaultEdgesForSteps(steps: WorkflowStep[]): { id: string; from: string; to: string }[] {
  return steps.slice(0, -1).map((step, index) => ({
    id: `${step.id}-${steps[index + 1].id}`,
    from: step.id,
    to: steps[index + 1].id,
  }));
}

function parseWorkflowStepsJson(value: string | null | undefined): WorkflowStep[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : null;
  } catch {
    return null;
  }
}

function stepContentForDefinition(
  taskId: string,
  steps: WorkflowStepInput[],
): AutomationBuilderSaveRequest["stepContent"] {
  const content: AutomationBuilderSaveRequest["stepContent"] = {};
  for (const step of steps) {
    if (step.agentPrompt !== undefined) {
      content[step.id] = {
        taskId,
        stepId: step.id,
        contentType: "prompt",
        content: step.agentPrompt,
        apps: step.apps ?? null,
      };
    } else if (step.script !== undefined) {
      content[step.id] = {
        taskId,
        stepId: step.id,
        contentType: "script",
        content: step.script,
        apps: step.apps ?? null,
      };
    }
  }
  return content;
}

function stepContentPatchForSteps(steps: WorkflowStepInput[]): AutomationDefinitionPatch["stepContent"] {
  const content: AutomationDefinitionPatch["stepContent"] = {};
  for (const step of steps) {
    const hasPrompt = hasOwn(step, "agentPrompt") && step.agentPrompt !== undefined;
    const hasScript = hasOwn(step, "script") && step.script !== undefined;
    const hasApps = hasOwn(step, "apps") && step.apps !== undefined;
    if (!hasPrompt && !hasScript && !hasApps) continue;
    content[step.id] = {
      contentType: step.type === "action" ? "script" : "prompt",
      ...(hasPrompt ? { content: step.agentPrompt } : {}),
      ...(hasScript ? { content: step.script } : {}),
      ...(hasApps ? { apps: step.apps ?? null } : {}),
    };
  }
  return content;
}

function definitionPatchFromParams(params: ManageScheduledTasksParams, ctx: TaskContext): AutomationDefinitionPatch {
  const patch: AutomationDefinitionPatch = {};
  if (params.prompt !== undefined) patch.prompt = params.prompt;
  if (params.execution_mode !== undefined) patch.executionMode = params.execution_mode;
  if (params.schedule_type !== undefined) patch.scheduleType = params.schedule_type;
  if (params.schedule_value !== undefined) patch.scheduleValue = params.schedule_value;
  if (params.timezone !== undefined) patch.timezone = params.timezone;
  if (params.status !== undefined) patch.status = params.status;
  if (params.title !== undefined) patch.title = params.title;
  if (params.description !== undefined) patch.description = params.description;

  const delivery: NonNullable<AutomationDefinitionPatch["delivery"]> = {};
  if (params.output_platform !== undefined) delivery.platform = params.output_platform;
  if (params.output_target !== undefined) delivery.targetId = params.output_target;
  if (params.output_thread_ts !== undefined) delivery.threadTs = params.output_thread_ts;
  if (params.output_mode !== undefined) delivery.mode = params.output_mode;
  if (params.delivery) {
    const hasExplicitThreadTs = hasOwn(params.delivery, "threadTs");
    if (params.delivery.platform !== undefined) delivery.platform = params.delivery.platform;
    if (params.delivery.targetType !== undefined) delivery.targetType = params.delivery.targetType;
    if (params.delivery.targetId !== undefined) delivery.targetId = params.delivery.targetId;
    if (hasExplicitThreadTs) delivery.threadTs = params.delivery.threadTs ?? null;
    if (params.delivery.mode !== undefined) delivery.mode = params.delivery.mode;
    if (params.delivery.targetType === "thread" && params.delivery.targetId === undefined) {
      delivery.targetId = ctx.deliveryTarget;
      delivery.platform ??= ctx.platform;
      delivery.threadTs = ctx.threadTs ?? null;
    } else if (
      (params.delivery.targetType !== undefined && params.delivery.targetType !== "thread") ||
      params.delivery.targetId !== undefined
    ) {
      delivery.threadTs = null;
    }
  }
  if (Object.keys(delivery).length > 0) patch.delivery = delivery;

  if (params.steps) {
    const triggerStep = params.steps.find((step) => step.type === "trigger");
    const steps = params.steps.map((step) => {
      if (step.type !== "trigger" || !step.triggerConfig) return step;
      if (step.triggerConfig.type !== "canvas") return step;
      return {
        ...step,
        triggerConfig: {
          ...step.triggerConfig,
          status: step.triggerConfig.status ?? "pending_canvas_setup",
        },
      };
    });
    patch.steps = stripContentFromSteps(steps);
    patch.stepContent = stepContentPatchForSteps(steps);
    if (triggerStep?.triggerConfig?.type === "canvas") {
      patch.scheduleType = "external";
      patch.scheduleValue = "canvas";
    }
    if (triggerStep?.triggerConfig?.type === "webhook") {
      patch.scheduleType = "external";
      patch.scheduleValue = "webhook";
    }
    if (triggerStep?.triggerConfig?.type === "slack_channel_message") {
      patch.scheduleType = "external";
      patch.scheduleValue = "slack_channel_message";
    }
  }
  if (params.edges !== undefined) patch.edges = params.edges;
  return patch;
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
  if (action === "getRun" || action === "get" || action === "lockStatus") return "inspect";
  if (action === "share") return "share";
  if (action === "steal") return "edit";
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

/**
 * Owner-or-grantee access for agent-managed automations. The grant set lives
 * in automation_task_shares; without a db handle the check fails closed so
 * non-owners are never granted access by omission.
 */
async function taskIsSharedWith(deps: ManageScheduledTasksDeps, taskId: string, userId: string): Promise<boolean> {
  if (!deps.db) return false;
  return createAutomationSharesRepository(deps.db).hasGrant(taskId, userId);
}

async function taskPermissionError(
  task: ScheduledTask,
  action: ManageScheduledTasksParams["action"],
  userRepo: SearchableUserRepo | undefined,
): Promise<string> {
  const ownerName = await resolveTaskOwnerName(task, userRepo);
  return `Error: You can't ${guardedActionLabel(action)} "${taskDisplayName(task)}" because it was created by ${ownerName}.`;
}

function automationPersistenceError(error: unknown): string | null {
  if (error instanceof AutomationValidationError) {
    return `Error: automation definition is invalid:\n${error.issues.map((issue) => `- ${issue.code}: ${issue.message}`).join("\n")}`;
  }
  return null;
}

async function buildDeliveryFields(
  params: ManageScheduledTasksParams,
  ctx: TaskContext,
  deps: ManageScheduledTasksDeps,
): Promise<
  | {
      outputTarget: string | undefined;
      outputPlatform: "slack" | "whatsapp" | undefined;
      outputThreadTs: string | null | undefined;
      outputMode: "deliver" | "silent" | undefined;
    }
  | { error: string }
> {
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

  const targetType =
    delivery?.targetType ?? (outputThreadTs ? "thread" : ctx.contextType === "channel" ? "channel" : ctx.contextType);
  const validationPlatform =
    outputPlatform ?? (ctx.platform === "slack" || ctx.platform === "whatsapp" ? ctx.platform : undefined);
  if (
    outputTarget &&
    validationPlatform &&
    (targetType === "channel" || targetType === "group" || targetType === "thread")
  ) {
    const principals =
      deps.db && deps.userRepo && ctx.createdBy
        ? await resolveViewerPrincipals({ db: deps.db, currentUserId: ctx.createdBy, userRepo: deps.userRepo }).catch(
            () => [],
          )
        : [];
    const authorized = deps.db
      ? await authorizedTargets(deps.db, principals, [{ platform: validationPlatform, targetId: outputTarget }])
      : new Set<string>();
    if (!authorized.has(`${validationPlatform}:${outputTarget}`)) {
      const targetLabel = targetType === "thread" ? "channel or group" : targetType;
      return {
        error: `Error: delivery target ${outputTarget} is not a member-authorized ${targetLabel}. No changes were saved.`,
      };
    }
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

function buildBuilderUrl(taskId: string, config: ManageScheduledTasksDeps["config"], conversationId?: string): string {
  const path = `/scheduled-tasks/${encodeURIComponent(taskId)}/edit`;
  const base = config?.BASE_URL?.replace(/\/$/, "") ?? `http://localhost:${config?.PORT ?? 3000}`;
  const conversationQuery = conversationId?.trim()
    ? `?conversationId=${encodeURIComponent(conversationId.trim())}`
    : "";
  return `${base}${path}${conversationQuery}`;
}

async function webhookResponseMetadata(
  deps: ManageScheduledTasksDeps,
  taskId: string,
  triggerConfig: WorkflowStep["triggerConfig"] | undefined,
): Promise<Record<string, unknown> | null> {
  if (triggerConfig?.type !== "webhook") return null;
  const endpoint = deps.db
    ? await createWebhookEndpointRepository(deps.db, deps.encryptionKey).getByTaskId(taskId)
    : undefined;
  const metadata = addWebhookEndpointMetadata(triggerConfig, taskId, {
    endpoint,
    baseUrl: deps.config?.BASE_URL,
    port: deps.config?.PORT,
  });
  return metadata;
}

/**
 * Uses the scheduler refresh result when available and keeps the row-read fallback only for older scheduler implementations without that method.
 */
async function refreshTaskAfterMutation(
  scheduler: TaskScheduler,
  taskId: string,
): Promise<{ task: ScheduledTask | null; failed: boolean }> {
  if (typeof scheduler.refreshTaskSchedule !== "function") {
    return { task: await scheduler.getTaskById(taskId), failed: false };
  }

  try {
    return { task: await scheduler.refreshTaskSchedule(taskId), failed: false };
  } catch {
    return { task: null, failed: true };
  }
}

async function automaticAutomationTestRun(scheduler: TaskScheduler, taskId: string): Promise<string> {
  try {
    const result = await scheduler.executeTaskById(taskId, { preserveTaskState: true, runMode: "test" });
    if (!result) {
      return `Automatic test run for automation ${taskId} did not execute because the task is already complete.`;
    }
    const outcome = result.status === "failed" || result.aborted ? "failed" : "completed";
    return [
      `Automatic test run ${outcome} for automation ${taskId}:`,
      JSON.stringify(result, null, 2),
      "Inspect this result and repair the automation if the test exposed an issue before reporting completion.",
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      `Automatic test run for automation ${taskId} could not be completed: ${message}`,
      "Inspect the automation and repair the issue before reporting completion.",
    ].join("\n");
  }
}

function buildArtifactTags(params: {
  steps: Array<WorkflowStep & { apps?: string[] }>;
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
  steps: Array<WorkflowStep & { apps?: string[] }>;
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

export function requiresAutomationBuilder(params: {
  steps: Array<WorkflowStep & { apps?: string[]; script?: string; agentPrompt?: string }>;
  scheduleType: string;
}): boolean {
  if (!isLocalScheduleType(params.scheduleType) || params.steps.length !== 2) return true;

  const [trigger] = params.steps.filter((step) => step.type === "trigger");
  const [executionStep] = params.steps.filter((step) => step.type !== "trigger");
  if (!trigger || !executionStep || trigger.triggerConfig?.type !== "schedule") return true;

  const triggerConfig = trigger.triggerConfig;
  const allowedTriggerConfigKeys = new Set(["type", "scheduleType", "scheduleValue", "timezone"]);
  if (Object.keys(triggerConfig).some((key) => !allowedTriggerConfigKeys.has(key))) return true;

  const literalActionScript = executionStep.type === "action" ? executionStep.script?.trim() : undefined;
  const literalActionMatch = literalActionScript
    ? [
        /^return\s+"((?:\\.|[^"\\])*)";?\s*$/,
        /^return\s+'((?:\\.|[^'\\])*)';?\s*$/,
        /^return\s+`((?:\\.|[^`\\$]|\$(?!\{))*)`;?\s*$/,
      ]
        .map((pattern) => pattern.exec(literalActionScript))
        .find((match) => match !== null)
    : undefined;
  const isSimpleLiteralAction =
    executionStep.type === "action" && Boolean(literalActionMatch?.[1]?.replace(/\\./g, "x").trim());
  if (!isSimpleLiteralAction) return true;

  for (const step of params.steps) {
    if (
      (step.type !== "action" && step.script !== undefined) ||
      (step.apps?.length ?? 0) > 0 ||
      (step.agentSkills?.length ?? 0) > 0 ||
      step.agentModel !== undefined ||
      (step.agentMcpServers?.length ?? 0) > 0 ||
      step.actionCapabilities !== undefined ||
      step.timeout !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function withStepContent(
  steps: WorkflowStep[],
  stepContent: AutomationBuilderSaveRequest["stepContent"],
): Array<WorkflowStep & { apps?: string[]; script?: string; agentPrompt?: string }> {
  return steps.map((step) => {
    const content = stepContent[step.id];
    if (!content) return step;
    return {
      ...step,
      ...(content.apps ? { apps: content.apps } : {}),
      ...(content.contentType === "script" ? { script: content.content } : { agentPrompt: content.content }),
    };
  });
}

async function collectAutomationArtifact(params: {
  deps: ManageScheduledTasksDeps;
  task: ScheduledTask;
  steps: Array<WorkflowStep & { apps?: string[]; script?: string; agentPrompt?: string }>;
  scheduleType: string;
  scheduleValue: string;
  timezone: string;
  kind: "New automation" | "Updated automation";
}): Promise<string> {
  const existingBuilderConversationId =
    params.kind === "Updated automation" && params.deps.db && params.deps.taskContext.createdBy
      ? (
          await createScheduledTaskConversationRepository(params.deps.db).listByTaskAndTranscriptUser(
            params.task.id,
            params.deps.taskContext.createdBy,
            { kind: "builder" },
          )
        ).find((row) => row.archived_at === null)?.conversation_id
      : undefined;
  const builderUrl = buildBuilderUrl(
    params.task.id,
    params.deps.config,
    params.kind === "Updated automation" ? existingBuilderConversationId : undefined,
  );
  const delivery = params.task.delivery;
  const deliveryLabel =
    delivery.mode === "silent"
      ? "Silent"
      : `${displayPlatform(delivery.platform)} ${delivery.targetType === "thread" ? "thread" : delivery.targetType}`;

  params.deps.automationArtifactCollector?.collect({
    taskId: params.task.id,
    requiresBuilder: true,
    kind: params.kind,
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

const LEGACY_AUTHORING_FIELDS = [
  "prompt",
  "execution_mode",
  "schedule_type",
  "schedule_value",
  "timezone",
  "session_mode",
  "title",
  "description",
  "steps",
  "edges",
  "output_target",
  "output_platform",
  "output_thread_ts",
  "output_mode",
  "status",
  "expected_revision",
  "expectedRevision",
  "delivery",
  "step_id",
  "step_content",
  "step_apps",
] as const satisfies readonly (keyof ManageScheduledTasksParams)[];

function hasLegacyAuthoringFields(params: ManageScheduledTasksParams): boolean {
  return LEGACY_AUTHORING_FIELDS.some((field) => hasOwn(params, field));
}

async function handleConfiguredChatAuthoring(
  params: ManageScheduledTasksParams,
  deps: ManageScheduledTasksDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }] });
  const chatAuthoring = deps.chatAuthoring;
  if (!chatAuthoring) {
    return text("Error: automation authoring is not configured.");
  }
  if (params.action === "updateStepContent") {
    return text(
      "Error: direct step-content updates are unavailable while automation authoring is configured. Use update with a natural-language request so the change is applied as a full automation edit.",
    );
  }
  if (params.action !== "add" && params.action !== "update") {
    return text("Error: this action is not an automation authoring action.");
  }
  if (hasLegacyAuthoringFields(params)) {
    return text(
      "Error: structured automation fields cannot be supplied while automation authoring is configured. Pass only the user's natural-language request.",
    );
  }
  const request = params.request?.trim();
  if (!request) {
    return text(`Error: request is required for ${params.action} action.`);
  }
  const currentAutomation = deps.currentAutomation ?? deps.taskContext.currentAutomation;
  const explicitTaskId = params.task_id?.trim() || undefined;
  const targetTaskId = explicitTaskId ?? (params.action === "update" ? currentAutomation?.taskId : undefined);
  if (params.action === "update" && !targetTaskId) {
    return text("Error: task_id is required for update action.");
  }

  let result: ChatAutomationAuthoringResult;
  const db = deps.db;
  const createdBy = deps.taskContext.createdBy;
  let agentLease: AgentLease | undefined;
  try {
    // The authoring edit path is lock-guarded like the structured update path:
    // acquire before the edit (so persistence's in-transaction lock check passes
    // for us) and release after, with the shared locked message when another
    // editor holds the lock.
    if (params.action === "update" && targetTaskId && db && createdBy) {
      const acquired = await acquireAgentLease(db, targetTaskId, deps.taskContext);
      if (acquired.kind === "stale") {
        return text("Error: the browser editing session is no longer active. Refresh and try again.");
      }
      if (acquired.kind === "locked") {
        return text(await lockedAutomationMessage(deps, acquired.lock));
      }
      agentLease = acquired.lease;
    }
    result = await chatAuthoring.author({
      action: params.action === "add" ? "create" : "edit",
      request,
      ...(targetTaskId ? { taskId: targetTaskId } : {}),
      taskContext: deps.taskContext,
      ...(targetTaskId && currentAutomation?.taskId === targetTaskId ? { currentAutomation } : {}),
      ...(agentLease ? { lease: { sessionId: agentLease.sessionId, generation: agentLease.generation } } : {}),
    });
  } catch (error) {
    if (error instanceof AutomationAuthoringValidationError) {
      return text(
        "Error: automation authoring could not produce a valid definition after three attempts. No invalid automation was saved. Please correct your request and try again.",
      );
    }
    return text("Error: automation authoring is temporarily unavailable. No changes were saved.");
  } finally {
    if (params.action === "update" && targetTaskId && db && createdBy && agentLease?.releaseAfterMutation) {
      await releaseLock(db, {
        taskId: targetTaskId,
        userId: createdBy,
        sessionId: agentLease.sessionId,
        generation: agentLease.generation,
      });
    }
  }

  if (result.kind === "clarification") return text(result.message);
  if (result.kind === "error") return text(`Error: ${result.message}`);

  if (params.action === "add" || params.action === "update") {
    await collectAutomationArtifact({
      deps,
      task: result.task,
      steps: result.artifact.steps,
      scheduleType: result.artifact.scheduleType,
      scheduleValue: result.artifact.scheduleValue,
      timezone: result.artifact.timezone,
      kind: params.action === "add" ? "New automation" : "Updated automation",
    });
  }
  const verb = params.action === "add" ? "created" : "updated";
  const triggerConfig = result.artifact.steps.find((step) => step.type === "trigger")?.triggerConfig;
  const webhookMetadata = await webhookResponseMetadata(deps, result.task.id, triggerConfig);
  const response = { ...result.task, ...(webhookMetadata ?? {}) };
  return text([`Automation ${verb}:`, JSON.stringify(response, null, 2)].join("\n"));
}

export async function handleManageScheduledTasks(
  params: ManageScheduledTasksParams,
  deps: ManageScheduledTasksDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { action } = params;
  const ctx = deps.taskContext;
  const currentAutomation = deps.currentAutomation ?? ctx.currentAutomation;
  const taskConversationAssociation = webChatTaskConversationAssociation(ctx);
  const explicitTaskId = params.task_id?.trim() || undefined;
  const task_id =
    explicitTaskId ??
    (action === "update" || action === "updateStepContent" || action === "open"
      ? currentAutomation?.taskId
      : undefined);

  const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }] });

  const BROKER_REQUIRED_MSG =
    "Error: Integration-backed action steps require a broker-capable integration provider (e.g. Canvas MCP in skill mode). Configure one in Settings → Integrations, or use a read-only Sketch tool action.";
  const FRESH_SESSION_ONLY_MSG =
    "Error: scheduled automations currently support only 'fresh' session_mode. Omit session_mode or set it to 'fresh'.";

  if (
    ctx.conversationKind === "web_chat" &&
    (action === "add" || action === "update" || action === "updateStepContent")
  ) {
    return text(
      "Automation setup and edits happen in the builder. In web chat, use list to resolve an existing automation, then use open with its task_id. No changes were made.",
    );
  }

  if (deps.chatAuthoring && (action === "add" || action === "update" || action === "updateStepContent")) {
    return handleConfiguredChatAuthoring(params, deps);
  }

  let brokerCapabilitySnapshot: boolean | undefined;
  const getBrokerCapabilitySnapshot = async (): Promise<boolean> => {
    if (brokerCapabilitySnapshot !== undefined) return brokerCapabilitySnapshot;
    const provider = deps.loadIntegrationProvider ? await deps.loadIntegrationProvider() : null;
    brokerCapabilitySnapshot = Boolean(provider?.isBrokerCapable());
    return brokerCapabilitySnapshot;
  };

  /** Returns an error response when an integration-backed action lacks a broker-capable provider. */
  const ensureBrokerForActionSteps = async (
    candidateSteps: WorkflowStepInput[] | undefined,
  ): Promise<ReturnType<typeof text> | null> => {
    if (!candidateSteps?.some((s) => workflowStepUsesIntegrationActions(s))) return null;
    if (!(await getBrokerCapabilitySnapshot())) return text(BROKER_REQUIRED_MSG);
    return null;
  };

  const ensureAgentSkillsAvailable = async (
    candidateSteps: WorkflowStepInput[] | undefined,
  ): Promise<ReturnType<typeof text> | null> => {
    if (!deps.validateAgentSkills || !ctx.createdBy || !candidateSteps) return null;
    const requestedSkills = candidateSteps.flatMap((step) => (step.type === "agent" ? (step.agentSkills ?? []) : []));
    if (requestedSkills.length === 0) return null;
    const unavailableSkills = await deps.validateAgentSkills(ctx.createdBy, requestedSkills, {
      platform: ctx.platform,
      contextType: ctx.contextType,
      deliveryTarget: ctx.deliveryTarget,
      createdBy: ctx.createdBy,
    });
    if (unavailableSkills.length === 0) return null;
    return text(
      `Error: connect or share the required integration before saving this automation: ${unavailableSkills.join(", ")}.`,
    );
  };

  const OWNERSHIP_GUARDED_ACTIONS = [
    "update",
    "get",
    "remove",
    "pause",
    "resume",
    "run",
    "getRun",
    "open",
    "share",
    "updateStepContent",
    "lockStatus",
    "steal",
  ];
  // Share is owner-only (admins denied). Remove is owner-or-admin. Every other
  // guarded action passes for owner, grantee, or admin. Persistence still
  // enforces owner-or-grantee inside its own transactions, so admin mutations
  // of a foreign task are denied there (L5 admin restore resolves this).
  const OWNER_ONLY_ACTIONS = new Set<ManageScheduledTasksParams["action"]>(["share"]);
  let guardedTask: ScheduledTask | null = null;
  if (task_id && OWNERSHIP_GUARDED_ACTIONS.includes(action)) {
    const task = await deps.scheduler.getTaskById(task_id);
    if (!ctx.createdBy || !task) {
      return text("Error: task not found.");
    }
    const isOwner = task.createdBy === ctx.createdBy;
    const isAdmin = ctx.canManageAnyTask === true;
    if (action === "remove") {
      if (!isOwner && !isAdmin) {
        return text(await taskPermissionError(task, action, deps.userRepo));
      }
    } else {
      const isGrantee = !isOwner && (await taskIsSharedWith(deps, task.id, ctx.createdBy));
      if (!isOwner && !isGrantee && !isAdmin) {
        return text(await taskPermissionError(task, action, deps.userRepo));
      }
      if (OWNER_ONLY_ACTIONS.has(action) && !isOwner) {
        return text(await taskPermissionError(task, action, deps.userRepo));
      }
    }
    guardedTask = task;
  }

  if (params.session_mode !== undefined && params.session_mode !== "fresh") {
    return text(FRESH_SESSION_ONLY_MSG);
  }

  switch (action) {
    case "list": {
      if (!ctx.createdBy) {
        return text("Error: scheduled task creator is not available in this context.");
      }
      if (ctx.contextType !== "dm") {
        // Channel/group context: tasks whose delivery target is this channel,
        // plus tasks the member owns or has been granted, deduplicated by id.
        const [deliveryTasks, accessibleTasks] = await Promise.all([
          deps.scheduler.listTasks({ deliveryTarget: ctx.deliveryTarget }),
          deps.scheduler.listTasksForUser(ctx.createdBy),
        ]);
        const tasksById = new Map<string, ScheduledTask>();
        for (const task of [...deliveryTasks, ...accessibleTasks]) tasksById.set(task.id, task);
        return text(JSON.stringify([...tasksById.values()], null, 2));
      }
      if (ctx.canManageAnyTask) {
        // Admin DM context: every automation, active or not.
        const tasks = await deps.scheduler.listTasks({ includeInactive: true });
        return text(JSON.stringify(tasks, null, 2));
      }
      const tasks = await deps.scheduler.listTasksForUser(ctx.createdBy);
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
        const isNativeWebhookTrigger = triggerStep?.triggerConfig?.type === "webhook";
        const isSlackChannelMessageTrigger = triggerStep?.triggerConfig?.type === "slack_channel_message";
        if (isCanvasWebhookTrigger(triggerStep?.triggerConfig)) {
          return text(
            "Error: Canvas-managed webhook triggers are not supported; use the Sketch-native webhook trigger instead.",
          );
        }
        if (isSlackChannelMessageTrigger && !triggerStep.triggerConfig?.channelId?.trim()) {
          return text("Error: Slack channel message trigger requires channelId.");
        }
        if (
          !isCanvasManagedTrigger &&
          !isNativeWebhookTrigger &&
          !isSlackChannelMessageTrigger &&
          (!params.schedule_type || !params.schedule_value)
        ) {
          return text("Error: schedule_type and schedule_value are required for add action.");
        }
        if (isNativeWebhookTrigger) {
          params.schedule_type = "external";
          params.schedule_value = "webhook";
        }
        if (triggerStep?.triggerConfig?.type === "canvas") {
          params.schedule_type = "external";
          params.schedule_value = "canvas";
          triggerStep.triggerConfig = {
            ...triggerStep.triggerConfig,
            status: triggerStep.triggerConfig.status ?? "pending_canvas_setup",
          };
        }
        if (triggerStep?.triggerConfig?.type === "slack_channel_message") {
          params.schedule_type = "external";
          params.schedule_value = "slack_channel_message";
        }

        const brokerError = await ensureBrokerForActionSteps(params.steps);
        if (brokerError) return brokerError;
      } else if (params.prompt) {
        // Sugar: expand simple prompt into a single-step workflow
        if (!params.schedule_type || !params.schedule_value) {
          return text("Error: prompt, schedule_type, and schedule_value are required for add action.");
        }
        params.title = params.title ?? params.prompt;
        const isNativeWebhook = params.schedule_type === "external" && params.schedule_value === "webhook";
        params.steps = [
          {
            id: "trigger",
            type: "trigger",
            label: isNativeWebhook ? "Webhook" : "Schedule",
            icon: isNativeWebhook ? "webhook" : "clock",
            triggerConfig: isNativeWebhook ? { type: "webhook" } : { type: "schedule" },
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

      const agentSkillError = await ensureAgentSkillsAvailable(params.steps);
      if (agentSkillError) return agentSkillError;

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
      const deliveryFields = await buildDeliveryFields(params, ctx, deps);
      if ("error" in deliveryFields) return text(deliveryFields.error);

      // Strip content from steps (stored separately in automation_step_content)
      const steps = params.steps as NonNullable<typeof params.steps>;
      const title = params.title as string;
      const prompt = params.prompt ?? title;
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
      const edgesForDb = params.edges ?? defaultEdgesForSteps(stepsForDb);
      const outputPlatform = deliveryFields.outputPlatform ?? ctx.platform;
      const outputTarget = deliveryFields.outputTarget ?? ctx.deliveryTarget;
      const outputThreadTs = deliveryFields.outputThreadTs ?? null;
      const outputMode = deliveryFields.outputMode ?? "deliver";
      if (!deps.db) {
        return text("Error: canonical automation persistence is not available in this context. No changes were saved.");
      }

      let saved: Awaited<ReturnType<typeof createAutomationDefinition>>;
      try {
        saved = await createAutomationDefinition({
          db: deps.db,
          request: {
            title,
            description: params.description ?? null,
            prompt,
            executionMode: params.execution_mode ?? "hybrid",
            scheduleType: scheduleType as "cron" | "interval" | "once" | "external",
            scheduleValue,
            timezone: resolvedTimezone,
            status: "active",
            delivery: {
              platform: outputPlatform,
              targetType:
                params.delivery?.targetType ??
                (deliveryFields.outputThreadTs
                  ? "thread"
                  : ctx.contextType === "channel"
                    ? "channel"
                    : ctx.contextType),
              targetId: outputTarget,
              threadTs: outputThreadTs,
              mode: outputMode,
            },
            steps: stepsForDb,
            edges: edgesForDb,
            stepContent: stepContentForDefinition("new-task", steps),
          },
          context: {
            platform: ctx.platform,
            contextType: ctx.contextType,
            deliveryTarget: ctx.deliveryTarget,
            threadTs: ctx.threadTs ?? null,
            createdBy: ctx.createdBy,
            originPlatform: ctx.origin?.platform ?? null,
            originConversationId: ctx.origin?.conversationId ?? null,
            originProviderThreadId: ctx.origin?.providerThreadId ?? null,
            originMessageId: ctx.origin?.currentMessageId ?? null,
          },
          brokerCapable: await getBrokerCapabilitySnapshot(),
          encryptionKey: deps.encryptionKey,
          ...(taskConversationAssociation ? { taskConversationAssociation } : {}),
        });
      } catch (error) {
        const message = automationPersistenceError(error);
        if (message) return text(message);
        throw error;
      }

      const { task: refreshedTask, failed: refreshFailed } = await refreshTaskAfterMutation(
        deps.scheduler,
        saved.row.id,
      );
      if (refreshFailed || !refreshedTask) {
        return text("Error: automation was saved, but its scheduler state could not be refreshed.");
      }

      const triggerStep = steps.find((s) => s.triggerConfig?.type === "webhook");
      const webhookMetadata = await webhookResponseMetadata(deps, refreshedTask.id, triggerStep?.triggerConfig);

      await collectAutomationArtifact({
        deps,
        task: refreshedTask,
        steps: withStepContent(stepsForDb, stepContentForDefinition("new-task", steps)),
        scheduleType,
        scheduleValue,
        timezone: resolvedTimezone,
        kind: "New automation",
      });

      const response: Record<string, unknown> = {
        ...refreshedTask,
        ...(webhookMetadata ?? {}),
      };
      const testRun = await automaticAutomationTestRun(deps.scheduler, refreshedTask.id);
      return text(["Automation created:", JSON.stringify(response, null, 2), testRun].join("\n"));
    }

    case "update": {
      if (!task_id) {
        return text("Error: task_id is required for update action.");
      }

      const brokerError = await ensureBrokerForActionSteps(params.steps);
      if (brokerError) return brokerError;
      if (params.steps?.some((step) => isCanvasWebhookTrigger(step.triggerConfig))) {
        return text(
          "Error: Canvas-managed webhook triggers are not supported; use the Sketch-native webhook trigger instead.",
        );
      }
      const agentSkillError = await ensureAgentSkillsAvailable(params.steps);
      if (agentSkillError) return agentSkillError;

      const scheduleChanged =
        params.schedule_type !== undefined || params.schedule_value !== undefined || params.timezone !== undefined;
      const existingTrigger = parseWorkflowStepsJson(guardedTask?.steps)?.find(
        (step) => step.type === "trigger",
      )?.triggerConfig;
      if (!params.steps && scheduleChanged && existingTrigger?.type === "slack_channel_message") {
        return text("Error: update the Slack channel message trigger steps to change its trigger metadata.");
      }
      if (!deps.db) {
        return text("Error: canonical automation persistence is not available in this context. No changes were saved.");
      }
      const db = deps.db;

      const expectedRevision =
        params.expected_revision ??
        params.expectedRevision ??
        (currentAutomation?.taskId === task_id ? currentAutomation.revision : undefined);
      const patch = definitionPatchFromParams(params, ctx);
      if (expectedRevision !== undefined) patch.expectedRevision = expectedRevision;

      let saved: Awaited<ReturnType<typeof updateAutomationDefinition>>;
      let agentLease: AgentLease | undefined;
      try {
        if (ctx.createdBy) {
          const acquired = await acquireAgentLease(db, task_id, ctx);
          if (acquired.kind === "stale") {
            return text("Error: the browser editing session is no longer active. Refresh and try again.");
          }
          if (acquired.kind === "locked") {
            return text(await lockedAutomationMessage(deps, acquired.lock));
          }
          agentLease = acquired.lease;
        }
        saved = await updateAutomationDefinition({
          db,
          taskId: task_id,
          patch,
          actor: agentMutationActor(ctx, agentLease),
          brokerCapable: await getBrokerCapabilitySnapshot(),
          encryptionKey: deps.encryptionKey,
          ...(taskConversationAssociation ? { taskConversationAssociation } : {}),
        });
      } catch (error) {
        const message = automationPersistenceError(error);
        if (message) return text(message);
        throw error;
      } finally {
        if (ctx.createdBy && agentLease?.releaseAfterMutation) {
          await releaseLock(db, {
            taskId: task_id,
            userId: ctx.createdBy,
            sessionId: agentLease.sessionId,
            generation: agentLease.generation,
          });
        }
      }
      if (saved.kind === "not_found") return text(`Error: task ${task_id} not found.`);
      if (saved.kind === "access_denied") return text(`Error: you do not have permission to update task ${task_id}.`);
      if (saved.kind === "revision_conflict") {
        return text(
          `Error: automation revision conflict. Task ${task_id} is now at revision ${saved.currentRevision}; refresh before retrying.`,
        );
      }
      if (saved.kind === "locked") {
        return text(await lockedAutomationMessage(deps, saved.lock));
      }
      if (saved.kind === "lease_required") {
        return text("Error: automation editing requires an active authoring lease.");
      }
      if (saved.kind === "lease_stale") {
        return text(await lockedAutomationMessage(deps, saved.lock));
      }

      const { task: updated, failed: refreshFailed } = await refreshTaskAfterMutation(deps.scheduler, saved.row.id);
      if (refreshFailed || !updated)
        return text("Error: automation was saved, but its scheduler state could not be refreshed.");
      await collectAutomationArtifact({
        deps,
        task: updated,
        steps: withStepContent(saved.request.steps, saved.request.stepContent),
        scheduleType: saved.request.scheduleType,
        scheduleValue: saved.request.scheduleValue,
        timezone: saved.request.timezone,
        kind: "Updated automation",
      });
      const updatedTrigger = saved.request.steps.find((step) => step.type === "trigger")?.triggerConfig;
      const webhookMetadata = await webhookResponseMetadata(deps, updated.id, updatedTrigger);
      const response = { ...updated, ...(webhookMetadata ?? {}) };
      const testRun = await automaticAutomationTestRun(deps.scheduler, updated.id);
      return text(["Automation updated:", JSON.stringify(response, null, 2), testRun].join("\n"));
    }

    case "open": {
      if (!task_id) {
        return text("Error: task_id is required for open action.");
      }
      if (!guardedTask) {
        return text("Error: task not found.");
      }
      const builderUrl = await collectAutomationArtifact({
        deps,
        task: guardedTask,
        steps: parseWorkflowStepsJson(guardedTask.steps) ?? [],
        scheduleType: guardedTask.scheduleType,
        scheduleValue: guardedTask.scheduleValue,
        timezone: guardedTask.timezone,
        kind: "Updated automation",
      });
      return text(`Automation ${task_id} is ready to edit in the builder: ${builderUrl}`);
    }

    case "share": {
      if (!task_id) {
        return text("Error: task_id is required for share action.");
      }
      if (!guardedTask) {
        return text("Error: task not found.");
      }
      return text(`- Open your automation - ${buildBuilderUrl(guardedTask.id, deps.config)}`);
    }

    case "get": {
      if (!task_id) return text("Error: task_id is required for get action.");
      if (!deps.db) {
        return text("Error: canonical automation persistence is not available in this context.");
      }
      const definition = await getAutomationDefinition({
        db: deps.db,
        taskId: task_id,
        webhookBaseUrl: deps.config?.BASE_URL,
        webhookPort: deps.config?.PORT,
        encryptionKey: deps.encryptionKey,
      });
      if (!definition) return text(`Error: task ${task_id} not found.`);
      return text(JSON.stringify(definition, null, 2));
    }

    case "remove": {
      if (!task_id) {
        return text("Error: task_id is required for remove action.");
      }
      if (!deps.db) {
        return text("Error: canonical automation persistence is not available in this context. No changes were saved.");
      }
      let agentLease: AgentLease | undefined;
      if (ctx.createdBy) {
        const acquired = await acquireAgentLease(deps.db, task_id, ctx);
        if (acquired.kind === "stale") {
          return text("Error: the browser editing session is no longer active. Refresh and try again.");
        }
        if (acquired.kind === "locked") {
          return text(await lockedAutomationMessage(deps, acquired.lock));
        }
        agentLease = acquired.lease;
      }
      let deletion: Awaited<ReturnType<typeof deleteAutomation>>;
      try {
        deletion = await deleteAutomation({
          db: deps.db,
          taskId: task_id,
          actor: agentMutationActor(ctx, agentLease),
          scheduler: { removeTaskRuntime: (id) => deps.scheduler.removeTaskRuntime(id) },
          encryptionKey: deps.encryptionKey,
        });
      } finally {
        if (ctx.createdBy && agentLease?.releaseAfterMutation) {
          await releaseLock(deps.db, {
            taskId: task_id,
            userId: ctx.createdBy,
            sessionId: agentLease.sessionId,
            generation: agentLease.generation,
          });
        }
      }
      if (deletion.kind === "not_found") return text(`Error: task ${task_id} not found.`);
      if (deletion.kind === "access_denied")
        return text(`Error: you do not have permission to delete task ${task_id}.`);
      if (deletion.kind === "scheduler_failure") {
        return text(
          `Error: automation ${task_id} was deleted, but scheduler cleanup failed. Runtime state is inconsistent.`,
        );
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
      if (!deps.automationRunsRepo) {
        return text("Error: run history is not available in this context.");
      }
      const runId = await deps.automationRunsRepo.create({
        taskId: task_id,
        triggeredByUserId: ctx.createdBy,
        triggerData: { type: "manual" },
      });
      // Fire the run without awaiting it: results deliver to the owner's
      // destinations through the normal scheduler path, and failures are
      // recorded + notified by the scheduler (failReservedManualRun). This
      // catch only prevents an unhandled rejection in the chat tool call.
      void deps.scheduler
        .executeTaskById(task_id, {
          runMode: "manual",
          runId,
          preserveTaskState: true,
          triggeredByUserId: ctx.createdBy,
        })
        .catch(() => undefined);
      const base = deps.config?.BASE_URL?.replace(/\/$/, "") ?? `http://localhost:${deps.config?.PORT ?? 3000}`;
      const displayName = guardedTask ? taskDisplayName(guardedTask) : task_id;
      return text(
        `Automation "${displayName}" run started. Track it here: ${base}/scheduled-tasks/${encodeURIComponent(task_id)}/edit?runId=${runId}`,
      );
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
      if (!run || run.task_id !== task_id) {
        return text(params.run_id ? `Error: run ${params.run_id} not found.` : "No runs found for this automation.");
      }
      return text(JSON.stringify(run, null, 2));
    }

    case "lockStatus": {
      if (!task_id) {
        return text("Error: task_id is required for lockStatus action.");
      }
      if (!deps.db) {
        return text("Error: automation lock state is not available in this context.");
      }
      const lock = await createAutomationLocksRepository(deps.db).getByTaskId(task_id);
      const displayName = guardedTask ? taskDisplayName(guardedTask) : task_id;
      if (!lock) {
        return text(`Automation "${displayName}" is not locked.`);
      }
      const holder = await holderDisplayName(deps, lock.holder_user_id);
      return text(
        `Automation "${displayName}" is locked by ${holder}. The lock expires at ${lock.expires_at}. Reply "take over" to request the edit lock.`,
      );
    }

    case "steal": {
      if (!task_id) {
        return text("Error: task_id is required for steal action.");
      }
      if (!ctx.createdBy) {
        return text("Error: your identity is not available to request the edit lock.");
      }
      if (!deps.db) {
        return text("Error: automation lock state is not available in this context.");
      }
      const stolen = await requestSteal(deps.db, { taskId: task_id, requester: lockHolderFor(ctx) });
      const displayName = guardedTask ? taskDisplayName(guardedTask) : task_id;
      if (stolen.kind === "not_locked") {
        return text(`Automation "${displayName}" is not locked by another editor right now.`);
      }
      const holder = await holderDisplayName(deps, stolen.lock.holder_user_id);
      if (stolen.kind === "locked") {
        return text(`Another user has already asked to take over this automation. Waiting for ${holder} to respond.`);
      }
      if (deps.notifyStealRequest) {
        void deps.notifyStealRequest(task_id).catch(() => {});
      }
      return text(`Waiting for ${holder} to approve your request to take over this automation.`);
    }

    case "updateStepContent": {
      if (!task_id) {
        return text("Error: task_id is required for updateStepContent action.");
      }
      if (!params.step_id || !params.step_content) {
        return text("Error: step_id and step_content are required for updateStepContent action.");
      }
      if (!deps.db) {
        return text("Error: canonical automation persistence is not available in this context. No changes were saved.");
      }
      const db = deps.db;

      const currentDefinition = await getAutomationDefinition({
        db,
        taskId: task_id,
        encryptionKey: deps.encryptionKey,
      });
      const step = currentDefinition?.steps.find((candidate) => candidate.id === params.step_id);
      const existing = currentDefinition?.stepContent[params.step_id];
      if (!currentDefinition || !step || step.type === "trigger" || !existing) {
        return text(`Error: step ${params.step_id} not found for task ${task_id}.`);
      }

      const expectedRevision =
        params.expected_revision ??
        params.expectedRevision ??
        (currentAutomation?.taskId === task_id ? currentAutomation.revision : undefined);
      let saved: Awaited<ReturnType<typeof updateAutomationDefinition>>;
      let agentLease: AgentLease | undefined;
      try {
        if (ctx.createdBy) {
          const acquired = await acquireAgentLease(db, task_id, ctx);
          if (acquired.kind === "stale") {
            return text("Error: the browser editing session is no longer active. Refresh and try again.");
          }
          if (acquired.kind === "locked") {
            return text(await lockedAutomationMessage(deps, acquired.lock));
          }
          agentLease = acquired.lease;
        }
        saved = await updateAutomationDefinition({
          db,
          taskId: task_id,
          patch: {
            expectedRevision,
            stepContent: {
              [params.step_id]: {
                contentType: existing.contentType,
                content: params.step_content,
                ...(params.step_apps === undefined ? {} : { apps: params.step_apps }),
              },
            },
          },
          actor: agentMutationActor(ctx, agentLease),
          brokerCapable: await getBrokerCapabilitySnapshot(),
          encryptionKey: deps.encryptionKey,
          ...(taskConversationAssociation ? { taskConversationAssociation } : {}),
        });
      } catch (error) {
        const message = automationPersistenceError(error);
        if (message) return text(message);
        throw error;
      } finally {
        if (ctx.createdBy && agentLease?.releaseAfterMutation) {
          await releaseLock(db, {
            taskId: task_id,
            userId: ctx.createdBy,
            sessionId: agentLease.sessionId,
            generation: agentLease.generation,
          });
        }
      }
      if (saved.kind === "not_found") return text(`Error: task ${task_id} not found.`);
      if (saved.kind === "access_denied") return text(`Error: you do not have permission to update task ${task_id}.`);
      if (saved.kind === "revision_conflict") {
        return text(
          `Error: automation revision conflict. Task ${task_id} is now at revision ${saved.currentRevision}; refresh before retrying.`,
        );
      }
      if (saved.kind === "locked") {
        return text(await lockedAutomationMessage(deps, saved.lock));
      }
      if (saved.kind === "lease_required") {
        return text("Error: automation editing requires an active authoring lease.");
      }
      if (saved.kind === "lease_stale") {
        return text(await lockedAutomationMessage(deps, saved.lock));
      }
      const { task: updated, failed: refreshFailed } = await refreshTaskAfterMutation(deps.scheduler, saved.row.id);
      if (refreshFailed || !updated)
        return text("Error: automation was saved, but its scheduler state could not be refreshed.");
      return text(`Step ${params.step_id} content updated at revision ${saved.row.revision}.`);
    }
  }
}

export function createManageScheduledTasksTool(deps: Partial<ManageScheduledTasksDeps>) {
  return tool(
    "ManageScheduledTasks",
    "Manage scheduled tasks that run automatically. Platform, delivery target, and creator are filled in automatically from context. Do not ask the user for these.",
    deps.chatAuthoring ? authoredScheduledTasksSchema : manageScheduledTasksSchema,
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
        encryptionKey: deps.encryptionKey,
        automationArtifactCollector: deps.automationArtifactCollector,
        chatAuthoring: deps.chatAuthoring,
        currentAutomation: deps.currentAutomation ?? deps.taskContext?.currentAutomation,
        db: deps.db,
      });
    },
  );
}

/**
 * Sketch MCP tools: SendFileToChat (file upload), getProviderConfig (integration credentials),
 * ManageScheduledTasks (create/list/update/pause/resume/remove scheduled agent runs),
 * GetTeamDirectory (discover team members), SearchUsers, SendMessageToUser,
 * SendMessageToUsers, and inbox workflow helpers for updating and resolving
 * explicit inbox tasks.
 *
 * Uses createSdkMcpServer() for in-memory tool dispatch. UploadCollector is created
 * per agent run. getProviderConfig reads integration provider credentials from the DB
 * so skills can use org-level API keys instead of per-user keys.
 *
 * ManageScheduledTasks is always registered (so the agent sees it) but returns an error
 * when scheduler or taskContext are not available (e.g. during scheduled task execution itself,
 * to prevent recursive scheduling).
 *
 * Messaging tools require inboxMessagesRepo, userRepo, currentUserId, and sendDm
 * to be present in deps. They return a descriptive error when those deps are absent.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod/v4";
import { KIND_TO_RULES, filterAccessibleFileIds, getFileContent, search } from "../connectors/search";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createEntityRepository } from "../db/repositories/entities";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { DB, UsersTable } from "../db/schema";
import { parseOnceSchedule } from "../scheduler/parse-once";
import type { TaskScheduler } from "../scheduler/service";
import type { TaskContext } from "../scheduler/types";
import type { WorkflowStep } from "../workflows/types";

type SelectableUser = Selectable<UsersTable>;

interface SearchableUserRepo {
  list: () => Promise<SelectableUser[]>;
  findById: (id: string) => Promise<SelectableUser | undefined>;
  getAllEmailsForUser: (id: string) => Promise<string[]>;
  findByEmail?: (email: string) => Promise<SelectableUser | undefined>;
  findBySlackId?: (slackUserId: string) => Promise<SelectableUser | undefined>;
  findByExactName?: (name: string, excludeUserId?: string) => Promise<SelectableUser | undefined>;
  searchByNamePrefix?: (query: string, limit?: number, excludeUserId?: string) => Promise<SelectableUser[]>;
  searchByNameSubstring?: (query: string, limit?: number, excludeUserId?: string) => Promise<SelectableUser[]>;
  update?: (id: string, data: { timezone?: string | null }) => Promise<SelectableUser>;
}

export class UploadCollector {
  private pending: string[] = [];

  collect(filePath: string): void {
    this.pending.push(filePath);
  }

  drain(): string[] {
    const files = [...this.pending];
    this.pending = [];
    return files;
  }
}

export interface SketchMcpDeps {
  uploadCollector: UploadCollector;
  workspaceDir: string;
  db?: Kysely<DB>;
  findIntegrationProvider?: () => Promise<{ type: string; credentials: string } | null>;
  taskContext?: TaskContext;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  toolConfig?: { BASE_URL?: string; PORT: number };
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  userRepo?: SearchableUserRepo;
  currentUserId?: string;
  sendDm?: (params: { userId: string; platform: string; message: string }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
  enqueueMessage?: (params: { requesterUserId: string; message: string }) => Promise<void>;
}

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
      type: z.enum(["webhook", "schedule"]),
      scheduleType: z.enum(["cron", "interval", "once"]).optional(),
      scheduleValue: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
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
    .enum(["fresh", "persistent", "chat"])
    .optional()
    .describe(
      `Controls memory across runs. Usually omit this (smart defaults apply).
- 'fresh': no memory, each run starts clean
- 'persistent': task remembers its own previous runs, isolated from user chat
- 'chat': continues the user's conversation session`,
    ),
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
  run_id: z.string().optional().describe("Run ID for getRun action. Omit for latest run."),
  step_id: z.string().optional().describe("Step ID for updateStepContent action."),
  step_content: z.string().optional().describe("New prompt or script content for updateStepContent action."),
  step_apps: z.array(z.string()).optional().describe("Updated MCP server slugs for updateStepContent action."),
};

type WorkflowStepInput = z.infer<typeof workflowStepSchema>;

type ManageScheduledTasksParams = {
  action: "list" | "add" | "update" | "remove" | "pause" | "resume" | "run" | "getRun" | "updateStepContent";
  prompt?: string;
  schedule_type?: "cron" | "interval" | "once";
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
  findIntegrationProvider?: () => Promise<{ type: string; credentials: string } | null>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  config?: { BASE_URL?: string; PORT: number };
}

function stripContentFromSteps(steps: WorkflowStepInput[]): WorkflowStep[] {
  return steps.map(({ script: _s, agentPrompt: _a, apps: _apps, ...step }) => step as WorkflowStep);
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

export async function handleManageScheduledTasks(
  params: ManageScheduledTasksParams,
  deps: ManageScheduledTasksDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { action, task_id } = params;
  const ctx = deps.taskContext;

  const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }] });

  // Ownership guard: creator-only for actions that mutate or inspect a specific task.
  // Unified 404 phrasing ("task not found") for both missing and not-yours — avoids
  // existence leaks. Admin bypass is deliberately not offered here; admins use the
  // web UI for tenant-wide ops. Matches the HTTP layer's same-behavior guarantee.
  const OWNERSHIP_GUARDED_ACTIONS = ["update", "remove", "pause", "resume", "run", "getRun", "updateStepContent"];
  if (task_id && OWNERSHIP_GUARDED_ACTIONS.includes(action)) {
    const task = await deps.scheduler.getTaskById(task_id);
    if (!task || task.createdBy !== ctx.createdBy) {
      return text("Error: task not found.");
    }
  }

  switch (action) {
    case "list": {
      const tasks =
        ctx.contextType === "dm"
          ? await deps.scheduler.listTasks({ createdBy: ctx.createdBy })
          : await deps.scheduler.listTasks({ deliveryTarget: ctx.deliveryTarget });
      return text(JSON.stringify(tasks, null, 2));
    }

    case "add": {
      // Multi-step: explicit steps array
      if (params.steps) {
        if (!params.title) {
          return text("Error: title is required when creating a multi-step automation.");
        }
        if (!params.schedule_type || !params.schedule_value) {
          return text("Error: schedule_type and schedule_value are required for add action.");
        }

        // Validate action steps require an integration provider
        if (params.steps.some((s) => s.type === "action")) {
          if (!deps.findIntegrationProvider) {
            return text(
              "Error: Action steps require an integration provider (e.g. Canvas MCP in skill mode). Configure one in Settings → Integrations, or use agent-only automations.",
            );
          }
          const provider = await deps.findIntegrationProvider();
          if (!provider) {
            return text(
              "Error: Action steps require an integration provider (e.g. Canvas MCP in skill mode). Configure one in Settings → Integrations, or use agent-only automations.",
            );
          }
        }
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

      let sessionMode = params.session_mode;
      if (!sessionMode) {
        if (ctx.contextType === "dm") {
          sessionMode = "chat";
        } else if (ctx.contextType === "channel" && ctx.threadTs) {
          sessionMode = "chat";
        } else {
          sessionMode = "fresh";
        }
      }

      if (sessionMode === "chat" && ctx.contextType === "channel" && !ctx.threadTs) {
        return text(
          "Error: 'chat' session mode is not available for top-level channel messages (no thread to continue). Use 'fresh' or 'persistent' instead.",
        );
      }

      // Strip content from steps (stored separately in automation_step_content)
      const steps = params.steps as NonNullable<typeof params.steps>;
      const title = params.title as string;
      const scheduleType = params.schedule_type as NonNullable<typeof params.schedule_type>;
      const scheduleValue = params.schedule_value as string;
      const stepsForDb = stripContentFromSteps(steps);

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
        outputTarget: params.output_target,
        outputPlatform: params.output_platform,
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

      // Handle steps update
      if (params.steps) {
        if (!deps.stepContentRepo && params.steps.some((s) => s.agentPrompt || s.script)) {
          return text(
            "Error: step content storage is not available in this context. Multi-step automations with prompts or scripts cannot be updated.",
          );
        }

        const stepsForDb = stripContentFromSteps(params.steps);
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
      if (!deps.queueManager) {
        return text("Error: manual trigger is not available in this context.");
      }
      deps.queueManager.getQueue(`task-${task_id}`).enqueue(async () => {
        await deps.scheduler.executeTaskById(task_id);
      });
      return text(`Automation ${task_id} triggered. Check run history for results.`);
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

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * Validates a candidate IANA timezone by attempting to construct an Intl
 * formatter with it. Avoids pulling in a hardcoded list — the runtime's
 * tz database is the authoritative source.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function handleSetUserTimezone(
  params: { timezone: string },
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo || !deps.userRepo.update || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Timezone update is not available in this context." }] };
  }
  const tz = params.timezone.trim();
  if (!tz) {
    return { content: [{ type: "text" as const, text: "Error: timezone is required." }] };
  }
  if (!isValidTimezone(tz)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: '${tz}' is not a valid IANA timezone. Examples: 'Asia/Kolkata', 'America/New_York', 'Europe/London'.`,
        },
      ],
    };
  }
  await deps.userRepo.update(deps.currentUserId, { timezone: tz });
  return { content: [{ type: "text" as const, text: `Timezone set to ${tz}.` }] };
}

export async function handleGetTeamDirectory(
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo) return { content: [{ type: "text" as const, text: "Team directory not available." }] };
  const users = await deps.userRepo.list();
  const directory = users
    .filter((u) => u.id !== deps.currentUserId)
    .map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role ?? null,
      type: u.type,
      description: u.description ?? "No description",
      channels: [...(u.slack_user_id ? ["slack"] : []), ...(u.whatsapp_number ? ["whatsapp"] : [])],
    }));
  return { content: [{ type: "text" as const, text: JSON.stringify(directory, null, 2) }] };
}

function detectPlatform(recipient: SelectableUser): "slack" | "whatsapp" | null {
  if (recipient.slack_user_id) return "slack";
  if (recipient.whatsapp_number) return "whatsapp";
  return null;
}

function formatUserMatch(user: SelectableUser, matchedBy: string) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slackUserId: user.slack_user_id,
    channels: [...(user.slack_user_id ? ["slack"] : []), ...(user.whatsapp_number ? ["whatsapp"] : [])],
    matchedBy,
  };
}

function extractSlackUserId(query: string): string | null {
  const mentionMatch = query.trim().match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return mentionMatch[1];
  const rawSlackIdMatch = query.trim().match(/^[A-Z][A-Z0-9]{4,}$/i);
  return rawSlackIdMatch ? rawSlackIdMatch[0] : null;
}

function looksLikeEmail(query: string): boolean {
  return query.includes("@");
}

async function deliverMessageToUser(
  params: { recipientUserId: string; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<
  | { status: "sent"; recipient: SelectableUser; platform: "slack" | "whatsapp"; inboxMessageId?: string }
  | { status: "skipped" | "failed"; error: string; recipient?: SelectableUser }
> {
  if (!deps.userRepo || !deps.sendDm || !deps.currentUserId) {
    return { status: "failed", error: "messaging is not available in this context." };
  }
  if (params.recipientUserId === deps.currentUserId) {
    return { status: "failed", error: "cannot send a message to yourself." };
  }

  const recipient = await deps.userRepo.findById(params.recipientUserId);
  if (!recipient) return { status: "failed", error: "user not found." };

  const platform = detectPlatform(recipient);
  if (!platform) {
    return { status: "failed", error: `${recipient.name} has no connected channel (Slack or WhatsApp).`, recipient };
  }

  const { channelId, messageRef } = await deps.sendDm({
    userId: params.recipientUserId,
    platform,
    message: params.message,
  });

  let inboxMessageId: string | undefined;
  if (params.storeInInbox !== false) {
    if (!deps.inboxMessagesRepo) {
      return { status: "failed", error: "Inbox storage is not available in this context.", recipient };
    }
    const inboxMessage = await deps.inboxMessagesRepo.create({
      senderUserId: deps.currentUserId,
      recipientUserId: params.recipientUserId,
      message: params.message,
      platform,
      channelId,
      messageRef,
    });
    inboxMessageId = inboxMessage.id;
  }

  return { status: "sent", recipient, platform, inboxMessageId };
}

export async function handleSendMessageToUser(
  params: { recipientUserId: string; message: string },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  const result = await deliverMessageToUser({ ...params, storeInInbox: true }, deps);
  if (result.status !== "sent") {
    return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: result.inboxMessageId,
          recipientName: result.recipient.name,
          status: "sent",
        }),
      },
    ],
  };
}

export async function handleSearchUsers(
  params: { queries: string[] },
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo) {
    return { content: [{ type: "text" as const, text: "User search is not available in this context." }] };
  }

  const results: Array<{ query: string; matches: Array<Record<string, unknown>> }> = [];

  for (const query of params.queries) {
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const slackUserId = extractSlackUserId(query);
    const trimmedQuery = query.trim();

    const pushMatch = (user: SelectableUser | undefined, matchedBy: string) => {
      if (!user || user.id === deps.currentUserId || seen.has(user.id)) return;
      seen.add(user.id);
      matches.push(formatUserMatch(user, matchedBy));
    };

    if (slackUserId) {
      pushMatch(await deps.userRepo.findBySlackId?.(slackUserId), "slack_user_id");
    }

    if (looksLikeEmail(trimmedQuery)) {
      pushMatch(await deps.userRepo.findByEmail?.(trimmedQuery), "exact_email");
    }

    pushMatch(await deps.userRepo.findByExactName?.(trimmedQuery, deps.currentUserId), "exact_name");

    const prefixMatches = deps.userRepo.searchByNamePrefix
      ? await deps.userRepo.searchByNamePrefix(trimmedQuery, 5, deps.currentUserId)
      : [];
    for (const user of prefixMatches) {
      pushMatch(user, "prefix_name");
    }

    if (trimmedQuery.length >= 3) {
      const substringMatches = deps.userRepo.searchByNameSubstring
        ? await deps.userRepo.searchByNameSubstring(trimmedQuery, 5, deps.currentUserId)
        : [];
      for (const user of substringMatches) {
        pushMatch(user, "substring_name");
      }
    }

    results.push({ query, matches });
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export async function handleSendMessageToUsers(
  params: { recipientUserIds: string[]; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const recipientUserId of params.recipientUserIds) {
    if (seen.has(recipientUserId)) {
      results.push({ recipientUserId, status: "skipped", error: "Duplicate recipient in request" });
      continue;
    }
    seen.add(recipientUserId);

    try {
      const result = await deliverMessageToUser(
        { recipientUserId, message: params.message, storeInInbox: params.storeInInbox },
        deps,
      );

      if (result.status === "sent") {
        results.push({
          recipientUserId,
          recipientName: result.recipient.name,
          status: "sent",
          platform: result.platform,
          ...(result.inboxMessageId ? { inboxMessageId: result.inboxMessageId } : {}),
        });
      } else {
        results.push({
          recipientUserId,
          recipientName: result.recipient?.name,
          status: result.status,
          error: result.error,
        });
      }
    } catch (error) {
      results.push({
        recipientUserId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export async function handleUpdateInboxWorkflow(
  params: { inboxMessageId: string; metadata: Record<string, unknown> },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.inboxMessagesRepo || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflows are not available in this context." }] };
  }

  const existing = await deps.inboxMessagesRepo.findById(params.inboxMessageId);
  if (!existing || existing.recipient_user_id !== deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow not found." }] };
  }
  if (existing.resolution_mode !== "explicit") {
    return { content: [{ type: "text" as const, text: "Error: inbox item is not an explicit workflow." }] };
  }
  if (existing.resolved_at) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow is already resolved." }] };
  }

  const updated = await deps.inboxMessagesRepo.updateWorkflow(params.inboxMessageId, params.metadata);
  if (!updated) {
    return { content: [{ type: "text" as const, text: "Error: failed to update inbox workflow." }] };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: updated.id,
          status: "updated",
          metadata: updated.metadata ? JSON.parse(updated.metadata) : null,
        }),
      },
    ],
  };
}

export async function handleResolveInboxWorkflow(
  params: { inboxMessageId: string },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.inboxMessagesRepo || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflows are not available in this context." }] };
  }

  const existing = await deps.inboxMessagesRepo.findById(params.inboxMessageId);
  if (!existing || existing.recipient_user_id !== deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow not found." }] };
  }
  if (existing.resolution_mode !== "explicit") {
    return { content: [{ type: "text" as const, text: "Error: inbox item is not an explicit workflow." }] };
  }
  if (existing.resolved_at) {
    return { content: [{ type: "text" as const, text: "Error: inbox workflow is already resolved." }] };
  }

  const resolved = await deps.inboxMessagesRepo.resolve(params.inboxMessageId);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: params.inboxMessageId,
          status: resolved?.resolved_at ? "resolved" : "not_found",
        }),
      },
    ],
  };
}

export function createSketchMcpServer(deps: SketchMcpDeps) {
  const absWorkspace = resolve(deps.workspaceDir);

  async function resolveUserEmails(): Promise<string[]> {
    if (!deps.currentUserId || !deps.userRepo?.getAllEmailsForUser) return [];
    return deps.userRepo.getAllEmailsForUser(deps.currentUserId);
  }

  const tools = [
    tool(
      "SendFileToChat",
      "Queue a file from the workspace to be sent back to the user in chat. The file must exist within your workspace directory. Create the file first using Write or Bash, then call this tool with the absolute path.",
      { file_path: z.string().describe("Absolute path to the file within your workspace") },
      async ({ file_path }) => {
        const absPath = resolve(file_path);

        if (!absPath.startsWith(absWorkspace)) {
          return {
            content: [{ type: "text" as const, text: `Error: file must be within your workspace ${absWorkspace}` }],
          };
        }

        if (!existsSync(absPath)) {
          return {
            content: [{ type: "text" as const, text: `Error: file not found at ${absPath}` }],
          };
        }

        deps.uploadCollector.collect(absPath);
        return {
          content: [{ type: "text" as const, text: `File queued for upload: ${absPath}` }],
        };
      },
    ),

    tool(
      "getProviderConfig",
      "Check if an integration provider is configured. Credentials and user scoping are injected automatically into integration CLI wrappers at runtime — never set API keys or email addresses manually.",
      {},
      async () => {
        if (!deps.findIntegrationProvider) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
          };
        }

        const provider = await deps.findIntegrationProvider();
        if (!provider) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                configured: true,
                type: provider.type,
              }),
            },
          ],
        };
      },
    ),

    tool(
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
          findIntegrationProvider: deps.findIntegrationProvider,
          queueManager: deps.queueManager,
          config: deps.toolConfig,
        });
      },
    ),

    tool(
      "GetTeamDirectory",
      "Discover team members and their roles. Returns all team members except yourself.",
      {},
      async () => handleGetTeamDirectory(deps),
    ),

    tool(
      "SetUserTimezone",
      "Update the current user's timezone. Use IANA names (e.g. 'Asia/Kolkata', 'America/New_York', 'Europe/London'). Call this when the user explicitly asks to change their timezone — the system already auto-resolves a default from Slack profile / WhatsApp country code.",
      {
        timezone: z.string().describe("IANA timezone name, e.g. 'Asia/Kolkata' or 'America/New_York'."),
      },
      async (params) => handleSetUserTimezone(params, deps),
    ),

    tool(
      "SearchUsers",
      "Resolve names, emails, Slack mentions, and Slack user IDs into tenant users. Returns ranked candidates so you can confirm recipients before sending messages.",
      {
        queries: z.array(z.string()).describe("Names, emails, Slack mentions, or Slack user IDs to resolve."),
      },
      async (params) => handleSearchUsers(params, deps),
    ),

    tool(
      "SendMessageToUser",
      "Send a DM to a team member via their connected channel (Slack or WhatsApp). The exact message is also stored as a one-way inbox item so their agent can see it on their next private chat.",
      {
        recipientUserId: z.string().describe("The user ID from GetTeamDirectory"),
        message: z.string().describe("The exact message text to send to the recipient."),
      },
      async (params) => handleSendMessageToUser(params, deps),
    ),

    tool(
      "SendMessageToUsers",
      "Send the same DM to multiple team members. When storeInInbox is true, the sent message is also stored as a one-way inbox item for each successful recipient.",
      {
        recipientUserIds: z.array(z.string()).describe("The recipient user IDs to message."),
        message: z.string().describe("The exact message text to send to every recipient."),
        storeInInbox: z
          .boolean()
          .optional()
          .describe("Whether to store the sent message in each recipient's inbox. Defaults to true."),
      },
      async (params) => handleSendMessageToUsers(params, deps),
    ),

    tool(
      "UpdateInboxWorkflow",
      "Update the metadata for one of your explicit inbox workflow items. Use this to save workflow stage, selected recipients, draft text, or reminder state.",
      {
        inboxMessageId: z.string().describe("The inbox workflow ID to update."),
        metadata: z.record(z.string(), z.unknown()).describe("A partial metadata object to merge into the workflow."),
      },
      async (params) => handleUpdateInboxWorkflow(params, deps),
    ),

    tool(
      "ResolveInboxWorkflow",
      "Resolve one of your explicit inbox workflow items so it stops appearing in future inbox context.",
      {
        inboxMessageId: z.string().describe("The inbox workflow ID to resolve."),
      },
      async (params) => handleResolveInboxWorkflow(params, deps),
    ),

    // --- Search tools ---
    tool(
      "Search",
      `Search across all indexed knowledge — docs, tasks, meetings, conversations, and workspace files. Uses hybrid search (keyword + semantic) for best results. Automatically surfaces matching entities for context.

When results mention a specific entity (project, client, person), results linked to that entity are boosted to the top. For hard-scoped search by entity, call SearchEntities first then pass the resolved IDs as \`entityIds\` (use \`entityIdsMode: "and"\` for "with X and Y", \`"or"\` for "from X or Y").

Recency: pass \`sortBy: "recency"\` for "latest", "most recent", "last X" questions. \`query\` is optional when filters are present (e.g. \`{ kind: "meeting", sortBy: "recency" }\` for "fetch my latest meeting" — RBAC scopes to what the user can see).

Use this to find information before asking others. Examples:
- "What did we decide about the auth approach?"  → Search({ query: "auth approach decision" })
- "Epik demo playbook"  → Search({ query: "Epik demo playbook" })
- "fetch my latest meeting"  → Search({ kind: "meeting", sortBy: "recency", limit: 3 })
- "latest meeting with Oliver Wyman and Ohoud"  → SearchEntities then Search({ kind: "meeting", entityIds: [<a>, <b>], sortBy: "recency" })
- "anything from Oliver or Ohoud lately"  → SearchEntities then Search({ entityIds: [<a>, <b>], entityIdsMode: "or", sortBy: "recency" })

\`kind\` cannot be combined with \`source: "local"\` (local files have no kind taxonomy).`,
      {
        query: z.string().optional().describe("Natural language search query. May be empty when filters are present."),
        entityId: z.string().optional().describe("Back-compat single-entity hard filter. Prefer entityIds."),
        entityIds: z
          .array(z.string())
          .optional()
          .describe("Multi-entity filter. Pair with entityIdsMode. Use after SearchEntities."),
        entityIdsMode: z
          .enum(["and", "or"])
          .optional()
          .describe(
            "'and' (default): only files mentioning ALL entities. 'or': files mentioning ANY of them. If 'and' returns nothing, retry with 'or' before declaring no results.",
          ),
        kind: z
          .enum(["meeting", "doc", "task", "message"])
          .optional()
          .describe(
            "Semantic content kind. meeting=Fireflies, doc=Drive/Notion/ClickUp Docs/Linear projects, task=ClickUp tasks/Linear issues, message=conversation.",
          ),
        source: z
          .enum(["google_drive", "clickup", "linear", "notion", "fireflies", "conversation", "local"])
          .optional()
          .describe("Filter to a specific source. Omit to search all."),
        sortBy: z
          .enum(["relevance", "recency"])
          .optional()
          .describe("Use 'recency' for 'latest', 'most recent', 'last X' questions. Default is 'relevance'."),
        after: z.string().optional().describe("Only results updated after this ISO date"),
        before: z.string().optional().describe("Only results updated before this ISO date"),
        limit: z.number().optional().describe("Max results (default 10; default 3 when sortBy=recency)."),
      },
      async ({
        query: searchQuery,
        entityId,
        entityIds,
        entityIdsMode,
        kind,
        source,
        sortBy,
        after,
        before,
        limit: resultLimit,
      }) => {
        if (!deps.db) {
          return { content: [{ type: "text" as const, text: "Search not available." }] };
        }

        // kind × source:"local" guard. local files have no kind taxonomy and the
        // combination would silently return zero results otherwise.
        if (kind && source === "local") {
          return {
            content: [
              {
                type: "text" as const,
                text: "kind cannot be combined with source: 'local' (local files have no kind taxonomy).",
              },
            ],
          };
        }

        const trimmedQuery = (searchQuery ?? "").trim();
        const callerProvidedEntityIds = !!(entityId || (entityIds && entityIds.length > 0));
        const hasFilter = !!kind || !!source || callerProvidedEntityIds || !!after || !!before;

        // Empty-query guard: must have at least one structural filter.
        if (!trimmedQuery && !hasFilter) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Need a query or at least one filter (kind, source, entityIds, after, before).",
              },
            ],
          };
        }

        const lines: string[] = [];
        const entityRepo = createEntityRepository(deps.db);

        // Skip auto-entity-discovery when caller pinned entityIds OR the query is empty
        // (LIKE '%%' would match every entity and explode the boost path).
        const skipAutoEntityBoost = callerProvidedEntityIds || trimmedQuery === "";

        // Build the "Matching entities" header, either from auto-discovery or
        // from the caller-supplied ids (parity).
        type EntityRow = Awaited<ReturnType<typeof entityRepo.searchEntities>>[number];
        let entityMatches: EntityRow[] = [];
        if (!skipAutoEntityBoost) {
          entityMatches = await entityRepo.searchEntities(trimmedQuery, { limit: 5 });
        } else if (callerProvidedEntityIds) {
          const ids = entityIds && entityIds.length > 0 ? entityIds : entityId ? [entityId] : [];
          entityMatches = await entityRepo.getEntities(ids);
        }
        if (entityMatches.length > 0) {
          const entityParts = entityMatches.map((e) => {
            const aliases = e.aliases ? (JSON.parse(e.aliases) as string[]) : [];
            const aliasStr = aliases.length > 0 ? `, aliases: ${aliases.join(", ")}` : "";
            const subtypeStr = e.subtype ? ` (${e.subtype})` : "";
            return `${e.name} (${e.id}) [${e.source_type}${subtypeStr}${aliasStr}]`;
          });
          lines.push(`**Matching entities**: ${entityParts.join(" | ")}`);
          lines.push("");
        }

        // Auto-boost set: only used for the relevance-sort handler-level reorder.
        // search() applies its own ENTITY_BOOST inside RRF; we mirror that here
        // so the agent sees entity-linked files at the top of relevance results.
        let entityFileIds: Set<string> | undefined;
        if (!skipAutoEntityBoost && entityMatches.length > 0) {
          const matchIds = entityMatches.map((e) => e.id);
          const mentions = await deps.db
            .selectFrom("entity_mentions")
            .select("indexed_file_id")
            .where("entity_id", "in", matchIds)
            .execute();
          entityFileIds = new Set(mentions.map((m) => m.indexed_file_id));
        }

        const effectiveLimit = resultLimit ?? (sortBy === "recency" ? 3 : 10);
        const userEmails = await resolveUserEmails();
        const results = await search(deps.db, trimmedQuery, {
          kindRules: kind ? KIND_TO_RULES[kind] : undefined,
          source,
          limit: effectiveLimit,
          after,
          before,
          entityId,
          entityIds,
          entityIdsMode,
          sortBy,
          userEmails,
          skipAutoEntityBoost,
        });

        // Handler-level reorder: only when sorting by relevance and we have a
        // boost set. Otherwise it would override recency order (or run against
        // an empty set when caller pinned entityIds).
        const effectiveSortBy = sortBy ?? "relevance";
        if (effectiveSortBy === "relevance" && !callerProvidedEntityIds && entityFileIds && entityFileIds.size > 0) {
          results.sort((a, b) => {
            const aLinked = entityFileIds?.has(a.id) ? 1 : 0;
            const bLinked = entityFileIds?.has(b.id) ? 1 : 0;
            if (aLinked !== bLinked) return bLinked - aLinked;
            return b.score - a.score;
          });
        }

        if (results.length === 0 && entityMatches.length === 0) {
          const label = trimmedQuery ? `"${trimmedQuery}"` : "the given filters";
          return { content: [{ type: "text" as const, text: `No results found for ${label}.` }] };
        }

        for (const r of results) {
          const sourceLabel = r.source.charAt(0).toUpperCase() + r.source.slice(1).replace(/_/g, " ");
          const date = r.sourceUpdatedAt ? new Date(r.sourceUpdatedAt).toISOString().split("T")[0] : "";

          lines.push(`**${r.fileName}** (${sourceLabel}${date ? `, ${date}` : ""})`);
          lines.push(`  sketchId: ${r.id}`);
          lines.push(`  providerId: ${r.providerFileId} (source=${r.source})`);
          if (r.providerUrl) lines.push(`  url: ${r.providerUrl}`);
          if (r.summary) {
            lines.push(`> ${r.summary.slice(0, 200)}${r.summary.length > 200 ? "..." : ""}`);
          } else if (r.snippet) {
            lines.push(`> ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`);
          }
          lines.push("");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    ),

    tool(
      "SearchEntities",
      `Search for entities (projects, people, teams, databases) across all connected sources. Accepts multiple query variations to catch abbreviations and informal names. Returns matched entities with their type, status, and mention count.

Use this when the user asks about a project, person, or any named thing tracked across the org's tools. Pass multiple name variations (e.g. ["Beetu", "B2", "beetu app"]) to maximize matches.`,
      {
        queries: z
          .array(z.string())
          .describe("Array of name variations to search for. Runs substring match per query, dedupes results."),
        types: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by entity source_type. Examples: 'person', 'clickup_space', 'clickup_folder', 'linear_project', 'notion_database'.",
          ),
      },
      async ({ queries, types }) => {
        if (!deps.db) {
          return { content: [{ type: "text" as const, text: "Entity search not available." }] };
        }
        const entityRepo = createEntityRepository(deps.db);
        const seen = new Set<string>();
        const results: Array<Record<string, unknown>> = [];

        for (const query of queries) {
          const matches = await entityRepo.searchEntities(query, {
            sourceTypes: types,
            limit: 20,
          });
          for (const entity of matches) {
            if (!seen.has(entity.id)) {
              seen.add(entity.id);
              results.push({
                id: entity.id,
                name: entity.name,
                sourceType: entity.source_type,
                subtype: entity.subtype,
                aliases: entity.aliases ? JSON.parse(entity.aliases) : [],
                status: entity.status,
                hotness: entity.hotness,
              });
            }
          }
        }

        // Layer 2: users table fallback if no entity matches
        if (results.length === 0 && deps.userRepo) {
          const users = await deps.userRepo.list();
          for (const query of queries) {
            const q = query.toLowerCase();
            for (const user of users) {
              if (user.name.toLowerCase().includes(q) && !seen.has(user.id)) {
                seen.add(user.id);
                results.push({
                  id: user.id,
                  name: user.name,
                  sourceType: "person",
                  subtype: "internal",
                  aliases: [],
                  status: "confirmed",
                  source: "team_directory",
                });
              }
            }
          }
        }

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: "No entities found matching those queries." }] };
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      },
    ),

    tool(
      "GetEntityContext",
      `Get cross-source context for an entity — all recent mentions across meetings, tasks, docs, and other indexed content. Returns a formatted timeline showing where and when this entity was referenced.

Use this after SearchEntities to dive deeper into a specific entity. The response is a human-readable summary, not raw data.`,
      {
        entityId: z.string().describe("The entity ID from SearchEntities results."),
        limit: z.number().optional().describe("Max mentions to return. Default 20. Agent can request more if needed."),
        since: z
          .string()
          .optional()
          .describe("ISO date string. Only return mentions after this date. Example: '2026-03-01'."),
      },
      async ({ entityId, limit, since }) => {
        if (!deps.db) {
          return { content: [{ type: "text" as const, text: "Entity context not available." }] };
        }
        const entityRepo = createEntityRepository(deps.db);
        const entity = await entityRepo.getEntity(entityId);
        if (!entity) {
          return { content: [{ type: "text" as const, text: `Entity ${entityId} not found.` }] };
        }

        const requestedLimit = limit ?? 20;
        const userEmails = await resolveUserEmails();
        // When RBAC is active, fetch an over-bound so access filtering doesn't starve the results.
        const rawMentions = await entityRepo.getMentionsForEntity(entityId, {
          limit: userEmails.length > 0 ? Math.max(requestedLimit * 5, 100) : requestedLimit,
          since,
        });

        const accessibleIds =
          userEmails.length > 0
            ? await filterAccessibleFileIds(
                deps.db,
                rawMentions.map((m) => m.indexed_file_id),
                userEmails,
              )
            : null;

        const mentions = (
          accessibleIds ? rawMentions.filter((m) => accessibleIds.has(m.indexed_file_id)) : rawMentions
        ).slice(0, requestedLimit);

        // Enrich mentions with file metadata
        const lines: string[] = [];
        const aliases = entity.aliases ? (JSON.parse(entity.aliases) as string[]) : [];
        const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
        lines.push(`## ${entity.name}${aliasStr}`);
        lines.push(
          `Type: ${entity.source_type}${entity.subtype ? ` (${entity.subtype})` : ""} | Status: ${entity.status}`,
        );
        lines.push(
          `Total mentions found: ${mentions.length}${mentions.length === requestedLimit ? " (limit reached, use 'since' or increase 'limit' for more)" : ""}`,
        );
        lines.push("");

        for (const mention of mentions) {
          const file = await deps.db
            .selectFrom("indexed_files")
            .select(["file_name", "file_type", "source", "source_path", "provider_url"])
            .where("id", "=", mention.indexed_file_id)
            .executeTakeFirst();

          if (!file) continue;

          const sourceDate = mention.source_updated_at ?? mention.source_created_at ?? mention.mentioned_at;
          const date = new Date(sourceDate).toISOString().split("T")[0];
          const sourceLabel = file.source.charAt(0).toUpperCase() + file.source.slice(1);
          const urlSuffix = file.provider_url ? ` (${file.provider_url})` : "";
          lines.push(`**${date}** — ${sourceLabel}: "${file.file_name}"${urlSuffix}`);
          if (mention.context_snippet) {
            lines.push(`  ${mention.context_snippet.slice(0, 200)}`);
          }
          lines.push("");
        }

        if (mentions.length === 0) {
          lines.push("No mentions found for this entity.");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    ),

    tool(
      "GetFileContent",
      `Retrieve the full content of an indexed file by its ID. Use this after Search returns a relevant result and you need the complete text — e.g. full meeting transcript, complete document, or full task description.

The ID comes from a previous Search result.`,
      {
        fileId: z.string().describe("The indexed file ID from a Search result."),
      },
      async ({ fileId }) => {
        if (!deps.db) {
          return { content: [{ type: "text" as const, text: "File content not available." }] };
        }
        const userEmails = await resolveUserEmails();
        const file = await getFileContent(deps.db, fileId, userEmails);

        if (!file) {
          return { content: [{ type: "text" as const, text: `File ${fileId} not found.` }] };
        }

        const lines: string[] = [];
        const sourceLabel = file.source.charAt(0).toUpperCase() + file.source.slice(1).replace(/_/g, " ");
        lines.push(`# ${file.fileName}`);
        lines.push(`Source: ${sourceLabel}${file.fileType ? ` (${file.fileType})` : ""}`);
        if (file.providerUrl) lines.push(`URL: ${file.providerUrl}`);
        lines.push("");
        lines.push(file.content ?? file.summary ?? "(no content)");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    ),
  ];

  return createSdkMcpServer({ name: "sketch", tools });
}

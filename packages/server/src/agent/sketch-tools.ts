/**
 * Sketch MCP tools: SendFileToChat (file upload), getProviderConfig (integration credentials),
 * ManageScheduledTasks (create/list/update/pause/resume/remove scheduled agent runs),
 * GetTeamDirectory (discover team members), SendMessageToUser (send tracked DM outreach),
 * and RespondToOutreach (deliver a response back to the requester).
 *
 * Uses createSdkMcpServer() for in-memory tool dispatch. UploadCollector is created
 * per agent run. getProviderConfig reads integration provider credentials from the DB
 * so skills can use org-level API keys instead of per-user keys.
 *
 * ManageScheduledTasks is always registered (so the agent sees it) but returns an error
 * when scheduler or taskContext are not available (e.g. during scheduled task execution itself,
 * to prevent recursive scheduling).
 *
 * Outreach tools require outreachRepo, userRepo, currentUserId, sendDm, and enqueueMessage
 * to be present in deps. They return a descriptive error when those deps are absent.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod/v4";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createEntityRepository } from "../db/repositories/entities";
import type { createOutreachRepository } from "../db/repositories/outreach";
import type { DB, UsersTable } from "../db/schema";
import type { TaskScheduler } from "../scheduler/service";
import type { TaskContext } from "../scheduler/types";
import type { WorkflowStep } from "../workflows/types";
import { buildSketchContext } from "./prompt";

type SelectableUser = Selectable<UsersTable>;

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
  /**
   * Repositories and helpers needed by the ManageScheduledTasks tool for multi-step
   * workflow persistence (step content), run inspection, and manual triggers.
   * Must be plumbed through from the adapter deps or multi-step automations silently
   * lose their prompts/scripts at creation time.
   */
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => void } };
  toolConfig?: { BASE_URL?: string; PORT: number };
  outreachRepo?: ReturnType<typeof createOutreachRepository>;
  userRepo?: { list: () => Promise<SelectableUser[]>; findById: (id: string) => Promise<SelectableUser | undefined> };
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
For once: ISO 8601 datetime string (e.g. '2026-03-14T15:00:00'). The task runs once at this time then auto-completes.`,
    ),
  timezone: z.string().optional().describe("IANA timezone (e.g. 'America/New_York', 'Asia/Kolkata'). Defaults to UTC."),
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

export async function handleManageScheduledTasks(
  params: ManageScheduledTasksParams,
  deps: ManageScheduledTasksDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { action, task_id } = params;
  const ctx = deps.taskContext;

  const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }] });

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

      if (params.schedule_type === "cron") {
        try {
          const { Cron } = await import("croner");
          new Cron(params.schedule_value as string, { timezone: params.timezone ?? "UTC" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return text(`Error: invalid cron expression '${params.schedule_value}': ${msg}`);
        }
      }

      if (params.schedule_type === "once" && params.schedule_value) {
        const runAt = new Date(params.schedule_value);
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
        timezone: params.timezone,
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

export async function handleSendMessageToUser(
  params: { recipientUserId: string; message: string; taskContext?: string },
  deps: Pick<SketchMcpDeps, "outreachRepo" | "userRepo" | "sendDm" | "currentUserId" | "taskContext">,
): Promise<ToolResult> {
  if (!deps.outreachRepo || !deps.userRepo || !deps.sendDm || !deps.currentUserId || !deps.taskContext) {
    return { content: [{ type: "text" as const, text: "Error: outreach is not available in this context." }] };
  }
  if (params.recipientUserId === deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Error: cannot send outreach to yourself." }] };
  }
  const recipient = await deps.userRepo.findById(params.recipientUserId);
  if (!recipient) return { content: [{ type: "text" as const, text: "Error: user not found." }] };
  if (!recipient.slack_user_id && !recipient.whatsapp_number) {
    return {
      content: [
        { type: "text" as const, text: `Error: ${recipient.name} has no connected channel (Slack or WhatsApp).` },
      ],
    };
  }

  const platform = recipient.slack_user_id ? "slack" : "whatsapp";
  const { channelId, messageRef } = await deps.sendDm({
    userId: params.recipientUserId,
    platform,
    message: params.message,
  });

  const ctx = deps.taskContext;
  const outreach = await deps.outreachRepo.create({
    requesterUserId: deps.currentUserId,
    recipientUserId: params.recipientUserId,
    message: params.message,
    taskContext: params.taskContext,
    platform,
    channelId,
    messageRef,
    requesterPlatform: ctx.platform,
    requesterChannel: ctx.deliveryTarget,
    requesterThreadTs: ctx.threadTs,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ outreachId: outreach.id, recipientName: recipient.name, status: "sent" }),
      },
    ],
  };
}

export async function handleGetOutreachStatus(
  deps: Pick<SketchMcpDeps, "outreachRepo" | "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.outreachRepo || !deps.currentUserId) {
    return { content: [{ type: "text" as const, text: "Outreach status not available." }] };
  }
  const [sent, received] = await Promise.all([
    deps.outreachRepo.findForRequester(deps.currentUserId),
    deps.outreachRepo.findPendingForRecipient(deps.currentUserId),
  ]);

  const userNameCache = new Map<string, string>();
  const resolveName = async (userId: string): Promise<string> => {
    const cached = userNameCache.get(userId);
    if (cached) return cached;
    const user = deps.userRepo ? await deps.userRepo.findById(userId) : null;
    const name = user?.name ?? "Unknown";
    userNameCache.set(userId, name);
    return name;
  };

  const sentItems = await Promise.all(
    sent.map(async (o) => ({
      id: o.id,
      recipientName: await resolveName(o.recipient_user_id),
      message: o.message,
      status: o.status,
      createdAt: o.created_at,
      response: o.response,
      respondedAt: o.responded_at,
    })),
  );

  const receivedItems = await Promise.all(
    received.map(async (o) => ({
      id: o.id,
      requesterName: await resolveName(o.requester_user_id),
      message: o.message,
      taskContext: o.task_context,
      status: o.status,
      createdAt: o.created_at,
    })),
  );

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ sent: sentItems, received: receivedItems }, null, 2) }],
  };
}

export async function handleRespondToOutreach(
  params: { outreachId: string; response: string },
  deps: Pick<SketchMcpDeps, "outreachRepo" | "enqueueMessage" | "userRepo">,
): Promise<ToolResult> {
  if (!deps.outreachRepo || !deps.enqueueMessage) {
    return { content: [{ type: "text" as const, text: "Error: outreach is not available in this context." }] };
  }
  const outreach = await deps.outreachRepo.findById(params.outreachId);
  if (!outreach) return { content: [{ type: "text" as const, text: "Error: outreach not found." }] };
  if (outreach.status !== "pending")
    return { content: [{ type: "text" as const, text: "Error: this outreach has already been responded to." }] };

  await deps.outreachRepo.markResponded(params.outreachId, params.response);

  const requester = deps.userRepo ? await deps.userRepo.findById(outreach.requester_user_id) : null;
  const recipientUser = deps.userRepo ? await deps.userRepo.findById(outreach.recipient_user_id) : null;

  const syntheticMessage = buildSketchContext({
    messages: [],
    currentUserName: "",
    currentMessage: "",
    isSharedContext: false,
    outreachResponses: [
      {
        id: outreach.id,
        message: outreach.message,
        taskContext: outreach.task_context,
        response: params.response,
        status: "responded",
        createdAt: outreach.created_at,
        respondedAt: outreach.responded_at,
        recipientName: recipientUser?.name ?? "Unknown",
      },
    ],
  });

  await deps.enqueueMessage({
    requesterUserId: outreach.requester_user_id,
    message: syntheticMessage,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ status: "delivered", requesterName: requester?.name ?? "Unknown" }),
      },
    ],
  };
}

export function createSketchMcpServer(deps: SketchMcpDeps) {
  const absWorkspace = resolve(deps.workspaceDir);

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
      "Discover team members and their roles. Use descriptions to decide who can help with a task. Returns all team members except yourself.",
      {},
      async () => handleGetTeamDirectory(deps),
    ),

    tool(
      "SendMessageToUser",
      "Send a tracked DM to a team member to ask a question or request information. The message is delivered via their connected channel (Slack or WhatsApp). The recipient's assistant will see the outreach and help them respond. Use GetTeamDirectory first to find the right person.",
      {
        recipientUserId: z.string().describe("The user ID from GetTeamDirectory"),
        message: z.string().describe("The message to send. Be specific about what you need."),
        taskContext: z
          .string()
          .optional()
          .describe(
            "Brief context about why you're asking, so the recipient's assistant understands the broader goal.",
          ),
      },
      async (params) => handleSendMessageToUser(params, deps),
    ),

    tool(
      "GetOutreachStatus",
      "Check the status of all your outreach messages (sent and received). Returns sent messages with their response status, and any pending inbound questions from other team members.",
      {},
      async () => handleGetOutreachStatus(deps),
    ),

    tool(
      "RespondToOutreach",
      "Mark a pending outreach question as answered and deliver the response to the person who asked. Call this when the user has provided information relevant to a pending outreach question shown in the <outreach> context section.",
      {
        outreachId: z.string().describe("The outreach ID from the <outreach> context section"),
        response: z
          .string()
          .describe("The answer or information gathered from the user. Summarize the key points clearly."),
      },
      async (params) => handleRespondToOutreach(params, deps),
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

        const mentions = await entityRepo.getMentionsForEntity(entityId, {
          limit: limit ?? 20,
          since,
        });

        // Enrich mentions with file metadata
        const lines: string[] = [];
        const aliases = entity.aliases ? (JSON.parse(entity.aliases) as string[]) : [];
        const aliasStr = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
        lines.push(`## ${entity.name}${aliasStr}`);
        lines.push(
          `Type: ${entity.source_type}${entity.subtype ? ` (${entity.subtype})` : ""} | Status: ${entity.status}`,
        );
        lines.push(
          `Total mentions found: ${mentions.length}${mentions.length === (limit ?? 20) ? " (limit reached, use 'since' or increase 'limit' for more)" : ""}`,
        );
        lines.push("");

        for (const mention of mentions) {
          const file = await deps.db
            .selectFrom("indexed_files")
            .select(["file_name", "file_type", "source", "source_path", "provider_url"])
            .where("id", "=", mention.indexed_file_id)
            .executeTakeFirst();

          if (!file) continue;

          const date = new Date(mention.mentioned_at).toISOString().split("T")[0];
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
  ];

  return createSdkMcpServer({ name: "sketch", tools });
}
